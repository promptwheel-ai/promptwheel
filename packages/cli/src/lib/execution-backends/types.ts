/**
 * Execution backend types
 */

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
  }): Promise<ClaudeResult>;
}
