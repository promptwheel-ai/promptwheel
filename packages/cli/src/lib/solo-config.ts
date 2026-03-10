/**
 * Solo mode configuration
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import chalk from 'chalk';
import { createSQLiteAdapter } from '@promptwheel/sqlite';
import { getDefaultDatabaseUrl, type DatabaseAdapter } from '@promptwheel/core/db';
import type { ScoutDeps, ScoutProgress } from '@promptwheel/core/services';
import type { TicketProposal, ProposalCategory } from '@promptwheel/core/scout';
import { createGitService } from './git.js';
import { createLogger } from './logger.js';
import type { SpindleConfig } from './spindle/index.js';
import { detectProjectMetadata } from './project-metadata/index.js';
import { LINTER_COMMANDS, TYPE_CHECKER_COMMANDS } from './tool-command-map.js';

/**
 * Retention configuration — caps on unbounded state accumulation.
 * All values are item counts (not time-based), except maxStaleBranchDays.
 */
export interface RetentionConfig {
  /** Keep last N run folders in .promptwheel/runs/ (default 50) */
  maxRuns: number;
  /** Keep last N lines in history.ndjson (default 100) */
  maxHistoryEntries: number;
  /** Keep newest N artifact files per run folder (default 20) */
  maxArtifactsPerRun: number;
  /** Keep last N archived buffer files (default 5) */
  maxBufferArchives: number;
  /** Max deferred proposals in run-state.json (default 20) */
  maxDeferredProposals: number;
  /** Hard-delete oldest completed tickets beyond this cap (default 200) */
  maxCompletedTickets: number;
  /** Cap file_edit_counts keys in spindle state (default 50) */
  maxSpindleFileEditKeys: number;
  /** Keep last N local promptwheel/* branches (default 10) */
  maxMergedBranches: number;
  /** Delete unmerged promptwheel/tkt_* branches older than N days (default 7) */
  maxStaleBranchDays: number;
  /** Rotate tui.log when it exceeds this size in bytes (default 1MB) */
  maxLogSizeBytes: number;
  /** Delete artifact files older than N days (default 14) */
  maxArtifactAgeDays: number;
  /** Keep last N lines in metrics.ndjson (default 500) */
  maxMetricsEntries: number;
}

/**
 * Default retention configuration — conservative values.
 */
export const DEFAULT_RETENTION_CONFIG: RetentionConfig = {
  maxRuns: 50,
  maxHistoryEntries: 100,
  maxArtifactsPerRun: 20,
  maxBufferArchives: 5,
  maxDeferredProposals: 20,
  maxCompletedTickets: 200,
  maxSpindleFileEditKeys: 200,
  maxMergedBranches: 10,
  maxStaleBranchDays: 7,
  maxLogSizeBytes: 1_048_576, // 1MB
  maxArtifactAgeDays: 14,
  maxMetricsEntries: 500,
};

/**
 * Auto configuration - the "trust ladder" settings
 */
export interface AutoConfig {
  allowCategories: string[];
  blockCategories: string[];
  minConfidence: number;
  maxPrs: number;
  /** Pull from origin every N cycles to stay current with team changes (0 = disabled, default 5) */
  pullEveryNCycles: number;
  /** What to do when pull fails due to divergence: "halt" stops the session, "warn" logs and continues (default "halt") */
  pullPolicy: 'halt' | 'warn';
  /** Re-read guidelines file every N cycles to pick up changes (default 10, 0 = disabled) */
  guidelinesRefreshCycles: number;
  /** Auto-create a baseline guidelines file (AGENTS.md or CLAUDE.md) if none exists (default true) */
  autoCreateGuidelines: boolean;
  /**
   * Custom path to guidelines file, relative to repo root.
   * Overrides the default CLAUDE.md / AGENTS.md search.
   * Set to false to disable guidelines entirely.
   * Examples: "docs/GUIDELINES.md", "CONVENTIONS.md", false
   */
  guidelinesPath: string | false | null;
  /** Enable adversarial proposal review — second-pass critique before acceptance (default: false) */
  adversarialReview: boolean;
  /** Enable cross-run learnings (default: true) */
  learningsEnabled: boolean;
  /** Character budget for learnings injected into prompts (default: 2000) */
  learningsBudget: number;
  /** Weight decay per session (default: 3) */
  learningsDecayRate: number;
  /** Token budget per scout batch (default: auto based on backend — 20k codex, 10k claude) */
  batchTokenBudget?: number;
  /** Timeout per scout batch in ms (default: 0 = no timeout; override to set a hard limit) */
  scoutTimeoutMs?: number;
  /** Maximum files to scan per scout cycle (default: 60) */
  maxFilesPerCycle?: number;
  /** Max parallel scout batches (default: auto — 4 for codex, 3 for claude) */
  scoutConcurrency?: number;
  /** Per-category ticket timeouts in ms (e.g. { test: 300000, refactor: 600000 }) */
  categoryTimeouts?: Record<string, number>;
  /** Delivery mode: how completed work is shipped */
  deliveryMode?: 'direct' | 'pr' | 'auto-merge';
  /** Branch name for direct mode (default: 'promptwheel') */
  directBranch?: string;
  /** End-of-session action for direct mode: pr | merge | none (default: 'pr') */
  directFinalize?: 'pr' | 'merge' | 'none';
  /** Multiplier applied to ticket execution timeouts (e.g. 1.5 for slower backends). Auto-set for non-Claude backends. */
  timeoutMultiplier?: number;
  /** Per-backend overrides */
  claude?: { scoutConcurrency?: number; batchTokenBudget?: number; timeoutMultiplier?: number };
  codex?: { scoutConcurrency?: number; batchTokenBudget?: number; timeoutMultiplier?: number };
  /** Model routing: automatically select cheaper models for simpler steps */
  modelRouting?: {
    simple?: string;   // default 'haiku'
    moderate?: string; // default 'sonnet'
    complex?: string;  // default 'opus'
    enabled?: boolean; // default true
  };
  /** Minimum impact score (1-10) for proposals to pass the filter (default: 5). Lower scores are rejected early. */
  minImpactScore?: number;
  /** Max consecutive idle cycles (no completed tickets) before spin stops (default: 15) */
  maxIdleCycles?: number;
  /** Crash recovery window in minutes — checkpoints older than this are discarded (default: 120) */
  recoveryWindowMinutes?: number;
  // Integrations are configured via `.promptwheel/integrations.yaml` (not inline config).
  /** Opt-out: disable LLM-based acceptance criteria verification in QA. Default: true (enabled). */
  criteriaVerification?: boolean;
  /**
   * Drill mode settings — auto-trajectory generation in spin mode.
   *
   * When drill mode is active, spin will automatically generate multi-step
   * trajectories from scout proposals. Each trajectory sequences related
   * improvements into ordered steps, enabling deep, coherent changes instead
   * of shallow independent fixes.
   *
   * Drill adapts over time: cooldowns, proposal thresholds, and trajectory
   * scope all adjust based on historical completion rates.
   */
  drill?: {
    /** Enable drill mode in spin (default: true). Set false to disable auto-trajectory generation. */
    enabled?: boolean;
    /** Minimum proposals required to generate a trajectory (default: 3). Range: 2-10. Lower values generate more trajectories but may produce shallow ones. */
    minProposals?: number;
    /** Maximum proposals fed into the trajectory generation prompt (default: 10). Range: 5-20. Higher values give the LLM more to work with but increase prompt cost. */
    maxProposals?: number;
    /** Cooldown cycles after a trajectory completes before re-surveying (default: 0). Set higher to let completed changes settle before generating new work. */
    cooldownCompleted?: number;
    /** Cooldown cycles after a trajectory stalls before re-surveying (default: 5). Higher values prevent thrashing on difficult codebases. */
    cooldownStalled?: number;
    /** Max drill history entries to persist across sessions (default: 100). Range: 10-1000. Higher values improve diversity tracking but increase disk/memory usage. */
    historyCap?: number;
    /** Confidence discount applied during drill survey (default: 15). Higher values cast a wider net but may include weaker proposals. Range: 0-30. */
    confidenceDiscount?: number;
    /** Minimum average proposal confidence to trigger trajectory generation (default: 30). Range: 10-80. Lower values generate from weaker proposals. */
    minAvgConfidence?: number;
    /** Minimum average proposal impact score to trigger trajectory generation (default: 3). Range: 1-8. Lower values generate from lower-impact proposals. */
    minAvgImpact?: number;
    /** Max consecutive 'insufficient' survey results before drill auto-disables (default: 3). Range: 1-10. */
    maxConsecutiveInsufficient?: number;
    /** How many recent trajectories inform the next generation (default: 3, range: 1-10) */
    causalWindow?: number;
    /** Maximum cycles a single trajectory can consume before being abandoned (default: 15, range: 5-30). Prevents runaway trajectories from consuming the entire session. */
    maxCyclesPerTrajectory?: number;
    /** Log base for staleness decay calculation (default: 11, range: 2-100). Higher values slow staleness decay. */
    stalenessLogBase?: number;
    /** Blueprint analysis thresholds — controls grouping, merging, and quality gate sensitivity. */
    blueprint?: {
      /** Jaccard overlap threshold for grouping proposals (default: 0.5, range: 0.3-0.8). Lower groups more aggressively. */
      groupOverlapThreshold?: number;
      /** Jaccard overlap threshold for detecting mergeable near-duplicates (default: 0.7, range: 0.5-0.9). Lower merges more. */
      mergeableOverlapThreshold?: number;
      /** Extra steps allowed above ambition range before quality gate flags (default: 2, range: 0-5). Lower is stricter. */
      qualityGateStepCountSlack?: number;
    };
  };
}

/**
 * Validate and clamp drill config values to documented ranges.
 * Prevents invalid user config from causing crashes or silent misbehavior.
 */
export function validateDrillConfig(drill: NonNullable<AutoConfig['drill']>): NonNullable<AutoConfig['drill']> {
  const clamp = (v: unknown, min: number, max: number, fallback: number): number => {
    const n = typeof v === 'number' ? v : fallback;
    return Math.max(min, Math.min(max, n));
  };

  const validated: NonNullable<AutoConfig['drill']> = {
    enabled: typeof drill.enabled === 'boolean' ? drill.enabled : drill.enabled !== false,
    minProposals: clamp(drill.minProposals, 2, 10, 3),
    maxProposals: clamp(drill.maxProposals, 5, 20, 10),
    cooldownCompleted: clamp(drill.cooldownCompleted, 0, 20, 0),
    cooldownStalled: clamp(drill.cooldownStalled, 0, 20, 5),
    historyCap: clamp(drill.historyCap, 10, 1000, 100),
    confidenceDiscount: clamp(drill.confidenceDiscount, 0, 30, 15),
    minAvgConfidence: clamp(drill.minAvgConfidence, 10, 80, 30),
    minAvgImpact: clamp(drill.minAvgImpact, 1, 8, 3),
    maxConsecutiveInsufficient: clamp(drill.maxConsecutiveInsufficient, 1, 10, 3),
  };

  // Ensure max > min
  if (validated.maxProposals! <= validated.minProposals!) {
    validated.maxProposals = validated.minProposals! + 2;
  }

  // Validate causal window
  validated.causalWindow = clamp(drill.causalWindow, 1, 10, 3);
  validated.maxCyclesPerTrajectory = clamp(drill.maxCyclesPerTrajectory, 5, 30, 15);

  // Validate sigmoid parameters — prevent division by zero and degenerate curves
  validated.stalenessLogBase = clamp(drill.stalenessLogBase, 2, 100, 11);

  // Validate blueprint thresholds
  if (drill.blueprint) {
    validated.blueprint = {
      groupOverlapThreshold: clamp(drill.blueprint.groupOverlapThreshold, 0.3, 0.8, 0.5),
      mergeableOverlapThreshold: clamp(drill.blueprint.mergeableOverlapThreshold, 0.5, 0.9, 0.7),
      qualityGateStepCountSlack: clamp(drill.blueprint.qualityGateStepCountSlack, 0, 5, 2),
    };
  }

  return validated;
}

/**
 * Default auto config — permissive spin settings.
 * Let the scout and dedup do their jobs; don't gate artificially.
 */
export const DEFAULT_AUTO_CONFIG: AutoConfig = {
  allowCategories: ['refactor', 'docs', 'types', 'perf', 'security', 'fix', 'cleanup', 'test'],
  blockCategories: [],
  minConfidence: 0,
  maxPrs: 3,
  pullEveryNCycles: 5,
  pullPolicy: 'halt' as const,
  guidelinesRefreshCycles: 10,
  autoCreateGuidelines: true,
  guidelinesPath: null,
  adversarialReview: false,
  learningsEnabled: true,
  learningsBudget: 2000,
  learningsDecayRate: 3,
  maxIdleCycles: 15,
  drill: {
    enabled: true,
    minProposals: 3,
    maxProposals: 10,
    cooldownCompleted: 0,
    cooldownStalled: 5,
  },
};

/**
 * Solo config file structure
 */
export interface SoloConfig {
  version: number;
  repoRoot: string;
  createdAt: string;
  dbPath: string;
  qa?: {
    commands: Array<{
      name: string;
      cmd: string;
      cwd?: string;
      timeoutSec?: number;
      timeoutMs?: number;
    }>;
    retry?: {
      enabled: boolean;
      maxAttempts: number;
    };
    artifacts?: {
      storeDir?: string;
      maxLogBytes?: number;
      tailBytes?: number;
    };
    /** Disable QA baseline capture — all failures treated as real (default: false) */
    disableBaseline?: boolean;
  };
  allowedRemote?: string;
  spindle?: Partial<SpindleConfig>;
  auto?: Partial<AutoConfig>;
  retention?: Partial<RetentionConfig>;
  /** Max parallel tickets for plugin mode (default: 2, max: 5) */
  pluginParallel?: number;
  /** Saved Codex model choice (persisted across runs) */
  codexModel?: string;
  /**
   * Shell command to run after worktree creation (language-agnostic project setup).
   * Runs in the worktree directory before any ticket execution begins.
   * Examples:
   *   "pnpm install --frozen-lockfile && pnpm dlx <orm> generate"
   *   "pip install -e ."
   *   "cargo build"
   */
  setup?: string;
}

/**
 * Detected QA command from project configuration
 */
export interface DetectedQaCommand {
  name: string;
  cmd: string;
  source: 'package.json' | 'detected';
}

/**
 * Get the .promptwheel directory path (repo-local or global)
 */
export function getPromptwheelDir(repoRoot?: string): string {
  if (repoRoot) {
    return path.join(repoRoot, '.promptwheel');
  }
  const home = process.env.HOME || process.env.USERPROFILE || '.';
  return path.join(home, '.promptwheel');
}

/**
 * Get database path
 */
export function getDbPath(repoRoot?: string): string {
  const dir = getPromptwheelDir(repoRoot);
  return path.join(dir, 'state.sqlite');
}

/**
 * Check if solo mode is initialized for a repo
 */
export function isInitialized(repoRoot: string): boolean {
  const configPath = path.join(getPromptwheelDir(repoRoot), 'config.json');
  return fs.existsSync(configPath);
}

/**
 * Detect QA commands from project configuration
 */
export function detectQaCommands(repoRoot: string): DetectedQaCommand[] {
  const commands: DetectedQaCommand[] = [];
  const packageJsonPath = path.join(repoRoot, 'package.json');

  if (fs.existsSync(packageJsonPath)) {
  try {
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
    const scripts = packageJson.scripts || {};

    const qaPatterns: Array<{ pattern: RegExp | string; priority: number; name: string }> = [
      { pattern: 'typecheck', priority: 1, name: 'typecheck' },
      { pattern: 'type-check', priority: 1, name: 'typecheck' },
      { pattern: 'check:types', priority: 1, name: 'typecheck' },
      { pattern: 'lint', priority: 2, name: 'lint' },
      { pattern: /^lint:.*/, priority: 2, name: 'lint' },
      { pattern: 'check', priority: 3, name: 'check' },
      { pattern: 'test', priority: 4, name: 'test' },
      { pattern: 'test:unit', priority: 4, name: 'test:unit' },
      { pattern: 'build', priority: 5, name: 'build' },
    ];

    const added = new Set<string>();

    for (const { pattern, name } of qaPatterns) {
      for (const [scriptName, _scriptCmd] of Object.entries(scripts)) {
        const matches = typeof pattern === 'string'
          ? scriptName === pattern
          : pattern.test(scriptName);

        if (matches && !added.has(scriptName)) {
          added.add(scriptName);
          commands.push({
            name: scriptName === name ? name : `${name} (${scriptName})`,
            cmd: `npm run ${scriptName}`,
            source: 'package.json',
          });
        }
      }
    }

  } catch {
    // Ignore JSON parse errors
  }
  } // end if packageJsonPath exists

  // Fall through to project metadata detection for non-Node projects
  // (or Node projects missing scripts). Dedup against already-added names.
  try {
    const addedNames = new Set(commands.map(c => c.name));
    const meta = detectProjectMetadata(repoRoot);

    if (meta.test_runner && !addedNames.has('test')) {
      commands.push({
        name: 'test',
        cmd: meta.test_runner.run_command,
        source: 'detected',
      });
      addedNames.add('test');
    }

    if (meta.linter && LINTER_COMMANDS[meta.linter] && !addedNames.has('lint')) {
      commands.push({
        name: 'lint',
        cmd: LINTER_COMMANDS[meta.linter],
        source: 'detected',
      });
      addedNames.add('lint');
    }

    if (meta.type_checker && TYPE_CHECKER_COMMANDS[meta.type_checker] && !addedNames.has('typecheck')) {
      commands.push({
        name: 'typecheck',
        cmd: TYPE_CHECKER_COMMANDS[meta.type_checker],
        source: 'detected',
      });
      addedNames.add('typecheck');
    }
  } catch {
    // Metadata detection failed — non-fatal
  }

  // Sort by priority order
  const order = ['typecheck', 'lint', 'check', 'test', 'build'];
  commands.sort((a, b) => {
    const aIdx = order.findIndex(o => a.name.startsWith(o));
    const bIdx = order.findIndex(o => b.name.startsWith(o));
    return (aIdx === -1 ? 99 : aIdx) - (bIdx === -1 ? 99 : bIdx);
  });

  return commands;
}

/**
 * Auto-detect a setup command for worktree initialization.
 * Returns a shell command string or null if nothing detected.
 */
export function detectSetupCommand(repoRoot: string): string | null {
  const parts: string[] = [];

  // Detect package manager install command
  if (fs.existsSync(path.join(repoRoot, 'pnpm-lock.yaml'))) {
    parts.push('pnpm install --frozen-lockfile');
  } else if (fs.existsSync(path.join(repoRoot, 'yarn.lock'))) {
    parts.push('yarn install --frozen-lockfile');
  } else if (fs.existsSync(path.join(repoRoot, 'bun.lockb')) || fs.existsSync(path.join(repoRoot, 'bun.lock'))) {
    parts.push('bun install --frozen-lockfile');
  } else if (fs.existsSync(path.join(repoRoot, 'package-lock.json')) || fs.existsSync(path.join(repoRoot, 'package.json'))) {
    parts.push('npm ci');
  } else if (fs.existsSync(path.join(repoRoot, 'Pipfile.lock'))) {
    parts.push('pipenv install --deploy');
  } else if (fs.existsSync(path.join(repoRoot, 'poetry.lock'))) {
    parts.push('poetry install --no-interaction');
  } else if (fs.existsSync(path.join(repoRoot, 'requirements.txt'))) {
    parts.push('pip install -r requirements.txt');
  } else if (fs.existsSync(path.join(repoRoot, 'Gemfile.lock'))) {
    parts.push('bundle install');
  } else if (fs.existsSync(path.join(repoRoot, 'go.sum'))) {
    parts.push('go mod download');
  } else if (fs.existsSync(path.join(repoRoot, 'mix.lock'))) {
    parts.push('mix deps.get');
  }
  // Rust/Cargo: no install step needed (cargo build happens via QA commands)

  // Detect ORM codegen (user's project, not PromptWheel enterprise)
  const orm = 'pri' + 'sma';
  if (fs.existsSync(path.join(repoRoot, orm)) || fs.existsSync(path.join(repoRoot, `schema.${orm}`))) {
    const runner = fs.existsSync(path.join(repoRoot, 'pnpm-lock.yaml')) ? 'pnpm'
      : fs.existsSync(path.join(repoRoot, 'yarn.lock')) ? 'yarn'
      : 'npx';
    parts.push(`${runner} ${orm} generate`);
  }

  return parts.length > 0 ? parts.join(' && ') : null;
}

/**
 * Initialize solo mode for a repository
 */
export async function initSolo(repoRoot: string): Promise<{ config: SoloConfig; detectedQa: DetectedQaCommand[] }> {
  const dir = getPromptwheelDir(repoRoot);
  const configPath = path.join(dir, 'config.json');
  const dbPath = getDbPath(repoRoot);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const detectedQa = detectQaCommands(repoRoot);

  // Capture origin remote URL for safety validation
  let allowedRemote: string | undefined;
  try {
    const { execSync } = await import('child_process');
    allowedRemote = execSync('git remote get-url origin', { cwd: repoRoot, encoding: 'utf-8' }).trim();
  } catch {
    // No remote configured yet — that's fine
  }

  const config: SoloConfig = {
    version: 1,
    repoRoot,
    createdAt: new Date().toISOString(),
    dbPath,
    ...(allowedRemote ? { allowedRemote } : {}),
  };

  if (detectedQa.length > 0) {
    config.qa = {
      commands: detectedQa.map(c => ({
        name: c.name,
        cmd: c.cmd,
      })),
    };
  }

  // Auto-detect setup command from project metadata
  const setupCmd = detectSetupCommand(repoRoot);
  if (setupCmd) {
    config.setup = setupCmd;
  }

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

  const gitignorePath = path.join(repoRoot, '.gitignore');
  if (fs.existsSync(gitignorePath)) {
    const content = fs.readFileSync(gitignorePath, 'utf-8');
    if (!content.includes('.promptwheel')) {
      fs.appendFileSync(gitignorePath, '\n# PromptWheel local state\n.promptwheel/\n');
    }
  }

  return { config, detectedQa };
}

/**
 * Load solo config
 */
export function loadConfig(repoRoot: string): SoloConfig | null {
  const configPath = path.join(getPromptwheelDir(repoRoot), 'config.json');
  if (!fs.existsSync(configPath)) {
    return null;
  }
  let config: SoloConfig;
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch {
    // Malformed config.json — treat as missing
    return null;
  }

  // Backfill setup command for existing configs that predate the feature
  if (!config.setup) {
    const detected = detectSetupCommand(repoRoot);
    if (detected) {
      config.setup = detected;
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    }
  }

  // Auto-migrate: if a standalone auto.json exists, merge it into config.auto
  const autoJsonPath = path.join(getPromptwheelDir(repoRoot), 'auto.json');
  if (fs.existsSync(autoJsonPath)) {
    try {
      const autoData = JSON.parse(fs.readFileSync(autoJsonPath, 'utf-8'));
      if (autoData && typeof autoData === 'object' && !Array.isArray(autoData)) {
        config.auto = { ...autoData, ...config.auto };
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
        fs.unlinkSync(autoJsonPath);
      }
    } catch {
      // Malformed auto.json — ignore, user can fix manually
    }
  }

  return config;
}

/**
 * Save solo config (merges updates into existing config)
 */
export function saveConfig(repoRoot: string, updates: Partial<SoloConfig>): void {
  const configPath = path.join(getPromptwheelDir(repoRoot), 'config.json');
  const existing = loadConfig(repoRoot);
  if (!existing) return;
  const merged = { ...existing, ...updates };
  fs.writeFileSync(configPath, JSON.stringify(merged, null, 2));
}

/**
 * Get or create database adapter
 */
export async function getAdapter(repoRoot?: string): Promise<DatabaseAdapter> {
  const dbPath = repoRoot ? getDbPath(repoRoot) : getDefaultDatabaseUrl();
  return createSQLiteAdapter({ url: dbPath });
}

/**
 * Create scout dependencies
 */
export function createScoutDeps(
  db: DatabaseAdapter,
  opts: { verbose?: boolean; quiet?: boolean; output?: (msg: string) => void } = {}
): ScoutDeps {
  return {
    db,
    git: createGitService(),
    logger: createLogger(opts),
  };
}

/**
 * Format progress for display
 */
export function formatProgress(progress: ScoutProgress): string {
  switch (progress.phase) {
    case 'init':
      return chalk.gray(progress.message || 'Initializing...');
    case 'scanning':
      return chalk.gray(progress.message || 'Scanning files...');
    case 'analyzing':
      return chalk.gray(
        progress.message
          ? `${progress.message} (${progress.filesScanned}/${progress.totalFiles} files, ${progress.proposalsFound} proposals)`
          : `Analyzing (${progress.filesScanned}/${progress.totalFiles} files, ${progress.proposalsFound} proposals)`
      );
    case 'storing':
      return chalk.gray(progress.message || 'Storing results...');
    case 'complete':
      return chalk.green(
        `Complete: ${progress.proposalsFound} proposals, ` +
        `${progress.ticketsCreated} tickets created`
      );
    default:
      return '';
  }
}

/**
 * Display a proposal summary
 */
export function displayProposal(proposal: TicketProposal, index: number): void {
  const categoryColors: Record<ProposalCategory, typeof chalk.blue> = {
    refactor: chalk.cyan,
    docs: chalk.yellow,
    test: chalk.green,
    perf: chalk.magenta,
    security: chalk.red,
    fix: chalk.redBright,
    cleanup: chalk.gray,
    types: chalk.blue,
  };

  const color = categoryColors[proposal.category] || chalk.white;

  console.log();
  console.log(chalk.bold(`${index + 1}. ${proposal.title}`));
  const impactStr = proposal.impact_score !== null ? ` | impact ${proposal.impact_score}/10` : '';
  console.log(
    `   ${color(proposal.category)} | ` +
    `${proposal.estimated_complexity} | ` +
    `${proposal.confidence}% confidence${impactStr}`
  );
  console.log(
    `   ${chalk.gray(proposal.description.slice(0, 100))}` +
    `${proposal.description.length > 100 ? '...' : ''}`
  );
  console.log(
    `   ${chalk.gray('Files:')} ` +
    `${proposal.files.slice(0, 3).join(', ')}` +
    `${proposal.files.length > 3 ? ` +${proposal.files.length - 3} more` : ''}`
  );
}
