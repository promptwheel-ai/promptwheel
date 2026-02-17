/**
 * Claude provider config
 */

import type { ProviderConfig } from './types.js';

export const claude: ProviderConfig = {
  displayName: 'Claude',
  defaultModel: 'opus',
  apiKeyEnvVar: 'ANTHROPIC_API_KEY',
  guidelinesFile: 'CLAUDE.md',
  defaultScoutTimeoutMs: 0,
  defaultScoutConcurrency: 3,
  defaultBatchTokenBudget: 40_000,
  async createScoutBackend() {
    const { ClaudeScoutBackend } = await import('@promptwheel/core/scout');
    return new ClaudeScoutBackend();
  },
  async createExecutionBackend() {
    const { ClaudeExecutionBackend } = await import('../execution-backends/index.js');
    return new ClaudeExecutionBackend();
  },
};
