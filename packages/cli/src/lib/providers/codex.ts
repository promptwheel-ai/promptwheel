/**
 * Codex provider config
 */

import type { ProviderConfig } from './types.js';

export const codex: ProviderConfig = {
  displayName: 'Codex',
  defaultModel: 'gpt-5.3-codex',
  apiKeyEnvVar: 'OPENAI_API_KEY',
  altAuth: 'codex login',
  guidelinesFile: 'AGENTS.md',
  defaultScoutTimeoutMs: 0,
  defaultScoutConcurrency: 4,
  defaultBatchTokenBudget: 60_000,
  async createScoutBackend(opts) {
    const { CodexScoutBackend } = await import('@promptwheel/core/scout');
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
