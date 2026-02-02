/**
 * OpenAI-compatible local scout backend
 *
 * Uses raw fetch against any OpenAI-compatible API (Ollama, vLLM, SGLang, LM Studio).
 * Zero new dependencies — uses Node's built-in fetch.
 */

import type { ScoutBackend, RunnerOptions, RunnerResult } from './runner.js';

export class OpenAILocalScoutBackend implements ScoutBackend {
  readonly name = 'openai-local';
  private baseUrl: string;
  private model: string;
  private apiKey?: string;

  constructor(opts: { baseUrl: string; model: string; apiKey?: string }) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.model = opts.model;
    this.apiKey = opts.apiKey;
  }

  async run(options: RunnerOptions): Promise<RunnerResult> {
    const { prompt, timeoutMs, signal } = options;
    const start = Date.now();

    if (signal?.aborted) {
      return { success: false, output: '', error: 'Aborted before start', durationMs: 0 };
    }

    // Combine external signal with timeout
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const abortHandler = () => controller.abort();
    signal?.addEventListener('abort', abortHandler);

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (this.apiKey) {
        headers['Authorization'] = `Bearer ${this.apiKey}`;
      }

      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: this.model,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0,
        }),
        signal: controller.signal,
      });

      const durationMs = Date.now() - start;

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        return {
          success: false,
          output: '',
          error: `HTTP ${response.status}: ${body.slice(0, 500)}`,
          durationMs,
        };
      }

      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = data.choices?.[0]?.message?.content ?? '';

      return {
        success: true,
        output: content,
        durationMs,
      };
    } catch (err) {
      const durationMs = Date.now() - start;
      const message = err instanceof Error ? err.message : String(err);
      const isAbort = message.includes('abort') || message.includes('AbortError');
      return {
        success: false,
        output: '',
        error: isAbort
          ? (signal?.aborted ? 'Aborted by signal' : 'Timeout exceeded')
          : message,
        durationMs,
      };
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abortHandler);
    }
  }
}
