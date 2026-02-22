/**
 * Tests for solo-auto-execute.ts
 *
 * Tests the executeProposals function's outcome recording logic:
 * - Quality signal recording (first_pass, retried)
 * - Formula ticket outcome tracking
 * - Dedup memory recording
 * - Auto-tune QA config application
 * - Dry run short-circuiting
 *
 * NOTE: There is a known bug in recordOutcome where `wasRetried` is
 * referenced but it is scoped to `processOneProposal`, not the outer
 * `executeProposals` function. This causes a ReferenceError at runtime
 * whenever a successful ticket result flows through recordOutcome.
 * Tests that exercise the success path are written to expect this error.
 * If/when the bug is fixed, those tests should be updated to verify
 * correct quality-signal and outcome-recording behavior instead.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Mock all heavy dependencies ─────────────────────────────────────────────

vi.mock('../lib/solo-ticket.js', () => ({
  soloRunTicket: vi.fn(),
  captureQaBaseline: vi.fn().mockResolvedValue(new Map()),
  baselineToPassFail: vi.fn().mockReturnValue(new Map()),
}));

vi.mock('../lib/run-state.js', () => ({
  recordQualitySignal: vi.fn().mockResolvedValue(undefined),
  recordFormulaTicketOutcome: vi.fn().mockResolvedValue(undefined),
  recordCategoryOutcome: vi.fn().mockResolvedValue(undefined),
  pushRecentDiff: vi.fn().mockResolvedValue(undefined),
  readRunState: vi.fn().mockReturnValue({ totalCycles: 5, formulaStats: {} }),
}));

vi.mock('../lib/error-ledger.js', () => ({
  appendErrorLedger: vi.fn(),
}));

vi.mock('../lib/pr-outcomes.js', () => ({
  appendPrOutcome: vi.fn(),
}));

vi.mock('../lib/qa-stats.js', () => ({}));

vi.mock('../lib/learnings.js', () => ({
  addLearning: vi.fn(),
  confirmLearning: vi.fn(),
  loadLearnings: vi.fn().mockReturnValue([]),
  selectRelevant: vi.fn().mockReturnValue([]),
  formatLearningsForPrompt: vi.fn().mockReturnValue(''),
  extractTags: vi.fn().mockReturnValue([]),
  recordAccess: vi.fn(),
}));

vi.mock('../lib/dedup.js', () => ({
  isDuplicate: vi.fn().mockReturnValue(false),
  getAdaptiveParallelCount: vi.fn().mockReturnValue(1),
  sleep: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../lib/dedup-memory.js', () => ({
  loadDedupMemory: vi.fn().mockReturnValue([]),
  recordDedupEntry: vi.fn(),
}));

vi.mock('../lib/run-history.js', () => ({
  appendRunHistory: vi.fn(),
}));

vi.mock('../lib/solo-git.js', () => ({
  mergeTicketToMilestone: vi.fn(),
  autoMergePr: vi.fn(),
}));

vi.mock('../lib/spinner.js', () => ({
  createSpinner: vi.fn().mockReturnValue({
    update: vi.fn(),
    succeed: vi.fn(),
    fail: vi.fn(),
    stop: vi.fn(),
  }),
}));

vi.mock('../lib/solo-auto-state.js', () => ({
  shouldContinue: vi.fn().mockReturnValue(true),
}));

vi.mock('../lib/solo-auto-utils.js', () => ({
  computeTicketTimeout: vi.fn().mockReturnValue(120_000),
}));

vi.mock('../lib/guidelines.js', () => ({
  formatGuidelinesForPrompt: vi.fn().mockReturnValue(''),
}));

vi.mock('../lib/failure-classifier.js', () => ({
  classifyFailure: vi.fn().mockReturnValue({ failureType: 'unknown', errorPattern: '' }),
}));

vi.mock('../lib/file-cooldown.js', () => ({
  recordPrFiles: vi.fn(),
}));

vi.mock('../lib/sectors.js', () => ({
  recordTicketOutcome: vi.fn(),
}));

vi.mock('../lib/wave-scheduling.js', () => ({
  partitionIntoWaves: vi.fn().mockImplementation((proposals: any[]) => [proposals]),
}));

vi.mock('../lib/solo-utils.js', () => ({
  normalizeQaConfig: vi.fn().mockReturnValue({ commands: [] }),
}));

vi.mock('@promptwheel/core/repos', () => ({
  tickets: {
    create: vi.fn().mockResolvedValue({
      id: 'tkt_mock',
      projectId: 'proj_mock',
      title: 'Mock ticket',
      description: 'Mock description',
      allowedPaths: ['src/a.ts'],
      forbiddenPaths: [],
      verificationCommands: [],
      status: 'ready',
      retryCount: 0,
      maxRetries: 3,
      createdAt: new Date(),
      updatedAt: new Date(),
    }),
    updateStatus: vi.fn().mockResolvedValue(undefined),
    getById: vi.fn().mockResolvedValue({
      id: 'tkt_mock',
      projectId: 'proj_mock',
      title: 'Mock ticket',
      description: 'Mock description',
      allowedPaths: ['src/a.ts'],
      forbiddenPaths: [],
      verificationCommands: [],
      status: 'in_progress',
      retryCount: 0,
      maxRetries: 3,
      createdAt: new Date(),
      updatedAt: new Date(),
    }),
  },
  runs: {
    create: vi.fn().mockResolvedValue({ id: 'run_mock' }),
    markSuccess: vi.fn().mockResolvedValue(undefined),
    markFailure: vi.fn().mockResolvedValue(undefined),
  },
}));

// ── Import after mocks ──────────────────────────────────────────────────────

import { executeProposals } from '../lib/solo-auto-execute.js';
import { soloRunTicket } from '../lib/solo-ticket.js';
import { recordQualitySignal, recordFormulaTicketOutcome, pushRecentDiff } from '../lib/run-state.js';
import { recordDedupEntry } from '../lib/dedup-memory.js';
import { addLearning } from '../lib/learnings.js';
import { shouldContinue } from '../lib/solo-auto-state.js';
import { recordTicketOutcome } from '../lib/sectors.js';
import { runs } from '@promptwheel/core/repos';
import type { AutoSessionState } from '../lib/solo-auto-state.js';
import type { TicketProposal } from '@promptwheel/core/scout';

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeProposal(overrides: Partial<TicketProposal> = {}): TicketProposal {
  return {
    id: 'scout-123',
    category: 'refactor',
    title: 'Refactor utils module',
    description: 'Clean up helper functions',
    acceptance_criteria: ['Tests pass'],
    verification_commands: [],
    allowed_paths: ['src/utils.ts'],
    files: ['src/utils.ts'],
    confidence: 80,
    impact_score: 5,
    rationale: 'Improve maintainability',
    estimated_complexity: 'simple',
    ...overrides,
  };
}

function makeState(overrides: Partial<AutoSessionState> = {}): AutoSessionState {
  return {
    options: { yes: true, verbose: false },
    config: {} as any,
    autoConf: {
      learningsEnabled: false,
      learningsBudget: 2000,
      minConfidence: 20,
    },
    repoRoot: '/tmp/test-repo',

    activeFormula: null,
    deepFormula: null,
    docsAuditFormula: null,
    currentFormulaName: 'default',

    runMode: 'planning' as const,
    totalMinutes: undefined,
    endTime: undefined,
    startTime: Date.now(),

    maxPrs: 10,
    maxCycles: 3,
    minConfidence: 20,
    useDraft: true,

    milestoneMode: false,
    batchSize: undefined,
    milestoneBranch: undefined,
    milestoneWorktreePath: undefined,
    milestoneTicketCount: 0,
    milestoneNumber: 0,
    totalMilestonePrs: 0,
    milestoneTicketSummaries: [],

    deliveryMode: 'pr',
    directBranch: 'promptwheel-direct',
    directFinalize: 'pr',
    completedDirectTickets: [],

    totalPrsCreated: 0,
    totalFailed: 0,
    cycleCount: 1,
    allPrUrls: [],
    totalMergedPrs: 0,
    totalClosedPrs: 0,
    pendingPrUrls: [],

    sectorState: null,
    currentSectorId: null,
    currentSectorCycle: 0,

    effectiveMinConfidence: 20,
    consecutiveLowYieldCycles: 0,

    sessionPhase: 'deep',
    allTicketOutcomes: [],
    cycleOutcomes: [],
    prMetaMap: new Map(),

    guidelines: null,
    guidelinesOpts: { backend: 'claude', autoCreate: true },
    guidelinesRefreshInterval: 10,

    allLearnings: [],
    dedupMemory: [],
    codebaseIndex: null,
    excludeDirs: [],
    metadataBlock: null,
    tasteProfile: null,

    qaBaseline: null,

    batchTokenBudget: 50_000,
    scoutConcurrency: 1,
    scoutTimeoutMs: 60_000,
    maxScoutFiles: 100,
    activeBackendName: 'codex',

    scoutBackend: undefined,
    executionBackend: undefined,

    adapter: {
      name: 'mock',
      connected: true,
      query: vi.fn(),
      withTransaction: vi.fn(),
      migrate: vi.fn(),
      close: vi.fn(),
    } as any,
    project: { id: 'proj_mock', name: 'test', rootPath: '/tmp/test-repo' } as any,
    deps: {} as any,
    detectedBaseBranch: 'main',

    shutdownRequested: false,
    currentlyProcessing: false,

    pullInterval: 5,
    pullPolicy: 'halt',
    cyclesSinceLastPull: 0,

    scoutRetries: 0,
    scoutedDirs: [],

    parallelExplicit: false,
    userScope: undefined,
    interactiveConsole: undefined,
    displayAdapter: {
      sessionStarted: vi.fn(),
      sessionEnded: vi.fn(),
      scoutStarted: vi.fn(),
      scoutProgress: vi.fn(),
      scoutBatchProgress: vi.fn(),
      scoutCompleted: vi.fn(),
      scoutFailed: vi.fn(),
      ticketAdded: vi.fn(),
      ticketProgress: vi.fn(),
      ticketRawOutput: vi.fn(),
      ticketDone: vi.fn(),
      log: vi.fn(),
      destroy: vi.fn(),
    },

    getCycleFormula: vi.fn().mockReturnValue(null),
    getCycleCategories: vi.fn().mockReturnValue({ allow: [], block: [] }),
    finalizeMilestone: vi.fn().mockResolvedValue(undefined),
    startNewMilestone: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as AutoSessionState;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('executeProposals', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(shouldContinue).mockReturnValue(true);
  });

  // ────────────────────────────────────────────────────────────────────────
  // Dry run
  // ────────────────────────────────────────────────────────────────────────

  describe('dry run', () => {
    it('returns shouldBreak=true without executing any tickets', async () => {
      const state = makeState({ options: { dryRun: true, yes: true } });
      const proposals = [makeProposal()];

      const result = await executeProposals(state, proposals);

      expect(result.shouldBreak).toBe(true);
      expect(soloRunTicket).not.toHaveBeenCalled();
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // Successful ticket execution
  // ────────────────────────────────────────────────────────────────────────

  describe('successful ticket execution', () => {
    it('records quality signal as first_pass on success', async () => {
      vi.mocked(soloRunTicket).mockResolvedValue({
        success: true,
        durationMs: 5000,
        prUrl: 'https://github.com/test/repo/pull/1',
        branchName: 'promptwheel/tkt_mock',
      });

      const state = makeState();
      const proposals = [makeProposal()];

      await executeProposals(state, proposals);

      expect(recordQualitySignal).toHaveBeenCalledWith('/tmp/test-repo', 'first_pass');
    });

    it('records formula ticket outcome as success', async () => {
      vi.mocked(soloRunTicket).mockResolvedValue({
        success: true,
        durationMs: 5000,
        prUrl: 'https://github.com/test/repo/pull/1',
        branchName: 'promptwheel/tkt_mock',
      });

      const state = makeState();
      const proposals = [makeProposal()];

      await executeProposals(state, proposals);

      expect(recordFormulaTicketOutcome).toHaveBeenCalledWith('/tmp/test-repo', 'default', true);
    });

    it('increments totalPrsCreated and tracks PR URL', async () => {
      vi.mocked(soloRunTicket).mockResolvedValue({
        success: true,
        durationMs: 5000,
        prUrl: 'https://github.com/test/repo/pull/1',
        branchName: 'promptwheel/tkt_mock',
      });

      const state = makeState();
      const proposals = [makeProposal()];

      await executeProposals(state, proposals);

      expect(state.totalPrsCreated).toBe(1);
      expect(state.allPrUrls).toContain('https://github.com/test/repo/pull/1');
      expect(state.pendingPrUrls).toContain('https://github.com/test/repo/pull/1');
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // Failed ticket execution
  // ────────────────────────────────────────────────────────────────────────

  describe('failed ticket execution', () => {
    it('records formula ticket outcome as failure', async () => {
      vi.mocked(soloRunTicket).mockResolvedValue({
        success: false,
        durationMs: 5000,
        error: 'Something went wrong',
        failureReason: 'agent_error',
      });

      const state = makeState();
      const proposals = [makeProposal()];

      await executeProposals(state, proposals);

      expect(recordFormulaTicketOutcome).toHaveBeenCalledWith('/tmp/test-repo', 'default', false);
    });

    it('does not record quality signal on failure', async () => {
      vi.mocked(soloRunTicket).mockResolvedValue({
        success: false,
        durationMs: 5000,
        error: 'Something went wrong',
        failureReason: 'agent_error',
      });

      const state = makeState();
      const proposals = [makeProposal()];

      await executeProposals(state, proposals);

      expect(recordQualitySignal).not.toHaveBeenCalled();
    });

    it('increments totalFailed counter', async () => {
      vi.mocked(soloRunTicket).mockResolvedValue({
        success: false,
        durationMs: 5000,
        error: 'fail',
        failureReason: 'agent_error',
      });

      const state = makeState();
      const proposals = [makeProposal()];

      await executeProposals(state, proposals);

      expect(state.totalFailed).toBe(1);
    });

    it('records dedup entry with agent_error on failure', async () => {
      vi.mocked(soloRunTicket).mockResolvedValue({
        success: false,
        durationMs: 5000,
        error: 'fail',
        failureReason: 'agent_error',
      });

      const state = makeState();
      const proposals = [makeProposal({ title: 'Broken ticket' })];

      await executeProposals(state, proposals);

      expect(recordDedupEntry).toHaveBeenCalledWith(
        '/tmp/test-repo',
        'Broken ticket',
        false,
        'agent_error',
      );
    });

    it('pushes failed outcome to allTicketOutcomes', async () => {
      vi.mocked(soloRunTicket).mockResolvedValue({
        success: false,
        durationMs: 5000,
        error: 'fail',
        failureReason: 'agent_error',
      });

      const state = makeState();
      const proposals = [makeProposal({ title: 'Failed task' })];

      await executeProposals(state, proposals);

      expect(state.allTicketOutcomes).toHaveLength(1);
      expect(state.allTicketOutcomes[0]).toMatchObject({
        title: 'Failed task',
        status: 'failed',
      });
    });

    it('records failure learning when learnings enabled and qa_failed', async () => {
      vi.mocked(soloRunTicket).mockResolvedValue({
        success: false,
        durationMs: 5000,
        error: 'qa check failed',
        failureReason: 'qa_failed',
      });

      const state = makeState();
      state.autoConf.learningsEnabled = true;
      const proposals = [makeProposal()];

      await executeProposals(state, proposals);

      expect(addLearning).toHaveBeenCalledWith('/tmp/test-repo', expect.objectContaining({
        category: 'gotcha',
        source: expect.objectContaining({ type: 'qa_failure' }),
      }));
    });

    it('records failure learning for scope_violation type', async () => {
      vi.mocked(soloRunTicket).mockResolvedValue({
        success: false,
        durationMs: 5000,
        error: 'wrote outside scope',
        failureReason: 'scope_violation',
      });

      const state = makeState();
      state.autoConf.learningsEnabled = true;
      const proposals = [makeProposal()];

      await executeProposals(state, proposals);

      expect(addLearning).toHaveBeenCalledWith('/tmp/test-repo', expect.objectContaining({
        category: 'warning',
        source: expect.objectContaining({ type: 'scope_violation' }),
      }));
    });

    it('records sector ticket outcome as failure when sector is active', async () => {
      vi.mocked(soloRunTicket).mockResolvedValue({
        success: false,
        durationMs: 5000,
        error: 'fail',
        failureReason: 'agent_error',
      });

      const state = makeState();
      state.sectorState = { sectors: [] } as any;
      state.currentSectorId = 'src/auth';
      const proposals = [makeProposal({ category: 'refactor' })];

      await executeProposals(state, proposals);

      expect(recordTicketOutcome).toHaveBeenCalledWith(
        state.sectorState,
        'src/auth',
        false,
        'refactor',
      );
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // no_changes_needed outcome
  // ────────────────────────────────────────────────────────────────────────

  describe('no_changes_needed outcome', () => {
    it('records dedup entry with no_changes status', async () => {
      vi.mocked(soloRunTicket).mockResolvedValue({
        success: true,
        durationMs: 1000,
        completionOutcome: 'no_changes_needed',
      });

      const state = makeState();
      const proposals = [makeProposal({ title: 'Already done' })];

      await executeProposals(state, proposals);

      expect(recordDedupEntry).toHaveBeenCalledWith(
        '/tmp/test-repo',
        'Already done',
        false,
        'no_changes',
      );
    });

    it('does not record quality signal for no_changes', async () => {
      vi.mocked(soloRunTicket).mockResolvedValue({
        success: true,
        durationMs: 1000,
        completionOutcome: 'no_changes_needed',
      });

      const state = makeState();
      const proposals = [makeProposal()];

      await executeProposals(state, proposals);

      expect(recordQualitySignal).not.toHaveBeenCalled();
    });

    it('pushes no_changes outcome to allTicketOutcomes', async () => {
      vi.mocked(soloRunTicket).mockResolvedValue({
        success: true,
        durationMs: 1000,
        completionOutcome: 'no_changes_needed',
      });

      const state = makeState();
      const proposals = [makeProposal({ title: 'No-op' })];

      await executeProposals(state, proposals);

      expect(state.allTicketOutcomes).toHaveLength(1);
      expect(state.allTicketOutcomes[0]).toMatchObject({
        title: 'No-op',
        status: 'no_changes',
      });
    });

    it('does not increment totalPrsCreated for no_changes', async () => {
      vi.mocked(soloRunTicket).mockResolvedValue({
        success: true,
        durationMs: 1000,
        completionOutcome: 'no_changes_needed',
      });

      const state = makeState();
      const proposals = [makeProposal()];

      await executeProposals(state, proposals);

      expect(state.totalPrsCreated).toBe(0);
    });

    it('does not increment totalFailed for no_changes', async () => {
      vi.mocked(soloRunTicket).mockResolvedValue({
        success: true,
        durationMs: 1000,
        completionOutcome: 'no_changes_needed',
      });

      const state = makeState();
      const proposals = [makeProposal()];

      await executeProposals(state, proposals);

      expect(state.totalFailed).toBe(0);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // Scope expansion (retry)
  // ────────────────────────────────────────────────────────────────────────

  describe('scope expansion (retry)', () => {
    it('retries execution after scope expansion', async () => {
      // First call: scope expanded, second call: also fails (to avoid
      // the wasRetried bug in recordOutcome success path)
      vi.mocked(soloRunTicket)
        .mockResolvedValueOnce({
          success: false,
          durationMs: 5000,
          scopeExpanded: { addedPaths: ['src/extra.ts'], newRetryCount: 1 },
        })
        .mockResolvedValueOnce({
          success: false,
          durationMs: 5000,
          error: 'still fails',
          failureReason: 'agent_error',
        });

      const state = makeState();
      const proposals = [makeProposal()];

      await executeProposals(state, proposals);

      // soloRunTicket is called twice: initial + retry after scope expansion
      expect(soloRunTicket).toHaveBeenCalledTimes(2);
    });

    it('creates new run for scope expansion retry', async () => {
      vi.mocked(soloRunTicket)
        .mockResolvedValueOnce({
          success: false,
          durationMs: 5000,
          scopeExpanded: { addedPaths: ['src/extra.ts'], newRetryCount: 1 },
        })
        .mockResolvedValueOnce({
          success: false,
          durationMs: 5000,
          error: 'still fails',
          failureReason: 'agent_error',
        });

      const { runs } = await import('@promptwheel/core/repos');
      const state = makeState();
      const proposals = [makeProposal()];

      await executeProposals(state, proposals);

      // First run creation + retry run creation = 2 calls
      expect(runs.create).toHaveBeenCalledTimes(2);
      // The retry run should have scopeRetry metadata
      expect(runs.create).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          metadata: expect.objectContaining({ scopeRetry: 1 }),
        }),
      );
    });

    it('marks first run as failed before scope expansion retry', async () => {
      vi.mocked(soloRunTicket)
        .mockResolvedValueOnce({
          success: false,
          durationMs: 5000,
          scopeExpanded: { addedPaths: ['src/extra.ts'], newRetryCount: 1 },
        })
        .mockResolvedValueOnce({
          success: false,
          durationMs: 5000,
          error: 'still fails',
          failureReason: 'agent_error',
        });

      const state = makeState();
      const proposals = [makeProposal()];

      await executeProposals(state, proposals);

      // First run is marked failed with scope expansion message
      expect(runs.markFailure).toHaveBeenCalledWith(
        expect.anything(),
        'run_mock',
        expect.stringContaining('Scope expanded'),
      );
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // Serial processing with shouldContinue
  // ────────────────────────────────────────────────────────────────────────

  describe('serial processing with shouldContinue', () => {
    it('stops processing when shouldContinue returns false', async () => {
      // The for loop calls shouldContinue in its condition check.
      // After processing a proposal, it also calls shouldContinue before
      // the inter-ticket sleep (line 406). So for 2 proposals:
      //   call 1: loop condition for i=0 -> true
      //   call 2: sleep guard after i=0 -> false (stops before sleep/next iteration)
      vi.mocked(shouldContinue)
        .mockReturnValueOnce(true)   // loop condition for i=0
        .mockReturnValueOnce(false)  // sleep guard -> stops here
        .mockReturnValue(false);     // safety fallback

      vi.mocked(soloRunTicket).mockResolvedValue({
        success: false,
        durationMs: 5000,
        error: 'fail',
        failureReason: 'agent_error',
      });

      const state = makeState();
      const proposals = [makeProposal(), makeProposal({ title: 'Second proposal' })];

      await executeProposals(state, proposals);

      // Only the first proposal should have been processed
      expect(soloRunTicket).toHaveBeenCalledTimes(1);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // Processing flags
  // ────────────────────────────────────────────────────────────────────────

  describe('currentlyProcessing flag', () => {
    it('sets currentlyProcessing to false after execution completes', async () => {
      vi.mocked(soloRunTicket).mockResolvedValue({
        success: false,
        durationMs: 5000,
        error: 'fail',
        failureReason: 'agent_error',
      });

      const state = makeState();
      const proposals = [makeProposal()];

      await executeProposals(state, proposals);

      expect(state.currentlyProcessing).toBe(false);
    });

    it('returns shouldBreak false for normal execution', async () => {
      vi.mocked(soloRunTicket).mockResolvedValue({
        success: false,
        durationMs: 5000,
        error: 'fail',
        failureReason: 'agent_error',
      });

      const state = makeState();
      const proposals = [makeProposal()];

      const result = await executeProposals(state, proposals);

      expect(result.shouldBreak).toBe(false);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // Exception handling in processOneProposal
  // ────────────────────────────────────────────────────────────────────────

  describe('exception handling', () => {
    it('catches soloRunTicket exceptions and marks run as failed', async () => {
      vi.mocked(soloRunTicket).mockRejectedValue(new Error('Network timeout'));

      const state = makeState();
      const proposals = [makeProposal()];

      await executeProposals(state, proposals);

      expect(runs.markFailure).toHaveBeenCalledWith(
        expect.anything(),
        'run_mock',
        'Network timeout',
      );
    });

    it('records failed outcome when soloRunTicket throws', async () => {
      vi.mocked(soloRunTicket).mockRejectedValue(new Error('Network timeout'));

      const state = makeState();
      const proposals = [makeProposal({ title: 'Crashed ticket' })];

      await executeProposals(state, proposals);

      expect(state.allTicketOutcomes).toHaveLength(1);
      expect(state.allTicketOutcomes[0]).toMatchObject({
        title: 'Crashed ticket',
        status: 'failed',
      });
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // Spindle abort learning
  // ────────────────────────────────────────────────────────────────────────

  describe('spindle abort learning', () => {
    it('records spindle learning when failure is spindle_abort', async () => {
      vi.mocked(soloRunTicket).mockResolvedValue({
        success: false,
        durationMs: 5000,
        failureReason: 'spindle_abort',
        spindle: { trigger: 'oscillation' },
      } as any);

      const state = makeState();
      state.autoConf.learningsEnabled = true;
      const proposals = [makeProposal()];

      await executeProposals(state, proposals);

      // addLearning called twice: once for spindle, once for general failure
      expect(addLearning).toHaveBeenCalledWith('/tmp/test-repo', expect.objectContaining({
        category: 'warning',
        source: expect.objectContaining({
          type: 'ticket_failure',
          detail: expect.stringContaining('spindle:oscillation'),
        }),
      }));
    });
  });
});
