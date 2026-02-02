/**
 * Kimi CLI scout backend
 *
 * Spawns `kimi --print -p <prompt> --model <model>` with cwd.
 * Collects stdout, extracts JSON using parseClaudeOutput.
 *
 * --print auto-enables --yolo (no confirmation prompts).
 * No --output-schema or --output-last-message — output is on stdout.
 */

import { spawn } from 'node:child_process';
import type { ScoutBackend, RunnerOptions, RunnerResult } from './runner.js';

export class KimiScoutBackend implements ScoutBackend {
  readonly name = 'kimi';
  private apiKey?: string;
  private defaultModel: string;

  constructor(opts?: { apiKey?: string; model?: string }) {
    this.apiKey = opts?.apiKey;
    this.defaultModel = opts?.model ?? 'kimi-k2.5';
  }

  async run(options: RunnerOptions): Promise<RunnerResult> {
    const { prompt, cwd, timeoutMs, model, signal } = options;
    const start = Date.now();

    if (signal?.aborted) {
      return { success: false, output: '', error: 'Aborted before start', durationMs: 0 };
    }

    const effectiveModel = model ?? this.defaultModel;

    const args = [
      '--print',
      '-p', prompt,
      '--model', effectiveModel,
      '--output-format', 'stream-json',
    ];

    const env: Record<string, string> = { ...process.env } as Record<string, string>;
    if (this.apiKey) {
      env.MOONSHOT_API_KEY = this.apiKey;
    }

    return new Promise<RunnerResult>((resolve) => {
      const proc = spawn('kimi', args, {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let killed = false;

      const timeout = setTimeout(() => {
        killed = true;
        proc.kill('SIGTERM');
        setTimeout(() => proc.kill('SIGKILL'), 5000);
      }, timeoutMs);

      const abortHandler = () => { killed = true; proc.kill('SIGTERM'); };
      signal?.addEventListener('abort', abortHandler);

      proc.stdout.on('data', (d) => { stdout += d.toString(); });
      proc.stderr.on('data', (d) => { stderr += d.toString(); });

      proc.on('close', (code) => {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', abortHandler);
        const durationMs = Date.now() - start;

        if (killed) {
          resolve({ success: false, output: stdout, error: signal?.aborted ? 'Aborted by signal' : 'Timeout exceeded', durationMs });
          return;
        }

        if (code !== 0) {
          resolve({ success: false, output: stdout, error: stderr || `kimi exited with code ${code}`, durationMs });
          return;
        }

        resolve({ success: true, output: stdout, durationMs });
      });

      proc.on('error', (err) => {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', abortHandler);
        resolve({ success: false, output: '', error: err.message, durationMs: Date.now() - start });
      });
    });
  }
}
