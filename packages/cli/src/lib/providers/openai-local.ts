/**
 * OpenAI-compatible local provider (Ollama, vLLM, SGLang, LM Studio)
 *
 * Uses raw fetch — zero new dependencies.
 */

import type { ProviderConfig } from './types.js';

const DEFAULT_BASE_URL = 'http://localhost:11434/v1';

export const openaiLocal: ProviderConfig = {
  displayName: 'OpenAI-Compatible Local',
  defaultModel: '',  // Must be specified via --local-model
  apiKeyEnvVar: null,
  guidelinesFile: 'CLAUDE.md',
  defaultScoutTimeoutMs: 300_000,
  defaultScoutConcurrency: 2,
  defaultBatchTokenBudget: 40_000,
  async createScoutBackend(opts) {
    const { OpenAILocalScoutBackend } = await import('@blockspool/core/scout');
    const baseUrl = opts.baseUrl || DEFAULT_BASE_URL;
    const model = opts.model || 'llama3';
    const apiKey = process.env.LOCAL_API_KEY || process.env.OPENAI_API_KEY;
    return new OpenAILocalScoutBackend({ baseUrl, model, apiKey });
  },
  async createExecutionBackend(opts) {
    const { OpenAILocalExecutionBackend } = await import('../openai-local-execution.js');
    const baseUrl = opts.baseUrl || DEFAULT_BASE_URL;
    const model = opts.model || 'llama3';
    const apiKey = process.env.LOCAL_API_KEY || process.env.OPENAI_API_KEY;
    return new OpenAILocalExecutionBackend({ baseUrl, model, apiKey, maxIterations: opts.maxIterations });
  },
};
