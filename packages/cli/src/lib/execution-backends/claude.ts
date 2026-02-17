/**
 * Claude Code CLI execution backend
 */

import { spawn } from 'node:child_process';
import type { ClaudeResult, ExecutionBackend } from './types.js';
import {
  parseStreamJsonLine,
  isStreamJsonOutput,
  reconstructText,
  type StreamJsonEvent,
} from '@promptwheel/core/trace/shared';

/** Format elapsed time as human-readable string */
function formatElapsed(ms: number): string {
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remainingSecs = secs % 60;
  return `${mins}m${remainingSecs}s`;
}

/** Detect phase from Claude CLI output patterns */
function detectPhase(text: string): string | null {
  const lower = text.toLowerCase();
  // Tool usage patterns
  if (lower.includes('reading') || lower.includes('read file') || lower.includes('let me read')) return 'Reading files';
  if (lower.includes('writing') || lower.includes('write file') || lower.includes('let me write') || lower.includes('creating file')) return 'Writing files';
  if (lower.includes('editing') || lower.includes('edit file') || lower.includes('let me edit') || lower.includes('updating')) return 'Editing files';
  if (lower.includes('running') || lower.includes('execute') || lower.includes('bash') || lower.includes('npm ') || lower.includes('running command')) return 'Running command';
  if (lower.includes('searching') || lower.includes('grep') || lower.includes('looking for') || lower.includes('finding')) return 'Searching';
  if (lower.includes('analyzing') || lower.includes('examining') || lower.includes('reviewing')) return 'Analyzing';
  if (lower.includes('testing') || lower.includes('test')) return 'Testing';
  if (lower.includes('commit') || lower.includes('git')) return 'Git operations';
  return null;
}

export class ClaudeExecutionBackend implements ExecutionBackend {
  readonly name = 'claude';

  run(opts: {
    worktreePath: string;
    prompt: string;
    timeoutMs: number;
    verbose: boolean;
    onProgress: (msg: string) => void;
    onRawOutput?: (chunk: string) => void;
  }): Promise<ClaudeResult> {
    return runClaude(opts);
  }
}

/**
 * Run Claude Code CLI
 */
export async function runClaude(opts: {
  worktreePath: string;
  prompt: string;
  timeoutMs: number;
  verbose: boolean;
  onProgress: (msg: string) => void;
  onRawOutput?: (chunk: string) => void;
}): Promise<ClaudeResult> {
  const { worktreePath, prompt, timeoutMs, verbose, onProgress, onRawOutput } = opts;

  // Gate: require ANTHROPIC_API_KEY for automated Claude Code usage
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      'Running Claude Code in automation requires ANTHROPIC_API_KEY.\n' +
      'Set the env var for API access, or use the PromptWheel plugin (/promptwheel:run) inside Claude Code.'
    );
  }

  const startTime = Date.now();

  return new Promise((resolve) => {
    const claude = spawn('claude', ['-p', '--dangerously-skip-permissions', '--output-format', 'stream-json'], {
      cwd: worktreePath,
      env: { ...process.env, CLAUDE_CODE_NON_INTERACTIVE: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let lastPhase = 'Starting';
    let isStreamJson: boolean | null = null; // detected from first line
    const traceEvents: StreamJsonEvent[] = [];
    const traceTimestamps: number[] = [];
    let lineBuf = '';

    // Periodic progress update with elapsed time
    const progressInterval = setInterval(() => {
      const elapsed = formatElapsed(Date.now() - startTime);
      onProgress(`${lastPhase}... (${elapsed})`);
    }, 3000);

    // Only set timeout if timeoutMs > 0 (0 = no timeout)
    const timer = timeoutMs > 0 ? setTimeout(() => {
      timedOut = true;
      claude.kill('SIGTERM');
    }, timeoutMs) : null;

    claude.stdin.write(prompt);
    claude.stdin.end();

    claude.stdout.on('data', (data: Buffer) => {
      const text = data.toString();
      stdout += text;
      onRawOutput?.(text);

      // Parse stream-json lines in real-time
      lineBuf += text;
      const lines = lineBuf.split('\n');
      lineBuf = lines.pop() ?? ''; // keep incomplete last line

      for (const line of lines) {
        if (!line.trim()) continue;

        // Auto-detect on first line
        if (isStreamJson === null) {
          isStreamJson = isStreamJsonOutput(line);
        }

        if (isStreamJson) {
          const evt = parseStreamJsonLine(line);
          if (evt) {
            traceEvents.push(evt);
            traceTimestamps.push(Date.now());
          }
        }
      }

      // Detect phase: use stream-json tool names or fall back to text matching
      let phaseText = text;
      if (isStreamJson && traceEvents.length > 0) {
        phaseText = reconstructText(traceEvents.slice(-3));
      }
      const phase = detectPhase(phaseText);
      if (phase) {
        lastPhase = phase;
        const elapsed = formatElapsed(Date.now() - startTime);
        onProgress(`${lastPhase}... (${elapsed})`);
      }

      if (verbose) {
        onProgress(text.trim().slice(0, 100));
      }
    });

    claude.stderr.on('data', (data: Buffer) => {
      const text = data.toString();
      stderr += text;
      onRawOutput?.(`[stderr] ${text}`);
    });

    claude.on('close', (code: number | null) => {
      if (timer) clearTimeout(timer);
      clearInterval(progressInterval);
      const durationMs = Date.now() - startTime;

      // Process any remaining buffer
      if (lineBuf.trim() && isStreamJson) {
        const evt = parseStreamJsonLine(lineBuf);
        if (evt) {
          traceEvents.push(evt);
          traceTimestamps.push(Date.now());
        }
      }

      // Reconstruct plain text stdout for backward compat when using stream-json
      const plainStdout = isStreamJson && traceEvents.length > 0
        ? reconstructText(traceEvents)
        : stdout;

      const traceData = isStreamJson && traceEvents.length > 0
        ? { traceEvents, traceTimestamps }
        : {};

      if (timedOut) {
        resolve({ success: false, error: `Timed out after ${timeoutMs}ms`, stdout: plainStdout, stderr, exitCode: code, timedOut: true, durationMs, ...traceData });
        return;
      }

      if (code !== 0) {
        resolve({ success: false, error: `Claude exited with code ${code}: ${stderr.slice(0, 200)}`, stdout: plainStdout, stderr, exitCode: code, timedOut: false, durationMs, ...traceData });
        return;
      }

      resolve({ success: true, stdout: plainStdout, stderr, exitCode: code, timedOut: false, durationMs, ...traceData });
    });

    claude.on('error', (err: Error) => {
      if (timer) clearTimeout(timer);
      clearInterval(progressInterval);
      resolve({ success: false, error: err.message, stdout, stderr, exitCode: null, timedOut: false, durationMs: Date.now() - startTime });
    });
  });
}
