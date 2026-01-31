/**
 * Scout runner - Executes LLM CLI backends for analysis
 */

import { spawn } from 'node:child_process';
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface RunnerOptions {
  /** Prompt to send to the LLM */
  prompt: string;
  /** Working directory */
  cwd: string;
  /** Timeout in ms */
  timeoutMs: number;
  /** Model to use */
  model?: string;
  /** Cancellation signal */
  signal?: AbortSignal;
}

export interface RunnerResult {
  /** Whether execution succeeded */
  success: boolean;
  /** Output from the LLM */
  output: string;
  /** Error message if failed */
  error?: string;
  /** Duration in ms */
  durationMs: number;
}

/**
 * Pluggable scout backend interface
 */
export interface ScoutBackend {
  /** Human-readable name for logging */
  readonly name: string;
  /** Run a scout prompt and return the result */
  run(options: RunnerOptions): Promise<RunnerResult>;
}

/**
 * Run Claude Code CLI with a prompt
 */
export async function runClaude(options: RunnerOptions): Promise<RunnerResult> {
  const { prompt, cwd, timeoutMs, model = 'opus', signal } = options;
  const start = Date.now();

  return new Promise((resolve) => {
    // Check if already aborted
    if (signal?.aborted) {
      resolve({
        success: false,
        output: '',
        error: 'Aborted before start',
        durationMs: Date.now() - start,
      });
      return;
    }

    const args = [
      '-p', prompt,
      '--model', model,
      '--output-format', 'text',
      '--allowedTools', '',  // Disable tools - content provided in prompt
    ];

    const proc = spawn('claude', args, {
      cwd,
      env: {
        ...process.env,
        CLAUDE_CODE_NON_INTERACTIVE: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let killed = false;

    // Timeout handler
    const timeout = setTimeout(() => {
      killed = true;
      proc.kill('SIGTERM');
      // Grace period before SIGKILL
      setTimeout(() => proc.kill('SIGKILL'), 5000);
    }, timeoutMs);

    // Abort signal handler
    const abortHandler = () => {
      killed = true;
      proc.kill('SIGTERM');
    };
    signal?.addEventListener('abort', abortHandler);

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abortHandler);

      const durationMs = Date.now() - start;

      if (killed) {
        resolve({
          success: false,
          output: stdout,
          error: signal?.aborted ? 'Aborted by signal' : 'Timeout exceeded',
          durationMs,
        });
        return;
      }

      if (code !== 0) {
        resolve({
          success: false,
          output: stdout,
          error: stderr || `Process exited with code ${code}`,
          durationMs,
        });
        return;
      }

      resolve({
        success: true,
        output: stdout,
        durationMs,
      });
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abortHandler);

      resolve({
        success: false,
        output: '',
        error: err.message,
        durationMs: Date.now() - start,
      });
    });
  });
}

/**
 * Claude Code CLI scout backend (default)
 */
export class ClaudeScoutBackend implements ScoutBackend {
  readonly name = 'claude';

  run(options: RunnerOptions): Promise<RunnerResult> {
    return runClaude(options);
  }
}

/**
 * Codex CLI scout backend
 *
 * Spawns `codex exec` in read-only sandbox mode for analysis.
 * Uses --output-last-message for reliable output extraction.
 */
export class CodexScoutBackend implements ScoutBackend {
  readonly name = 'codex';
  private apiKey?: string;
  private defaultModel: string;

  constructor(opts?: { apiKey?: string; model?: string }) {
    this.apiKey = opts?.apiKey;
    this.defaultModel = opts?.model ?? 'o4-mini';
  }

  async run(options: RunnerOptions): Promise<RunnerResult> {
    const { prompt, cwd, timeoutMs, model, signal } = options;
    const start = Date.now();

    if (signal?.aborted) {
      return { success: false, output: '', error: 'Aborted before start', durationMs: 0 };
    }

    const tmpDir = mkdtempSync(join(tmpdir(), 'blockspool-codex-'));
    const outPath = join(tmpDir, 'output.md');

    try {
      const effectiveModel = model ?? this.defaultModel;

      const args = [
        'exec',
        '--json',
        '--sandbox', 'read-only',
        '--ask-for-approval', 'never',
        '--output-last-message', outPath,
        '--model', effectiveModel,
        '--cd', cwd,
        '-',
      ];

      const env: Record<string, string> = { ...process.env } as Record<string, string>;
      if (this.apiKey) {
        env.CODEX_API_KEY = this.apiKey;
      }

      return await new Promise<RunnerResult>((resolve) => {
        const proc = spawn('codex', args, {
          cwd,
          env,
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        // Send prompt via stdin
        proc.stdin.write(prompt);
        proc.stdin.end();

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

          // Prefer --output-last-message file over stdout (stdout is JSONL telemetry)
          let output = stdout;
          try {
            output = readFileSync(outPath, 'utf-8');
          } catch {
            // Fall back to stdout if file wasn't written
          }

          if (code !== 0) {
            resolve({ success: false, output, error: stderr || `codex exited with code ${code}`, durationMs });
            return;
          }

          resolve({ success: true, output, durationMs });
        });

        proc.on('error', (err) => {
          clearTimeout(timeout);
          signal?.removeEventListener('abort', abortHandler);
          resolve({ success: false, output: '', error: err.message, durationMs: Date.now() - start });
        });
      });
    } finally {
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
    }
  }
}

/**
 * Parse JSON from Claude's output
 *
 * Handles common issues like markdown code blocks
 */
export function parseClaudeOutput<T>(output: string): T | null {
  // Try direct parse first
  try {
    return JSON.parse(output.trim());
  } catch {
    // Ignore and try other methods
  }

  // Try extracting from markdown code block
  const jsonMatch = output.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[1].trim());
    } catch {
      // Ignore
    }
  }

  // Try finding JSON object/array in output
  const objectMatch = output.match(/\{[\s\S]*\}/);
  if (objectMatch) {
    try {
      return JSON.parse(objectMatch[0]);
    } catch {
      // Ignore
    }
  }

  return null;
}
