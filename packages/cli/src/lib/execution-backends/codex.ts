/**
 * Codex CLI execution backend
 *
 * Default: `--sandbox workspace-write` (safe unattended mode).
 * Optional: `unsafeBypassSandbox` enables `--dangerously-bypass-approvals-and-sandbox`
 * for use inside externally hardened/isolated runners only.
 */

import { spawn } from 'node:child_process';
import type { ClaudeResult, ExecutionBackend } from './types.js';

export class CodexExecutionBackend implements ExecutionBackend {
  readonly name = 'codex';
  private apiKey?: string;
  private model: string;
  private unsafeBypassSandbox: boolean;

  constructor(opts?: { apiKey?: string; model?: string; unsafeBypassSandbox?: boolean }) {
    this.apiKey = opts?.apiKey;
    this.model = opts?.model ?? 'gpt-5.2-codex';
    this.unsafeBypassSandbox = opts?.unsafeBypassSandbox ?? false;
  }

  async run(opts: {
    worktreePath: string;
    prompt: string;
    timeoutMs: number;
    verbose: boolean;
    onProgress: (msg: string) => void;
  }): Promise<ClaudeResult> {
    const { worktreePath, prompt, timeoutMs, verbose, onProgress } = opts;
    const startTime = Date.now();

    const { mkdtempSync, readFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');

    const tmpDir = mkdtempSync(join(tmpdir(), 'blockspool-codex-exec-'));
    const outPath = join(tmpDir, 'output.md');

    try {
      return await new Promise<ClaudeResult>((resolve) => {
        const args = ['exec', '--json', '--output-last-message', outPath];

        if (this.unsafeBypassSandbox) {
          args.push('--dangerously-bypass-approvals-and-sandbox');
        } else {
          args.push('--sandbox', 'workspace-write');
        }

        args.push('--model', this.model);
        args.push('--cd', worktreePath);
        args.push('-');

        const env: Record<string, string> = { ...process.env } as Record<string, string>;
        if (this.apiKey) {
          env.CODEX_API_KEY = this.apiKey;
        }

        const proc = spawn('codex', args, {
          cwd: worktreePath,
          env,
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        let stdout = '';
        let stderr = '';
        let timedOut = false;

        const timer = setTimeout(() => {
          timedOut = true;
          proc.kill('SIGTERM');
          setTimeout(() => proc.kill('SIGKILL'), 5000);
        }, timeoutMs);

        proc.stdin.write(prompt);
        proc.stdin.end();

        proc.stdout.on('data', (data: Buffer) => {
          const text = data.toString();
          stdout += text;
          if (verbose) {
            onProgress(text.trim().slice(0, 100));
          }
        });

        proc.stderr.on('data', (data: Buffer) => {
          stderr += data.toString();
        });

        proc.on('close', (code: number | null) => {
          clearTimeout(timer);
          const durationMs = Date.now() - startTime;

          if (timedOut) {
            resolve({ success: false, error: `Timed out after ${timeoutMs}ms`, stdout, stderr, exitCode: code, timedOut: true, durationMs });
            return;
          }

          // Prefer --output-last-message file over stdout (stdout is JSONL telemetry)
          let output = stdout;
          try {
            output = readFileSync(outPath, 'utf-8');
          } catch {
            // Fall back to stdout if file wasn't written
          }

          if (code !== 0) {
            resolve({ success: false, error: `codex exited with code ${code}: ${stderr.slice(0, 200)}`, stdout: output, stderr, exitCode: code, timedOut: false, durationMs });
            return;
          }

          resolve({ success: true, stdout: output, stderr, exitCode: code, timedOut: false, durationMs });
        });

        proc.on('error', (err: Error) => {
          clearTimeout(timer);
          resolve({ success: false, error: err.message, stdout, stderr, exitCode: null, timedOut: false, durationMs: Date.now() - startTime });
        });
      });
    } finally {
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  }
}
