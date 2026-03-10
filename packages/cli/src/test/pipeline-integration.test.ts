/**
 * Integration tests for the core pipeline:
 * processOneProposal() → soloRunTicket()
 *
 * Tests three critical paths:
 * 1. Happy path: proposals found → execution succeeds → result recorded
 * 2. QA failure: execution fails QA → result indicates failure
 * 3. Scope violation: agent touches forbidden files → scope expanded → retry succeeds
 *
 * Strategy: Mock `soloRunTicket` (the execution boundary) and the database adapter,
 * but exercise the real `processOneProposal` logic including retries, scope expansion,
 * and direct/PR mode branching.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { TicketProposal } from '@promptwheel/core/scout';

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('../lib/solo-ticket.js', () => ({
  soloRunTicket: vi.fn(),
  captureQaBaseline: vi.fn().mockResolvedValue(new Map()),
  baselineToPassFail: vi.fn().mockReturnValue(new Map()),
}));

vi.mock('@promptwheel/core/repos', () => ({
  tickets: {
    create: vi.fn().mockResolvedValue({
      id: 'tkt_mock',
      projectId: 'proj_mock',
      title: 'Mock ticket',
      description: 'Mock description',
      allowedPaths: ['src/**'],
      forbiddenPaths: ['node_modules'],
      verificationCommands: [],
      status: 'open',
    }),
    updateStatus: vi.fn().mockResolvedValue(undefined),
    getById: vi.fn().mockResolvedValue({
      id: 'tkt_mock',
      projectId: 'proj_mock',
      title: 'Mock ticket',
      description: 'Mock description',
      allowedPaths: ['src/**'],
      forbiddenPaths: ['node_modules'],
      verificationCommands: [],
      status: 'in_progress',
    }),
  },
  runs: {
    create: vi.fn().mockResolvedValue({ id: 'run_mock', projectId: 'proj_mock', type: 'worker', ticketId: 'tkt_mock' }),
    markSuccess: vi.fn().mockResolvedValue(undefined),
    markFailure: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../lib/run-state.js', () => ({
  recordQualitySignal: vi.fn(),
  recordCategoryOutcome: vi.fn(),
  pushRecentDiff: vi.fn(),
  deferProposal: vi.fn(),
  readRunState: vi.fn().mockReturnValue({
    totalCycles: 1,
    deferredProposals: [],
    recentDiffs: [],
    lensZeroYieldPairs: [],
  }),
}));

vi.mock('../lib/learnings.js', () => ({
  selectRelevant: vi.fn().mockReturnValue([]),
  formatLearningsForPrompt: vi.fn().mockReturnValue(''),
  extractTags: vi.fn().mockReturnValue([]),
  addLearning: vi.fn(),
  confirmLearning: vi.fn(),
  recordAccess: vi.fn(),
  recordApplication: vi.fn(),
  recordOutcome: vi.fn(),
}));

vi.mock('../lib/dedup-memory.js', () => ({
  recordDedupEntry: vi.fn(),
  loadDedupMemory: vi.fn().mockReturnValue([]),
}));

vi.mock('../lib/sectors.js', () => ({
  recordTicketOutcome: vi.fn(),
  recordMergeOutcome: vi.fn(),
  computeCoverage: vi.fn().mockReturnValue(null),
}));

vi.mock('../lib/file-cooldown.js', () => ({
  recordPrFiles: vi.fn(),
}));

vi.mock('../lib/error-ledger.js', () => ({
  appendErrorLedger: vi.fn(),
}));

vi.mock('../lib/pr-outcomes.js', () => ({
  appendPrOutcome: vi.fn(),
}));

vi.mock('../lib/solo-git.js', () => ({
  mergeTicketToMilestone: vi.fn().mockResolvedValue({ success: true }),
  deleteTicketBranch: vi.fn().mockResolvedValue(undefined),
  autoMergePr: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../lib/guidelines.js', () => ({
  formatGuidelinesForPrompt: vi.fn().mockReturnValue(''),
}));

vi.mock('../lib/failure-classifier.js', () => ({
  classifyFailure: vi.fn().mockReturnValue({ reason: 'unknown', root_cause: 'unknown' }),
}));

vi.mock('../lib/solo-auto-utils.js', () => ({
  computeTicketTimeout: vi.fn().mockReturnValue(120000),
}));

vi.mock('../lib/solo-utils.js', () => ({
  normalizeQaConfig: vi.fn().mockReturnValue([]),
}));

vi.mock('../lib/wave-scheduling.js', () => ({
  partitionIntoWaves: vi.fn().mockImplementation((proposals: TicketProposal[]) => [proposals]),
  enrichWithSymbols: vi.fn().mockImplementation((proposals: TicketProposal[]) => proposals),
}));

vi.mock('@promptwheel/core/waves/shared', () => ({
  orderMergeSequence: vi.fn().mockImplementation((proposals: TicketProposal[]) => proposals),
}));

vi.mock('@promptwheel/core/codebase-index', () => ({
  loadAstCache: vi.fn().mockReturnValue(null),
}));

vi.mock('../lib/dedup.js', () => ({
  getAdaptiveParallelCount: vi.fn().mockReturnValue(1),
  sleep: vi.fn().mockResolvedValue(undefined),
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

let tmpDir: string;

function ensurePromptwheelDir(): void {
  fs.mkdirSync(path.join(tmpDir, '.promptwheel'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, '.promptwheel', 'run-state.json'), JSON.stringify({
    totalCycles: 0, deferredProposals: [], recentDiffs: [], lensZeroYieldPairs: [],
  }));
}

function makeProposal(overrides: Partial<TicketProposal> = {}): TicketProposal {
  return {
    id: `scout-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    category: 'refactor',
    title: 'Refactor utils module',
    description: 'Clean up helper functions for better readability',
    acceptance_criteria: ['Tests pass', 'No lint errors'],
    verification_commands: ['npm test'],
    allowed_paths: ['src/utils.ts'],
    files: ['src/utils.ts'],
    confidence: 80,
    impact_score: 5,
    rationale: 'Improve code quality and maintainability',
    estimated_complexity: 'simple',
    ...overrides,
  };
}

function makeState(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    repoRoot: tmpDir,
    cycleCount: 1,
    cycleOutcomes: [],
    allTicketOutcomes: [],
    options: { verbose: false, yes: true },
    autoConf: { learningsEnabled: false, minConfidence: 20, learningsDecayRate: 3, learningsBudget: 2000 },
    config: { auto: {} },
    runMode: 'planning' as const,
    effectiveMinConfidence: 20,
    consecutiveLowYieldCycles: 0,
    consecutiveIdleCycles: 0,
    consecutiveFailureCycles: 0,
    backpressureRetries: 0,
    _prevCycleCompleted: 0,
    pendingPrUrls: [] as string[],
    allPrUrls: [] as string[],
    maxPrs: 10,
    totalPrsCreated: 0,
    totalFailed: 0,
    totalMergedPrs: 0,
    totalClosedPrs: 0,
    deliveryMode: 'pr',
    milestoneMode: false,
    milestoneBranch: undefined,
    milestoneWorktreePath: undefined,
    milestoneTicketCount: 0,
    milestoneTicketSummaries: [] as string[],
    totalMilestonePrs: 0,
    milestoneNumber: 0,
    batchSize: undefined,
    useDraft: false,
    directBranch: 'main',
    directFinalize: 'none',
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
    excludePatterns: [],
    dedupMemory: [],
    completedDirectTickets: [] as Array<{ title: string; category: string; files: string[] }>,
    allTraceAnalyses: [],
    prMetaMap: new Map(),
    currentFormulaName: 'default',
    tasteProfile: { preferredCategories: [], avoidCategories: [], preferredScopes: [] },
    guidelines: null,
    metadataBlock: null,
    qaBaseline: null,
    shutdownRequested: false,
    shutdownReason: null,
    currentlyProcessing: false,
    displayAdapter: {
      log: vi.fn(),
      progressUpdate: vi.fn(),
      drillStateChanged: vi.fn(),
      destroy: vi.fn(),
      ticketAdded: vi.fn(),
      ticketProgress: vi.fn(),
      ticketDone: vi.fn(),
      ticketCompleted: vi.fn(),
      ticketFailed: vi.fn(),
      ticketRawOutput: vi.fn(),
      sectorMapUpdate: vi.fn(),
    },
    adapter: { run: vi.fn().mockResolvedValue([]), get: vi.fn().mockResolvedValue(null) },
    project: { id: 'proj_mock', name: 'test-project' },
    deps: {},
    detectedBaseBranch: 'main',
    scoutBackend: undefined,
    executionBackend: undefined,
    integrations: { providers: [] },
    _pendingIntegrationProposals: [],
    integrationLastRun: {},
    repos: [],
    repoIndex: 0,
    ...overrides,
  };
}

// ── Setup / Teardown ─────────────────────────────────────────────────────────

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-integration-'));
  ensurePromptwheelDir();
  vi.clearAllMocks();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Pipeline: Happy Path', () => {
  it('returns success with PR URL when execution succeeds', async () => {
    const { soloRunTicket } = await import('../lib/solo-ticket.js');
    const { processOneProposal } = await import('../lib/solo-auto-execute.js');

    vi.mocked(soloRunTicket).mockResolvedValue({
      success: true,
      durationMs: 5000,
      prUrl: 'https://github.com/test/repo/pull/1',
      branchName: 'promptwheel/tkt_mock',
      changedFiles: ['src/utils.ts'],
    });

    const state = makeState();
    const result = await processOneProposal(state as any, makeProposal(), '1/1', null);

    expect(result.success).toBe(true);
    expect(result.prUrl).toBe('https://github.com/test/repo/pull/1');
  });

  it('creates ticket and run in database', async () => {
    const { soloRunTicket } = await import('../lib/solo-ticket.js');
    const { processOneProposal } = await import('../lib/solo-auto-execute.js');
    const { tickets, runs } = await import('@promptwheel/core/repos');

    vi.mocked(soloRunTicket).mockResolvedValue({
      success: true, durationMs: 5000, branchName: 'promptwheel/tkt_mock',
    });

    await processOneProposal(makeState() as any, makeProposal(), '1/1', null);

    expect(vi.mocked(tickets.create)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        title: 'Refactor utils module',
        projectId: 'proj_mock',
      }),
    );
    expect(vi.mocked(tickets.updateStatus)).toHaveBeenCalledWith(expect.anything(), 'tkt_mock', 'in_progress');
    expect(vi.mocked(runs.create)).toHaveBeenCalled();
  });

  it('returns noChanges when agent makes no modifications', async () => {
    const { soloRunTicket } = await import('../lib/solo-ticket.js');
    const { processOneProposal } = await import('../lib/solo-auto-execute.js');
    const { runs, tickets } = await import('@promptwheel/core/repos');

    vi.mocked(soloRunTicket).mockResolvedValue({
      success: true, durationMs: 3000, completionOutcome: 'no_changes_needed',
    });

    const result = await processOneProposal(makeState() as any, makeProposal(), '1/1', null);

    expect(result.success).toBe(false);
    expect(result.noChanges).toBe(true);
    expect(vi.mocked(runs.markSuccess)).toHaveBeenCalled();
    expect(vi.mocked(tickets.updateStatus)).toHaveBeenCalledWith(expect.anything(), 'tkt_mock', 'done');
  });

  it('passes execution options correctly in direct mode', async () => {
    const { soloRunTicket } = await import('../lib/solo-ticket.js');
    const { processOneProposal } = await import('../lib/solo-auto-execute.js');

    vi.mocked(soloRunTicket).mockResolvedValue({
      success: true, durationMs: 3000, branchName: 'promptwheel-direct', changedFiles: ['src/utils.ts'],
    });

    const state = makeState({ deliveryMode: 'direct', directBranch: 'main', directFinalize: 'none' });
    const result = await processOneProposal(state as any, makeProposal(), '1/1', null);

    expect(result.success).toBe(true);
    expect(vi.mocked(soloRunTicket)).toHaveBeenCalledWith(
      expect.objectContaining({ skipPr: true, skipPush: true }),
    );

    const directTickets = state.completedDirectTickets as Array<{ title: string }>;
    expect(directTickets).toHaveLength(1);
  });
});

describe('Pipeline: QA Failure Path', () => {
  it('returns failure with qa_failed reason', async () => {
    const { soloRunTicket } = await import('../lib/solo-ticket.js');
    const { processOneProposal } = await import('../lib/solo-auto-execute.js');
    const { runs } = await import('@promptwheel/core/repos');

    vi.mocked(soloRunTicket).mockResolvedValue({
      success: false, durationMs: 8000, failureReason: 'qa_failed',
      error: 'npm test failed: 2 assertions',
    });

    const result = await processOneProposal(makeState() as any, makeProposal(), '1/1', null);

    expect(result.success).toBe(false);
    expect(result.failureReason).toBe('qa_failed');
    expect(vi.mocked(runs.markFailure)).toHaveBeenCalled();
  });

  it('returns failure with agent_error reason', async () => {
    const { soloRunTicket } = await import('../lib/solo-ticket.js');
    const { processOneProposal } = await import('../lib/solo-auto-execute.js');

    vi.mocked(soloRunTicket).mockResolvedValue({
      success: false, durationMs: 2000, failureReason: 'agent_error',
      error: 'Agent crashed with SIGTERM',
    });

    const result = await processOneProposal(makeState() as any, makeProposal(), '1/1', null);

    expect(result.success).toBe(false);
    expect(result.failureReason).toBe('agent_error');
  });

  it('returns failure for spindle abort', async () => {
    const { soloRunTicket } = await import('../lib/solo-ticket.js');
    const { processOneProposal } = await import('../lib/solo-auto-execute.js');

    vi.mocked(soloRunTicket).mockResolvedValue({
      success: false, durationMs: 15000, failureReason: 'spindle_abort',
      spindle: { type: 'spinning', iterations: 50, tokenBudget: 100000, tokensUsed: 95000 },
    });

    const result = await processOneProposal(makeState() as any, makeProposal(), '1/1', null);

    expect(result.success).toBe(false);
    expect(result.failureReason).toBe('spindle_abort');
  });

  it('returns failure for timeout', async () => {
    const { soloRunTicket } = await import('../lib/solo-ticket.js');
    const { processOneProposal } = await import('../lib/solo-auto-execute.js');

    vi.mocked(soloRunTicket).mockResolvedValue({
      success: false, durationMs: 120000, failureReason: 'timeout',
      error: 'Execution timed out after 120s',
    });

    const result = await processOneProposal(makeState() as any, makeProposal(), '1/1', null);

    expect(result.success).toBe(false);
    expect(result.failureReason).toBe('timeout');
  });
});

describe('Pipeline: Scope Violation Path', () => {
  it('retries with expanded scope on scope_violation', async () => {
    const { soloRunTicket } = await import('../lib/solo-ticket.js');
    const { processOneProposal } = await import('../lib/solo-auto-execute.js');
    const { tickets } = await import('@promptwheel/core/repos');

    vi.mocked(soloRunTicket)
      .mockResolvedValueOnce({
        success: false, durationMs: 3000, failureReason: 'scope_violation',
        scopeExpanded: { addedPaths: ['src/tests/**'], newRetryCount: 1 },
        error: 'Files outside allowed scope',
      })
      .mockResolvedValueOnce({
        success: true, durationMs: 5000,
        prUrl: 'https://github.com/test/repo/pull/3',
        branchName: 'promptwheel/tkt_mock',
      });

    const result = await processOneProposal(makeState() as any, makeProposal(), '1/1', null);

    expect(result.success).toBe(true);
    expect(result.wasRetried).toBe(true);
    expect(vi.mocked(soloRunTicket)).toHaveBeenCalledTimes(2);
    // Second call should have retryContext
    expect(vi.mocked(soloRunTicket).mock.calls[1][0]).toHaveProperty('retryContext');
  });

  it('gives up after max scope retries (3 attempts)', async () => {
    const { soloRunTicket } = await import('../lib/solo-ticket.js');
    const { processOneProposal } = await import('../lib/solo-auto-execute.js');

    vi.mocked(soloRunTicket).mockResolvedValue({
      success: false, durationMs: 3000, failureReason: 'scope_violation',
      scopeExpanded: { addedPaths: ['src/tests/**'], newRetryCount: 1 },
      error: 'Files outside allowed scope',
    });

    const result = await processOneProposal(makeState() as any, makeProposal(), '1/1', null);

    expect(result.success).toBe(false);
    // 1 original + 2 retries = 3 total calls
    expect(vi.mocked(soloRunTicket)).toHaveBeenCalledTimes(3);
  });
});

describe('Pipeline: Direct Mode', () => {
  it('records completed ticket in direct mode without PR', async () => {
    const { soloRunTicket } = await import('../lib/solo-ticket.js');
    const { processOneProposal } = await import('../lib/solo-auto-execute.js');

    vi.mocked(soloRunTicket).mockResolvedValue({
      success: true, durationMs: 3000, branchName: 'promptwheel-direct', changedFiles: ['src/utils.ts'],
    });

    const state = makeState({ deliveryMode: 'direct' });
    const result = await processOneProposal(state as any, makeProposal(), '1/1', null);

    expect(result.success).toBe(true);
    expect(result.prUrl).toBeUndefined();
    const directTickets = state.completedDirectTickets as Array<{ title: string; category: string; files: string[] }>;
    expect(directTickets[0].title).toBe('Refactor utils module');
    expect(directTickets[0].category).toBe('refactor');
  });
});

describe('Pipeline: Error Handling', () => {
  it('catches unexpected exceptions from soloRunTicket', async () => {
    const { soloRunTicket } = await import('../lib/solo-ticket.js');
    const { processOneProposal } = await import('../lib/solo-auto-execute.js');

    vi.mocked(soloRunTicket).mockRejectedValue(new Error('Unexpected crash'));

    const result = await processOneProposal(makeState() as any, makeProposal(), '1/1', null);

    expect(result.success).toBe(false);
  });

  it('calls soloRunTicket with correct repoRoot', async () => {
    const { soloRunTicket } = await import('../lib/solo-ticket.js');
    const { processOneProposal } = await import('../lib/solo-auto-execute.js');

    vi.mocked(soloRunTicket).mockResolvedValue({
      success: true, durationMs: 3000, branchName: 'b',
    });

    const state = makeState();
    await processOneProposal(state as any, makeProposal(), '1/1', null);

    expect(vi.mocked(soloRunTicket)).toHaveBeenCalledWith(
      expect.objectContaining({ repoRoot: tmpDir }),
    );
  });

  it('passes guidelines and metadata context to soloRunTicket', async () => {
    const { soloRunTicket } = await import('../lib/solo-ticket.js');
    const { processOneProposal } = await import('../lib/solo-auto-execute.js');

    vi.mocked(soloRunTicket).mockResolvedValue({
      success: true, durationMs: 3000, branchName: 'b',
    });

    const state = makeState({ guidelines: { source: 'claude.md', content: 'test guidelines' }, metadataBlock: 'project: test' });
    await processOneProposal(state as any, makeProposal(), '1/1', null);

    expect(vi.mocked(soloRunTicket)).toHaveBeenCalledWith(
      expect.objectContaining({
        metadataContext: 'project: test',
      }),
    );
  });
});
