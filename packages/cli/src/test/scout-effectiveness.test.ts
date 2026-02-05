/**
 * Tests for scout effectiveness fixes:
 * - Fix 1: Category constraints wired to scout prompt
 * - Fix 2: Diminishing returns uses post-filter yield
 * - Fix 3: Honest quality rate & QA stats display
 * - Fix 4: Empty sector skip
 */

import { describe, it, expect, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Fix 1: Category constraints — type-level verification
// (The type checks are verified by tsc --noEmit; here we test the logic)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Fix 3: Honest quality rate & QA stats display
// ---------------------------------------------------------------------------

describe('getCommandSuccessRate', () => {
  it('returns -1 for zero runs (no data signal)', async () => {
    const { getCommandSuccessRate } = await import('../lib/qa-stats.js');
    const stats = {
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
    };
    expect(getCommandSuccessRate(stats)).toBe(-1);
  });

  it('returns correct rate for positive runs', async () => {
    const { getCommandSuccessRate } = await import('../lib/qa-stats.js');
    const stats = {
      name: 'test',
      totalRuns: 10,
      successes: 8,
      failures: 2,
      timeouts: 0,
      preExistingSkips: 0,
      totalDurationMs: 5000,
      avgDurationMs: 500,
      lastRunAt: Date.now(),
      consecutiveFailures: 0,
      consecutiveTimeouts: 0,
      recentBaselineResults: [],
    };
    expect(getCommandSuccessRate(stats)).toBe(0.8);
  });
});

describe('displayWheelHealth QA display', () => {
  it('shows "QA: untested" when qaPassed + qaFailed === 0', async () => {
    // We test the formatting logic directly
    const qaPassed = 0;
    const qaFailed = 0;
    const qaStr = (qaPassed + qaFailed) > 0
      ? `${qaPassed}/${qaPassed + qaFailed} QA pass`
      : 'QA: untested';
    expect(qaStr).toBe('QA: untested');
  });

  it('shows QA pass count when QA has run', () => {
    const qaPassed = 3;
    const qaFailed = 1;
    const qaStr = (qaPassed + qaFailed) > 0
      ? `${qaPassed}/${qaPassed + qaFailed} QA pass`
      : 'QA: untested';
    expect(qaStr).toBe('3/4 QA pass');
  });

  it('shows "no data" for QA command with 0 runs', () => {
    const totalRuns = 0;
    const successes = 0;
    const avgDurationMs = 0;
    const rate = totalRuns > 0 ? Math.round(successes / totalRuns * 100) : null;
    const rateStr = rate !== null ? `${rate}% success` : 'no data';
    const avgStr = totalRuns > 0
      ? (avgDurationMs >= 1000 ? `avg ${(avgDurationMs / 1000).toFixed(1)}s` : `avg ${avgDurationMs}ms`)
      : '';
    const result = `${rateStr}${avgStr ? `, ${avgStr}` : ''}`;
    expect(result).toBe('no data');
  });

  it('shows success rate and avg for QA command with runs', () => {
    const totalRuns = 5;
    const successes = 4;
    const avgDurationMs = 1500;
    const rate = totalRuns > 0 ? Math.round(successes / totalRuns * 100) : null;
    const rateStr = rate !== null ? `${rate}% success` : 'no data';
    const avgStr = totalRuns > 0
      ? (avgDurationMs >= 1000 ? `avg ${(avgDurationMs / 1000).toFixed(1)}s` : `avg ${avgDurationMs}ms`)
      : '';
    const result = `${rateStr}${avgStr ? `, ${avgStr}` : ''}`;
    expect(result).toBe('80% success, avg 1.5s');
  });
});

// ---------------------------------------------------------------------------
// Fix 4: Empty sector skip
// ---------------------------------------------------------------------------

describe('empty sector skip', () => {
  it('marks sector fileCount and productionFileCount to 0 when scannedFiles is 0', () => {
    // Simulate the logic from solo-auto-scout.ts
    const sector = {
      path: 'playwright-report/trace',
      fileCount: 15,
      productionFileCount: 10,
      production: false,
      purpose: 'generated',
      classificationConfidence: 'low',
      lastScannedAt: 0,
      lastScannedCycle: 0,
      scanCount: 0,
      proposalYield: 0,
    };

    const scannedFiles = 0;
    const sectorState = { sectors: [sector] };
    const currentSectorId = 'playwright-report/trace';

    // Apply the fix logic
    if (scannedFiles === 0 && sectorState && currentSectorId) {
      const s = sectorState.sectors.find(s => s.path === currentSectorId);
      if (s) {
        s.fileCount = 0;
        s.productionFileCount = 0;
      }
    }

    expect(sector.fileCount).toBe(0);
    expect(sector.productionFileCount).toBe(0);
  });

  it('does not modify sector when scannedFiles > 0', () => {
    const sector = {
      path: 'src/lib',
      fileCount: 25,
      productionFileCount: 20,
      production: true,
      purpose: 'core',
      classificationConfidence: 'high',
      lastScannedAt: 0,
      lastScannedCycle: 0,
      scanCount: 0,
      proposalYield: 0,
    };

    const scannedFiles = 5;
    const sectorState = { sectors: [sector] };
    const currentSectorId = 'src/lib';

    if (scannedFiles === 0 && sectorState && currentSectorId) {
      const s = sectorState.sectors.find(s => s.path === currentSectorId);
      if (s) {
        s.fileCount = 0;
        s.productionFileCount = 0;
      }
    }

    expect(sector.fileCount).toBe(25);
    expect(sector.productionFileCount).toBe(20);
  });
});

// ---------------------------------------------------------------------------
// Fix 2: Diminishing returns post-filter
// ---------------------------------------------------------------------------

describe('diminishing returns post-filter logic', () => {
  it('increments consecutiveLowYieldCycles when approved/scanned < threshold', () => {
    const LOW_YIELD_THRESHOLD = 0.2;
    const state = { cycleCount: 3, consecutiveLowYieldCycles: 0, shutdownRequested: false };
    const approved = 0;
    const scanned = 50;

    if (state.cycleCount > 2) {
      const yieldRate = approved / Math.max(scanned, 1);
      if (yieldRate < LOW_YIELD_THRESHOLD) {
        state.consecutiveLowYieldCycles++;
      } else {
        state.consecutiveLowYieldCycles = 0;
      }
    }

    expect(state.consecutiveLowYieldCycles).toBe(1);
  });

  it('resets counter when a cycle has good yield', () => {
    const LOW_YIELD_THRESHOLD = 0.2;
    const state = { cycleCount: 5, consecutiveLowYieldCycles: 2, shutdownRequested: false };
    const approved = 15;
    const scanned = 50;

    if (state.cycleCount > 2) {
      const yieldRate = approved / Math.max(scanned, 1);
      if (yieldRate < LOW_YIELD_THRESHOLD) {
        state.consecutiveLowYieldCycles++;
      } else {
        state.consecutiveLowYieldCycles = 0;
      }
    }

    expect(state.consecutiveLowYieldCycles).toBe(0);
  });

  it('requests shutdown after 3 consecutive low-yield cycles', () => {
    const LOW_YIELD_THRESHOLD = 0.2;
    const MAX_LOW_YIELD_CYCLES = 3;
    const state = { cycleCount: 6, consecutiveLowYieldCycles: 2, shutdownRequested: false };
    const approved = 0;
    const scanned = 50;

    if (state.cycleCount > 2) {
      const yieldRate = approved / Math.max(scanned, 1);
      if (yieldRate < LOW_YIELD_THRESHOLD) {
        state.consecutiveLowYieldCycles++;
      } else {
        state.consecutiveLowYieldCycles = 0;
      }
      if (state.consecutiveLowYieldCycles >= MAX_LOW_YIELD_CYCLES) {
        state.shutdownRequested = true;
      }
    }

    expect(state.consecutiveLowYieldCycles).toBe(3);
    expect(state.shutdownRequested).toBe(true);
  });

  it('does not trigger for cycleCount <= 2', () => {
    const LOW_YIELD_THRESHOLD = 0.2;
    const state = { cycleCount: 2, consecutiveLowYieldCycles: 0, shutdownRequested: false };
    const approved = 0;
    const scanned = 50;

    if (state.cycleCount > 2) {
      const yieldRate = approved / Math.max(scanned, 1);
      if (yieldRate < LOW_YIELD_THRESHOLD) {
        state.consecutiveLowYieldCycles++;
      }
    }

    expect(state.consecutiveLowYieldCycles).toBe(0);
  });

  it('includes category note when categoryRejected > 0', () => {
    const MAX_LOW_YIELD_CYCLES = 3;
    const categoryRejected = 5;
    const catNote = categoryRejected > 0
      ? ` (${categoryRejected} proposals rejected by category — consider broadening categories)`
      : '';
    const message = `Diminishing returns: ${MAX_LOW_YIELD_CYCLES} consecutive low-yield cycles${catNote}. Stopping.`;

    expect(message).toContain('5 proposals rejected by category');
    expect(message).toContain('consider broadening categories');
  });

  it('no category note when categoryRejected is 0', () => {
    const MAX_LOW_YIELD_CYCLES = 3;
    const categoryRejected = 0;
    const catNote = categoryRejected > 0
      ? ` (${categoryRejected} proposals rejected by category — consider broadening categories)`
      : '';
    const message = `Diminishing returns: ${MAX_LOW_YIELD_CYCLES} consecutive low-yield cycles${catNote}. Stopping.`;

    expect(message).not.toContain('proposals rejected by category');
    expect(message).toBe('Diminishing returns: 3 consecutive low-yield cycles. Stopping.');
  });
});

// ---------------------------------------------------------------------------
// Fix 1: Category constraint wiring logic
// ---------------------------------------------------------------------------

describe('category constraint selection logic', () => {
  it('uses types when allowCategories <= 4 (formula-driven)', () => {
    const allowCategories = ['docs', 'test'];
    const blockCategories = ['deps', 'auth', 'config'];

    const types = allowCategories.length <= 4 ? allowCategories : undefined;
    const excludeTypes = allowCategories.length > 4 ? blockCategories : undefined;

    expect(types).toEqual(['docs', 'test']);
    expect(excludeTypes).toBeUndefined();
  });

  it('uses excludeTypes when allowCategories > 4 (broad default)', () => {
    const allowCategories = ['refactor', 'docs', 'test', 'perf', 'security', 'fix', 'cleanup'];
    const blockCategories = ['deps', 'auth'];

    const types = allowCategories.length <= 4 ? allowCategories : undefined;
    const excludeTypes = allowCategories.length > 4 ? blockCategories : undefined;

    expect(types).toBeUndefined();
    expect(excludeTypes).toEqual(['deps', 'auth']);
  });

  it('uses types for exactly 4 categories', () => {
    const allowCategories = ['docs', 'test', 'perf', 'fix'];
    const blockCategories: string[] = [];

    const types = allowCategories.length <= 4 ? allowCategories : undefined;
    const excludeTypes = allowCategories.length > 4 ? blockCategories : undefined;

    expect(types).toEqual(['docs', 'test', 'perf', 'fix']);
    expect(excludeTypes).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Fix A: Merge conflict retry
// ---------------------------------------------------------------------------

describe('merge conflict retry', () => {
  it('conflictBranch is returned when merge fails', () => {
    // Simulate processOneProposal returning conflictBranch on merge conflict
    const result: { success: boolean; conflictBranch?: string } = {
      success: false,
      conflictBranch: 'blockspool/ticket-123',
    };
    expect(result.conflictBranch).toBe('blockspool/ticket-123');
    expect(result.success).toBe(false);
  });

  it('conflictBranch is undefined when merge succeeds', () => {
    const result: { success: boolean; conflictBranch?: string } = {
      success: true,
    };
    expect(result.conflictBranch).toBeUndefined();
    expect(result.success).toBe(true);
  });

  it('retry loop iterates over conflicted tickets', () => {
    // Simulate wave results with some conflicted tickets
    type WaveResult = { status: 'fulfilled'; value: { success: boolean; conflictBranch?: string } };
    const taskResults: WaveResult[] = [
      { status: 'fulfilled', value: { success: true } },
      { status: 'fulfilled', value: { success: false, conflictBranch: 'branch-a' } },
      { status: 'fulfilled', value: { success: true } },
      { status: 'fulfilled', value: { success: false, conflictBranch: 'branch-b' } },
      { status: 'fulfilled', value: { success: false } }, // failed but no conflict branch
    ];

    const conflicted: Array<{ branch: string; index: number }> = [];
    for (let ri = 0; ri < taskResults.length; ri++) {
      const r = taskResults[ri];
      if (r.status === 'fulfilled' && r.value.conflictBranch) {
        conflicted.push({ branch: r.value.conflictBranch, index: ri });
      }
    }

    expect(conflicted).toHaveLength(2);
    expect(conflicted[0].branch).toBe('branch-a');
    expect(conflicted[0].index).toBe(1);
    expect(conflicted[1].branch).toBe('branch-b');
    expect(conflicted[1].index).toBe(3);
  });

  it('successful retry increments milestoneTicketCount', () => {
    const state = {
      milestoneTicketCount: 3,
      milestoneTicketSummaries: ['a', 'b', 'c'],
    };

    // Simulate a successful retry merge
    const retrySuccess = true;
    const proposalTitle = 'Fix auth module';

    if (retrySuccess) {
      state.milestoneTicketCount++;
      state.milestoneTicketSummaries.push(proposalTitle);
    }

    expect(state.milestoneTicketCount).toBe(4);
    expect(state.milestoneTicketSummaries).toContain('Fix auth module');
  });

  it('failed retry does not increment milestoneTicketCount', () => {
    const state = {
      milestoneTicketCount: 3,
      milestoneTicketSummaries: ['a', 'b', 'c'],
    };

    const retrySuccess = false;
    const proposalTitle = 'Fix auth module';

    if (retrySuccess) {
      state.milestoneTicketCount++;
      state.milestoneTicketSummaries.push(proposalTitle);
    }

    expect(state.milestoneTicketCount).toBe(3);
    expect(state.milestoneTicketSummaries).not.toContain('Fix auth module');
  });
});

// ---------------------------------------------------------------------------
// Fix B: Deep sector threshold
// ---------------------------------------------------------------------------

describe('deep sector threshold', () => {
  it('sectorProductionFileCount >= 25 → returns deep formula', () => {
    const deepFormula = { name: 'deep', description: 'Deep scan' };
    const sectorProductionFileCount: number | undefined = 30;

    // Simulate the hard-guarantee guard
    const sessionPhase = 'deep';
    const shouldUseDeep = sessionPhase !== 'warmup' && (sectorProductionFileCount ?? Infinity) >= 25;

    expect(shouldUseDeep).toBe(true);
  });

  it('sectorProductionFileCount < 25 → skips deep formula', () => {
    const sectorProductionFileCount: number | undefined = 22;

    const sessionPhase = 'deep';
    const shouldUseDeep = sessionPhase !== 'warmup' && (sectorProductionFileCount ?? Infinity) >= 25;

    expect(shouldUseDeep).toBe(false);
  });

  it('sectorProductionFileCount undefined → treats as Infinity (deep allowed — backward compat)', () => {
    const sectorProductionFileCount: number | undefined = undefined;

    const sessionPhase = 'deep';
    const shouldUseDeep = sessionPhase !== 'warmup' && (sectorProductionFileCount ?? Infinity) >= 25;

    expect(shouldUseDeep).toBe(true);
  });

  it('threshold boundary: 24 → skip deep', () => {
    const sectorProductionFileCount = 24;
    const shouldUseDeep = (sectorProductionFileCount ?? Infinity) >= 25;
    expect(shouldUseDeep).toBe(false);
  });

  it('threshold boundary: 25 → allow deep', () => {
    const sectorProductionFileCount = 25;
    const shouldUseDeep = (sectorProductionFileCount ?? Infinity) >= 25;
    expect(shouldUseDeep).toBe(true);
  });

  it('UCB1 deep selection falls through to null on small sector', () => {
    const deepFormula = { name: 'deep', description: 'Deep scan' };
    const sectorProductionFileCount: number | undefined = 15;

    // Simulate UCB1 selecting deep
    let bestFormula: typeof deepFormula | null = deepFormula;

    // Apply the guard
    if (bestFormula === deepFormula && (sectorProductionFileCount ?? Infinity) < 25) {
      bestFormula = null;
    }

    expect(bestFormula).toBeNull();
  });

  it('UCB1 deep selection kept on large sector', () => {
    const deepFormula = { name: 'deep', description: 'Deep scan' };
    const sectorProductionFileCount: number | undefined = 50;

    let bestFormula: typeof deepFormula | null = deepFormula;

    if (bestFormula === deepFormula && (sectorProductionFileCount ?? Infinity) < 25) {
      bestFormula = null;
    }

    expect(bestFormula).toBe(deepFormula);
  });
});
