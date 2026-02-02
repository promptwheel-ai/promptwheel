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
  /** Optional: process all batches in a single session (e.g., persistent MCP) */
  runAll?(options: RunnerOptions[]): Promise<RunnerResult[]>;
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
    this.defaultModel = opts?.model ?? 'gpt-5.2-codex';
  }

  async run(options: RunnerOptions): Promise<RunnerResult> {
    const { prompt, cwd, timeoutMs, model, signal } = options;
    const start = Date.now();

    if (signal?.aborted) {
      return { success: false, output: '', error: 'Aborted before start', durationMs: 0 };
    }

    const tmpDir = mkdtempSync(join(tmpdir(), 'blockspool-codex-'));
    const outPath = join(tmpDir, 'output.md');
    const schemaPath = join(tmpDir, 'schema.json');

    // Write JSON schema so Codex returns structured output
    // OpenAI requires additionalProperties: false on every object
    writeFileSync(schemaPath, JSON.stringify({
      type: 'object',
      properties: {
        proposals: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              category: { type: 'string' },
              title: { type: 'string' },
              description: { type: 'string' },
              acceptance_criteria: { type: 'array', items: { type: 'string' } },
              verification_commands: { type: 'array', items: { type: 'string' } },
              allowed_paths: { type: 'array', items: { type: 'string' } },
              files: { type: 'array', items: { type: 'string' } },
              confidence: { type: 'number' },
              impact_score: { type: 'number' },
              rationale: { type: 'string' },
              estimated_complexity: { type: 'string' },
            },
            required: ['category', 'title', 'description', 'confidence', 'impact_score', 'files',
              'acceptance_criteria', 'verification_commands', 'allowed_paths', 'rationale', 'estimated_complexity'],
            additionalProperties: false,
          },
        },
      },
      required: ['proposals'],
      additionalProperties: false,
    }));

    try {
      const effectiveModel = model ?? this.defaultModel;

      const args = [
        'exec',
        '--json',
        '--sandbox', 'read-only',
        '--output-last-message', outPath,
        '--output-schema', schemaPath,
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
 * Codex MCP scout backend — persistent single session
 *
 * Instead of spawning N cold `codex exec` processes, spawns ONE session
 * that connects to our MCP batch server. Codex calls tools in a loop
 * to pull batches and submit results. One warm session, zero cold starts.
 *
 * Opt-in via --codex-mcp flag.
 */
export class CodexMcpScoutBackend implements ScoutBackend {
  readonly name = 'codex';
  private apiKey?: string;
  private defaultModel: string;

  constructor(opts?: { apiKey?: string; model?: string }) {
    this.apiKey = opts?.apiKey;
    this.defaultModel = opts?.model ?? 'gpt-5.2-codex';
  }

  /** Single-batch fallback (not normally used — runAll is preferred) */
  async run(options: RunnerOptions): Promise<RunnerResult> {
    // Delegate to the regular CodexScoutBackend for single-batch
    const backend = new CodexScoutBackend({ apiKey: this.apiKey, model: this.defaultModel });
    return backend.run(options);
  }

  /**
   * Process all batches in a single persistent Codex session via MCP.
   *
   * 1. Writes batch prompts to a temp JSON file
   * 2. Spawns `codex exec` with MCP config pointing to our batch server
   * 3. Codex loops over get_next_batch → analyze → submit_results
   * 4. Collects results when signal_done fires
   */
  async runAll(allOptions: RunnerOptions[]): Promise<RunnerResult[]> {
    const start = Date.now();
    const cwd = allOptions[0]?.cwd ?? process.cwd();
    const model = allOptions[0]?.model ?? this.defaultModel;
    const signal = allOptions[0]?.signal;
    const timeoutMs = Math.max(...allOptions.map(o => o.timeoutMs)) * allOptions.length;

    if (signal?.aborted) {
      return allOptions.map(() => ({ success: false, output: '', error: 'Aborted before start', durationMs: 0 }));
    }

    const prompts = allOptions.map(o => o.prompt);

    const tmpDir = mkdtempSync(join(tmpdir(), 'blockspool-mcp-'));
    const dataPath = join(tmpDir, 'batches.json');
    const outPath = join(tmpDir, 'output.md');

    writeFileSync(dataPath, JSON.stringify(prompts));

    // Resolve path to the MCP batch server entrypoint
    // In production: dist/scout/mcp-batch-server.js
    // We use import.meta.url to find our own location
    const selfUrl = import.meta?.url;
    let serverScript: string;
    if (selfUrl) {
      const { fileURLToPath } = await import('node:url');
      const selfPath = fileURLToPath(selfUrl);
      const dir = selfPath.substring(0, selfPath.lastIndexOf('/'));
      serverScript = join(dir, 'mcp-batch-server.js');
    } else {
      serverScript = join(process.cwd(), 'node_modules', '@blockspool', 'core', 'dist', 'scout', 'mcp-batch-server.js');
    }

    // Build MCP config for codex exec
    const mcpConfig = {
      mcpServers: {
        'batch-server': {
          command: 'node',
          args: [serverScript, '--data', dataPath],
        },
      },
    };
    const mcpConfigPath = join(tmpDir, 'mcp-config.json');
    writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig));

    const systemPrompt = `You have access to a batch analysis MCP server with three tools: get_next_batch, submit_results, and signal_done.

Your job:
1. Call get_next_batch() to get a batch of code files to analyze
2. Read the prompt carefully and analyze the code
3. Generate proposals as a JSON object with a "proposals" array
4. Call submit_results({ batchId: <id>, output: <your JSON string> })
5. Repeat steps 1-4 until get_next_batch() returns { done: true }
6. Call signal_done() to confirm completion

IMPORTANT: Each batch prompt contains code files and instructions. Follow the instructions exactly.
Return your analysis as a JSON string in the output field of submit_results.`;

    try {
      const args = [
        'exec',
        '--sandbox', 'read-only',
        '--output-last-message', outPath,
        '--model', model,
        '--cd', cwd,
        '-c', mcpConfigPath,
        '-',
      ];

      const env: Record<string, string> = { ...process.env } as Record<string, string>;
      if (this.apiKey) {
        env.CODEX_API_KEY = this.apiKey;
      }

      const result = await new Promise<{ success: boolean; output: string; error?: string }>((resolve) => {
        const proc = spawn('codex', args, {
          cwd,
          env,
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        proc.stdin.write(systemPrompt);
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

          if (killed) {
            resolve({ success: false, output: stdout, error: signal?.aborted ? 'Aborted by signal' : 'Timeout exceeded' });
            return;
          }

          // Read the batch server's collected results from the data temp dir
          // The MCP server writes results as side-effect; we read them via the output file
          let output = stdout;
          try {
            output = readFileSync(outPath, 'utf-8');
          } catch {
            // Fall back to stdout
          }

          if (code !== 0) {
            resolve({ success: false, output, error: stderr || `codex exited with code ${code}` });
            return;
          }

          resolve({ success: true, output });
        });

        proc.on('error', (err) => {
          clearTimeout(timeout);
          signal?.removeEventListener('abort', abortHandler);
          resolve({ success: false, output: '', error: err.message });
        });
      });

      const durationMs = Date.now() - start;

      if (!result.success) {
        return allOptions.map(() => ({
          success: false,
          output: result.output,
          error: result.error,
          durationMs,
        }));
      }

      // Parse collected results from the MCP server
      // The server stores results in a Map<batchId, output>
      // We need to reconstruct from what Codex submitted
      // Since the MCP server runs in-process with Codex (via stdio),
      // we parse the output looking for per-batch JSON results
      //
      // Strategy: try to split the output by batch, or treat entire output
      // as a single result and distribute
      const results: RunnerResult[] = [];

      // Try reading a results file that the MCP server may have written
      const resultsPath = join(tmpDir, 'results.json');
      let batchResults: Map<number, string> | null = null;
      try {
        const raw = readFileSync(resultsPath, 'utf-8');
        const parsed = JSON.parse(raw) as Record<string, string>;
        batchResults = new Map(Object.entries(parsed).map(([k, v]) => [parseInt(k, 10), v]));
      } catch {
        // Results file not available — Codex submitted via MCP tools
        // We need to extract from the Codex output
      }

      if (batchResults && batchResults.size > 0) {
        for (let i = 0; i < allOptions.length; i++) {
          const batchOutput = batchResults.get(i);
          results.push({
            success: !!batchOutput,
            output: batchOutput ?? '',
            error: batchOutput ? undefined : 'No result for batch',
            durationMs: Math.round(durationMs / allOptions.length),
          });
        }
      } else {
        // Fallback: return the entire output as a single result for batch 0,
        // empty results for the rest. The caller will parse what it can.
        for (let i = 0; i < allOptions.length; i++) {
          results.push({
            success: i === 0 && result.success,
            output: i === 0 ? result.output : '',
            error: i === 0 ? undefined : 'Batch not processed (MCP session may have ended early)',
            durationMs: Math.round(durationMs / allOptions.length),
          });
        }
      }

      return results;

    } finally {
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
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
