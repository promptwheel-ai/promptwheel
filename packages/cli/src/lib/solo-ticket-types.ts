/**
 * Types and constants for solo ticket execution
 */

import type { tickets, runs } from '@blockspool/core/repos';
import type { StepKind } from '@blockspool/core/repos';
import type { SpindleConfig } from '../lib/spindle/index.js';
import type { SoloConfig } from './solo-config.js';
import type { getAdapter } from './solo-config.js';
import type { ExecutionBackend } from './execution-backends/index.js';

/**
 * Canonical failure reasons for run results
 */
export type FailureReason =
  | 'agent_error'
  | 'scope_violation'
  | 'spindle_abort'
  | 'qa_failed'
  | 'git_error'
  | 'pr_error'
  | 'timeout'
  | 'cancelled';

/**
 * Outcome type for successful completions that don't involve code changes
 */
export type CompletionOutcome =
  | 'no_changes_needed';

/**
 * Spindle abort details for diagnostics
 */
export interface SpindleAbortDetails {
  trigger: 'oscillation' | 'spinning' | 'stalling' | 'repetition' | 'token_budget' | 'qa_ping_pong' | 'command_failure';
  confidence: number;
  estimatedTokens: number;
  iteration: number;
  thresholds: {
    similarityThreshold: number;
    maxSimilarOutputs: number;
    maxStallIterations: number;
    tokenBudgetWarning: number;
    tokenBudgetAbort: number;
  };
  metrics: {
    similarityScore?: number;
    iterationsWithoutChange?: number;
    repeatedPatterns?: string[];
    oscillationPattern?: string;
  };
  recommendations: string[];
  artifactPath: string;
}

/**
 * Result of running a ticket
 */
export interface RunTicketResult {
  success: boolean;
  branchName?: string;
  prUrl?: string;
  durationMs: number;
  error?: string;
  failureReason?: FailureReason;
  completionOutcome?: CompletionOutcome;
  spindle?: SpindleAbortDetails;
  artifacts?: {
    execution?: string;
    diff?: string;
    violations?: string;
    spindle?: string;
    runSummary?: string;
  };
  scopeExpanded?: {
    addedPaths: string[];
    newRetryCount: number;
  };
}

/**
 * Exit codes for solo run
 */
export const EXIT_CODES = {
  SUCCESS: 0,
  FAILURE: 1,
  SPINDLE_ABORT: 2,
  SIGINT: 130,
} as const;

/**
 * Options for running a ticket
 */
export interface RunTicketOptions {
  ticket: Awaited<ReturnType<typeof tickets.getById>> & {};
  repoRoot: string;
  config: SoloConfig | null;
  adapter: Awaited<ReturnType<typeof getAdapter>>;
  runId: string;
  skipQa: boolean;
  createPr: boolean;
  draftPr?: boolean;
  timeoutMs: number;
  verbose: boolean;
  onProgress: (msg: string) => void;
  /** Override the base branch for worktree creation (e.g. milestone branch) */
  baseBranch?: string;
  /** Skip pushing the branch to origin */
  skipPush?: boolean;
  /** Skip PR creation even if createPr is true */
  skipPr?: boolean;
  /** Execution backend override (default: ClaudeExecutionBackend) */
  executionBackend?: ExecutionBackend;
  /** Project guidelines context to prepend to execution prompt */
  guidelinesContext?: string;
  /** Learnings context to prepend to execution prompt */
  learningsContext?: string;
  /** Project metadata context to prepend to execution prompt */
  metadataContext?: string;
  /** If true, retry QA failures by expanding scope to include test files and fixing them */
  qaRetryWithTestFix?: boolean;
  /** Scout confidence score (0-100) — used to add planning preamble for complex changes */
  confidence?: number;
  /** Estimated complexity from scout — used to add planning preamble */
  complexity?: string;
}

/**
 * Execution step definitions
 */
export const EXECUTE_STEPS = [
  { name: 'worktree', kind: 'git' as StepKind },
  { name: 'agent', kind: 'internal' as StepKind },
  { name: 'scope', kind: 'internal' as StepKind },
  { name: 'commit', kind: 'git' as StepKind },
  { name: 'push', kind: 'git' as StepKind },
  { name: 'qa', kind: 'command' as StepKind },
  { name: 'pr', kind: 'git' as StepKind },
  { name: 'cleanup', kind: 'internal' as StepKind },
] as const;

export type StepName = typeof EXECUTE_STEPS[number]['name'];
