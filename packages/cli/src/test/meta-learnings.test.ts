/**
 * Tests for meta-learning extraction (aggregate pattern detection).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { extractMetaLearnings, type MetaLearningContext } from '../lib/meta-learnings.js';
import { type Learning } from '../lib/learnings.js';
import { saveQaStats, type QaStatsStore, type QaCommandStats } from '../lib/qa-stats.js';
import type { TicketOutcome } from '../lib/run-history.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

function learningsFile(): string {
  return path.join(tmpDir, '.promptwheel', 'learnings.json');
}

function readLearningsRaw(): Learning[] {
  if (!fs.existsSync(learningsFile())) return [];
  return JSON.parse(fs.readFileSync(learningsFile(), 'utf8'));
}

function makeLearning(overrides: Partial<Learning> = {}): Learning {
  return {
    id: 'test-1',
    text: 'Test learning',
    category: 'gotcha',
    source: { type: 'qa_failure' },
    tags: [],
    weight: 50,
    created_at: new Date().toISOString(),
    last_confirmed_at: new Date().toISOString(),
    access_count: 0,
    ...overrides,
  };
}

function makeOutcome(overrides: Partial<TicketOutcome> = {}): TicketOutcome {
  return {
    id: '',
    title: 'Test ticket',
    category: 'refactor',
    status: 'completed',
    ...overrides,
  };
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

function makeContext(overrides: Partial<MetaLearningContext> = {}): MetaLearningContext {
  return {
    projectRoot: tmpDir,
    cycleOutcomes: [],
    allOutcomes: [],
    learningsEnabled: true,
    existingLearnings: [],
    ...overrides,
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meta-learnings-test-'));
  const dir = path.join(tmpDir, '.promptwheel');
  fs.mkdirSync(dir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// extractMetaLearnings
// ---------------------------------------------------------------------------

describe('extractMetaLearnings', () => {
  it('returns 0 when learnings disabled', () => {
    const count = extractMetaLearnings(makeContext({ learningsEnabled: false }));
    expect(count).toBe(0);
  });

  it('returns 0 with insufficient outcomes', () => {
    const count = extractMetaLearnings(makeContext({
      allOutcomes: [makeOutcome()],
    }));
    expect(count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// checkConfidenceMiscalibration
// ---------------------------------------------------------------------------

describe('confidence miscalibration detection', () => {
  it('detects high failure rate (>40%)', () => {
    const outcomes = [
      ...Array.from({ length: 6 }, () => makeOutcome({ status: 'failed' })),
      ...Array.from({ length: 4 }, () => makeOutcome({ status: 'completed' })),
    ];

    const count = extractMetaLearnings(makeContext({ allOutcomes: outcomes }));
    expect(count).toBeGreaterThanOrEqual(1);

    const learnings = readLearningsRaw();
    const miscal = learnings.find(l => l.text.includes('High failure rate'));
    expect(miscal).toBeDefined();
    expect(miscal!.source.type).toBe('process_insight');
  });

  it('does not trigger at 30% failure rate', () => {
    const outcomes = [
      ...Array.from({ length: 3 }, () => makeOutcome({ status: 'failed' })),
      ...Array.from({ length: 7 }, () => makeOutcome({ status: 'completed' })),
    ];

    extractMetaLearnings(makeContext({ allOutcomes: outcomes }));

    const learnings = readLearningsRaw();
    const miscal = learnings.find(l => l.text.includes('High failure rate'));
    expect(miscal).toBeUndefined();
  });

  it('deduplicates — does not add twice', () => {
    const outcomes = Array.from({ length: 10 }, () => makeOutcome({ status: 'failed' }));
    const existing = [makeLearning({
      text: 'High failure rate across recent cycles',
      source: { type: 'process_insight' },
    })];

    const count = extractMetaLearnings(makeContext({
      allOutcomes: outcomes,
      existingLearnings: existing,
    }));

    // Should not add a new one because similar text exists
    const learnings = readLearningsRaw();
    const miscals = learnings.filter(l => l.text.includes('High failure rate'));
    expect(miscals).toHaveLength(0);
    // The function should return 0 for this check since it was deduped
  });
});

// ---------------------------------------------------------------------------
// checkCategoryFailurePatterns
// ---------------------------------------------------------------------------

describe('category failure pattern detection', () => {
  it('detects category with >50% failure rate over 5+ tickets', () => {
    const outcomes = [
      ...Array.from({ length: 4 }, () => makeOutcome({ category: 'refactor', status: 'failed' })),
      ...Array.from({ length: 1 }, () => makeOutcome({ category: 'refactor', status: 'completed' })),
      ...Array.from({ length: 5 }, () => makeOutcome({ category: 'types', status: 'completed' })),
    ];

    extractMetaLearnings(makeContext({ allOutcomes: outcomes }));

    const learnings = readLearningsRaw();
    const catFail = learnings.find(l => l.text.includes('Category refactor'));
    expect(catFail).toBeDefined();
    expect(catFail!.tags).toContain('category:refactor');
  });

  it('does not trigger for category with <5 tickets', () => {
    const outcomes = [
      ...Array.from({ length: 3 }, () => makeOutcome({ category: 'security', status: 'failed' })),
    ];

    extractMetaLearnings(makeContext({ allOutcomes: outcomes }));

    const learnings = readLearningsRaw();
    const catFail = learnings.find(l => l.text.includes('Category security'));
    expect(catFail).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// checkTimeoutPatterns
// ---------------------------------------------------------------------------

describe('timeout pattern detection', () => {
  it('detects command with >20% timeout rate', () => {
    const store: QaStatsStore = {
      commands: {
        test: makeStats({ name: 'test', totalRuns: 10, timeouts: 4 }),
      },
      lastUpdated: 0,
      disabledCommands: [],
      lastCalibratedQualityRate: null,
    };
    saveQaStats(tmpDir, store);

    extractMetaLearnings(makeContext({ allOutcomes: Array.from({ length: 5 }, () => makeOutcome()) }));

    const learnings = readLearningsRaw();
    const timeout = learnings.find(l => l.text.includes('times out frequently'));
    expect(timeout).toBeDefined();
    expect(timeout!.tags).toContain('cmd:test');
    expect(timeout!.category).toBe('gotcha');
  });

  it('does not trigger with <5 total runs', () => {
    const store: QaStatsStore = {
      commands: {
        test: makeStats({ name: 'test', totalRuns: 3, timeouts: 2 }),
      },
      lastUpdated: 0,
      disabledCommands: [],
      lastCalibratedQualityRate: null,
    };
    saveQaStats(tmpDir, store);

    extractMetaLearnings(makeContext({ allOutcomes: Array.from({ length: 5 }, () => makeOutcome()) }));

    const learnings = readLearningsRaw();
    const timeout = learnings.find(l => l.text.includes('times out frequently'));
    expect(timeout).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// checkQaCommandReliability
// ---------------------------------------------------------------------------

describe('QA command reliability detection', () => {
  it('detects single command responsible for >60% of failures', () => {
    const store: QaStatsStore = {
      commands: {
        lint: makeStats({ name: 'lint', totalRuns: 20, failures: 8 }),
        test: makeStats({ name: 'test', totalRuns: 20, failures: 2 }),
      },
      lastUpdated: 0,
      disabledCommands: [],
      lastCalibratedQualityRate: null,
    };
    saveQaStats(tmpDir, store);

    extractMetaLearnings(makeContext({ allOutcomes: Array.from({ length: 5 }, () => makeOutcome()) }));

    const learnings = readLearningsRaw();
    const reliability = learnings.find(l => l.text.includes('primary QA failure source'));
    expect(reliability).toBeDefined();
    expect(reliability!.text).toContain('lint');
    expect(reliability!.tags).toContain('cmd:lint');
  });

  it('does not trigger when failures are evenly distributed', () => {
    const store: QaStatsStore = {
      commands: {
        lint: makeStats({ name: 'lint', totalRuns: 20, failures: 5 }),
        test: makeStats({ name: 'test', totalRuns: 20, failures: 5 }),
      },
      lastUpdated: 0,
      disabledCommands: [],
      lastCalibratedQualityRate: null,
    };
    saveQaStats(tmpDir, store);

    extractMetaLearnings(makeContext({ allOutcomes: Array.from({ length: 5 }, () => makeOutcome()) }));

    const learnings = readLearningsRaw();
    const reliability = learnings.find(l => l.text.includes('primary QA failure source'));
    expect(reliability).toBeUndefined();
  });

  it('does not trigger with only 1 command', () => {
    const store: QaStatsStore = {
      commands: {
        test: makeStats({ name: 'test', totalRuns: 20, failures: 15 }),
      },
      lastUpdated: 0,
      disabledCommands: [],
      lastCalibratedQualityRate: null,
    };
    saveQaStats(tmpDir, store);

    extractMetaLearnings(makeContext({ allOutcomes: Array.from({ length: 5 }, () => makeOutcome()) }));

    const learnings = readLearningsRaw();
    const reliability = learnings.find(l => l.text.includes('primary QA failure source'));
    expect(reliability).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Combined behavior
// ---------------------------------------------------------------------------

describe('combined meta-learning extraction', () => {
  it('generates multiple insights in one pass', () => {
    // High failure rate + timeout pattern + reliability issue
    const outcomes = Array.from({ length: 10 }, () => makeOutcome({ status: 'failed' }));

    const store: QaStatsStore = {
      commands: {
        lint: makeStats({ name: 'lint', totalRuns: 10, timeouts: 5, failures: 8 }),
        test: makeStats({ name: 'test', totalRuns: 10, failures: 1 }),
      },
      lastUpdated: 0,
      disabledCommands: [],
      lastCalibratedQualityRate: null,
    };
    saveQaStats(tmpDir, store);

    const count = extractMetaLearnings(makeContext({ allOutcomes: outcomes }));
    expect(count).toBeGreaterThanOrEqual(2);

    const learnings = readLearningsRaw();
    expect(learnings.some(l => l.text.includes('High failure rate'))).toBe(true);
    expect(learnings.some(l => l.text.includes('times out frequently'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Formula effectiveness feedback
// ---------------------------------------------------------------------------

function writeRunState(formulaStats: Record<string, unknown>): void {
  const runStatePath = path.join(tmpDir, '.promptwheel', 'run-state.json');
  const state = {
    totalCycles: 10,
    lastDocsAuditCycle: 0,
    lastRunAt: Date.now(),
    deferredProposals: [],
    formulaStats,
  };
  fs.writeFileSync(runStatePath, JSON.stringify(state, null, 2));
}

describe('formula effectiveness feedback', () => {
  it('creates learning for formula with < 40% success rate over 5+ tickets', () => {
    writeRunState({
      'security-audit': {
        cycles: 10,
        proposalsGenerated: 10,
        ticketsSucceeded: 1,
        ticketsTotal: 6,
        recentCycles: 10,
        recentProposalsGenerated: 10,
        recentTicketsSucceeded: 1,
        recentTicketsTotal: 6,
        lastResetCycle: 0,
        mergeCount: 0,
        closedCount: 0,
      },
    });

    const count = extractMetaLearnings(makeContext({
      allOutcomes: Array.from({ length: 5 }, () => makeOutcome()),
    }));
    expect(count).toBeGreaterThanOrEqual(1);

    const learnings = readLearningsRaw();
    const formulaLearning = learnings.find(l => l.text.includes('Formula security-audit has low success rate'));
    expect(formulaLearning).toBeDefined();
    expect(formulaLearning!.tags).toContain('formula:security-audit');
    expect(formulaLearning!.source.type).toBe('process_insight');
  });

  it('does not create learning for formula with > 60% success rate', () => {
    writeRunState({
      'test-coverage': {
        cycles: 10,
        proposalsGenerated: 10,
        ticketsSucceeded: 8,
        ticketsTotal: 10,
        recentCycles: 10,
        recentProposalsGenerated: 10,
        recentTicketsSucceeded: 8,
        recentTicketsTotal: 10,
        lastResetCycle: 0,
        mergeCount: 0,
        closedCount: 0,
      },
    });

    extractMetaLearnings(makeContext({
      allOutcomes: Array.from({ length: 5 }, () => makeOutcome()),
    }));

    const learnings = readLearningsRaw();
    const formulaLearning = learnings.find(l => l.text.includes('Formula test-coverage has low success rate'));
    expect(formulaLearning).toBeUndefined();
  });

  it('does not create learning for formula with < 5 tickets', () => {
    writeRunState({
      'cleanup': {
        cycles: 2,
        proposalsGenerated: 3,
        ticketsSucceeded: 0,
        ticketsTotal: 3,
        recentCycles: 2,
        recentProposalsGenerated: 3,
        recentTicketsSucceeded: 0,
        recentTicketsTotal: 3,
        lastResetCycle: 0,
        mergeCount: 0,
        closedCount: 0,
      },
    });

    extractMetaLearnings(makeContext({
      allOutcomes: Array.from({ length: 5 }, () => makeOutcome()),
    }));

    const learnings = readLearningsRaw();
    const formulaLearning = learnings.find(l => l.text.includes('Formula cleanup has low success rate'));
    expect(formulaLearning).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Formula merge rate feedback
// ---------------------------------------------------------------------------

describe('formula merge rate feedback', () => {
  it('creates learning for formula with < 50% merge rate over 3+ outcomes', () => {
    writeRunState({
      'security-audit': {
        cycles: 10,
        proposalsGenerated: 10,
        ticketsSucceeded: 5,
        ticketsTotal: 10,
        recentCycles: 10,
        recentProposalsGenerated: 10,
        recentTicketsSucceeded: 5,
        recentTicketsTotal: 10,
        lastResetCycle: 0,
        mergeCount: 1,
        closedCount: 3,
      },
    });

    const count = extractMetaLearnings(makeContext({
      allOutcomes: Array.from({ length: 5 }, () => makeOutcome()),
    }));
    expect(count).toBeGreaterThanOrEqual(1);

    const learnings = readLearningsRaw();
    const mergeLearning = learnings.find(l => l.text.includes('Formula security-audit PRs are frequently closed'));
    expect(mergeLearning).toBeDefined();
    expect(mergeLearning!.tags).toContain('formula:security-audit');
  });

  it('does not create duplicate formula learnings', () => {
    writeRunState({
      'security-audit': {
        cycles: 10,
        proposalsGenerated: 10,
        ticketsSucceeded: 1,
        ticketsTotal: 6,
        recentCycles: 10,
        recentProposalsGenerated: 10,
        recentTicketsSucceeded: 1,
        recentTicketsTotal: 6,
        lastResetCycle: 0,
        mergeCount: 0,
        closedCount: 0,
      },
    });

    const existing = [makeLearning({
      text: 'Formula security-audit has low success rate',
      source: { type: 'process_insight' },
    })];

    extractMetaLearnings(makeContext({
      allOutcomes: Array.from({ length: 5 }, () => makeOutcome()),
      existingLearnings: existing,
    }));

    const learnings = readLearningsRaw();
    const formulaLearnings = learnings.filter(l => l.text.includes('Formula security-audit has low success rate'));
    expect(formulaLearnings).toHaveLength(0);
  });
});
