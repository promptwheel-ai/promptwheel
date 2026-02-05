/**
 * Claude Code CLI execution backend
 */

import { spawn } from 'node:child_process';
import type { ClaudeResult, ExecutionBackend } from './types.js';

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
    let lastPhase = 'Starting';

    // Periodic progress update with elapsed time
    const progressInterval = setInterval(() => {
      const elapsed = formatElapsed(Date.now() - startTime);
      onProgress(`${lastPhase}... (${elapsed})`);
    }, 3000);

    const timer = setTimeout(() => {
      timedOut = true;
      claude.kill('SIGTERM');
    }, timeoutMs);

    claude.stdin.write(prompt);
    claude.stdin.end();

    claude.stdout.on('data', (data: Buffer) => {
      const text = data.toString();
      stdout += text;

      // Detect phase from output
      const phase = detectPhase(text);
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
      stderr += data.toString();
    });

    claude.on('close', (code: number | null) => {
      clearTimeout(timer);
      clearInterval(progressInterval);
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
      clearInterval(progressInterval);
      resolve({ success: false, error: err.message, stdout, stderr, exitCode: null, timedOut: false, durationMs: Date.now() - startTime });
    });
  });
}
