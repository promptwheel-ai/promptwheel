import { describe, it, expect } from 'vitest';
import {
  buildCycleContextBlock,
  pushCycleSummary,
  computeConvergenceMetrics,
  formatConvergenceOneLiner,
  type CycleSummary,
  type ConvergenceMetrics,
} from '../lib/cycle-context.js';
import type { SectorState } from '../lib/sectors.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSummary(overrides: Partial<CycleSummary> = {}): CycleSummary {
  return {
    cycle: 1,
    scope: 'src/**',
    formula: 'default',
    succeeded: [],
    failed: [],
    noChanges: [],
    ...overrides,
  };
}

function makeSectorState(sectors: Array<{
  path: string;
  fileCount: number;
  production?: boolean;
  scanCount?: number;
  proposalYield?: number;
  polishedAt?: number;
  mergeCount?: number;
  closedCount?: number;
}>): SectorState {
  return {
    version: 2,
    builtAt: new Date().toISOString(),
    sectors: sectors.map(s => ({
      path: s.path,
      fileCount: s.fileCount,
      production: s.production ?? true,
      scanCount: s.scanCount ?? 0,
      proposalYield: s.proposalYield ?? 0,
      polishedAt: s.polishedAt ?? 0,
      mergeCount: s.mergeCount ?? 0,
      closedCount: s.closedCount ?? 0,
      lastScannedAt: 0,
      difficulty: 1,
      categoryStats: {},
    })) as any,
  };
}

// ---------------------------------------------------------------------------
// buildCycleContextBlock
// ---------------------------------------------------------------------------

describe('buildCycleContextBlock', () => {
  it('returns empty string for empty input', () => {
    expect(buildCycleContextBlock([])).toBe('');
    expect(buildCycleContextBlock([], [])).toBe('');
  });

  it('includes succeeded entries', () => {
    const cycles = [makeSummary({
      cycle: 1,
      succeeded: [{ title: 'Fix auth', category: 'security' }],
    })];
    const result = buildCycleContextBlock(cycles);
    expect(result).toContain('<recent-cycles>');
    expect(result).toContain('</recent-cycles>');
    expect(result).toContain('Cycle 1');
    expect(result).toContain('[security] Fix auth');
    expect(result).toContain('Succeeded:');
  });

  it('includes failed entries', () => {
    const cycles = [makeSummary({
      cycle: 2,
      failed: [{ title: 'Refactor DB', reason: 'timeout' }],
    })];
    const result = buildCycleContextBlock(cycles);
    expect(result).toContain('Failed:');
    expect(result).toContain('Refactor DB (timeout)');
  });

  it('includes noChanges entries', () => {
    const cycles = [makeSummary({
      noChanges: ['Update docs'],
    })];
    const result = buildCycleContextBlock(cycles);
    expect(result).toContain('No changes produced:');
    expect(result).toContain('Update docs');
  });

  it('includes recent diffs section when provided', () => {
    const diffs = [{
      title: 'Fix auth',
      summary: 'Added token validation',
      files: ['src/auth.ts', 'src/middleware.ts'],
      cycle: 1,
    }];
    const result = buildCycleContextBlock([], diffs);
    expect(result).toContain('<recent-diffs>');
    expect(result).toContain('</recent-diffs>');
    expect(result).toContain('Fix auth');
    expect(result).toContain('src/auth.ts, src/middleware.ts');
    expect(result).toContain('Consider proposing follow-up work');
  });

  it('limits recent diffs to last 5', () => {
    const diffs = Array.from({ length: 8 }, (_, i) => ({
      title: `Change ${i}`,
      summary: `Summary ${i}`,
      files: [`file${i}.ts`],
      cycle: i,
    }));
    const result = buildCycleContextBlock([], diffs);
    // Should contain changes 3-7 (last 5) but not 0-2
    expect(result).toContain('Change 3');
    expect(result).toContain('Change 7');
    expect(result).not.toContain('Change 2');
  });

  it('includes follow-up guidance text', () => {
    const cycles = [makeSummary({ succeeded: [{ title: 'X', category: 'fix' }] })];
    const result = buildCycleContextBlock(cycles);
    expect(result).toContain('Use these outcomes to propose FOLLOW-UP work');
    expect(result).toContain('Fix what failed');
  });
});

// ---------------------------------------------------------------------------
// pushCycleSummary
// ---------------------------------------------------------------------------

describe('pushCycleSummary', () => {
  it('appends to empty buffer', () => {
    const result = pushCycleSummary([], makeSummary({ cycle: 1 }));
    expect(result).toHaveLength(1);
    expect(result[0].cycle).toBe(1);
  });

  it('appends within max limit', () => {
    const buf = [makeSummary({ cycle: 1 }), makeSummary({ cycle: 2 })];
    const result = pushCycleSummary(buf, makeSummary({ cycle: 3 }), 5);
    expect(result).toHaveLength(3);
  });

  it('trims oldest when exceeding max', () => {
    const buf = Array.from({ length: 5 }, (_, i) => makeSummary({ cycle: i + 1 }));
    const result = pushCycleSummary(buf, makeSummary({ cycle: 6 }), 5);
    expect(result).toHaveLength(5);
    expect(result[0].cycle).toBe(2); // oldest (cycle 1) trimmed
    expect(result[4].cycle).toBe(6);
  });

  it('uses default max of 5', () => {
    const buf = Array.from({ length: 5 }, (_, i) => makeSummary({ cycle: i + 1 }));
    const result = pushCycleSummary(buf, makeSummary({ cycle: 6 }));
    expect(result).toHaveLength(5);
    expect(result[0].cycle).toBe(2);
  });

  it('handles custom max of 1', () => {
    const buf = [makeSummary({ cycle: 1 })];
    const result = pushCycleSummary(buf, makeSummary({ cycle: 2 }), 1);
    expect(result).toHaveLength(1);
    expect(result[0].cycle).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// computeConvergenceMetrics
// ---------------------------------------------------------------------------

describe('computeConvergenceMetrics', () => {
  it('returns defaults for empty sector state', () => {
    const state = makeSectorState([]);
    const result = computeConvergenceMetrics(state, 0, []);
    expect(result.polishedSectorPct).toBe(0);
    expect(result.avgProposalYield).toBe(0);
    expect(result.learningsDensity).toBe(0);
    expect(result.successRateTrend).toBe('stable');
    expect(result.suggestedAction).toBe('continue');
  });

  it('computes polishedSectorPct correctly', () => {
    const state = makeSectorState([
      { path: 'a/', fileCount: 10, production: true, polishedAt: 1000 },
      { path: 'b/', fileCount: 10, production: true, polishedAt: 0 },
      { path: 'c/', fileCount: 10, production: true, polishedAt: 2000 },
      { path: 'd/', fileCount: 10, production: true, polishedAt: 0 },
    ]);
    const result = computeConvergenceMetrics(state, 0, []);
    expect(result.polishedSectorPct).toBe(50); // 2/4
  });

  it('excludes non-production sectors from polished count', () => {
    const state = makeSectorState([
      { path: 'a/', fileCount: 10, production: true, polishedAt: 1000 },
      { path: 'b/', fileCount: 10, production: false, polishedAt: 1000 },
    ]);
    const result = computeConvergenceMetrics(state, 0, []);
    expect(result.polishedSectorPct).toBe(100); // only 1 prod sector, and it's polished
  });

  it('excludes sectors with fileCount=0', () => {
    const state = makeSectorState([
      { path: 'a/', fileCount: 0, production: true, polishedAt: 1000 },
      { path: 'b/', fileCount: 10, production: true, polishedAt: 0 },
    ]);
    const result = computeConvergenceMetrics(state, 0, []);
    expect(result.polishedSectorPct).toBe(0); // sector a has 0 files, filtered out
  });

  it('computes avgProposalYield from scanned sectors', () => {
    const state = makeSectorState([
      { path: 'a/', fileCount: 10, production: true, scanCount: 2, proposalYield: 3 },
      { path: 'b/', fileCount: 10, production: true, scanCount: 1, proposalYield: 1 },
      { path: 'c/', fileCount: 10, production: true, scanCount: 0, proposalYield: 0 }, // not scanned
    ]);
    const result = computeConvergenceMetrics(state, 0, []);
    expect(result.avgProposalYield).toBe(2); // (3+1)/2 scanned sectors
  });

  it('computes learningsDensity', () => {
    const state = makeSectorState([
      { path: 'a/', fileCount: 10, production: true },
      { path: 'b/', fileCount: 20, production: true },
    ]);
    const result = computeConvergenceMetrics(state, 15, []);
    expect(result.learningsDensity).toBe(0.5); // 15 learnings / 30 files
  });

  // Success rate trend
  it('detects improving trend', () => {
    const cycles = [
      makeSummary({ succeeded: [{ title: 'a', category: 'fix' }], failed: [{ title: 'b', reason: 'x' }, { title: 'c', reason: 'y' }] }), // 33%
      makeSummary({ succeeded: [{ title: 'd', category: 'fix' }], failed: [{ title: 'e', reason: 'x' }] }), // 50%
      makeSummary({ succeeded: [{ title: 'f', category: 'fix' }, { title: 'g', category: 'fix' }], failed: [] }), // 100%
    ];
    const state = makeSectorState([{ path: 'a/', fileCount: 10, production: true }]);
    const result = computeConvergenceMetrics(state, 0, cycles);
    expect(result.successRateTrend).toBe('improving');
  });

  it('detects declining trend', () => {
    const cycles = [
      makeSummary({ succeeded: [{ title: 'a', category: 'fix' }, { title: 'b', category: 'fix' }], failed: [] }), // 100%
      makeSummary({ succeeded: [{ title: 'c', category: 'fix' }], failed: [{ title: 'd', reason: 'x' }] }), // 50%
      makeSummary({ succeeded: [], failed: [{ title: 'e', reason: 'x' }, { title: 'f', reason: 'y' }] }), // 0%
    ];
    const state = makeSectorState([{ path: 'a/', fileCount: 10, production: true }]);
    const result = computeConvergenceMetrics(state, 0, cycles);
    expect(result.successRateTrend).toBe('declining');
  });

  it('detects stable trend', () => {
    const cycles = [
      makeSummary({ succeeded: [{ title: 'a', category: 'fix' }], failed: [{ title: 'b', reason: 'x' }] }), // 50%
      makeSummary({ succeeded: [{ title: 'c', category: 'fix' }], failed: [{ title: 'd', reason: 'x' }] }), // 50%
      makeSummary({ succeeded: [{ title: 'e', category: 'fix' }], failed: [{ title: 'f', reason: 'x' }] }), // 50%
    ];
    const state = makeSectorState([{ path: 'a/', fileCount: 10, production: true }]);
    const result = computeConvergenceMetrics(state, 0, cycles);
    expect(result.successRateTrend).toBe('stable');
  });

  it('returns stable for fewer than 3 cycles', () => {
    const cycles = [
      makeSummary({ succeeded: [{ title: 'a', category: 'fix' }], failed: [] }),
    ];
    const state = makeSectorState([{ path: 'a/', fileCount: 10, production: true }]);
    const result = computeConvergenceMetrics(state, 0, cycles);
    expect(result.successRateTrend).toBe('stable');
  });

  // Suggested action thresholds
  it('suggests stop when >80% polished and yield < 0.5', () => {
    const state = makeSectorState([
      { path: 'a/', fileCount: 10, production: true, polishedAt: 1, scanCount: 1, proposalYield: 0.3 },
      { path: 'b/', fileCount: 10, production: true, polishedAt: 1, scanCount: 1, proposalYield: 0.4 },
      { path: 'c/', fileCount: 10, production: true, polishedAt: 1, scanCount: 1, proposalYield: 0.2 },
      { path: 'd/', fileCount: 10, production: true, polishedAt: 1, scanCount: 1, proposalYield: 0.3 },
      { path: 'e/', fileCount: 10, production: true, polishedAt: 1, scanCount: 1, proposalYield: 0.1 },
    ]);
    const result = computeConvergenceMetrics(state, 0, []);
    expect(result.polishedSectorPct).toBe(100);
    expect(result.avgProposalYield).toBeLessThan(0.5);
    expect(result.suggestedAction).toBe('stop');
  });

  it('suggests widen_scope when >60% polished and declining', () => {
    const state = makeSectorState([
      { path: 'a/', fileCount: 10, production: true, polishedAt: 1, scanCount: 1, proposalYield: 1 },
      { path: 'b/', fileCount: 10, production: true, polishedAt: 1, scanCount: 1, proposalYield: 1 },
      { path: 'c/', fileCount: 10, production: true, polishedAt: 1, scanCount: 1, proposalYield: 1 },
      { path: 'd/', fileCount: 10, production: true, polishedAt: 0, scanCount: 1, proposalYield: 1 },
    ]);
    // 75% polished, avg yield=1 (above 0.5 so won't hit stop)
    const decliningCycles = [
      makeSummary({ succeeded: [{ title: 'a', category: 'fix' }, { title: 'b', category: 'fix' }], failed: [] }), // 100%
      makeSummary({ succeeded: [{ title: 'c', category: 'fix' }], failed: [{ title: 'd', reason: 'x' }] }), // 50%
      makeSummary({ succeeded: [], failed: [{ title: 'e', reason: 'x' }, { title: 'f', reason: 'y' }] }), // 0%
    ];
    const result = computeConvergenceMetrics(state, 0, decliningCycles);
    expect(result.suggestedAction).toBe('widen_scope');
  });

  it('suggests deepen when yield > 1.5 and improving', () => {
    const state = makeSectorState([
      { path: 'a/', fileCount: 10, production: true, polishedAt: 0, scanCount: 1, proposalYield: 2 },
      { path: 'b/', fileCount: 10, production: true, polishedAt: 0, scanCount: 1, proposalYield: 2 },
    ]);
    // 0% polished, avg yield=2 (above 1.5)
    const improvingCycles = [
      makeSummary({ succeeded: [{ title: 'a', category: 'fix' }], failed: [{ title: 'b', reason: 'x' }, { title: 'c', reason: 'y' }] }), // 33%
      makeSummary({ succeeded: [{ title: 'd', category: 'fix' }], failed: [{ title: 'e', reason: 'x' }] }), // 50%
      makeSummary({ succeeded: [{ title: 'f', category: 'fix' }, { title: 'g', category: 'fix' }], failed: [] }), // 100%
    ];
    const result = computeConvergenceMetrics(state, 0, improvingCycles);
    expect(result.suggestedAction).toBe('deepen');
  });

  it('suggests continue as default', () => {
    const state = makeSectorState([
      { path: 'a/', fileCount: 10, production: true, polishedAt: 0, scanCount: 1, proposalYield: 1 },
    ]);
    const result = computeConvergenceMetrics(state, 0, []);
    expect(result.suggestedAction).toBe('continue');
  });

  // Merge rate and velocity
  it('computes merge rate from sector data', () => {
    const state = makeSectorState([
      { path: 'a/', fileCount: 10, production: true, mergeCount: 3, closedCount: 1 },
      { path: 'b/', fileCount: 10, production: true, mergeCount: 2, closedCount: 0 },
    ]);
    const result = computeConvergenceMetrics(state, 0, []);
    // totalMerged=5, totalClosed=1, mergeRate = 5/(5+1) ≈ 0.833
    expect(result.mergeRate).toBeCloseTo(5 / 6);
  });

  it('returns NaN merge rate when no merge/close data', () => {
    const state = makeSectorState([
      { path: 'a/', fileCount: 10, production: true },
    ]);
    const result = computeConvergenceMetrics(state, 0, []);
    expect(isNaN(result.mergeRate)).toBe(true);
  });

  it('computes velocity from session context', () => {
    const state = makeSectorState([
      { path: 'a/', fileCount: 10, production: true },
    ]);
    const sessionCtx = { elapsedMs: 3_600_000, prsCreated: 6, prsMerged: 4, prsClosed: 1 };
    const result = computeConvergenceMetrics(state, 0, [], sessionCtx);
    expect(result.velocity.prsPerHour).toBe(6); // 6 PRs in 1 hour
    expect(result.velocity.mergeRatePercent).toBe(80); // 4/(4+1)=80%
  });
});

// ---------------------------------------------------------------------------
// formatConvergenceOneLiner
// ---------------------------------------------------------------------------

describe('formatConvergenceOneLiner', () => {
  it('formats basic metrics', () => {
    const m: ConvergenceMetrics = {
      polishedSectorPct: 50,
      avgProposalYield: 1.5,
      learningsDensity: 0.3,
      successRateTrend: 'stable',
      suggestedAction: 'continue',
      mergeRate: NaN,
      velocity: { prsPerHour: 0, mergeRatePercent: 0 },
    };
    const result = formatConvergenceOneLiner(m);
    expect(result).toContain('50% polished');
    expect(result).toContain('yield 1.5/scan');
    expect(result).toContain('continue');
    expect(result).toContain('→'); // stable arrow
  });

  it('includes improving arrow', () => {
    const m: ConvergenceMetrics = {
      polishedSectorPct: 30,
      avgProposalYield: 2.0,
      learningsDensity: 0,
      successRateTrend: 'improving',
      suggestedAction: 'deepen',
      mergeRate: NaN,
      velocity: { prsPerHour: 0, mergeRatePercent: 0 },
    };
    const result = formatConvergenceOneLiner(m);
    expect(result).toContain('↑'); // improving arrow
  });

  it('includes declining arrow', () => {
    const m: ConvergenceMetrics = {
      polishedSectorPct: 80,
      avgProposalYield: 0.5,
      learningsDensity: 0,
      successRateTrend: 'declining',
      suggestedAction: 'stop',
      mergeRate: NaN,
      velocity: { prsPerHour: 0, mergeRatePercent: 0 },
    };
    const result = formatConvergenceOneLiner(m);
    expect(result).toContain('↓'); // declining arrow
  });

  it('includes velocity when prsPerHour > 0', () => {
    const m: ConvergenceMetrics = {
      polishedSectorPct: 50,
      avgProposalYield: 1.0,
      learningsDensity: 0,
      successRateTrend: 'stable',
      suggestedAction: 'continue',
      mergeRate: NaN,
      velocity: { prsPerHour: 3.5, mergeRatePercent: 80 },
    };
    const result = formatConvergenceOneLiner(m);
    expect(result).toContain('3.5 PRs/h');
  });

  it('includes merge rate when available', () => {
    const m: ConvergenceMetrics = {
      polishedSectorPct: 50,
      avgProposalYield: 1.0,
      learningsDensity: 0,
      successRateTrend: 'stable',
      suggestedAction: 'continue',
      mergeRate: 0.75,
      velocity: { prsPerHour: 0, mergeRatePercent: 0 },
    };
    const result = formatConvergenceOneLiner(m);
    expect(result).toContain('merge 75%');
  });

  it('omits merge rate when NaN', () => {
    const m: ConvergenceMetrics = {
      polishedSectorPct: 50,
      avgProposalYield: 1.0,
      learningsDensity: 0,
      successRateTrend: 'stable',
      suggestedAction: 'continue',
      mergeRate: NaN,
      velocity: { prsPerHour: 0, mergeRatePercent: 0 },
    };
    const result = formatConvergenceOneLiner(m);
    expect(result).not.toContain('merge');
  });
});
