/**
 * Claude Code CLI execution backend
 */

import { spawn } from 'node:child_process';
import type { ClaudeResult, ExecutionBackend } from './types.js';

export class ClaudeExecutionBackend implements ExecutionBackend {
  readonly name = 'claude';

  run(opts: {
    worktreePath: string;
    prompt: string;
    timeoutMs: number;
    verbose: boolean;
    onProgress: (msg: string) => void;
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
}): Promise<ClaudeResult> {
  const { worktreePath, prompt, timeoutMs, verbose, onProgress } = opts;

  // Gate: require ANTHROPIC_API_KEY for automated Claude Code usage
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      'Running Claude Code in automation requires ANTHROPIC_API_KEY.\n' +
      'Set the env var for API access, or use the BlockSpool plugin (/blockspool:run) inside Claude Code.'
    );
  }

  const startTime = Date.now();

  return new Promise((resolve) => {
    const claude = spawn('claude', ['-p', '--dangerously-skip-permissions'], {
      cwd: worktreePath,
      env: { ...process.env, CLAUDE_CODE_NON_INTERACTIVE: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      claude.kill('SIGTERM');
    }, timeoutMs);

    claude.stdin.write(prompt);
    claude.stdin.end();

    claude.stdout.on('data', (data: Buffer) => {
      const text = data.toString();
      stdout += text;
      if (verbose) {
        onProgress(text.trim().slice(0, 100));
      }
    });

    claude.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    claude.on('close', (code: number | null) => {
      clearTimeout(timer);
      const durationMs = Date.now() - startTime;

      if (timedOut) {
        resolve({ success: false, error: `Timed out after ${timeoutMs}ms`, stdout, stderr, exitCode: code, timedOut: true, durationMs });
        return;
      }

      if (code !== 0) {
        resolve({ success: false, error: `Claude exited with code ${code}: ${stderr.slice(0, 200)}`, stdout, stderr, exitCode: code, timedOut: false, durationMs });
        return;
      }

      resolve({ success: true, stdout, stderr, exitCode: code, timedOut: false, durationMs });
    });

    claude.on('error', (err: Error) => {
      clearTimeout(timer);
      resolve({ success: false, error: err.message, stdout, stderr, exitCode: null, timedOut: false, durationMs: Date.now() - startTime });
    });
  });
}
