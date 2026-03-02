/**
 * Anthropic Batch API provider config
 *
 * Uses the Message Batches API for 50% cost reduction on scout prompts.
 * Only used as a scout backend — execution stays real-time.
 */

import type { ProviderConfig } from './types.js';

export const anthropicBatch: ProviderConfig = {
  displayName: 'Anthropic Batch',
  defaultModel: 'claude-sonnet-4-20250514',
  apiKeyEnvVar: 'ANTHROPIC_API_KEY',
  guidelinesFile: 'CLAUDE.md',
  defaultScoutTimeoutMs: 0, // Batch API manages its own timeout (24h expiry)
  defaultScoutConcurrency: 1, // runAll() handles all batches in one submission
  defaultBatchTokenBudget: 40_000,
  async createScoutBackend(opts) {
    const { AnthropicBatchScoutBackend } = await import('@promptwheel/core/scout');
    return new AnthropicBatchScoutBackend({ apiKey: opts.apiKey, model: opts.model });
  },
  async createExecutionBackend() {
    // Batch mode is scout-only — execution uses Claude CLI
    const { ClaudeExecutionBackend } = await import('../execution-backends/index.js');
    return new ClaudeExecutionBackend();
  },
};
