/**
 * Sub-interfaces for AutoSessionState.
 *
 * AutoSessionState extends all five of these. Each sub-interface groups
 * a coherent slice of session state so that functions can declare
 * narrower parameter types (e.g. `SessionConfig & SessionRuntime`).
 *
 * This is a pure type refactor — zero runtime changes.
 */

import type { DatabaseAdapter } from '@promptwheel/core/db';
import type { ScoutBackend } from '@promptwheel/core/services';
import type { projects } from '@promptwheel/core/repos';
import type { loadConfig, createScoutDeps } from './solo-config.js';
import type { ExecutionBackend } from './execution-backends/index.js';
import type { ProjectGuidelines, GuidelinesBackend } from './guidelines.js';
import type { Learning } from './learnings.js';
import type { DedupEntry } from './dedup-memory.js';
import type { CodebaseIndex } from './codebase-index.js';
import type { GoalMeasurement, Goal } from './goals.js';
import type { Trajectory, TrajectoryState, TrajectoryStep } from '@promptwheel/core/trajectory/shared';
import type { TicketOutcome } from './run-history.js';
import type { TraceAnalysis } from '@promptwheel/core/trace/shared';
import type { DisplayAdapter } from './display-adapter.js';
import type { InteractiveConsole } from './solo-stdin.js';
import type { IntegrationConfig } from './integrations.js';
import type { TicketProposal } from '@promptwheel/core/scout';

// ── Foundational types ──────────────────────────────────────────────────────
// Defined here (not in solo-auto-state.ts) to avoid circular imports.

export type RunMode = 'planning' | 'spin';

export interface AutoModeOptions {
  // Primary options
  hours?: string;
  pr?: boolean;
  scope?: string;
  dryRun?: boolean;
  verbose?: boolean;
  plan?: boolean;
  /** Output format: 'json' writes structured JSON alongside the Markdown report */
  output?: 'json';

  // Secondary options (hidden but functional)
  codex?: boolean;
  safe?: boolean;
  /** Only allow these categories (comma-separated CLI string) */
  allow?: string;
  /** Block these categories (comma-separated CLI string) */
  block?: string;
  tests?: boolean;
  yes?: boolean;
  parallel?: string;

  // Legacy/advanced options
  minutes?: string;
  cycles?: string;
  maxPrs?: string;
  minConfidence?: string;
  draft?: boolean;
  batchSize?: string;
  scoutBackend?: string;
  executeBackend?: string;
  codexModel?: string;
  codexUnsafeFullAccess?: boolean;
  includeClaudeMd?: boolean;
  batchTokenBudget?: string;
  scoutTimeout?: string;
  maxScoutFiles?: string;
  scoutConcurrency?: string;
  codexMcp?: boolean;
  deliveryMode?: 'direct' | 'pr' | 'auto-merge';
  directBranch?: string;
  directFinalize?: 'pr' | 'merge' | 'none';
  individualPrs?: boolean;
  skipQaFix?: boolean;
  /** Enable AI-powered QA baseline fix (off by default — modifies working tree) */
  qaFix?: boolean;
  /** Enable live terminal UI with agent output streaming */
  tui?: boolean;
  /** Drill mode — auto-generate trajectories from scout output in spin mode */
  drill?: boolean;
  /** Explicit spin mode flag */
  spin?: boolean;
  /** Poll GitHub issues with this label and convert to proposals (default label: "promptwheel") */
  issues?: boolean | string;
  /** Comma-separated list of repository directories for multi-repo sessions */
  repos?: string;
  /** Use Anthropic Batch API for scouts (50% cost, async processing) */
  batch?: boolean;
}

// ── SessionOptions ──────────────────────────────────────────────────────────
/** CLI inputs — immutable after init */
export interface SessionOptions {
  options: AutoModeOptions;
  runMode: RunMode;
  userScope: string | undefined;
  parallelExplicit: boolean;
}

// ── SessionConfig ───────────────────────────────────────────────────────────
/** Loaded from disk — refreshed periodically */
export interface SessionConfig {
  config: ReturnType<typeof loadConfig>;
  autoConf: Record<string, any>;
  repoRoot: string;
  guidelines: ProjectGuidelines | null;
  guidelinesOpts: { backend: GuidelinesBackend; autoCreate: boolean; customPath?: string };
  guidelinesRefreshInterval: number;
  integrations: IntegrationConfig;
  allLearnings: Learning[];
  dedupMemory: DedupEntry[];
  codebaseIndex: CodebaseIndex | null;
  excludeDirs: string[];
  excludePatterns: string[];
  metadataBlock: string | null;
  goals: Goal[];
  activeGoal: Goal | null;
  activeGoalMeasurement: GoalMeasurement | null;
  activeTrajectory: Trajectory | null;
  activeTrajectoryState: TrajectoryState | null;
  currentTrajectoryStep: TrajectoryStep | null;
}

// ── SessionRuntime ──────────────────────────────────────────────────────────
/** Mutable counters, flags, tracking */
export interface SessionRuntime {
  startTime: number;
  totalMinutes: number | undefined;
  endTime: number | undefined;
  maxPrs: number;
  maxCycles: number;
  minConfidence: number;
  useDraft: boolean;
  cycleCount: number;
  totalPrsCreated: number;
  totalFailed: number;
  allPrUrls: string[];
  totalMergedPrs: number;
  totalClosedPrs: number;
  pendingPrUrls: string[];
  milestoneMode: boolean;
  batchSize: number | undefined;
  milestoneBranch: string | undefined;
  milestoneWorktreePath: string | undefined;
  milestoneTicketCount: number;
  milestoneNumber: number;
  totalMilestonePrs: number;
  milestoneTicketSummaries: string[];
  deliveryMode: 'direct' | 'pr' | 'auto-merge';
  directBranch: string;
  directFinalize: 'pr' | 'merge' | 'none';
  completedDirectTickets: Array<{ title: string; category: string; files: string[] }>;
  /** Trace analyses collected from ticket executions (one per ticket, when stream-json available) */
  allTraceAnalyses: TraceAnalysis[];
  effectiveMinConfidence: number;
  consecutiveLowYieldCycles: number;
  /** Consecutive main-loop iterations with zero completed tickets (catches all empty-cycle paths) */
  consecutiveIdleCycles: number;
  /** Consecutive cycles where all proposals failed (distinct from idle — proposals were found) */
  consecutiveFailureCycles: number;
  /** Consecutive backpressure waits — caps to prevent infinite hangs */
  backpressureRetries: number;
  /** Completed ticket count from previous cycle — set before resetting cycleOutcomes */
  _prevCycleCompleted: number;
  sessionPhase: 'warmup' | 'deep' | 'cooldown';
  allTicketOutcomes: TicketOutcome[];
  cycleOutcomes: TicketOutcome[];
  prMetaMap: Map<string, Record<string, unknown>>;
  qaBaseline: ReadonlyMap<string, boolean> | null;
  shutdownRequested: boolean;
  shutdownReason: 'user_signal' | 'user_quit' | 'convergence' | 'low_yield' | 'idle' | 'branch_diverged' | 'time_limit' | 'pr_limit' | 'rate_limited' | 'completed' | null;
  currentlyProcessing: boolean;
  pullInterval: number;
  pullPolicy: 'halt' | 'warn';
  cyclesSinceLastPull: number;
  scoutRetries: number;
  scoutedDirs: string[];
  /** Pending proposals from pre-scout integrations, consumed by scout phase */
  _pendingIntegrationProposals: TicketProposal[];
  /** Per-provider last-invoked cycle for cadence tracking */
  integrationLastRun: Record<string, number>;
  /** Per-phase progress within current cycle (for progress bar) */
  _cycleProgress: { done: number; total: number; label: string } | null;
  /** Titles hard-rejected by dedup gate, accumulated across cycles for drill escalation */
  escalationCandidates: Set<string>;
  drillMode: boolean;
  drillLastGeneratedAtCycle: number;
  drillTrajectoriesGenerated: number;
  /** Outcome of the last drill trajectory ('completed' | 'stalled' | null) */
  drillLastOutcome: 'completed' | 'stalled' | null;
  /** History of drill trajectories for avoidance and stats */
  drillHistory: Array<{
    name: string;
    description: string;
    stepsTotal: number;
    stepsCompleted: number;
    stepsFailed: number;
    outcome: 'completed' | 'stalled';
    /** Step completion percentage (0-1). More granular than binary outcome. */
    completionPct: number;
    categories: string[];
    scopes: string[];
    timestamp?: number;
    failedSteps?: Array<{ id: string; title: string; reason?: string }>;
    completedStepSummaries?: string[];
    modifiedFiles?: string[];
    ambitionLevel?: 'conservative' | 'moderate' | 'ambitious';
    /** Per-step outcomes — enables step-level learning. */
    stepOutcomes?: Array<{ id: string; status: 'completed' | 'failed' | 'skipped' | 'pending' }>;
    /** Avg confidence of proposals at generation time. */
    proposalAvgConfidence?: number;
    /** Avg impact of proposals at generation time. */
    proposalAvgImpact?: number;
    /** Number of proposals dropped by freshness filter. */
    freshnessDropCount?: number;
    /** Number of distinct categories in proposals at generation time. */
    proposalCategoryCount?: number;
    /** Number of proposal groups identified by blueprint file-overlap analysis. */
    blueprintGroupCount?: number;
    /** Number of cross-category conflicts detected by blueprint. */
    blueprintConflictCount?: number;
    /** Number of enabler proposals (depended upon by others). */
    blueprintEnablerCount?: number;
    /** Number of mergeable near-duplicate proposal pairs. */
    blueprintMergeableCount?: number;
    /** Whether QA was retried with test-fix expansion. */
    qualityRetried?: boolean;
    /** Number of quality issues detected during QA. */
    qualityIssueCount?: number;
    /** Model used for execution (from model routing) */
    modelUsed?: string;
    /** Formulas used in parallel scouting for this cycle */
    formulasUsed?: string[];
  }>;
  /** Categories already covered by drill trajectories this session */
  drillCoveredCategories: Map<string, number>;
  /** Scopes already covered by drill trajectories this session */
  drillCoveredScopes: Map<string, number>;
  /** Timestamp of last drill survey — used for staleness detection */
  drillLastSurveyTimestamp: number | null;
  /** Consecutive 'insufficient' drill survey results — triggers stop when too many */
  drillConsecutiveInsufficient: number;
  /** Telemetry from the most recent trajectory generation — carried to outcome recording */
  drillGenerationTelemetry: {
    proposalAvgConfidence?: number;
    proposalAvgImpact?: number;
    freshnessDropCount?: number;
    proposalCategoryCount?: number;
    blueprintGroupCount?: number;
    blueprintConflictCount?: number;
    blueprintEnablerCount?: number;
    blueprintMergeableCount?: number;
    qualityRetried?: boolean;
    qualityIssueCount?: number;
  } | null;
  /** Ratio of proposals dropped by freshness filter last generation (0-1) — bridges to cooldown */
  drillLastFreshnessDropRatio: number | null;
  /** Last convergence suggested action — fed into trajectory generation for scope steering */
  lastConvergenceAction?: 'continue' | 'widen_scope' | 'deepen' | 'stop';
  batchTokenBudget: number;
  scoutConcurrency: number;
  scoutTimeoutMs: number;
  maxScoutFiles: number;
  activeBackendName: string;
  /** Last commit SHA when a scout scan was performed — used for incremental scanning. */
  lastScanCommit: string | null;
  /** All repo roots for multi-repo sessions. Empty when single-repo. */
  repos: string[];
  /** Current index into repos[] for round-robin cycling */
  repoIndex: number;
}

// ── SessionDeps ─────────────────────────────────────────────────────────────
/** External adapters, backends, services */
export interface SessionDeps {
  adapter: DatabaseAdapter;
  project: Awaited<ReturnType<typeof projects.ensureForRepo>>;
  deps: ReturnType<typeof createScoutDeps>;
  detectedBaseBranch: string;
  scoutBackend: ScoutBackend | undefined;
  executionBackend: ExecutionBackend | undefined;
}

// ── SessionUI ───────────────────────────────────────────────────────────────
/** Display and interaction */
export interface SessionUI {
  displayAdapter: DisplayAdapter;
  interactiveConsole: InteractiveConsole | undefined;
  getCycleFormula: (cycle: number) => { name: string; prompt?: string; model?: string; categories?: string[] } | null;
  getCycleCategories: (formula: { name: string; categories?: string[] } | null) => { allow: string[]; block: string[] };
  finalizeMilestone: () => Promise<void>;
  startNewMilestone: () => Promise<void>;
}
