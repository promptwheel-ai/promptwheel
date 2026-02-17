/**
 * Goals — measurable targets that drive wheel formula selection.
 *
 * A goal is a formula with a `measure` field. The system measures current
 * state, picks the goal with the biggest gap from target, and works toward it.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  type Formula,
  parseSimpleYaml,
  parseStringList,
} from '@promptwheel/core/formulas/shared';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GoalMeasurement {
  goalName: string;
  current: number | null;  // null = measurement failed
  target: number;
  direction: 'up' | 'down';
  gapPercent: number;       // 0-100, how far from target (0 = met)
  met: boolean;
  error?: string;
  measuredAt: number;       // timestamp
}

export interface GoalState {
  measurements: Record<string, GoalMeasurementEntry[]>;  // ring buffer per goal
  lastUpdated: number;
}

interface GoalMeasurementEntry {
  value: number | null;
  timestamp: number;
  error?: string;
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/**
 * Load goal files from `.promptwheel/goals/*.yaml`, return formulas with measure fields.
 */
export function loadGoals(repoRoot: string): Formula[] {
  const goalsDir = path.join(repoRoot, '.promptwheel', 'goals');
  if (!fs.existsSync(goalsDir)) return [];

  const files = fs.readdirSync(goalsDir).filter(f => f.endsWith('.yaml') || f.endsWith('.yml'));
  const goals: Formula[] = [];

  for (const file of files) {
    try {
      const filePath = path.join(goalsDir, file);
      const content = fs.readFileSync(filePath, 'utf-8');
      const parsed = parseSimpleYaml(content);

      const name = parsed.name || path.basename(file, path.extname(file));
      const measureCmd = parsed.measure_cmd;
      const measureTarget = parsed.measure_target ? parseFloat(parsed.measure_target) : undefined;
      const measureDirection = parsed.measure_direction as 'up' | 'down' | undefined;

      if (!measureCmd || measureTarget === undefined || !measureDirection) {
        continue; // skip goals missing required measure fields
      }

      const formula: Formula = {
        name,
        description: parsed.description || `Goal: ${name}`,
        categories: parsed.categories ? parseStringList(parsed.categories) : undefined,
        prompt: parsed.prompt,
        minConfidence: parsed.min_confidence ? parseInt(parsed.min_confidence, 10) : undefined,
        min_confidence: parsed.min_confidence ? parseInt(parsed.min_confidence, 10) : undefined,
        measure: {
          cmd: measureCmd,
          target: measureTarget,
          direction: measureDirection,
        },
      };

      goals.push(formula);
    } catch {
      // Skip malformed goal files
    }
  }

  return goals;
}

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

/**
 * Run a measurement command and parse the last number from its output.
 * Returns null if the command fails or produces no parseable number.
 */
export function runMeasurement(cmd: string, repoRoot: string): { value: number | null; error?: string } {
  try {
    const output = execFileSync('sh', ['-c', cmd], {
      cwd: repoRoot,
      timeout: 30_000,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Find the last number in the output
    const matches = output.match(/-?\d+\.?\d*/g);
    if (!matches || matches.length === 0) {
      return { value: null, error: 'No numeric output' };
    }

    const value = parseFloat(matches[matches.length - 1]);
    if (isNaN(value)) {
      return { value: null, error: 'Could not parse number' };
    }

    return { value };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Truncate long error messages
    const shortMsg = message.length > 100 ? message.slice(0, 100) + '...' : message;
    return { value: null, error: shortMsg };
  }
}

/**
 * Measure all goals, compute gaps.
 */
export function measureGoals(goals: Formula[], repoRoot: string): GoalMeasurement[] {
  const measurements: GoalMeasurement[] = [];

  for (const goal of goals) {
    if (!goal.measure) continue;

    const { value, error } = runMeasurement(goal.measure.cmd, repoRoot);
    const { target, direction } = goal.measure;

    let gapPercent = 100;
    let met = false;

    if (value !== null) {
      if (direction === 'up') {
        // Higher is better: gap = how far below target
        if (value >= target) {
          gapPercent = 0;
          met = true;
        } else if (target !== 0) {
          gapPercent = ((target - value) / target) * 100;
        }
      } else {
        // Lower is better: gap = how far above target
        if (value <= target) {
          gapPercent = 0;
          met = true;
        } else {
          // For "down" direction, express gap relative to current value
          gapPercent = target === 0
            ? (value > 0 ? 100 : 0)
            : ((value - target) / value) * 100;
        }
      }
    }

    measurements.push({
      goalName: goal.name,
      current: value,
      target,
      direction,
      gapPercent: Math.round(gapPercent * 10) / 10,
      met,
      error,
      measuredAt: Date.now(),
    });
  }

  return measurements;
}

/**
 * Pick the goal with the biggest gap from target.
 * Skips met goals and errored goals.
 */
export function pickGoalByGap(measurements: GoalMeasurement[]): GoalMeasurement | null {
  const candidates = measurements
    .filter(m => !m.met && m.current !== null)
    .sort((a, b) => b.gapPercent - a.gapPercent);

  return candidates[0] ?? null;
}

// ---------------------------------------------------------------------------
// Prompt formatting
// ---------------------------------------------------------------------------

/**
 * Format goal context for injection into the scout prompt.
 */
export function formatGoalContext(goal: Formula, measurement: GoalMeasurement): string {
  const arrow = measurement.direction === 'up' ? '↑' : '↓';
  const unit = measurement.direction === 'up' ? 'higher is better' : 'lower is better';
  return [
    `<goal>`,
    `Active goal: ${goal.name}`,
    `${goal.description}`,
    `Current: ${measurement.current} | Target: ${measurement.target} (${arrow} ${unit})`,
    `Gap: ${measurement.gapPercent}%`,
    `</goal>`,
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// State persistence
// ---------------------------------------------------------------------------

function goalStatePath(repoRoot: string): string {
  return path.join(repoRoot, '.promptwheel', 'goal-state.json');
}

export function readGoalState(repoRoot: string): GoalState {
  const p = goalStatePath(repoRoot);
  try {
    if (fs.existsSync(p)) {
      return JSON.parse(fs.readFileSync(p, 'utf-8'));
    }
  } catch {
    // Corrupted file — start fresh
  }
  return { measurements: {}, lastUpdated: 0 };
}

export function writeGoalState(repoRoot: string, state: GoalState): void {
  const p = goalStatePath(repoRoot);
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  state.lastUpdated = Date.now();
  fs.writeFileSync(p, JSON.stringify(state, null, 2));
}

const MAX_MEASUREMENTS_PER_GOAL = 50;

/**
 * Append a measurement to the ring buffer for a goal.
 */
export function recordGoalMeasurement(repoRoot: string, measurement: GoalMeasurement): void {
  const state = readGoalState(repoRoot);
  if (!state.measurements[measurement.goalName]) {
    state.measurements[measurement.goalName] = [];
  }

  const entries = state.measurements[measurement.goalName];
  entries.push({
    value: measurement.current,
    timestamp: measurement.measuredAt,
    error: measurement.error,
  });

  // Ring buffer: keep only the last N entries
  if (entries.length > MAX_MEASUREMENTS_PER_GOAL) {
    state.measurements[measurement.goalName] = entries.slice(-MAX_MEASUREMENTS_PER_GOAL);
  }

  writeGoalState(repoRoot, state);
}
