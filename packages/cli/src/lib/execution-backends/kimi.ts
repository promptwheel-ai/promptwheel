/**
 * Kimi CLI execution backend
 *
 * Spawns `kimi --print --model <model>` with prompt on stdin.
 * Output is on stdout. No --output-last-message or --output-schema.
 */

import { spawn } from 'node:child_process';
import type { ClaudeResult, ExecutionBackend } from './types.js';

export class KimiExecutionBackend implements ExecutionBackend {
  readonly name = 'kimi';
  private apiKey?: string;
  private model: string;

  constructor(opts?: { apiKey?: string; model?: string }) {
    this.apiKey = opts?.apiKey;
    this.model = opts?.model ?? 'kimi-k2.5';
  }

  async run(opts: {
    worktreePath: string;
    prompt: string;
    timeoutMs: number;
    verbose: boolean;
    onProgress: (msg: string) => void;
    onRawOutput?: (chunk: string) => void;
  }): Promise<ClaudeResult> {
    const { worktreePath, prompt, timeoutMs, verbose, onProgress, onRawOutput } = opts;
    const startTime = Date.now();

    return new Promise<ClaudeResult>((resolve) => {
      const args = ['--print', '--model', this.model];

      const env: Record<string, string> = { ...process.env } as Record<string, string>;
      if (this.apiKey) {
        env.MOONSHOT_API_KEY = this.apiKey;
      }

      const proc = spawn('kimi', args, {
        cwd: worktreePath,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let timedOut = false;

      // Only set timeout if timeoutMs > 0 (0 = no timeout)
      const timer = timeoutMs > 0 ? setTimeout(() => {
        timedOut = true;
        proc.kill('SIGTERM');
        setTimeout(() => proc.kill('SIGKILL'), 5000);
      }, timeoutMs) : null;

      proc.stdin.write(prompt);
      proc.stdin.end();

      proc.stdout.on('data', (data: Buffer) => {
        const text = data.toString();
        stdout += text;
        onRawOutput?.(text);
        if (verbose) {
          onProgress(text.trim().slice(0, 100));
        }
      });

      proc.stderr.on('data', (data: Buffer) => {
        const text = data.toString();
        stderr += text;
        onRawOutput?.(`[stderr] ${text}`);
      });

      proc.on('close', (code: number | null) => {
        if (timer) clearTimeout(timer);
        const durationMs = Date.now() - startTime;

        if (timedOut) {
          resolve({ success: false, error: `Timed out after ${timeoutMs}ms`, stdout, stderr, exitCode: code, timedOut: true, durationMs });
          return;
        }

        if (code !== 0) {
          resolve({ success: false, error: `kimi exited with code ${code}: ${stderr.slice(0, 200)}`, stdout, stderr, exitCode: code, timedOut: false, durationMs });
          return;
        }

        resolve({ success: true, stdout, stderr, exitCode: code, timedOut: false, durationMs });
      });

      proc.on('error', (err: Error) => {
        if (timer) clearTimeout(timer);
        resolve({ success: false, error: err.message, stdout, stderr, exitCode: null, timedOut: false, durationMs: Date.now() - startTime });
      });
    });
  }
}
