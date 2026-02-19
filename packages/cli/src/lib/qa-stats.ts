/**
 * Per-command QA statistics tracking.
 *
 * Persists to `.promptwheel/qa-stats.json` and provides:
 * - Per-command success/failure/timeout tracking
 * - Baseline result ring buffer for health monitoring
 * - Auto-tuning of QA config (timeout adjustment)
 * - Confidence calibration from quality signals
 *
 * Philosophy: failing baseline commands are never disabled — they're
 * skipped during QA verification (via the pass/fail map) and surfaced
 * to the scout as high-priority healing targets. Only timeout-related
 * config issues cause command demotion.
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

export interface QaStatsStore {
  commands: Record<string, QaCommandStats>;
  lastUpdated: number;
  /** @deprecated — no longer used. Baseline-failing commands are skipped, not disabled. */
  disabledCommands: Array<{ name: string; reason: string; disabledAt: number }>;
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
  return path.join(projectRoot, '.promptwheel', QA_STATS_FILE);
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

/**
 * Reset QA execution streaks for a fresh session start.
 * Preserves the baseline ring buffer for health monitoring.
 */
export function resetQaStatsForSession(projectRoot: string): void {
  const fp = statsPath(projectRoot);
  if (!fs.existsSync(fp)) return;

  const store = loadQaStats(projectRoot);
  if (Object.keys(store.commands).length === 0) return;

  for (const name of Object.keys(store.commands)) {
    store.commands[name].consecutiveFailures = 0;
    store.commands[name].consecutiveTimeouts = 0;
  }

  // Clear stale disabledCommands — organic healing never disables
  store.disabledCommands = [];

  saveQaStats(projectRoot, store);
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

// ---------------------------------------------------------------------------
// Auto-Tune from Stats (timeout adjustment only)
// ---------------------------------------------------------------------------

/**
 * Auto-tune QA config based on accumulated per-command stats.
 *
 * Only adjusts timeouts for slow commands and demotes commands that
 * consistently time out (config issue, not healable by code changes).
 *
 * Baseline-failing commands are NEVER disabled — they're skipped during
 * QA verification via the pass/fail map and surfaced to the scout as
 * high-priority healing targets through the baseline health block.
 */
export function autoTuneQaConfig(
  projectRoot: string,
  qaConfig: QaConfig,
): { config: QaConfig; disabled: Array<{ name: string; reason: string }> } {
  const store = loadQaStats(projectRoot);
  const disabled: Array<{ name: string; reason: string }> = [];
  const keptCommands: QaConfig['commands'] = [];

  for (const cmd of qaConfig.commands) {
    const stats = store.commands[cmd.name];
    if (!stats) {
      keptCommands.push(cmd);
      continue;
    }

    // Consecutive timeout demotion (config issue — wrong command, missing deps)
    if (stats.consecutiveTimeouts >= 3 && stats.totalRuns >= 5) {
      const reason = `${stats.consecutiveTimeouts} consecutive timeouts (${stats.totalRuns} total runs)`;
      disabled.push({ name: cmd.name, reason });
      continue;
    }

    // Timeout adjustment for slow commands
    const currentTimeout = cmd.timeoutMs ?? 120_000;
    if (stats.avgDurationMs > currentTimeout * 0.8 && stats.totalRuns >= 5) {
      const newTimeout = Math.round(currentTimeout * 1.5);
      keptCommands.push({ ...cmd, timeoutMs: newTimeout });
    } else {
      keptCommands.push(cmd);
    }
  }

  saveQaStats(projectRoot, store);

  return {
    config: { ...qaConfig, commands: keptCommands },
    disabled,
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

// ---------------------------------------------------------------------------
// Baseline health block for scout prompt
// ---------------------------------------------------------------------------

export function buildBaselineHealthBlock(projectRoot: string, currentScope?: string): string {
  const baselinePath = path.join(projectRoot, '.promptwheel', 'qa-baseline.json');
  if (!fs.existsSync(baselinePath)) return '';
  let data: any;
  try {
    data = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
  } catch { return ''; }
  if (!data.failures?.length) return '';

  const details: Record<string, { cmd: string; output: string }> = data.details ?? {};
  const lines: string[] = [
    '<baseline-health>',
    '## QA Baseline Failures (High Priority)',
    'These QA commands fail BEFORE any changes (pre-existing).',
    'Propose a targeted fix for one of these failures if it touches files in your current scope.',
    'Healing these baselines is high-value work — it unblocks QA verification for all future tickets.',
    '',
  ];

  // Scope filter: extract sector prefix (e.g., "scripts" from "scripts/**")
  const scopePrefix = currentScope?.replace(/\/?\*\*?$/, '').replace(/\/$/, '') || '';

  for (const name of data.failures) {
    const detail = details[name];
    lines.push(`### ${name}`);
    if (detail?.cmd) lines.push(`Command: \`${detail.cmd}\``);
    if (detail?.output) {
      // Cap raw output before split to prevent large allocations
      const capped = detail.output.length > 10000 ? detail.output.slice(0, 10000) : detail.output;
      let outputLines = capped.split('\n');
      // If scoped, filter to lines mentioning files in this sector
      if (scopePrefix && scopePrefix !== '.') {
        const scoped = outputLines.filter((l: string) => l.includes(scopePrefix));
        if (scoped.length > 0) outputLines = scoped;
      }
      // Cap at 30 lines to avoid prompt bloat
      if (outputLines.length > 30) {
        outputLines = [...outputLines.slice(0, 28), `... (${outputLines.length - 28} more lines)`];
      }
      lines.push('```');
      lines.push(...outputLines);
      lines.push('```');
    }
    lines.push('');
  }

  lines.push('</baseline-health>');
  return lines.join('\n');
}
