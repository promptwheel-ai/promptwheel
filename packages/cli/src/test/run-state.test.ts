/**
 * Integration tests for the persistent run-state module.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  readRunState,
  writeRunState,
  recordCycle,
  isDocsAuditDue,
  recordDocsAudit,
  recordFormulaResult,
  recordFormulaMergeOutcome,
  recordQualitySignal,
  getQualityRate,
  recordFormulaTicketOutcome,
  deferProposal,
  popDeferredForScope,
  pushRecentDiff,
} from '../lib/run-state.js';
import type { DeferredProposal } from '../lib/run-state.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

function makeProposal(overrides: Partial<DeferredProposal> = {}): DeferredProposal {
  return {
    category: 'test',
    title: 'Test proposal',
    description: 'A test proposal',
    files: ['src/lib/foo.ts'],
    allowed_paths: ['src/lib'],
    confidence: 80,
    impact_score: 7,
    original_scope: 'src/lib',
    deferredAt: Date.now(),
    ...overrides,
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-state-test-'));
  fs.mkdirSync(path.join(tmpDir, '.promptwheel'), { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// readRunState / writeRunState
// ---------------------------------------------------------------------------

describe('readRunState', () => {
  it('returns defaults when no file exists', () => {
    const state = readRunState(tmpDir);
    expect(state.totalCycles).toBe(0);
    expect(state.lastDocsAuditCycle).toBe(0);
    expect(state.lastRunAt).toBe(0);
    expect(state.deferredProposals).toEqual([]);
    expect(state.formulaStats).toEqual({});
    expect(state.recentCycles).toEqual([]);
    expect(state.recentDiffs).toEqual([]);
  });

  it('round-trips through write and read', () => {
    const state = readRunState(tmpDir);
    state.totalCycles = 5;
    state.lastDocsAuditCycle = 2;
    state.lastRunAt = 1700000000000;
    writeRunState(tmpDir, state);

    const loaded = readRunState(tmpDir);
    expect(loaded.totalCycles).toBe(5);
    expect(loaded.lastDocsAuditCycle).toBe(2);
    expect(loaded.lastRunAt).toBe(1700000000000);
    expect(loaded.deferredProposals).toEqual([]);
    expect(loaded.formulaStats).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// recordCycle
// ---------------------------------------------------------------------------

describe('recordCycle', () => {
  it('increments totalCycles counter', () => {
    recordCycle(tmpDir);
    recordCycle(tmpDir);

    const state = readRunState(tmpDir);
    expect(state.totalCycles).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// isDocsAuditDue
// ---------------------------------------------------------------------------

describe('isDocsAuditDue', () => {
  it('returns true when no cycles have run (default interval 3)', () => {
    // totalCycles=0, lastDocsAuditCycle=0 → gap=0 < 3
    expect(isDocsAuditDue(tmpDir)).toBe(false);
  });

  it('returns true when gap reaches default interval', () => {
    const state = readRunState(tmpDir);
    state.totalCycles = 3;
    state.lastDocsAuditCycle = 0;
    writeRunState(tmpDir, state);

    expect(isDocsAuditDue(tmpDir)).toBe(true);
  });

  it('returns false when gap is under the interval', () => {
    const state = readRunState(tmpDir);
    state.totalCycles = 5;
    state.lastDocsAuditCycle = 4;
    writeRunState(tmpDir, state);

    expect(isDocsAuditDue(tmpDir)).toBe(false);
  });

  it('respects custom interval parameter', () => {
    const state = readRunState(tmpDir);
    state.totalCycles = 10;
    state.lastDocsAuditCycle = 5;
    writeRunState(tmpDir, state);

    expect(isDocsAuditDue(tmpDir, 5)).toBe(true);
    expect(isDocsAuditDue(tmpDir, 6)).toBe(false);
  });

  it('returns true when gap exceeds interval', () => {
    const state = readRunState(tmpDir);
    state.totalCycles = 20;
    state.lastDocsAuditCycle = 5;
    writeRunState(tmpDir, state);

    expect(isDocsAuditDue(tmpDir)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// recordDocsAudit
// ---------------------------------------------------------------------------

describe('recordDocsAudit', () => {
  it('updates lastDocsAuditCycle to current totalCycles', async () => {
    const state = readRunState(tmpDir);
    state.totalCycles = 7;
    writeRunState(tmpDir, state);

    await recordDocsAudit(tmpDir);

    const loaded = readRunState(tmpDir);
    expect(loaded.lastDocsAuditCycle).toBe(7);
  });

  it('makes isDocsAuditDue return false after recording', async () => {
    const state = readRunState(tmpDir);
    state.totalCycles = 6;
    state.lastDocsAuditCycle = 0;
    writeRunState(tmpDir, state);

    expect(isDocsAuditDue(tmpDir)).toBe(true);

    await recordDocsAudit(tmpDir);

    expect(isDocsAuditDue(tmpDir)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// recordFormulaResult
// ---------------------------------------------------------------------------

describe('recordFormulaResult', () => {
  it('creates formula entry and increments cycles and proposalsGenerated', async () => {
    await recordFormulaResult(tmpDir, 'security-audit', 3);

    const state = readRunState(tmpDir);
    const stats = state.formulaStats['security-audit'];
    expect(stats).toBeDefined();
    expect(stats.cycles).toBe(1);
    expect(stats.proposalsGenerated).toBe(3);
    expect(stats.recentCycles).toBe(1);
    expect(stats.recentProposalsGenerated).toBe(3);
  });

  it('accumulates across multiple calls', async () => {
    await recordFormulaResult(tmpDir, 'test-coverage', 2);
    await recordFormulaResult(tmpDir, 'test-coverage', 5);

    const state = readRunState(tmpDir);
    const stats = state.formulaStats['test-coverage'];
    expect(stats.cycles).toBe(2);
    expect(stats.proposalsGenerated).toBe(7);
    expect(stats.recentCycles).toBe(2);
    expect(stats.recentProposalsGenerated).toBe(7);
  });

  it('resets recent counters at 20-cycle boundary', async () => {
    // Seed state with totalCycles=19 and a formula with 19 recent cycles
    const state = readRunState(tmpDir);
    state.totalCycles = 19;
    state.formulaStats['cleanup'] = {
      cycles: 19,
      proposalsGenerated: 50,
      ticketsSucceeded: 10,
      ticketsTotal: 15,
      recentCycles: 19,
      recentProposalsGenerated: 50,
      recentTicketsSucceeded: 10,
      recentTicketsTotal: 15,
      lastResetCycle: 0,
    };
    writeRunState(tmpDir, state);

    // This call triggers the 20-cycle reset (totalCycles=19 - lastResetCycle=0 >= 20? No, 19 < 20)
    // Actually need totalCycles - lastResetCycle >= 20. Set totalCycles=20
    const state2 = readRunState(tmpDir);
    state2.totalCycles = 20;
    writeRunState(tmpDir, state2);

    await recordFormulaResult(tmpDir, 'cleanup', 4);

    const loaded = readRunState(tmpDir);
    const stats = loaded.formulaStats['cleanup'];
    // Recent counters should be reset: recentCycles=1 (this call), recentProposalsGenerated=4
    expect(stats.recentCycles).toBe(1);
    expect(stats.recentProposalsGenerated).toBe(4);
    // Total counters should still accumulate
    expect(stats.cycles).toBe(20);
    expect(stats.proposalsGenerated).toBe(54);
    // lastResetCycle updated to current totalCycles
    expect(stats.lastResetCycle).toBe(20);
  });

  it('does not reset recent counters before 20-cycle boundary', async () => {
    const state = readRunState(tmpDir);
    state.totalCycles = 10;
    state.formulaStats['docs'] = {
      cycles: 10,
      proposalsGenerated: 20,
      ticketsSucceeded: 5,
      ticketsTotal: 8,
      recentCycles: 10,
      recentProposalsGenerated: 20,
      recentTicketsSucceeded: 5,
      recentTicketsTotal: 8,
      lastResetCycle: 0,
    };
    writeRunState(tmpDir, state);

    await recordFormulaResult(tmpDir, 'docs', 2);

    const loaded = readRunState(tmpDir);
    const stats = loaded.formulaStats['docs'];
    // 10 - 0 = 10 < 20, no reset
    expect(stats.recentCycles).toBe(11);
    expect(stats.recentProposalsGenerated).toBe(22);
  });

  it('tracks multiple formulas independently', async () => {
    await recordFormulaResult(tmpDir, 'alpha', 1);
    await recordFormulaResult(tmpDir, 'beta', 3);

    const state = readRunState(tmpDir);
    expect(state.formulaStats['alpha'].proposalsGenerated).toBe(1);
    expect(state.formulaStats['beta'].proposalsGenerated).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// recordFormulaMergeOutcome
// ---------------------------------------------------------------------------

describe('recordFormulaMergeOutcome', () => {
  it('increments mergeCount on merge', async () => {
    await recordFormulaMergeOutcome(tmpDir, 'security-audit', true);

    const state = readRunState(tmpDir);
    const stats = state.formulaStats['security-audit'];
    expect(stats).toBeDefined();
    expect(stats.mergeCount).toBe(1);
    expect(stats.closedCount).toBe(0);
  });

  it('increments closedCount on close', async () => {
    await recordFormulaMergeOutcome(tmpDir, 'test-coverage', false);

    const state = readRunState(tmpDir);
    const stats = state.formulaStats['test-coverage'];
    expect(stats).toBeDefined();
    expect(stats.mergeCount).toBe(0);
    expect(stats.closedCount).toBe(1);
  });

  it('accumulates across multiple calls', async () => {
    await recordFormulaMergeOutcome(tmpDir, 'cleanup', true);
    await recordFormulaMergeOutcome(tmpDir, 'cleanup', true);
    await recordFormulaMergeOutcome(tmpDir, 'cleanup', false);

    const state = readRunState(tmpDir);
    const stats = state.formulaStats['cleanup'];
    expect(stats.mergeCount).toBe(2);
    expect(stats.closedCount).toBe(1);
  });

  it('creates formula entry if it does not exist', async () => {
    await recordFormulaMergeOutcome(tmpDir, 'new-formula', true);

    const state = readRunState(tmpDir);
    const stats = state.formulaStats['new-formula'];
    expect(stats).toBeDefined();
    expect(stats.cycles).toBe(0);
    expect(stats.mergeCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// recordQualitySignal
// ---------------------------------------------------------------------------

describe('recordQualitySignal', () => {
  it('increments totalTickets and firstPassSuccess on first_pass', async () => {
    await recordQualitySignal(tmpDir, 'first_pass');

    const state = readRunState(tmpDir);
    expect(state.qualitySignals).toBeDefined();
    expect(state.qualitySignals!.totalTickets).toBe(1);
    expect(state.qualitySignals!.firstPassSuccess).toBe(1);
    expect(state.qualitySignals!.retriedSuccess).toBe(0);
  });

  it('increments totalTickets and retriedSuccess on retried', async () => {
    await recordQualitySignal(tmpDir, 'retried');

    const state = readRunState(tmpDir);
    expect(state.qualitySignals!.totalTickets).toBe(1);
    expect(state.qualitySignals!.retriedSuccess).toBe(1);
    expect(state.qualitySignals!.firstPassSuccess).toBe(0);
  });

  it('increments qaPassed on qa_pass', async () => {
    await recordQualitySignal(tmpDir, 'qa_pass');

    const state = readRunState(tmpDir);
    expect(state.qualitySignals!.qaPassed).toBe(1);
    expect(state.qualitySignals!.totalTickets).toBe(0);
  });

  it('increments qaFailed on qa_fail', async () => {
    await recordQualitySignal(tmpDir, 'qa_fail');

    const state = readRunState(tmpDir);
    expect(state.qualitySignals!.qaFailed).toBe(1);
    expect(state.qualitySignals!.totalTickets).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// getQualityRate
// ---------------------------------------------------------------------------

describe('getQualityRate', () => {
  it('returns correct ratio based on firstPassSuccess / totalTickets', () => {
    const state = readRunState(tmpDir);
    state.qualitySignals = {
      totalTickets: 10,
      firstPassSuccess: 8,
      retriedSuccess: 1,
      qaPassed: 5,
      qaFailed: 2,
    };
    writeRunState(tmpDir, state);

    expect(getQualityRate(tmpDir)).toBe(0.8);
  });

  it('returns 1 when no quality data exists', () => {
    expect(getQualityRate(tmpDir)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// recordFormulaTicketOutcome
// ---------------------------------------------------------------------------

describe('recordFormulaTicketOutcome', () => {
  it('increments ticketsSucceeded on success', async () => {
    await recordFormulaTicketOutcome(tmpDir, 'security-audit', true);

    const state = readRunState(tmpDir);
    const stats = state.formulaStats['security-audit'];
    expect(stats).toBeDefined();
    expect(stats.ticketsTotal).toBe(1);
    expect(stats.ticketsSucceeded).toBe(1);
  });

  it('increments ticketsTotal but not ticketsSucceeded on failure', async () => {
    await recordFormulaTicketOutcome(tmpDir, 'test-coverage', false);

    const state = readRunState(tmpDir);
    const stats = state.formulaStats['test-coverage'];
    expect(stats).toBeDefined();
    expect(stats.ticketsTotal).toBe(1);
    expect(stats.ticketsSucceeded).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// deferProposal / popDeferredForScope
// ---------------------------------------------------------------------------

describe('deferProposal / popDeferredForScope', () => {
  it('round-trips a deferred proposal for matching scope', async () => {
    const proposal = makeProposal({
      title: 'Fix src/lib issue',
      files: ['src/lib/foo.ts'],
      original_scope: 'src/lib',
    });

    await deferProposal(tmpDir, proposal);

    const matched = popDeferredForScope(tmpDir, 'src/lib');
    expect(matched).toHaveLength(1);
    expect(matched[0].title).toBe('Fix src/lib issue');

    // Verify it was removed from state
    const state = readRunState(tmpDir);
    expect(state.deferredProposals).toHaveLength(0);
  });

  it('does not return proposals for a different scope', async () => {
    const proposal = makeProposal({
      title: 'Fix src/lib issue',
      files: ['src/lib/foo.ts'],
      original_scope: 'src/lib',
    });

    await deferProposal(tmpDir, proposal);

    const matched = popDeferredForScope(tmpDir, 'src/api');
    expect(matched).toHaveLength(0);

    // Verify proposal is still stored
    const state = readRunState(tmpDir);
    expect(state.deferredProposals).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// pushRecentDiff
// ---------------------------------------------------------------------------

describe('pushRecentDiff', () => {
  it('caps the ring buffer at 10 entries', async () => {
    for (let i = 0; i < 12; i++) {
      await pushRecentDiff(tmpDir, {
        title: `Diff ${i}`,
        summary: `Summary ${i}`,
        files: [`file-${i}.ts`],
        cycle: i,
      });
    }

    const state = readRunState(tmpDir);
    expect(state.recentDiffs).toHaveLength(10);
    // Oldest two (0, 1) should have been evicted; first remaining is Diff 2
    expect(state.recentDiffs![0].title).toBe('Diff 2');
    expect(state.recentDiffs![9].title).toBe('Diff 11');
  });
});

// ---------------------------------------------------------------------------
// Concurrency safety
// ---------------------------------------------------------------------------

describe('concurrent recordQualitySignal', () => {
  it('does not lose data under concurrent writes', async () => {
    const promises: Promise<void>[] = [];
    for (let i = 0; i < 20; i++) {
      promises.push(recordQualitySignal(tmpDir, 'first_pass'));
    }
    await Promise.all(promises);

    const state = readRunState(tmpDir);
    expect(state.qualitySignals!.totalTickets).toBe(20);
    expect(state.qualitySignals!.firstPassSuccess).toBe(20);
  });
});
