/**
 * Per-command QA statistics tracking.
 *
 * Persists to `.blockspool/qa-stats.json` and provides:
 * - Per-command success/failure/timeout tracking
 * - Baseline result ring buffer for chronic failure detection
 * - Auto-tuning of QA config based on accumulated stats
 * - Confidence calibration from quality signals
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { readRunState } from './run-state.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface QaCommandStats {
  name: string;
  totalRuns: number;
  successes: number;
  failures: number;
  timeouts: number;
  preExistingSkips: number;
  totalDurationMs: number;
  avgDurationMs: number;
  lastRunAt: number;
  consecutiveFailures: number;
  consecutiveTimeouts: number;
  /** Ring buffer of recent baseline results (max 10) */
  recentBaselineResults: boolean[];
}

export interface DisabledCommand {
  name: string;
  reason: string;
  disabledAt: number;
}

export interface QaStatsStore {
  commands: Record<string, QaCommandStats>;
  lastUpdated: number;
  /** Commands disabled by auto-tune, persisted across restarts */
  disabledCommands: DisabledCommand[];
  /** Quality rate when calibrateConfidence last adjusted (hysteresis) */
  lastCalibratedQualityRate: number | null;
}

/** Normalized QA config shape (matches normalizeQaConfig output) */
interface QaConfig {
  commands: Array<{
    name: string;
    cmd: string;
    cwd?: string;
    timeoutMs?: number;
  }>;
  artifacts: { dir: string; maxLogBytes: number; tailBytes: number };
  retry: { enabled: boolean; maxAttempts: number };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const QA_STATS_FILE = 'qa-stats.json';
const MAX_BASELINE_RING = 10;
const CHRONIC_FAILURE_THRESHOLD = 5;

// ---------------------------------------------------------------------------
// Async mutex (same pattern as run-state.ts)
// ---------------------------------------------------------------------------

let _writeLock: Promise<void> = Promise.resolve();

function withWriteLock<T>(fn: () => T): Promise<T> {
  const prev = _writeLock;
  let release!: () => void;
  _writeLock = new Promise<void>((r) => { release = r; });
  return prev.then(fn).finally(() => release());
}

// ---------------------------------------------------------------------------
// File I/O
// ---------------------------------------------------------------------------

function statsPath(projectRoot: string): string {
  return path.join(projectRoot, '.blockspool', QA_STATS_FILE);
}

export function loadQaStats(projectRoot: string): QaStatsStore {
  const fp = statsPath(projectRoot);
  if (!fs.existsSync(fp)) {
    return { commands: {}, lastUpdated: 0, disabledCommands: [], lastCalibratedQualityRate: null };
  }
  try {
    const raw = fs.readFileSync(fp, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      commands: parsed.commands ?? {},
      lastUpdated: parsed.lastUpdated ?? 0,
      disabledCommands: Array.isArray(parsed.disabledCommands) ? parsed.disabledCommands : [],
      lastCalibratedQualityRate: parsed.lastCalibratedQualityRate ?? null,
    };
  } catch {
    return { commands: {}, lastUpdated: 0, disabledCommands: [], lastCalibratedQualityRate: null };
  }
}

export function saveQaStats(projectRoot: string, store: QaStatsStore): void {
  const fp = statsPath(projectRoot);
  const dir = path.dirname(fp);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  store.lastUpdated = Date.now();
  const tmp = fp + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, fp);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ensureCommand(store: QaStatsStore, name: string): QaCommandStats {
  if (!store.commands[name]) {
    store.commands[name] = {
      name,
      totalRuns: 0,
      successes: 0,
      failures: 0,
      timeouts: 0,
      preExistingSkips: 0,
      totalDurationMs: 0,
      avgDurationMs: 0,
      lastRunAt: 0,
      consecutiveFailures: 0,
      consecutiveTimeouts: 0,
      recentBaselineResults: [],
    };
  }
  return store.commands[name];
}

// ---------------------------------------------------------------------------
// Core API
// ---------------------------------------------------------------------------

/**
 * Record the result of a QA command execution.
 */
export function recordQaCommandResult(
  projectRoot: string,
  name: string,
  result: {
    passed: boolean;
    durationMs: number;
    timedOut: boolean;
    skippedPreExisting: boolean;
  },
): Promise<void> {
  return withWriteLock(() => {
    const store = loadQaStats(projectRoot);
    const stats = ensureCommand(store, name);

    stats.totalRuns++;
    stats.lastRunAt = Date.now();

    if (result.skippedPreExisting) {
      stats.preExistingSkips++;
      // Don't count skips toward pass/fail streaks
    } else if (result.timedOut) {
      stats.timeouts++;
      stats.consecutiveTimeouts++;
      stats.consecutiveFailures++;
    } else if (result.passed) {
      stats.successes++;
      stats.consecutiveFailures = 0;
      stats.consecutiveTimeouts = 0;
    } else {
      stats.failures++;
      stats.consecutiveFailures++;
      stats.consecutiveTimeouts = 0;
    }

    stats.totalDurationMs += result.durationMs;
    stats.avgDurationMs = stats.totalRuns > 0
      ? Math.round(stats.totalDurationMs / stats.totalRuns)
      : 0;

    saveQaStats(projectRoot, store);
  });
}

/**
 * Record a baseline check result (push to ring buffer).
 */
export function recordBaselineResult(
  projectRoot: string,
  name: string,
  passed: boolean,
): Promise<void> {
  return withWriteLock(() => {
    const store = loadQaStats(projectRoot);
    const stats = ensureCommand(store, name);

    stats.recentBaselineResults.push(passed);
    if (stats.recentBaselineResults.length > MAX_BASELINE_RING) {
      stats.recentBaselineResults.shift();
    }

    saveQaStats(projectRoot, store);
  });
}

/**
 * Get the success rate for a command (0-1).
 */
export function getCommandSuccessRate(stats: QaCommandStats): number {
  if (stats.totalRuns === 0) return -1;
  return stats.successes / stats.totalRuns;
}

/**
 * Check if a command is chronically failing based on recent baseline results.
 * Returns true if the last CHRONIC_FAILURE_THRESHOLD baseline results are all false.
 */
export function isChronicallyFailing(stats: QaCommandStats): boolean {
  const recent = stats.recentBaselineResults;
  if (recent.length < CHRONIC_FAILURE_THRESHOLD) return false;
  const tail = recent.slice(-CHRONIC_FAILURE_THRESHOLD);
  return tail.every(r => r === false);
}

// ---------------------------------------------------------------------------
// Feature 3: Auto-Tune from Stats
// ---------------------------------------------------------------------------

/** Number of recent passing baselines needed to re-enable a disabled command */
const RE_ENABLE_THRESHOLD = 3;

/**
 * Check if a previously disabled command should be re-enabled.
 * Returns true if the last RE_ENABLE_THRESHOLD baseline results are all passing.
 */
function shouldReEnable(stats: QaCommandStats): boolean {
  const recent = stats.recentBaselineResults;
  if (recent.length < RE_ENABLE_THRESHOLD) return false;
  const tail = recent.slice(-RE_ENABLE_THRESHOLD);
  return tail.every(r => r === true);
}

/**
 * Auto-tune QA config based on accumulated per-command stats.
 *
 * Persists disabled command decisions to qa-stats.json so they survive
 * process restarts. Commands are re-enabled if their recent baselines pass.
 */
export function autoTuneQaConfig(
  projectRoot: string,
  qaConfig: QaConfig,
): { config: QaConfig; disabled: Array<{ name: string; reason: string }>; reEnabled: string[] } {
  const store = loadQaStats(projectRoot);
  const newlyDisabled: Array<{ name: string; reason: string }> = [];
  const reEnabled: string[] = [];
  const keptCommands: QaConfig['commands'] = [];

  // Build set of previously persisted disabled names
  const persistedDisabled = new Map(
    store.disabledCommands.map(d => [d.name, d]),
  );

  // Check for re-enablement of previously disabled commands
  for (const [name, entry] of persistedDisabled) {
    const stats = store.commands[name];
    if (stats && shouldReEnable(stats)) {
      reEnabled.push(name);
      persistedDisabled.delete(name);
    }
  }

  for (const cmd of qaConfig.commands) {
    // Skip commands that are persisted-disabled (and not re-enabled)
    if (persistedDisabled.has(cmd.name)) {
      newlyDisabled.push({
        name: cmd.name,
        reason: persistedDisabled.get(cmd.name)!.reason + ' (persisted)',
      });
      continue;
    }

    const stats = store.commands[cmd.name];
    if (!stats) {
      keptCommands.push(cmd);
      continue;
    }

    // Rule 2: Chronic failure demotion
    if (isChronicallyFailing(stats)) {
      const reason = `Chronically failing (last ${CHRONIC_FAILURE_THRESHOLD} baselines all failed)`;
      newlyDisabled.push({ name: cmd.name, reason });
      persistedDisabled.set(cmd.name, { name: cmd.name, reason, disabledAt: Date.now() });
      continue;
    }

    // Rule 3: Consecutive timeout demotion
    if (stats.consecutiveTimeouts >= 3 && stats.totalRuns >= 5) {
      const reason = `${stats.consecutiveTimeouts} consecutive timeouts (${stats.totalRuns} total runs)`;
      newlyDisabled.push({ name: cmd.name, reason });
      persistedDisabled.set(cmd.name, { name: cmd.name, reason, disabledAt: Date.now() });
      continue;
    }

    // Rule 1: Timeout adjustment
    const currentTimeout = cmd.timeoutMs ?? 120_000;
    if (stats.avgDurationMs > currentTimeout * 0.8 && stats.totalRuns >= 5) {
      const newTimeout = Math.round(currentTimeout * 1.5);
      keptCommands.push({ ...cmd, timeoutMs: newTimeout });
    } else {
      keptCommands.push(cmd);
    }
  }

  // Persist disabled decisions to disk
  store.disabledCommands = [...persistedDisabled.values()];
  saveQaStats(projectRoot, store);

  return {
    config: {
      ...qaConfig,
      commands: keptCommands,
    },
    disabled: newlyDisabled,
    reEnabled,
  };
}

/** Hysteresis band: only adjust if quality rate moved >15% from last calibration */
const HYSTERESIS_BAND = 0.15;

/**
 * Calibrate the minimum confidence threshold based on ticket-level quality
 * signals from run-state (not QA command stats).
 *
 * Uses hysteresis to prevent oscillation: only adjusts if the quality rate
 * has moved more than 15% from the rate at last calibration.
 *
 * Returns a delta to apply (positive = raise threshold, negative = lower).
 */
export function calibrateConfidence(
  projectRoot: string,
  currentMin: number,
  originalMin: number,
): number {
  // Read ticket-level quality signals (scout accuracy), not QA command stats
  const runState = readRunState(projectRoot);
  const qs = runState.qualitySignals;
  if (!qs || qs.totalTickets < 5) return 0;

  const qualityRate = qs.firstPassSuccess / qs.totalTickets;

  // Hysteresis: check if rate moved enough from last calibration point
  const store = loadQaStats(projectRoot);
  if (store.lastCalibratedQualityRate !== null) {
    const drift = Math.abs(qualityRate - store.lastCalibratedQualityRate);
    if (drift < HYSTERESIS_BAND) return 0;
  }

  let delta = 0;

  if (qualityRate < 0.6) {
    delta = 5; // Raise threshold — scout is overestimating
  } else if (qualityRate > 0.9 && qs.totalTickets >= 10) {
    // Lower threshold, but never below original
    const newMin = currentMin - 5;
    if (newMin >= originalMin) {
      delta = -5;
    }
  }

  if (delta !== 0) {
    // Persist the quality rate at which we calibrated (hysteresis anchor)
    store.lastCalibratedQualityRate = qualityRate;
    saveQaStats(projectRoot, store);
  }

  return delta;
}
