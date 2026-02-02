/**
 * Codex provider config
 */

import type { ProviderConfig } from './types.js';

export const codex: ProviderConfig = {
  displayName: 'Codex',
  defaultModel: 'gpt-5.2-codex',
  apiKeyEnvVar: 'CODEX_API_KEY',
  altAuth: 'codex login',
  guidelinesFile: 'AGENTS.md',
  defaultScoutTimeoutMs: 300_000,
  defaultScoutConcurrency: 4,
  defaultBatchTokenBudget: 80_000,
  async createScoutBackend(opts) {
    const { CodexScoutBackend } = await import('@blockspool/core/scout');
    return new CodexScoutBackend({ apiKey: opts.apiKey, model: opts.model });
  },
  async createExecutionBackend(opts) {
    const { CodexExecutionBackend } = await import('../execution-backends/index.js');
    return new CodexExecutionBackend({
      apiKey: opts.apiKey,
      model: opts.model,
      unsafeBypassSandbox: opts.unsafeBypassSandbox,
    });
  },
};
