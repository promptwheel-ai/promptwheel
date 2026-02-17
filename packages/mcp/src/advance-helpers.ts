import * as fs from 'node:fs';
import * as path from 'node:path';
import { RunManager } from './run-manager.js';
import { getRegistry } from './tool-registry.js';
import {
  selectRelevant,
  formatLearningsForPrompt,
  recordAccess,
} from './learnings.js';
import type { AdaptiveRiskAssessment } from '@blockspool/core/learnings/shared';
import {
  type Trajectory,
  type TrajectoryState,
  parseTrajectoryYaml,
  getNextStep as getTrajectoryNextStep,
  formatTrajectoryForPrompt,
} from '@blockspool/core/trajectory/shared';
import type { SectorState } from '@blockspool/core/sectors/shared';

export const DEFAULT_LEARNINGS_BUDGET = 2000;

/** Load trajectory state from project root — returns null if missing/invalid. */
export function loadTrajectoryData(rootPath: string): { trajectory: Trajectory; state: TrajectoryState } | null {
  try {
    const statePath = path.join(rootPath, '.blockspool', 'trajectory-state.json');
    if (!fs.existsSync(statePath)) return null;
    const trajState: TrajectoryState = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    if (trajState.paused) return null;

    const trajDir = path.join(rootPath, '.blockspool', 'trajectories');
    if (!fs.existsSync(trajDir)) return null;

    const files = fs.readdirSync(trajDir).filter(f => f.endsWith('.yaml') || f.endsWith('.yml'));
    for (const file of files) {
      const content = fs.readFileSync(path.join(trajDir, file), 'utf8');
      const traj = parseTrajectoryYaml(content);
      if (traj.name === trajState.trajectoryName && traj.steps.length > 0) {
        return { trajectory: traj, state: trajState };
      }
    }
  } catch (err) {
    if (err instanceof Error && !('code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT')) {
      console.warn(`[blockspool] Failed to load trajectory data: ${err.message}`);
    }
  }
  return null;
}

/** Load sectors.json from project root — returns null if missing/invalid. */
export function loadSectorsState(rootPath: string): SectorState | null {
  try {
    const filePath = path.join(rootPath, '.blockspool', 'sectors.json');
    if (!fs.existsSync(filePath)) return null;
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (data?.version !== 2 || !Array.isArray(data.sectors)) return null;
    return data as SectorState;
  } catch (err) {
    if (err instanceof Error && !('code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT')) {
      console.warn(`[blockspool] Failed to load sectors.json: ${err.message}`);
    }
    return null;
  }
}

/**
 * Build a learnings block for prompt injection. Tracks injected IDs in state.
 * Uses cached learnings from RunState (loaded at session start) to avoid redundant file I/O.
 */
export function buildLearningsBlock(
  run: RunManager,
  contextPaths: string[],
  contextCommands: string[],
): string {
  const s = run.require();
  if (!s.learnings_enabled) return '';

  // Lazy-load learnings from disk on first use
  run.ensureLearningsLoaded();

  const projectPath = run.rootPath;
  const allLearnings = s.cached_learnings;
  if (allLearnings.length === 0) return '';

  const relevant = selectRelevant(allLearnings, { paths: contextPaths, commands: contextCommands });
  const budget = DEFAULT_LEARNINGS_BUDGET;
  const block = formatLearningsForPrompt(relevant, budget);
  if (!block) return '';

  // Track which learnings were injected
  const injectedIds = relevant
    .filter(l => block.includes(l.text))
    .map(l => l.id);
  s.injected_learning_ids = [...new Set([...s.injected_learning_ids, ...injectedIds])];

  // Record access
  if (injectedIds.length > 0) {
    recordAccess(projectPath, injectedIds);
  }

  return block + '\n\n';
}

/**
 * Build a risk context block for prompts when adaptive trust detects elevated/high risk.
 * Returns empty string for low/normal risk.
 */
export function buildRiskContextBlock(riskAssessment: AdaptiveRiskAssessment | undefined): string {
  if (!riskAssessment) return '';
  if (riskAssessment.level === 'low' || riskAssessment.level === 'normal') return '';

  const lines = [
    '<risk-context>',
    `## Adaptive Risk: ${riskAssessment.level.toUpperCase()} (score: ${riskAssessment.score})`,
    '',
  ];

  if (riskAssessment.fragile_paths.length > 0) {
    lines.push('### Known Fragile Paths');
    for (const fp of riskAssessment.fragile_paths.slice(0, 5)) {
      lines.push(`- \`${fp}\``);
    }
    lines.push('');
  }

  if (riskAssessment.known_issues.length > 0) {
    lines.push('### Known Issues in These Files');
    for (const issue of riskAssessment.known_issues) {
      lines.push(`- ${issue}`);
    }
    lines.push('');
  }

  lines.push('**Be extra careful** — these files have a history of failures. Consider smaller changes and more thorough testing.');
  lines.push('</risk-context>');
  return lines.join('\n') + '\n\n';
}

export function getScoutAutoApprove(): string[] {
  return getRegistry().getAutoApprovePatterns({ phase: 'SCOUT', category: null });
}

export function getExecuteAutoApprove(category: string | null): string[] {
  return getRegistry().getAutoApprovePatterns({ phase: 'EXECUTE', category });
}

export function getQaAutoApprove(): string[] {
  return getRegistry().getAutoApprovePatterns({ phase: 'QA', category: null });
}

export function getPrAutoApprove(): string[] {
  return getRegistry().getAutoApprovePatterns({ phase: 'PR', category: null });
}
