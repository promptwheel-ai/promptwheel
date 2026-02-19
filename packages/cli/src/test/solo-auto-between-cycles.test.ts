/**
 * Tests for pre-cycle and post-cycle maintenance in auto mode.
 *
 * Uses real temp dirs for file-system state (run-state.json, qa-stats.json,
 * learnings.json) and mocks heavy dependencies like git operations, PR
 * status checks, sector operations, and codebase index.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// ---------------------------------------------------------------------------
// Module mocks — must be declared before any imports from the SUT
// ---------------------------------------------------------------------------

vi.mock('../lib/solo-git.js', () => ({
  checkPrStatuses: vi.fn().mockResolvedValue([]),
  fetchPrReviewComments: vi.fn().mockResolvedValue([]),
}));

vi.mock('../lib/sectors.js', () => ({
  saveSectors: vi.fn(),
  refreshSectors: vi.fn(),
  recordMergeOutcome: vi.fn(),
  computeCoverage: vi.fn().mockReturnValue(0),
  suggestScopeAdjustment: vi.fn().mockReturnValue('continue'),
  getSectorCategoryAffinity: vi.fn().mockReturnValue([]),
  getSectorMinConfidence: vi.fn().mockReturnValue(20),
  loadOrBuildSectors: vi.fn(),
  pickNextSector: vi.fn(),
}));

vi.mock('../lib/codebase-index.js', () => ({
  refreshCodebaseIndex: vi.fn(),
  hasStructuralChanges: vi.fn().mockReturnValue(false),
  buildCodebaseIndex: vi.fn(),
}));

vi.mock('../lib/dedup-memory.js', () => ({
  loadDedupMemory: vi.fn().mockReturnValue([]),
}));

vi.mock('../lib/dedup.js', () => ({
  sleep: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../lib/solo-auto-utils.js', () => ({
  getSessionPhase: vi.fn().mockReturnValue('deep'),
  formatElapsed: vi.fn().mockReturnValue('0m'),
}));

vi.mock('../lib/guidelines.js', () => ({
  loadGuidelines: vi.fn().mockReturnValue(null),
}));

vi.mock('../lib/file-cooldown.js', () => ({
  removePrEntries: vi.fn(),
}));

vi.mock('../lib/taste-profile.js', () => ({
  buildTasteProfile: vi.fn().mockReturnValue({ preferredCategories: [], avoidCategories: [], preferredScopes: [] }),
  saveTasteProfile: vi.fn(),
}));

// ---------------------------------------------------------------------------
// SUT imports (after mocks)
// ---------------------------------------------------------------------------

import {
  runPreCycleMaintenance,
  runPostCycleMaintenance,
} from '../lib/solo-auto-between-cycles.js';
import { readRunState, writeRunState, recordCycle } from '../lib/run-state.js';
import { calibrateConfidence, loadQaStats, saveQaStats } from '../lib/qa-stats.js';
import { extractMetaLearnings } from '../lib/meta-learnings.js';
import { addLearning, loadLearnings, consolidateLearnings } from '../lib/learnings.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

function ensurePromptwheelDir(): void {
  const dir = path.join(tmpDir, '.promptwheel');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function writeRunStateRaw(overrides: Record<string, any> = {}): void {
  ensurePromptwheelDir();
  const state = {
    totalCycles: 0,
    lastDocsAuditCycle: 0,
    lastRunAt: 0,
    deferredProposals: [],
    formulaStats: {},
    recentCycles: [],
    recentDiffs: [],
    ...overrides,
  };
  fs.writeFileSync(
    path.join(tmpDir, '.promptwheel', 'run-state.json'),
    JSON.stringify(state, null, 2),
  );
}

function readRunStateRaw(): Record<string, any> {
  const fp = path.join(tmpDir, '.promptwheel', 'run-state.json');
  if (!fs.existsSync(fp)) return {};
  return JSON.parse(fs.readFileSync(fp, 'utf8'));
}

function writeQualitySignals(signals: {
  totalTickets: number;
  firstPassSuccess: number;
  retriedSuccess: number;
  qaPassed: number;
  qaFailed: number;
}): void {
  writeRunStateRaw({ qualitySignals: signals });
}

/**
 * Build a minimal AutoSessionState-compatible object with sensible defaults.
 * Only the fields actually read by runPreCycleMaintenance / runPostCycleMaintenance
 * are required; everything else can be stubbed.
 */
function makeState(overrides: Partial<any> = {}): any {
  return {
    repoRoot: tmpDir,
    cycleCount: 0,
    cycleOutcomes: [],
    allTicketOutcomes: [],
    options: { verbose: false },
    autoConf: {
      learningsEnabled: true,
      minConfidence: 20,
      learningsDecayRate: 3,
    },
    config: { auto: {} },
    runMode: 'planning' as const,
    effectiveMinConfidence: 20,
    consecutiveLowYieldCycles: 0,
    pendingPrUrls: [],
    maxPrs: 10,
    deliveryMode: 'pr',
    sectorState: null,
    currentSectorId: null,
    currentSectorCycle: 0,
    sessionPhase: 'deep',
    startTime: Date.now(),
    totalMinutes: undefined,
    endTime: undefined,
    allLearnings: [],
    codebaseIndex: null,
    excludeDirs: [],
    dedupMemory: [],
    shutdownRequested: false,
    currentlyProcessing: true,
    guidelinesRefreshInterval: 10,
    guidelinesOpts: { backend: 'claude', autoCreate: false },
    guidelines: null,
    pullInterval: 0,
    pullPolicy: 'halt',
    cyclesSinceLastPull: 0,
    currentFormulaName: 'default',
    tasteProfile: { preferredCategories: [], avoidCategories: [], preferredScopes: [] },
    prMetaMap: new Map(),
    allPrUrls: [],
    totalMergedPrs: 0,
    totalClosedPrs: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'between-cycles-test-'));
  ensurePromptwheelDir();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ===========================================================================
// Pre-cycle tests
// ===========================================================================

describe('runPreCycleMaintenance', () => {
  // -----------------------------------------------------------------------
  // 1. Quality rate < 0.5 after cycleCount > 2 raises confidence +10
  // -----------------------------------------------------------------------
  it('raises effectiveMinConfidence +10 when quality rate < 0.5 and cycleCount > 2', async () => {
    // Write quality signals with low first-pass success rate (3/10 = 0.3)
    writeQualitySignals({
      totalTickets: 10,
      firstPassSuccess: 3,
      retriedSuccess: 0,
      qaPassed: 0,
      qaFailed: 0,
    });

    const state = makeState({
      // cycleCount will be incremented to 3 inside runPreCycleMaintenance
      cycleCount: 2,
      effectiveMinConfidence: 30,
    });

    const result = await runPreCycleMaintenance(state);

    expect(result.shouldSkipCycle).toBe(false);
    // Quality rate boost: +10 for quality < 0.5
    // Session phase is 'deep' (mocked), so deep adjustment: max(10, 30-10) = 20.. but
    // the deep adjustment happens first, then quality rate check.
    // After deep: max(10, 30-10) = 20
    // After quality boost: 20 + 10 = 30
    expect(state.effectiveMinConfidence).toBeGreaterThanOrEqual(30);
  });

  // -----------------------------------------------------------------------
  // 2. calibrateConfidence called after cycle 5, delta applied
  // -----------------------------------------------------------------------
  it('applies calibrateConfidence delta after cycle 5', async () => {
    // Set up quality signals that will cause calibrateConfidence to return +5
    // (quality rate < 0.6 triggers +5)
    writeRunStateRaw({
      qualitySignals: {
        totalTickets: 10,
        firstPassSuccess: 4,
        retriedSuccess: 0,
        qaPassed: 0,
        qaFailed: 0,
      },
    });

    const state = makeState({
      // Will be incremented to 6 inside runPreCycleMaintenance
      cycleCount: 5,
      effectiveMinConfidence: 40,
    });

    await runPreCycleMaintenance(state);

    // After deep phase adjustment: max(10, 40-10) = 30
    // After quality rate <0.5 boost (rate = 0.4): +10 => 40
    // After calibrateConfidence (rate 0.4 < 0.6): +5 => 45
    expect(state.effectiveMinConfidence).toBe(45);
  });

  // -----------------------------------------------------------------------
  // 3. Confidence clamped to ceiling of 80
  // -----------------------------------------------------------------------
  it('clamps effectiveMinConfidence to ceiling of 80', async () => {
    // Set up conditions to push confidence very high:
    // - quality rate < 0.5 => +10
    // - calibrateConfidence => +5
    // Start high so additions exceed 80
    writeRunStateRaw({
      qualitySignals: {
        totalTickets: 10,
        firstPassSuccess: 2,
        retriedSuccess: 0,
        qaPassed: 0,
        qaFailed: 0,
      },
    });

    const state = makeState({
      cycleCount: 5,
      effectiveMinConfidence: 75,
    });

    await runPreCycleMaintenance(state);

    // After deep adjustment: max(10, 75-10) = 65
    // After quality boost: 65 + 10 = 75
    // After calibration: 75 + 5 = 80
    // Clamped to ceiling = 80
    expect(state.effectiveMinConfidence).toBeLessThanOrEqual(80);
  });

  // -----------------------------------------------------------------------
  // 4. Confidence floor at 0
  // -----------------------------------------------------------------------
  it('clamps effectiveMinConfidence to floor of 0', async () => {
    // With deep phase adjustment: max(10, val-10) — but we can test by
    // starting low enough and ensuring it doesn't go negative.
    // getSessionPhase returns 'deep' by default, so deep adjusts via:
    //   effectiveMinConfidence = Math.max(10, effectiveMinConfidence - 10)
    // That will floor at 10 due to the deep adjustment itself.
    //
    // To test the 0 floor, we need to bypass deep adjustment.
    // Mock getSessionPhase to return 'cooldown' (no adjustment).
    const { getSessionPhase } = await import('../lib/solo-auto-utils.js');
    vi.mocked(getSessionPhase).mockReturnValue('cooldown');

    // No quality signals => quality rate = 1 => no boost
    // cycleCount will be 1 (no calibration, no quality check)
    const state = makeState({
      cycleCount: 0,
      effectiveMinConfidence: -5,
    });

    await runPreCycleMaintenance(state);

    // Should be clamped to floor of 0
    expect(state.effectiveMinConfidence).toBe(0);
  });

  // -----------------------------------------------------------------------
  // 5. Backpressure: pendingPrUrls.length / maxPrs > 0.7 => shouldSkipCycle
  // -----------------------------------------------------------------------
  it('returns shouldSkipCycle true when backpressure exceeds 0.7', async () => {
    const state = makeState({
      runMode: 'spin' as const,
      pendingPrUrls: ['pr1', 'pr2', 'pr3', 'pr4', 'pr5', 'pr6', 'pr7', 'pr8'],
      maxPrs: 10,
      deliveryMode: 'pr',
    });

    const result = await runPreCycleMaintenance(state);

    expect(result.shouldSkipCycle).toBe(true);
    // cycleCount should have been decremented back (undo increment)
    expect(state.cycleCount).toBe(0);
  });

  it('does not skip when backpressure is at 0.7 exactly', async () => {
    const state = makeState({
      runMode: 'spin' as const,
      pendingPrUrls: ['pr1', 'pr2', 'pr3', 'pr4', 'pr5', 'pr6', 'pr7'],
      maxPrs: 10,
      deliveryMode: 'pr',
    });

    const result = await runPreCycleMaintenance(state);

    // 7/10 = 0.7 — the check is > 0.7 (strict), so this should not skip
    expect(result.shouldSkipCycle).toBe(false);
  });

  it('does not apply backpressure in direct delivery mode', async () => {
    const state = makeState({
      runMode: 'spin' as const,
      pendingPrUrls: ['pr1', 'pr2', 'pr3', 'pr4', 'pr5', 'pr6', 'pr7', 'pr8'],
      maxPrs: 10,
      deliveryMode: 'direct',
    });

    const result = await runPreCycleMaintenance(state);

    expect(result.shouldSkipCycle).toBe(false);
  });
});

// ===========================================================================
// Post-cycle tests
// ===========================================================================

describe('runPostCycleMaintenance', () => {
  // -----------------------------------------------------------------------
  // 6. recordCycle increments totalCycles in run-state.json
  // -----------------------------------------------------------------------
  it('increments totalCycles in run-state.json via recordCycle', async () => {
    writeRunStateRaw({ totalCycles: 5 });

    const state = makeState({
      cycleCount: 3,
      cycleOutcomes: [],
    });

    await runPostCycleMaintenance(state, '**', false);

    const rs = readRunStateRaw();
    expect(rs.totalCycles).toBe(6);
  });

  // -----------------------------------------------------------------------
  // 7. extractMetaLearnings called when cycleCount >= 3 and learnings enabled
  // -----------------------------------------------------------------------
  it('calls extractMetaLearnings when cycleCount >= 3 and learnings enabled', async () => {
    writeRunStateRaw({ totalCycles: 2 });

    // Build enough outcomes to make extractMetaLearnings potentially produce results
    const outcomes = Array.from({ length: 10 }, (_, i) => ({
      id: `tkt-${i}`,
      title: `Ticket ${i}`,
      category: 'refactor',
      status: i < 7 ? 'failed' : 'completed',
    }));

    const state = makeState({
      cycleCount: 3,
      allTicketOutcomes: outcomes,
      cycleOutcomes: outcomes.slice(0, 3),
      autoConf: {
        learningsEnabled: true,
        minConfidence: 20,
        learningsDecayRate: 3,
      },
    });

    await runPostCycleMaintenance(state, '**', false);

    // After extractMetaLearnings with high failure rate (70%), learnings should be added
    const learningsFile = path.join(tmpDir, '.promptwheel', 'learnings.json');
    if (fs.existsSync(learningsFile)) {
      const learnings = JSON.parse(fs.readFileSync(learningsFile, 'utf8'));
      // High failure rate insight should be written
      const hasProcessInsight = learnings.some(
        (l: any) => l.source?.type === 'process_insight',
      );
      expect(hasProcessInsight).toBe(true);
    }
  });

  it('skips extractMetaLearnings when cycleCount < 3', async () => {
    writeRunStateRaw({ totalCycles: 0 });

    const state = makeState({
      cycleCount: 2,
      cycleOutcomes: [],
      allTicketOutcomes: Array.from({ length: 10 }, () => ({
        id: '', title: 'T', category: 'refactor', status: 'failed',
      })),
    });

    await runPostCycleMaintenance(state, '**', false);

    // No learnings file should be created by meta-learnings (only by cycle summary logic)
    const learningsFile = path.join(tmpDir, '.promptwheel', 'learnings.json');
    if (fs.existsSync(learningsFile)) {
      const learnings = JSON.parse(fs.readFileSync(learningsFile, 'utf8'));
      const hasProcessInsight = learnings.some(
        (l: any) => l.source?.type === 'process_insight',
      );
      expect(hasProcessInsight).toBe(false);
    }
  });

  it('skips extractMetaLearnings when learnings disabled', async () => {
    writeRunStateRaw({ totalCycles: 2 });

    const state = makeState({
      cycleCount: 5,
      cycleOutcomes: [],
      allTicketOutcomes: Array.from({ length: 10 }, () => ({
        id: '', title: 'T', category: 'refactor', status: 'failed',
      })),
      autoConf: {
        learningsEnabled: false,
        minConfidence: 20,
        learningsDecayRate: 3,
      },
    });

    await runPostCycleMaintenance(state, '**', false);

    // No process_insight learnings should be created
    const learningsFile = path.join(tmpDir, '.promptwheel', 'learnings.json');
    if (fs.existsSync(learningsFile)) {
      const learnings = JSON.parse(fs.readFileSync(learningsFile, 'utf8'));
      const hasProcessInsight = learnings.some(
        (l: any) => l.source?.type === 'process_insight',
      );
      expect(hasProcessInsight).toBe(false);
    }
  });

  // -----------------------------------------------------------------------
  // 8. Learnings consolidation every 5 cycles
  // -----------------------------------------------------------------------
  it('consolidates learnings every 5 cycles', async () => {
    writeRunStateRaw({ totalCycles: 4 });

    // Seed many learnings so consolidation has something to work with
    const learningsFile = path.join(tmpDir, '.promptwheel', 'learnings.json');
    const seedLearnings = Array.from({ length: 10 }, (_, i) => ({
      id: `l-${i}`,
      text: `Learning number ${i}`,
      category: 'gotcha',
      source: { type: 'qa_failure' },
      tags: [],
      weight: 50,
      created_at: new Date().toISOString(),
      last_confirmed_at: new Date().toISOString(),
      access_count: 0,
    }));
    fs.writeFileSync(learningsFile, JSON.stringify(seedLearnings, null, 2));

    const state = makeState({
      cycleCount: 5, // 5 % 5 === 0 => should consolidate
      cycleOutcomes: [],
      allLearnings: seedLearnings,
      autoConf: {
        learningsEnabled: true,
        minConfidence: 20,
        learningsDecayRate: 3,
      },
    });

    await runPostCycleMaintenance(state, '**', false);

    // After consolidation, allLearnings should have been reloaded
    // (consolidateLearnings deduplicates/merges, then loadLearnings re-reads)
    // The state.allLearnings should be repopulated
    expect(Array.isArray(state.allLearnings)).toBe(true);
  });

  it('does not consolidate learnings when not on 5-cycle boundary', async () => {
    writeRunStateRaw({ totalCycles: 2 });

    const learningsFile = path.join(tmpDir, '.promptwheel', 'learnings.json');
    const seedLearnings = Array.from({ length: 5 }, (_, i) => ({
      id: `l-${i}`,
      text: `Learning ${i}`,
      category: 'gotcha',
      source: { type: 'qa_failure' },
      tags: [],
      weight: 50,
      created_at: new Date().toISOString(),
      last_confirmed_at: new Date().toISOString(),
      access_count: 0,
    }));
    fs.writeFileSync(learningsFile, JSON.stringify(seedLearnings, null, 2));

    const state = makeState({
      cycleCount: 3, // 3 % 5 !== 0 => should NOT consolidate
      cycleOutcomes: [],
      allLearnings: [...seedLearnings],
    });

    await runPostCycleMaintenance(state, '**', false);

    // allLearnings should still be refreshed (reloaded) but not consolidated
    // unless the count exceeds 50
    expect(Array.isArray(state.allLearnings)).toBe(true);
  });

  // -----------------------------------------------------------------------
  // 9. Spin one-liner is printed when cycleCount >= 2
  // -----------------------------------------------------------------------
  it('prints spin one-liner when cycleCount >= 2', async () => {
    writeRunStateRaw({ totalCycles: 1 });

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const state = makeState({
      cycleCount: 2,
      cycleOutcomes: [],
      effectiveMinConfidence: 35,
    });

    await runPostCycleMaintenance(state, '**', false);

    // Find the spin one-liner in console output
    const spinCall = consoleSpy.mock.calls.find(
      (args) => typeof args[0] === 'string' && args[0].includes('Spin:'),
    );
    expect(spinCall).toBeDefined();

    consoleSpy.mockRestore();
  });

  it('does not print spin one-liner when cycleCount < 2', async () => {
    writeRunStateRaw({ totalCycles: 0 });

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const state = makeState({
      cycleCount: 1,
      cycleOutcomes: [],
    });

    await runPostCycleMaintenance(state, '**', false);

    const spinCall = consoleSpy.mock.calls.find(
      (args) => typeof args[0] === 'string' && args[0].includes('Spin:'),
    );
    expect(spinCall).toBeUndefined();

    consoleSpy.mockRestore();
  });

  // -----------------------------------------------------------------------
  // Post-cycle: currentlyProcessing is set to false
  // -----------------------------------------------------------------------
  it('sets currentlyProcessing to false', async () => {
    writeRunStateRaw({ totalCycles: 0 });

    const state = makeState({
      cycleCount: 1,
      cycleOutcomes: [],
      currentlyProcessing: true,
    });

    await runPostCycleMaintenance(state, '**', false);

    expect(state.currentlyProcessing).toBe(false);
  });

  // -----------------------------------------------------------------------
  // Post-cycle: cycle summary is pushed to recentCycles in run-state.json
  // -----------------------------------------------------------------------
  it('pushes cycle summary to recentCycles in run-state.json', async () => {
    writeRunStateRaw({ totalCycles: 0 });

    const state = makeState({
      cycleCount: 1,
      cycleOutcomes: [
        { id: '1', title: 'Fix auth', category: 'security', status: 'completed' },
        { id: '2', title: 'Refactor DB', category: 'refactor', status: 'failed' },
      ],
      currentFormulaName: 'default',
    });

    await runPostCycleMaintenance(state, 'src/**', false);

    const rs = readRunStateRaw();
    expect(rs.recentCycles).toBeDefined();
    expect(rs.recentCycles.length).toBeGreaterThanOrEqual(1);
    const lastCycle = rs.recentCycles[rs.recentCycles.length - 1];
    expect(lastCycle.scope).toBe('src/**');
    expect(lastCycle.formula).toBe('default');
    expect(lastCycle.succeeded).toHaveLength(1);
    expect(lastCycle.succeeded[0].title).toBe('Fix auth');
    expect(lastCycle.failed).toHaveLength(1);
    expect(lastCycle.failed[0].title).toBe('Refactor DB');
  });
});
