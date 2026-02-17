/**
 * Generic provider registry for CLI backends (Claude, Codex, Kimi, OpenAI-Local, etc.)
 *
 * Each provider defines metadata, auth requirements, and factory methods
 * for creating scout and execution backends.
 */

export type { ProviderConfig, ProviderFactoryOpts, ExecutionFactoryOpts } from './types.js';

import type { ProviderConfig } from './types.js';
import { claude } from './claude.js';
import { codex } from './codex.js';
import { kimi } from './kimi.js';
import { openaiLocal } from './openai-local.js';

const providers = new Map<string, ProviderConfig>();

providers.set('claude', claude);
providers.set('codex', codex);
providers.set('kimi', kimi);
providers.set('openai-local', openaiLocal);

/**
 * Get a provider config by name.
 * Throws if the provider is not registered.
 */
export function getProvider(name: string): ProviderConfig {
  const provider = providers.get(name);
  if (!provider) {
    throw new Error(`Unknown provider: ${name}. Valid providers: ${getProviderNames().join(', ')}`);
  }
  return provider;
}

/**
 * Check if a provider name is registered.
 */
export function isValidProvider(name: string): boolean {
  return providers.has(name);
}

/**
 * Get all registered provider names.
 */
export function getProviderNames(): string[] {
  return Array.from(providers.keys());
}
