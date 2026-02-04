/**
 * Tests for per-command QA statistics tracking and auto-tuning.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  loadQaStats,
  saveQaStats,
  recordQaCommandResult,
  recordBaselineResult,
  getCommandSuccessRate,
  isChronicallyFailing,
  autoTuneQaConfig,
  calibrateConfidence,
  type QaStatsStore,
  type QaCommandStats,
} from '../lib/qa-stats.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

function statsFile(): string {
  return path.join(tmpDir, '.blockspool', 'qa-stats.json');
}

function runStateFile(): string {
  return path.join(tmpDir, '.blockspool', 'run-state.json');
}

function writeStatsRaw(store: QaStatsStore): void {
  const dir = path.join(tmpDir, '.blockspool');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(statsFile(), JSON.stringify(store, null, 2));
}

function readStatsRaw(): QaStatsStore {
  if (!fs.existsSync(statsFile())) return { commands: {}, lastUpdated: 0, disabledCommands: [], lastCalibratedQualityRate: null };
  return JSON.parse(fs.readFileSync(statsFile(), 'utf8'));
}

function writeRunState(qualitySignals: { totalTickets: number; firstPassSuccess: number; retriedSuccess: number; qaPassed: number; qaFailed: number }): void {
  const dir = path.join(tmpDir, '.blockspool');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const state = {
    totalCycles: 10,
    lastDocsAuditCycle: 0,
    lastRunAt: Date.now(),
    deferredProposals: [],
    formulaStats: {},
    qualitySignals,
  };
  fs.writeFileSync(runStateFile(), JSON.stringify(state, null, 2));
}

function makeStats(overrides: Partial<QaCommandStats> = {}): QaCommandStats {
  return {
    name: 'test',
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
    ...overrides,
  };
}

function makeQaConfig(commands: Array<{ name: string; cmd: string; timeoutMs?: number }>) {
  return {
    commands: commands.map(c => ({ name: c.name, cmd: c.cmd, cwd: '.', timeoutMs: c.timeoutMs })),
    artifacts: { dir: '.blockspool/artifacts', maxLogBytes: 200_000, tailBytes: 16_384 },
    retry: { enabled: false, maxAttempts: 1 },
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-stats-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// loadQaStats / saveQaStats
// ---------------------------------------------------------------------------

describe('loadQaStats', () => {
  it('returns empty store when no file exists', () => {
    const store = loadQaStats(tmpDir);
    expect(store.commands).toEqual({});
    expect(store.lastUpdated).toBe(0);
    expect(store.disabledCommands).toEqual([]);
    expect(store.lastCalibratedQualityRate).toBeNull();
  });

  it('round-trips through save and load', () => {
    const store: QaStatsStore = {
      commands: {
        lint: makeStats({ name: 'lint', totalRuns: 5, successes: 3 }),
      },
      lastUpdated: 0,
      disabledCommands: [{ name: 'build', reason: 'chronic failure', disabledAt: 1000 }],
      lastCalibratedQualityRate: 0.75,
    };

    saveQaStats(tmpDir, store);
    const loaded = loadQaStats(tmpDir);

    expect(loaded.commands.lint.totalRuns).toBe(5);
    expect(loaded.commands.lint.successes).toBe(3);
    expect(loaded.disabledCommands).toHaveLength(1);
    expect(loaded.disabledCommands[0].name).toBe('build');
    expect(loaded.lastCalibratedQualityRate).toBe(0.75);
  });

  it('handles corrupted JSON gracefully', () => {
    const dir = path.join(tmpDir, '.blockspool');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(statsFile(), 'not json');

    const store = loadQaStats(tmpDir);
    expect(store.commands).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// recordQaCommandResult
// ---------------------------------------------------------------------------

describe('recordQaCommandResult', () => {
  it('creates new command entry on first record', async () => {
    await recordQaCommandResult(tmpDir, 'lint', {
      passed: true, durationMs: 1000, timedOut: false, skippedPreExisting: false,
    });

    const store = readStatsRaw();
    expect(store.commands.lint).toBeDefined();
    expect(store.commands.lint.totalRuns).toBe(1);
    expect(store.commands.lint.successes).toBe(1);
    expect(store.commands.lint.avgDurationMs).toBe(1000);
  });

  it('increments counters on success', async () => {
    await recordQaCommandResult(tmpDir, 'test', {
      passed: true, durationMs: 500, timedOut: false, skippedPreExisting: false,
    });
    await recordQaCommandResult(tmpDir, 'test', {
      passed: true, durationMs: 1500, timedOut: false, skippedPreExisting: false,
    });

    const store = readStatsRaw();
    expect(store.commands.test.totalRuns).toBe(2);
    expect(store.commands.test.successes).toBe(2);
    expect(store.commands.test.failures).toBe(0);
    expect(store.commands.test.avgDurationMs).toBe(1000);
  });

  it('tracks failures and consecutive failures', async () => {
    await recordQaCommandResult(tmpDir, 'test', {
      passed: false, durationMs: 100, timedOut: false, skippedPreExisting: false,
    });
    await recordQaCommandResult(tmpDir, 'test', {
      passed: false, durationMs: 100, timedOut: false, skippedPreExisting: false,
    });

    const store = readStatsRaw();
    expect(store.commands.test.failures).toBe(2);
    expect(store.commands.test.consecutiveFailures).toBe(2);
  });

  it('resets consecutive counters on success', async () => {
    await recordQaCommandResult(tmpDir, 'test', {
      passed: false, durationMs: 100, timedOut: false, skippedPreExisting: false,
    });
    await recordQaCommandResult(tmpDir, 'test', {
      passed: false, durationMs: 100, timedOut: false, skippedPreExisting: false,
    });
    await recordQaCommandResult(tmpDir, 'test', {
      passed: true, durationMs: 100, timedOut: false, skippedPreExisting: false,
    });

    const store = readStatsRaw();
    expect(store.commands.test.consecutiveFailures).toBe(0);
    expect(store.commands.test.consecutiveTimeouts).toBe(0);
  });

  it('tracks timeouts as both timeout and failure', async () => {
    await recordQaCommandResult(tmpDir, 'test', {
      passed: false, durationMs: 60000, timedOut: true, skippedPreExisting: false,
    });

    const store = readStatsRaw();
    expect(store.commands.test.timeouts).toBe(1);
    expect(store.commands.test.consecutiveTimeouts).toBe(1);
    expect(store.commands.test.consecutiveFailures).toBe(1);
  });

  it('tracks pre-existing skips separately', async () => {
    await recordQaCommandResult(tmpDir, 'test', {
      passed: false, durationMs: 0, timedOut: false, skippedPreExisting: true,
    });

    const store = readStatsRaw();
    expect(store.commands.test.preExistingSkips).toBe(1);
    expect(store.commands.test.consecutiveFailures).toBe(0);
    expect(store.commands.test.failures).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// recordBaselineResult
// ---------------------------------------------------------------------------

describe('recordBaselineResult', () => {
  it('pushes to ring buffer', async () => {
    await recordBaselineResult(tmpDir, 'lint', true);
    await recordBaselineResult(tmpDir, 'lint', false);
    await recordBaselineResult(tmpDir, 'lint', true);

    const store = readStatsRaw();
    expect(store.commands.lint.recentBaselineResults).toEqual([true, false, true]);
  });

  it('caps ring buffer at 10 entries', async () => {
    for (let i = 0; i < 12; i++) {
      await recordBaselineResult(tmpDir, 'lint', i % 2 === 0);
    }

    const store = readStatsRaw();
    expect(store.commands.lint.recentBaselineResults).toHaveLength(10);
  });
});

// ---------------------------------------------------------------------------
// getCommandSuccessRate
// ---------------------------------------------------------------------------

describe('getCommandSuccessRate', () => {
  it('returns -1 for zero runs (no data)', () => {
    expect(getCommandSuccessRate(makeStats())).toBe(-1);
  });

  it('computes correct rate', () => {
    expect(getCommandSuccessRate(makeStats({ totalRuns: 10, successes: 7 }))).toBe(0.7);
  });
});

// ---------------------------------------------------------------------------
// isChronicallyFailing
// ---------------------------------------------------------------------------

describe('isChronicallyFailing', () => {
  it('returns false with insufficient data', () => {
    expect(isChronicallyFailing(makeStats({
      recentBaselineResults: [false, false, false],
    }))).toBe(false);
  });

  it('returns false when recent results include passes', () => {
    expect(isChronicallyFailing(makeStats({
      recentBaselineResults: [false, false, false, false, true],
    }))).toBe(false);
  });

  it('returns true when last 5 baselines all fail', () => {
    expect(isChronicallyFailing(makeStats({
      recentBaselineResults: [true, true, false, false, false, false, false],
    }))).toBe(true);
  });

  it('only looks at last 5 results', () => {
    expect(isChronicallyFailing(makeStats({
      recentBaselineResults: [false, false, false, false, false, true, false, false, false, false],
    }))).toBe(false);
    // Last 5: [true, false, false, false, false] — has a true, so not chronic
    // Wait, slice(-5) of [f,f,f,f,f,t,f,f,f,f] = [t,f,f,f,f] — correct, not all false
  });
});

// ---------------------------------------------------------------------------
// autoTuneQaConfig
// ---------------------------------------------------------------------------

describe('autoTuneQaConfig', () => {
  it('passes through all commands when stats are empty', () => {
    const config = makeQaConfig([
      { name: 'lint', cmd: 'npm run lint' },
      { name: 'test', cmd: 'npm test' },
    ]);

    const result = autoTuneQaConfig(tmpDir, config);
    expect(result.config.commands).toHaveLength(2);
    expect(result.disabled).toHaveLength(0);
    expect(result.reEnabled).toHaveLength(0);
  });

  it('disables chronically failing commands', () => {
    writeStatsRaw({
      commands: {
        lint: makeStats({
          name: 'lint',
          recentBaselineResults: [false, false, false, false, false],
        }),
      },
      lastUpdated: 0,
      disabledCommands: [],
      lastCalibratedQualityRate: null,
    });

    const config = makeQaConfig([
      { name: 'lint', cmd: 'npm run lint' },
      { name: 'test', cmd: 'npm test' },
    ]);

    const result = autoTuneQaConfig(tmpDir, config);
    expect(result.config.commands).toHaveLength(1);
    expect(result.config.commands[0].name).toBe('test');
    expect(result.disabled).toHaveLength(1);
    expect(result.disabled[0].name).toBe('lint');
  });

  it('disables commands with consecutive timeouts', () => {
    writeStatsRaw({
      commands: {
        test: makeStats({
          name: 'test',
          totalRuns: 5,
          consecutiveTimeouts: 3,
        }),
      },
      lastUpdated: 0,
      disabledCommands: [],
      lastCalibratedQualityRate: null,
    });

    const config = makeQaConfig([{ name: 'test', cmd: 'npm test' }]);
    const result = autoTuneQaConfig(tmpDir, config);

    expect(result.config.commands).toHaveLength(0);
    expect(result.disabled).toHaveLength(1);
    expect(result.disabled[0].reason).toContain('consecutive timeouts');
  });

  it('increases timeout when avg duration approaches limit', () => {
    writeStatsRaw({
      commands: {
        test: makeStats({
          name: 'test',
          totalRuns: 10,
          avgDurationMs: 100_000, // 100s, > 80% of 120s default
        }),
      },
      lastUpdated: 0,
      disabledCommands: [],
      lastCalibratedQualityRate: null,
    });

    const config = makeQaConfig([{ name: 'test', cmd: 'npm test' }]);
    const result = autoTuneQaConfig(tmpDir, config);

    expect(result.config.commands).toHaveLength(1);
    expect(result.config.commands[0].timeoutMs).toBe(180_000); // 120k * 1.5
  });

  it('persists disabled commands to disk', () => {
    writeStatsRaw({
      commands: {
        lint: makeStats({
          name: 'lint',
          recentBaselineResults: [false, false, false, false, false],
        }),
      },
      lastUpdated: 0,
      disabledCommands: [],
      lastCalibratedQualityRate: null,
    });

    const config = makeQaConfig([{ name: 'lint', cmd: 'npm run lint' }]);
    autoTuneQaConfig(tmpDir, config);

    const store = readStatsRaw();
    expect(store.disabledCommands).toHaveLength(1);
    expect(store.disabledCommands[0].name).toBe('lint');
  });

  it('keeps persisted disabled commands across calls', () => {
    writeStatsRaw({
      commands: {
        lint: makeStats({
          name: 'lint',
          recentBaselineResults: [false, false, false, false, false],
        }),
      },
      lastUpdated: 0,
      disabledCommands: [{ name: 'lint', reason: 'Chronically failing', disabledAt: Date.now() }],
      lastCalibratedQualityRate: null,
    });

    const config = makeQaConfig([{ name: 'lint', cmd: 'npm run lint' }]);
    const result = autoTuneQaConfig(tmpDir, config);

    expect(result.config.commands).toHaveLength(0);
    expect(result.disabled[0].reason).toContain('persisted');
  });

  it('re-enables commands when last 3 baselines pass', () => {
    writeStatsRaw({
      commands: {
        lint: makeStats({
          name: 'lint',
          recentBaselineResults: [false, false, false, true, true, true],
        }),
      },
      lastUpdated: 0,
      disabledCommands: [{ name: 'lint', reason: 'Chronically failing', disabledAt: Date.now() }],
      lastCalibratedQualityRate: null,
    });

    const config = makeQaConfig([{ name: 'lint', cmd: 'npm run lint' }]);
    const result = autoTuneQaConfig(tmpDir, config);

    expect(result.reEnabled).toContain('lint');
    expect(result.config.commands).toHaveLength(1);
    expect(result.config.commands[0].name).toBe('lint');
  });

  it('does not re-enable if only 2 recent baselines pass', () => {
    writeStatsRaw({
      commands: {
        lint: makeStats({
          name: 'lint',
          recentBaselineResults: [false, false, true, true],
        }),
      },
      lastUpdated: 0,
      disabledCommands: [{ name: 'lint', reason: 'Chronically failing', disabledAt: Date.now() }],
      lastCalibratedQualityRate: null,
    });

    const config = makeQaConfig([{ name: 'lint', cmd: 'npm run lint' }]);
    const result = autoTuneQaConfig(tmpDir, config);

    expect(result.reEnabled).toHaveLength(0);
    expect(result.config.commands).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// calibrateConfidence
// ---------------------------------------------------------------------------

describe('calibrateConfidence', () => {
  it('returns 0 when no quality signals exist', () => {
    expect(calibrateConfidence(tmpDir, 50, 20)).toBe(0);
  });

  it('returns 0 when totalTickets < 5', () => {
    writeRunState({ totalTickets: 3, firstPassSuccess: 1, retriedSuccess: 0, qaPassed: 0, qaFailed: 0 });
    expect(calibrateConfidence(tmpDir, 50, 20)).toBe(0);
  });

  it('returns +5 when quality rate < 0.6', () => {
    writeRunState({ totalTickets: 10, firstPassSuccess: 4, retriedSuccess: 0, qaPassed: 0, qaFailed: 0 });
    expect(calibrateConfidence(tmpDir, 50, 20)).toBe(5);
  });

  it('returns -5 when quality rate > 0.9 with enough data', () => {
    writeRunState({ totalTickets: 15, firstPassSuccess: 14, retriedSuccess: 0, qaPassed: 0, qaFailed: 0 });
    expect(calibrateConfidence(tmpDir, 50, 20)).toBe(-5);
  });

  it('does not lower below original min', () => {
    writeRunState({ totalTickets: 15, firstPassSuccess: 14, retriedSuccess: 0, qaPassed: 0, qaFailed: 0 });
    // currentMin is 22, original is 20. 22 - 5 = 17 < 20, so should return 0
    expect(calibrateConfidence(tmpDir, 22, 20)).toBe(0);
  });

  it('blocks adjustment within hysteresis band', () => {
    writeRunState({ totalTickets: 10, firstPassSuccess: 4, retriedSuccess: 0, qaPassed: 0, qaFailed: 0 });

    // First call: adjusts and records anchor
    const delta1 = calibrateConfidence(tmpDir, 50, 20);
    expect(delta1).toBe(5);

    // Second call with same rate: within hysteresis band, should return 0
    const delta2 = calibrateConfidence(tmpDir, 55, 20);
    expect(delta2).toBe(0);
  });

  it('adjusts when rate drifts beyond hysteresis band', () => {
    writeRunState({ totalTickets: 10, firstPassSuccess: 4, retriedSuccess: 0, qaPassed: 0, qaFailed: 0 });

    // First call: rate = 0.4, adjusts
    calibrateConfidence(tmpDir, 50, 20);

    // Rate improves significantly beyond the band (0.4 → 0.95, drift = 0.55 > 0.15)
    writeRunState({ totalTickets: 20, firstPassSuccess: 19, retriedSuccess: 0, qaPassed: 0, qaFailed: 0 });
    const delta = calibrateConfidence(tmpDir, 55, 20);
    expect(delta).toBe(-5);
  });

  it('persists last calibrated quality rate', () => {
    writeRunState({ totalTickets: 10, firstPassSuccess: 3, retriedSuccess: 0, qaPassed: 0, qaFailed: 0 });
    calibrateConfidence(tmpDir, 50, 20);

    const store = readStatsRaw();
    expect(store.lastCalibratedQualityRate).toBeCloseTo(0.3);
  });
});
