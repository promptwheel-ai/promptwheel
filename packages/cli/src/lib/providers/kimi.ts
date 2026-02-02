/**
 * Kimi provider config
 */

import type { ProviderConfig } from './types.js';

export const kimi: ProviderConfig = {
  displayName: 'Kimi',
  defaultModel: 'kimi-k2.5',
  apiKeyEnvVar: 'MOONSHOT_API_KEY',
  altAuth: 'kimi /login',
  guidelinesFile: 'KIMI.md',
  defaultScoutTimeoutMs: 180_000,
  defaultScoutConcurrency: 3,
  defaultBatchTokenBudget: 40_000,
  async createScoutBackend(opts) {
    const { KimiScoutBackend } = await import('@blockspool/core/scout');
    return new KimiScoutBackend({ apiKey: opts.apiKey, model: opts.model });
  },
  async createExecutionBackend(opts) {
    const { KimiExecutionBackend } = await import('../execution-backends/index.js');
    return new KimiExecutionBackend({ apiKey: opts.apiKey, model: opts.model });
  },
};
