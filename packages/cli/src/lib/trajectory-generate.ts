/**
 * Trajectory auto-generation — uses an LLM to decompose a high-level goal
 * into an ordered, multi-step trajectory YAML.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { runClaude, parseClaudeOutput } from '@promptwheel/core/scout';
import { buildCodebaseIndex, formatIndexForPrompt } from './codebase-index.js';
import { detectProjectMetadata, formatMetadataForPrompt } from './project-metadata/index.js';
import {
  serializeTrajectoryToYaml,
  parseTrajectoryYaml,
  type Trajectory,
  type TrajectoryStep,
} from '@promptwheel/core/trajectory/shared';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface GenerateOptions {
  goal: string;
  repoRoot: string;
  model?: string;
  timeoutMs?: number;
}

export interface GenerateResult {
  trajectory: Trajectory;
  yaml: string;
  filePath: string;
}

export async function generateTrajectory(opts: GenerateOptions): Promise<GenerateResult> {
  // 1. Build codebase context
  const excludeDirs = ['node_modules', 'dist', 'build', '.git', '.promptwheel', 'coverage', '__pycache__'];
  const codebaseIndex = buildCodebaseIndex(opts.repoRoot, excludeDirs, true);
  const projectMeta = detectProjectMetadata(opts.repoRoot);

  const indexBlock = formatIndexForPrompt(codebaseIndex, 0);
  const metaBlock = formatMetadataForPrompt(projectMeta);

  // 2. Build prompt
  const prompt = buildGeneratePrompt(opts.goal, indexBlock, metaBlock);

  // 3. Call LLM
  const result = await runClaude({
    prompt,
    cwd: opts.repoRoot,
    timeoutMs: opts.timeoutMs ?? 120_000,
    model: opts.model ?? 'sonnet',
  });

  if (!result.success) {
    throw new Error(`LLM call failed: ${result.error}`);
  }

  // 4. Parse JSON response
  const parsed = parseClaudeOutput<{ name: string; description: string; steps: unknown[] }>(result.output);
  if (!parsed || !parsed.name || !parsed.steps?.length) {
    throw new Error('Failed to parse trajectory from LLM output');
  }

  // 5. Validate and build Trajectory
  const trajectory = validateAndBuild(parsed);

  // 6. Serialize to YAML
  const yaml = serializeTrajectoryToYaml(trajectory);

  // 7. Verify round-trip
  const roundTripped = parseTrajectoryYaml(yaml);
  if (roundTripped.steps.length !== trajectory.steps.length) {
    throw new Error('YAML round-trip validation failed');
  }

  // 8. Write to disk
  const slug = slugify(trajectory.name);
  const dir = path.join(opts.repoRoot, '.promptwheel', 'trajectories');
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${slug}.yaml`);
  fs.writeFileSync(filePath, yaml, 'utf-8');

  return { trajectory, yaml, filePath };
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

function buildGeneratePrompt(goal: string, indexBlock: string, metaBlock: string): string {
  return `You are a principal engineer planning a multi-step implementation trajectory.

Given a high-level goal, decompose it into ordered steps that can each be completed in 1-3 scout cycles by an AI coding agent.

## Goal

${goal}

## Codebase Context

${metaBlock}

${indexBlock}

## Requirements

1. Each step should be:
   - Self-contained and completable independently (after its dependencies)
   - Scoped to specific files/directories (use glob patterns)
   - Have clear acceptance criteria that an AI can verify
   - Have at least one verification command that exits 0 on success

2. Steps should be ordered logically:
   - Infrastructure/setup first
   - Core implementation next
   - Integration and testing last
   - Use depends_on to express ordering constraints

3. Step IDs should be short kebab-case identifiers (e.g., "install-deps", "add-config", "impl-core")

4. Scope globs should be specific enough to guide the scout but not so narrow they miss related files. Use patterns like "src/auth/**" or "packages/core/src/*.ts".

5. Categories should be from: security, fix, perf, refactor, test, types, cleanup, docs

6. Keep it to 3-8 steps. Fewer is better if the goal is simple.

## Output Format

Respond with ONLY a JSON object (no markdown, no explanation):

{
  "name": "kebab-case-trajectory-name",
  "description": "One-line description of the trajectory",
  "steps": [
    {
      "id": "step-id",
      "title": "Short imperative title",
      "description": "What this step accomplishes and how",
      "scope": "glob/pattern/**",
      "categories": ["refactor"],
      "acceptance_criteria": ["Criterion that can be checked"],
      "verification_commands": ["command that exits 0 on success"],
      "depends_on": []
    }
  ]
}`;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

interface RawStep {
  id?: string;
  title?: string;
  description?: string;
  scope?: string;
  categories?: string[];
  acceptance_criteria?: string[];
  verification_commands?: string[];
  depends_on?: string[];
  measure?: { cmd?: string; target?: number; direction?: string };
}

export function validateAndBuild(raw: { name: string; description: string; steps: unknown[] }): Trajectory {
  const steps: TrajectoryStep[] = (raw.steps as RawStep[]).map((s) => ({
    id: String(s.id || '').replace(/[^a-z0-9-]/gi, '-').toLowerCase(),
    title: String(s.title || ''),
    description: String(s.description || ''),
    scope: s.scope ? String(s.scope) : undefined,
    categories: Array.isArray(s.categories) ? s.categories.map(String) : undefined,
    acceptance_criteria: Array.isArray(s.acceptance_criteria) ? s.acceptance_criteria.map(String) : [],
    verification_commands: Array.isArray(s.verification_commands) ? s.verification_commands.map(String) : [],
    depends_on: Array.isArray(s.depends_on) ? s.depends_on.map(String) : [],
    measure: s.measure?.cmd !== undefined && s.measure?.target !== undefined && s.measure?.direction
      ? {
          cmd: String(s.measure.cmd),
          target: Number(s.measure.target),
          direction: s.measure.direction === 'down' ? 'down' as const : 'up' as const,
        }
      : undefined,
  }));

  // Validate: no duplicate IDs
  const ids = new Set<string>();
  for (const step of steps) {
    if (!step.id) throw new Error('Step missing ID');
    if (ids.has(step.id)) throw new Error(`Duplicate step ID: ${step.id}`);
    ids.add(step.id);
  }

  // Validate: depends_on references exist
  for (const step of steps) {
    for (const dep of step.depends_on) {
      if (!ids.has(dep)) throw new Error(`Step "${step.id}" depends on unknown step "${dep}"`);
    }
  }

  return {
    name: String(raw.name || ''),
    description: String(raw.description || ''),
    steps,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}
