import { describe, it, expect } from 'vitest';
import { getProvider, isValidProvider, getProviderNames } from '../lib/providers/index.js';

// ---------------------------------------------------------------------------
// getProviderNames
// ---------------------------------------------------------------------------

describe('getProviderNames', () => {
  it('returns all registered provider names', () => {
    const names = getProviderNames();
    expect(names).toContain('claude');
    expect(names).toContain('codex');
    expect(names).toContain('kimi');
    expect(names).toContain('openai-local');
  });

  it('returns exactly 4 providers', () => {
    expect(getProviderNames()).toHaveLength(4);
  });

  it('returns an array of strings', () => {
    const names = getProviderNames();
    for (const name of names) {
      expect(typeof name).toBe('string');
    }
  });
});

// ---------------------------------------------------------------------------
// isValidProvider
// ---------------------------------------------------------------------------

describe('isValidProvider', () => {
  it('returns true for all registered providers', () => {
    expect(isValidProvider('claude')).toBe(true);
    expect(isValidProvider('codex')).toBe(true);
    expect(isValidProvider('kimi')).toBe(true);
    expect(isValidProvider('openai-local')).toBe(true);
  });

  it('returns false for unknown provider names', () => {
    expect(isValidProvider('unknown')).toBe(false);
    expect(isValidProvider('gpt4')).toBe(false);
    expect(isValidProvider('')).toBe(false);
  });

  it('is case-sensitive', () => {
    expect(isValidProvider('Claude')).toBe(false);
    expect(isValidProvider('CLAUDE')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getProvider
// ---------------------------------------------------------------------------

describe('getProvider', () => {
  it('returns a config object for valid providers', () => {
    const config = getProvider('claude');
    expect(config).toBeDefined();
    expect(typeof config.displayName).toBe('string');
    expect(typeof config.defaultModel).toBe('string');
    expect(typeof config.guidelinesFile).toBe('string');
  });

  it('throws for unknown provider', () => {
    expect(() => getProvider('unknown')).toThrow('Unknown provider: unknown');
  });

  it('includes valid provider names in error message', () => {
    expect(() => getProvider('bad')).toThrow('Valid providers:');
  });

  it('returns config with required fields for each provider', () => {
    for (const name of getProviderNames()) {
      const config = getProvider(name);
      expect(config.displayName).toBeTruthy();
      expect(typeof config.defaultModel).toBe('string');
      expect(config.guidelinesFile).toBeTruthy();
      expect(typeof config.defaultScoutTimeoutMs).toBe('number');
      expect(typeof config.defaultScoutConcurrency).toBe('number');
      expect(typeof config.defaultBatchTokenBudget).toBe('number');
      expect(config.defaultScoutTimeoutMs).toBeGreaterThanOrEqual(0);
      expect(config.defaultScoutConcurrency).toBeGreaterThan(0);
      expect(config.defaultBatchTokenBudget).toBeGreaterThan(0);
    }
  });

  it('returns config with factory methods for each provider', () => {
    for (const name of getProviderNames()) {
      const config = getProvider(name);
      expect(typeof config.createScoutBackend).toBe('function');
      expect(typeof config.createExecutionBackend).toBe('function');
    }
  });

  it('claude provider uses CLAUDE.md guidelines file', () => {
    const config = getProvider('claude');
    expect(config.guidelinesFile).toBe('CLAUDE.md');
  });

  it('claude provider requires ANTHROPIC_API_KEY', () => {
    const config = getProvider('claude');
    expect(config.apiKeyEnvVar).toBe('ANTHROPIC_API_KEY');
  });

  it('openai-local provider has null apiKeyEnvVar', () => {
    const config = getProvider('openai-local');
    expect(config.apiKeyEnvVar).toBeNull();
  });
});
