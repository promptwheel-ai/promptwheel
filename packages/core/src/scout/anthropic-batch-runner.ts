/**
 * Anthropic Batch API scout backend
 *
 * Uses the Message Batches API for 50% cost reduction on scout prompts.
 * Submits all scout batches as a single API batch, polls for completion,
 * then maps results back to RunnerResult[].
 *
 * Opt-in via `--batch` CLI flag. Requires ANTHROPIC_API_KEY.
 */

import type { ScoutBackend, RunnerOptions, RunnerResult } from './runner.js';

/**
 * Minimal subset of Anthropic SDK types used by this backend.
 * Avoids a hard import so the module loads even without @anthropic-ai/sdk installed.
 */
interface AnthropicClient {
  messages: {
    create(params: {
      model: string;
      max_tokens: number;
      messages: Array<{ role: string; content: string }>;
    }): Promise<{ content: Array<{ type: string; text?: string }> }>;
    batches: {
      create(params: {
        requests: Array<{
          custom_id: string;
          params: {
            model: string;
            max_tokens: number;
            messages: Array<{ role: string; content: string }>;
          };
        }>;
      }): Promise<{
        id: string;
        processing_status: string;
      }>;
      retrieve(id: string): Promise<{
        id: string;
        processing_status: string;
        results_url: string | null;
      }>;
      results(id: string): Promise<AsyncIterable<{
        custom_id: string;
        result: {
          type: string;
          message?: { content: Array<{ type: string; text?: string }> };
          error?: { message: string };
        };
      }>>;
      cancel(id: string): Promise<unknown>;
    };
  };
}

export class AnthropicBatchScoutBackend implements ScoutBackend {
  readonly name = 'anthropic-batch';
  private client: AnthropicClient | null = null;
  private model: string;
  private apiKey?: string;

  constructor(opts?: { apiKey?: string; model?: string }) {
    this.apiKey = opts?.apiKey;
    this.model = opts?.model ?? 'claude-sonnet-4-20250514';
  }

  private async getClient(): Promise<AnthropicClient> {
    if (this.client) return this.client;
    try {
      // Dynamic import — only fails if --batch is used without the SDK installed
      const { default: Anthropic } = await import('@anthropic-ai/sdk');
      this.client = new Anthropic({ apiKey: this.apiKey }) as unknown as AnthropicClient;
      return this.client;
    } catch {
      throw new Error(
        'AnthropicBatchScoutBackend requires @anthropic-ai/sdk. ' +
        'Install it with: npm install @anthropic-ai/sdk',
      );
    }
  }

  /**
   * Extract text content from a Messages API response content array.
   */
  private extractText(content: Array<{ type: string; text?: string }>): string {
    return content
      .filter(c => c.type === 'text' && c.text)
      .map(c => c.text!)
      .join('');
  }

  /**
   * Single-batch fallback — uses standard messages.create() (no batch overhead).
   */
  async run(options: RunnerOptions): Promise<RunnerResult> {
    const { prompt, timeoutMs, signal } = options;
    const start = Date.now();

    if (signal?.aborted) {
      return { success: false, output: '', error: 'Aborted before start', durationMs: 0 };
    }

    const client = await this.getClient();

    // Combine external signal with timeout
    const controller = new AbortController();
    const timeout = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;
    const abortHandler = () => controller.abort();
    signal?.addEventListener('abort', abortHandler);

    try {
      const response = await client.messages.create({
        model: this.model,
        max_tokens: 16384,
        messages: [{ role: 'user', content: prompt }],
      });

      const output = this.extractText(response.content);
      return {
        success: true,
        output,
        durationMs: Date.now() - start,
      };
    } catch (err) {
      return {
        success: false,
        output: '',
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start,
      };
    } finally {
      if (timeout) clearTimeout(timeout);
      signal?.removeEventListener('abort', abortHandler);
    }
  }

  /**
   * Batch API path — submit all prompts as one batch, poll for results.
   *
   * 1. Build requests array for batches.create()
   * 2. Submit batch
   * 3. Poll batch status until 'ended' (with exponential backoff)
   * 4. Stream results via batches.results()
   * 5. Map results back to RunnerResult[]
   */
  async runAll(allOptions: RunnerOptions[]): Promise<RunnerResult[]> {
    const start = Date.now();
    const signal = allOptions[0]?.signal;

    if (signal?.aborted) {
      return allOptions.map(() => ({
        success: false, output: '', error: 'Aborted before start', durationMs: 0,
      }));
    }

    // For a single batch, skip batch API overhead
    if (allOptions.length === 1) {
      return [await this.run(allOptions[0])];
    }

    const client = await this.getClient();

    // 1. Build batch requests
    const requests = allOptions.map((opt, i) => ({
      custom_id: `batch-${i}`,
      params: {
        model: this.model,
        max_tokens: 16384,
        messages: [{ role: 'user' as const, content: opt.prompt }],
      },
    }));

    // 2. Submit batch
    let batch: { id: string; processing_status: string };
    try {
      batch = await client.messages.batches.create({ requests });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return allOptions.map(() => ({
        success: false, output: '', error: `Batch creation failed: ${error}`, durationMs: Date.now() - start,
      }));
    }

    // 3. Poll until ended
    try {
      await this.pollUntilEnded(client, batch.id, signal);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      // Try to cancel the batch on abort
      if (signal?.aborted) {
        try { await client.messages.batches.cancel(batch.id); } catch { /* best-effort */ }
      }
      return allOptions.map(() => ({
        success: false, output: '', error, durationMs: Date.now() - start,
      }));
    }

    // 4. Stream results and map back
    const resultMap = new Map<number, RunnerResult>();

    try {
      const resultsIter = await client.messages.batches.results(batch.id);
      for await (const entry of resultsIter) {
        const index = this.parseCustomId(entry.custom_id);
        if (index === null) continue;

        if (entry.result.type === 'succeeded' && entry.result.message) {
          const output = this.extractText(entry.result.message.content);
          resultMap.set(index, {
            success: true,
            output,
            durationMs: Date.now() - start,
          });
        } else if (entry.result.type === 'errored') {
          resultMap.set(index, {
            success: false,
            output: '',
            error: entry.result.error?.message ?? 'Batch request errored',
            durationMs: Date.now() - start,
          });
        } else {
          // canceled or expired
          resultMap.set(index, {
            success: false,
            output: '',
            error: `Batch request ${entry.result.type}`,
            durationMs: Date.now() - start,
          });
        }
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      // Return what we have, fill gaps with error
      const durationMs = Date.now() - start;
      return allOptions.map((_, i) =>
        resultMap.get(i) ?? { success: false, output: '', error: `Results fetch failed: ${error}`, durationMs },
      );
    }

    // 5. Map results preserving batch order
    const durationMs = Date.now() - start;
    return allOptions.map((_, i) =>
      resultMap.get(i) ?? { success: false, output: '', error: 'No result returned for batch', durationMs },
    );
  }

  /**
   * Poll batch status with exponential backoff until processing_status is 'ended'.
   */
  private async pollUntilEnded(
    client: AnthropicClient,
    batchId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    let delay = 2000;     // Start at 2s
    const factor = 1.5;   // Backoff multiplier
    const maxDelay = 30000; // Cap at 30s

    while (true) {
      if (signal?.aborted) {
        throw new Error('Aborted by signal');
      }

      const status = await client.messages.batches.retrieve(batchId);
      if (status.processing_status === 'ended') {
        return;
      }

      // Wait with abort-awareness
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, delay);
        if (signal) {
          const onAbort = () => {
            clearTimeout(timer);
            reject(new Error('Aborted by signal'));
          };
          signal.addEventListener('abort', onAbort, { once: true });
          // Clean up listener when timer fires
          const origResolve = resolve;
          resolve = (() => {
            signal.removeEventListener('abort', onAbort);
            origResolve();
          }) as () => void;
        }
      });

      delay = Math.min(delay * factor, maxDelay);
    }
  }

  /**
   * Parse a custom_id like "batch-3" back to its index.
   */
  private parseCustomId(customId: string): number | null {
    const match = customId.match(/^batch-(\d+)$/);
    return match ? parseInt(match[1], 10) : null;
  }
}
