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
import type { Formula } from './formulas.js';
import type { loadConfig, createScoutDeps } from './solo-config.js';
import type { ExecutionBackend } from './execution-backends/index.js';
import type { ProjectGuidelines, GuidelinesBackend } from './guidelines.js';
import type { Learning } from './learnings.js';
import type { DedupEntry } from './dedup-memory.js';
import type { CodebaseIndex } from './codebase-index.js';
import type { loadTasteProfile } from './taste-profile.js';
import type { GoalMeasurement } from './goals.js';
import type { SectorState } from './sectors.js';
import type { Trajectory, TrajectoryState, TrajectoryStep } from '@promptwheel/core/trajectory/shared';
import type { TicketOutcome } from './run-history.js';
import type { TraceAnalysis } from '@promptwheel/core/trace/shared';
import type { DisplayAdapter } from './display-adapter.js';
import type { InteractiveConsole } from './solo-stdin.js';

// ── Foundational types ──────────────────────────────────────────────────────
// Defined here (not in solo-auto-state.ts) to avoid circular imports.

export type RunMode = 'planning' | 'spin';

export interface AutoModeOptions {
  // Primary options
  hours?: string;
  pr?: boolean;
  scope?: string;
  formula?: string;
  dryRun?: boolean;
  verbose?: boolean;
  spin?: boolean;

  // Secondary options (hidden but functional)
  codex?: boolean;
  safe?: boolean;
  tests?: boolean;
  yes?: boolean;
  parallel?: string;
  eco?: boolean;

  // Legacy/advanced options (kept for backwards compat)
  minutes?: string;
  cycles?: string;
  continuous?: boolean;
  maxPrs?: string;
  minConfidence?: string;
  draft?: boolean;
  deep?: boolean;
  batchSize?: string;
  scoutBackend?: string;
  executeBackend?: string;
  codexModel?: string;
  kimiModel?: string;
  codexUnsafeFullAccess?: boolean;
  includeClaudeMd?: boolean;
  batchTokenBudget?: string;
  scoutTimeout?: string;
  maxScoutFiles?: string;
  docsAudit?: boolean;
  docsAuditInterval?: string;
  scoutConcurrency?: string;
  codexMcp?: boolean;
  localUrl?: string;
  localModel?: string;
  localMaxIterations?: string;
  deliveryMode?: 'direct' | 'pr' | 'auto-merge';
  directBranch?: string;
  directFinalize?: 'pr' | 'merge' | 'none';
  individualPrs?: boolean;
  skipQaFix?: boolean;
  /** Enable AI-powered QA baseline fix (off by default — modifies working tree) */
  qaFix?: boolean;
  /** Enable live terminal UI with agent output streaming */
  tui?: boolean;
  /** Running inside daemon process (no TTY, no interactive console, no process.exit) */
  daemon?: boolean;
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
  activeFormula: Formula | null;
  deepFormula: Formula | null;
  docsAuditFormula: Formula | null;
  currentFormulaName: string;
  guidelines: ProjectGuidelines | null;
  guidelinesOpts: { backend: GuidelinesBackend; autoCreate: boolean; customPath?: string };
  guidelinesRefreshInterval: number;
  allLearnings: Learning[];
  dedupMemory: DedupEntry[];
  codebaseIndex: CodebaseIndex | null;
  excludeDirs: string[];
  metadataBlock: string | null;
  tasteProfile: ReturnType<typeof loadTasteProfile>;
  goals: Formula[];
  activeGoal: Formula | null;
  activeGoalMeasurement: GoalMeasurement | null;
  sectorState: SectorState | null;
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
  currentSectorId: string | null;
  currentSectorCycle: number;
  sessionScannedSectors: Set<string>;
  effectiveMinConfidence: number;
  consecutiveLowYieldCycles: number;
  sessionPhase: 'warmup' | 'deep' | 'cooldown';
  allTicketOutcomes: TicketOutcome[];
  cycleOutcomes: TicketOutcome[];
  prMetaMap: Map<string, { sectorId: string; formula: string }>;
  qaBaseline: Map<string, boolean> | null;
  shutdownRequested: boolean;
  currentlyProcessing: boolean;
  pullInterval: number;
  pullPolicy: 'halt' | 'warn';
  cyclesSinceLastPull: number;
  scoutRetries: number;
  scoutedDirs: string[];
  batchTokenBudget: number;
  scoutConcurrency: number;
  scoutTimeoutMs: number;
  maxScoutFiles: number;
  activeBackendName: string;
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
  getCycleFormula: (cycle: number) => Formula | null;
  getCycleCategories: (formula: Formula | null) => { allow: string[]; block: string[] };
  finalizeMilestone: () => Promise<void>;
  startNewMilestone: () => Promise<void>;
}
