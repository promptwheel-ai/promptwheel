/**
 * Shared types for the ticket execution pipeline.
 *
 * TicketContext carries everything the step functions need.
 * Each step returns a StepResult indicating whether to continue.
 */

import type { DatabaseAdapter } from '@promptwheel/core/db';
import type { runSteps } from '@promptwheel/core/repos';
import type { TraceAnalysis } from '@promptwheel/core/trace/shared';
import type { SoloConfig } from '../solo-config.js';
import type { ExecutionBackend } from '../execution-backends/index.js';
import type { SpindleConfig, SpindleState } from '../spindle/index.js';
import type {
  RunTicketResult,
  RunTicketOptions,
  StepName,
} from '../solo-ticket-types.js';

export interface StepResult {
  /** false = abort pipeline and return result immediately */
  continue: boolean;
  /** Set when aborting — the final result to return */
  result?: RunTicketResult;
}

export interface TicketContext {
  // From opts
  ticket: RunTicketOptions['ticket'];
  repoRoot: string;
  config: SoloConfig | null;
  adapter: DatabaseAdapter;
  runId: string;
  verbose: boolean;
  opts: RunTicketOptions;

  // Derived
  branchName: string;
  worktreePath: string;
  baseDir: string;
  startTime: number;

  // Accumulated state (mutated by steps)
  baselineFiles: Set<string>;
  qaBaseline: Map<string, boolean> | null;
  artifactPaths: {
    execution?: string;
    diff?: string;
    violations?: string;
    spindle?: string;
  };
  spindleState: SpindleState;
  spindleConfig: SpindleConfig;
  /** Tracks which changed files pass scope check */
  changedFiles: string[];
  /** The porcelain status output (set by scope step) */
  statusOutput: string;
  /** PR URL set by the PR step */
  prUrl: string | undefined;
  /** The execution backend instance (created by agent step or from opts) */
  execBackend: ExecutionBackend;
  /** Agent stdout captured by step-agent, consumed by step-spindle */
  agentStdout?: string;
  /** Trace analysis from stream-json output (set by step-agent) */
  traceAnalysis?: TraceAnalysis;

  // Step tracking
  stepRecords: Map<StepName, Awaited<ReturnType<typeof runSteps.create>>>;
  stepResults: Array<{
    name: string;
    status: 'success' | 'failed' | 'skipped';
    startedAt?: number;
    completedAt?: number;
    errorMessage?: string;
  }>;

  // Helpers
  markStep: (name: StepName, status: 'started' | 'success' | 'failed' | 'skipped', markOpts?: {
    errorMessage?: string;
    metadata?: Record<string, unknown>;
  }) => Promise<void>;
  skipRemaining: (fromIndex: number, reason: string) => Promise<void>;
  saveRunSummary: (result: RunTicketResult) => Promise<string>;
  onProgress: (msg: string) => void;
}
