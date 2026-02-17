/**
 * Per-command QA statistics tracking for the MCP package.
 *
 * Minimal subset copied from CLI's `packages/cli/src/lib/qa-stats.ts`.
 * Provides persistence to `.blockspool/qa-stats.json` for QA command
 * result tracking when running through the plugin/MCP path.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

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

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const QA_STATS_FILE = 'qa-stats.json';
const MAX_BASELINE_RING = 10;

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
  } catch (err) {
    console.warn(`[blockspool] failed to parse qa-stats.json: ${err instanceof Error ? err.message : String(err)}`);
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
): void {
  const store = loadQaStats(projectRoot);
  const stats = ensureCommand(store, name);

  stats.totalRuns++;
  stats.lastRunAt = Date.now();

  if (result.skippedPreExisting) {
    stats.preExistingSkips++;
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
}

/**
 * Record a baseline check result (push to ring buffer).
 */
export function recordBaselineResult(
  projectRoot: string,
  name: string,
  passed: boolean,
): void {
  const store = loadQaStats(projectRoot);
  const stats = ensureCommand(store, name);
  stats.recentBaselineResults.push(passed);
  if (stats.recentBaselineResults.length > MAX_BASELINE_RING) {
    stats.recentBaselineResults.shift();
  }
  saveQaStats(projectRoot, store);
}
