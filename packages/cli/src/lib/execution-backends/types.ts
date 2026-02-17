/**
 * Execution backend types
 */

import type { StreamJsonEvent } from '@promptwheel/core/trace/shared';

/**
 * Execution result with full details for artifact storage
 */
export interface ClaudeResult {
  success: boolean;
  error?: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  /** Parsed JSONL events when using --output-format stream-json (undefined if text mode) */
  traceEvents?: StreamJsonEvent[];
  /** Per-event timestamps for liveness computation */
  traceTimestamps?: number[];
}

/**
 * Pluggable execution backend interface
 */
export interface ExecutionBackend {
  /** Human-readable name for logging */
  readonly name: string;
  /** Run a prompt against a worktree and return the result */
  run(opts: {
    worktreePath: string;
    prompt: string;
    timeoutMs: number;
    verbose: boolean;
    onProgress: (msg: string) => void;
    /** Stream raw stdout/stderr chunks for live TUI display */
    onRawOutput?: (chunk: string) => void;
  }): Promise<ClaudeResult>;
}
