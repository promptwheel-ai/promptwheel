/**
 * ExecRunner types - Interface for command execution
 *
 * Core contains only the interface/types.
 * Node implementation lives in packages/cli.
 */

export type ExecStatus = 'success' | 'failed' | 'timeout' | 'canceled';

export interface ExecOutput {
  /** Path intended to be stored in DB (usually repo-relative) */
  path: string;
  /** Absolute path for immediate file access */
  absPath: string;
  /** Bytes written to artifact file (capped by maxLogBytes) */
  bytes: number;
  /** Whether output exceeded maxLogBytes (file is truncated) */
  truncated: boolean;
  /** Tail of output (last tailBytes), derived from full stream even if truncated */
  tail: string;
}

export interface ExecSpec {
  cmd: string;
  cwd?: string;
  env?: Record<string, string | undefined>;

  /** Defaults to true (runs through shell). */
  shell?: boolean;

  /** Timeout for the process. If hit -> kill -> status=timeout. */
  timeoutMs?: number;

  /** Optional cancellation. If aborted -> kill -> status=canceled. */
  signal?: AbortSignal;

  /**
   * Artifact config.
   * artifactsDir can be repo-relative (recommended) or absolute.
   */
  repoRoot: string;
  artifactsDir: string;

  runId: string;
  attempt: number;
  stepName: string;
  ordinal: number;

  /** Cap bytes written to disk per stream (stdout/stderr). */
  maxLogBytes?: number;

  /** Tail buffer size in bytes per stream. */
  tailBytes?: number;

  /** Optional live hooks (useful later for TUI/streaming). */
  onStdoutChunk?: (chunk: Buffer) => void;
  onStderrChunk?: (chunk: Buffer) => void;
}

export interface ExecResult {
  status: ExecStatus;
  exitCode: number | null;
  signal: string | null;

  /** Runner/system failure (spawn error, timeout msg, stream write error, etc.) */
  errorMessage?: string;

  pid: number | null;

  startedAtMs: number;
  endedAtMs: number;
  durationMs: number;

  stdout: ExecOutput;
  stderr: ExecOutput;
}

export interface ExecRunner {
  run(spec: ExecSpec): Promise<ExecResult>;
}
