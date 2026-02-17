/**
 * Node.js ExecRunner implementation
 *
 * Spawns commands, captures output to artifact files,
 * handles timeout/cancellation, and returns structured results.
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type {
  ExecRunner,
  ExecSpec,
  ExecResult,
  ExecOutput,
  ExecStatus,
} from '@promptwheel/core';

export interface NodeExecRunnerOptions {
  defaultMaxLogBytes?: number; // per stream
  defaultTailBytes?: number;   // per stream
  killGraceMs?: number;        // after SIGTERM, wait then SIGKILL
}

/**
 * Configuration constants for ExecRunner
 */

/** Maximum bytes to write per output stream (stdout/stderr). Prevents runaway disk usage. */
const DEFAULT_MAX_LOG_BYTES = 2_000_000; // 2MB per stream

/** Bytes to retain in memory for the tail buffer, used for fast UI display. */
const DEFAULT_TAIL_BYTES = 65_536; // 64KB tail for fast UI

/** Grace period in ms between SIGTERM and SIGKILL when killing a child process. */
const DEFAULT_KILL_GRACE_MS = 1_500;

/** Maximum length for sanitized file name segments. Prevents overly long artifact paths. */
const MAX_FILE_SEGMENT_LENGTH = 64;

function isProbablyAbsolute(p: string): boolean {
  return path.isAbsolute(p);
}

function sanitizeFileSegment(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_FILE_SEGMENT_LENGTH) || 'step';
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

function appendTail(current: Buffer, chunk: Buffer, tailBytes: number): Buffer {
  if (tailBytes <= 0) return Buffer.alloc(0);
  if (chunk.length >= tailBytes) {
    return Buffer.from(chunk.subarray(chunk.length - tailBytes));
  }
  if (current.length === 0) return Buffer.from(chunk);

  const combined = Buffer.concat([current, chunk]);
  if (combined.length <= tailBytes) return combined;
  return Buffer.from(combined.subarray(combined.length - tailBytes));
}

async function ensureDir(absDir: string): Promise<void> {
  await fs.promises.mkdir(absDir, { recursive: true });
}

function writeCapped(
  stream: fs.WriteStream,
  chunk: Buffer,
  state: { bytesWritten: number; truncated: boolean },
  maxBytes: number
): void {
  if (maxBytes <= 0) {
    state.truncated = true;
    return;
  }

  if (state.truncated) return;

  const remaining = maxBytes - state.bytesWritten;
  if (remaining <= 0) {
    state.truncated = true;
    return;
  }

  if (chunk.length <= remaining) {
    stream.write(chunk);
    state.bytesWritten += chunk.length;
    return;
  }

  // partial write, then truncate
  stream.write(chunk.subarray(0, remaining));
  state.bytesWritten += remaining;
  state.truncated = true;
}

function waitForStreamClose(stream: fs.WriteStream): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.once('close', () => resolve());
    stream.once('error', (err) => reject(err));
  });
}

export class NodeExecRunner implements ExecRunner {
  private readonly defaultMaxLogBytes: number;
  private readonly defaultTailBytes: number;
  private readonly killGraceMs: number;

  constructor(opts: NodeExecRunnerOptions = {}) {
    this.defaultMaxLogBytes = opts.defaultMaxLogBytes ?? DEFAULT_MAX_LOG_BYTES;
    this.defaultTailBytes = opts.defaultTailBytes ?? DEFAULT_TAIL_BYTES;
    this.killGraceMs = opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  }

  async run(spec: ExecSpec): Promise<ExecResult> {
    const startedAtMs = Date.now();

    const maxLogBytes = spec.maxLogBytes ?? this.defaultMaxLogBytes;
    const tailBytes = spec.tailBytes ?? this.defaultTailBytes;

    const repoRoot = spec.repoRoot;
    const artifactsDirAbs = isProbablyAbsolute(spec.artifactsDir)
      ? spec.artifactsDir
      : path.join(repoRoot, spec.artifactsDir);

    // Layout: .promptwheel/artifacts/<runId>/attempt-<n>/
    const attemptDirAbs = path.join(artifactsDirAbs, spec.runId, `attempt-${spec.attempt}`);
    await ensureDir(attemptDirAbs);

    const safeName = sanitizeFileSegment(spec.stepName);
    const base = `${pad2(spec.ordinal)}-${safeName}`;

    const stdoutAbs = path.join(attemptDirAbs, `${base}.stdout.log`);
    const stderrAbs = path.join(attemptDirAbs, `${base}.stderr.log`);

    const stdoutPathDb = isProbablyAbsolute(spec.artifactsDir)
      ? stdoutAbs
      : path.join(spec.artifactsDir, spec.runId, `attempt-${spec.attempt}`, `${base}.stdout.log`);

    const stderrPathDb = isProbablyAbsolute(spec.artifactsDir)
      ? stderrAbs
      : path.join(spec.artifactsDir, spec.runId, `attempt-${spec.attempt}`, `${base}.stderr.log`);

    const stdoutStream = fs.createWriteStream(stdoutAbs, { flags: 'w' });
    const stderrStream = fs.createWriteStream(stderrAbs, { flags: 'w' });

    let stdoutTail: Buffer = Buffer.alloc(0);
    let stderrTail: Buffer = Buffer.alloc(0);

    const stdoutState = { bytesWritten: 0, truncated: false };
    const stderrState = { bytesWritten: 0, truncated: false };

    let timedOut = false;
    let canceled = false;
    let errorMessage: string | undefined;

    let exitCode: number | null = null;
    let signal: string | null = null;
    let pid: number | null = null;

    let timeoutHandle: NodeJS.Timeout | undefined;

    const endAndWaitStreams = async (): Promise<void> => {
      try { stdoutStream.end(); } catch { /* ignore */ }
      try { stderrStream.end(); } catch { /* ignore */ }

      await Promise.allSettled([
        waitForStreamClose(stdoutStream),
        waitForStreamClose(stderrStream),
      ]);
    };

    const makeOutput = (stream: 'stdout' | 'stderr'): ExecOutput => {
      const isStdout = stream === 'stdout';
      const absPath = isStdout ? stdoutAbs : stderrAbs;
      const pathDb = isStdout ? stdoutPathDb : stderrPathDb;
      const bytes = isStdout ? stdoutState.bytesWritten : stderrState.bytesWritten;
      const truncated = isStdout ? stdoutState.truncated : stderrState.truncated;
      const tailBuf = isStdout ? stdoutTail : stderrTail;

      return {
        absPath,
        path: pathDb,
        bytes,
        truncated,
        tail: tailBuf.toString('utf8'),
      };
    };

    const finalize = async (status: ExecStatus): Promise<ExecResult> => {
      const endedAtMs = Date.now();
      await endAndWaitStreams();

      return {
        status,
        exitCode,
        signal,
        errorMessage,
        pid,
        startedAtMs,
        endedAtMs,
        durationMs: Math.max(0, endedAtMs - startedAtMs),
        stdout: makeOutput('stdout'),
        stderr: makeOutput('stderr'),
      };
    };

    let child: ReturnType<typeof spawn> | undefined;

    const killChild = (_why: 'timeout' | 'canceled' | 'error') => {
      if (!child || child.killed) return;

      try {
        child.kill('SIGTERM');
      } catch { /* ignore */ }

      // Escalate after grace period
      setTimeout(() => {
        if (!child || child.killed) return;
        try {
          child.kill('SIGKILL');
        } catch { /* ignore */ }
      }, this.killGraceMs);
    };

    const onAbort = () => {
      canceled = true;
      errorMessage = errorMessage ?? 'Canceled';
      killChild('canceled');
    };

    // Shared cleanup: clears timeout, removes abort listener, then finalizes
    const cleanupAndFinalize = async (status: ExecStatus): Promise<ExecResult> => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (spec.signal) spec.signal.removeEventListener('abort', onAbort);
      return await finalize(status);
    };

    try {
      const env = { ...process.env, ...(spec.env ?? {}) } as Record<string, string>;
      const cwd = spec.cwd ?? repoRoot;

      // If already aborted, short-circuit
      if (spec.signal?.aborted) {
        canceled = true;
        errorMessage = 'Canceled (signal already aborted)';
        return await finalize('canceled');
      }

      if (spec.signal) {
        spec.signal.addEventListener('abort', onAbort, { once: true });
      }

      child = spawn(spec.cmd, {
        cwd,
        env,
        shell: spec.shell ?? true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      pid = child.pid ?? null;

      // Timeout handling
      if (spec.timeoutMs && spec.timeoutMs > 0) {
        timeoutHandle = setTimeout(() => {
          timedOut = true;
          errorMessage = errorMessage ?? `Timed out after ${spec.timeoutMs}ms`;
          killChild('timeout');
        }, spec.timeoutMs);
      }

      // Stream piping + tail capture
      if (child.stdout) {
        child.stdout.on('data', (chunk) => {
          const buf = Buffer.from(chunk);
          spec.onStdoutChunk?.(buf);
          stdoutTail = appendTail(stdoutTail, buf, tailBytes);
          writeCapped(stdoutStream, buf, stdoutState, maxLogBytes);
        });
      }

      if (child.stderr) {
        child.stderr.on('data', (chunk) => {
          const buf = Buffer.from(chunk);
          spec.onStderrChunk?.(buf);
          stderrTail = appendTail(stderrTail, buf, tailBytes);
          writeCapped(stderrStream, buf, stderrState, maxLogBytes);
        });
      }

      // Spawn error (ENOENT, permissions, etc.)
      const spawnErrorPromise = new Promise<ExecResult>((resolve) => {
        child!.once('error', async (err: Error) => {
          errorMessage = errorMessage ?? err.message;
          exitCode = null;
          signal = null;
          killChild('error');
          resolve(await cleanupAndFinalize('failed'));
        });
      });

      // Normal close path
      const closePromise = new Promise<ExecResult>((resolve) => {
        child!.once('close', async (code: number | null, sig: NodeJS.Signals | null) => {
          exitCode = code;
          signal = sig ?? null;

          let status: ExecStatus;
          if (canceled) status = 'canceled';
          else if (timedOut) status = 'timeout';
          else if (code === 0) status = 'success';
          else status = 'failed';

          resolve(await cleanupAndFinalize(status));
        });
      });

      // Write stream error (disk issue)
      const writeErrorPromise = new Promise<ExecResult>((resolve) => {
        const onWriteError = async (err: Error) => {
          errorMessage = errorMessage ?? `Artifact write error: ${err.message}`;
          killChild('error');
          resolve(await cleanupAndFinalize('failed'));
        };

        stdoutStream.once('error', onWriteError);
        stderrStream.once('error', onWriteError);
      });

      // First one wins
      return await Promise.race([spawnErrorPromise, closePromise, writeErrorPromise]);
    } catch (err) {
      errorMessage = errorMessage ?? (err instanceof Error ? err.message : String(err));
      return await cleanupAndFinalize('failed');
    }
  }
}

/**
 * Create a Node exec runner with default options
 */
export function createExecRunner(opts?: NodeExecRunnerOptions): ExecRunner {
  return new NodeExecRunner(opts);
}
