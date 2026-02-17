import { describe, it, expect } from 'vitest';
import {
  getCycleCategories,
  type CycleFormulaContext,
} from '../lib/solo-cycle-formula.js';
import type { Formula } from '../lib/formulas.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(overrides: Partial<CycleFormulaContext> = {}): CycleFormulaContext {
  return {
    activeFormula: null,
    sessionPhase: 'deep',
    deepFormula: null,
    docsAuditFormula: null,
    isContinuous: false,
    repoRoot: '/tmp/test',
    options: {},
    config: null,
    ...overrides,
  };
}

function makeFormula(overrides: Partial<Formula> = {}): Formula {
  return {
    name: 'test-formula',
    description: 'Test formula',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// getCycleCategories
// ---------------------------------------------------------------------------

describe('getCycleCategories', () => {
  // ---------------------------------------------------------------------------
  // Cooldown phase
  // ---------------------------------------------------------------------------

  it('restricts to light categories during cooldown', () => {
    const ctx = makeCtx({ sessionPhase: 'cooldown' });
    const { allow, block } = getCycleCategories(ctx, null);

    expect(allow).toEqual(['docs', 'cleanup', 'types']);
    expect(block).toContain('deps');
    expect(block).toContain('auth');
    expect(block).toContain('config');
    expect(block).toContain('migration');
  });

  it('cooldown ignores formula categories', () => {
    const ctx = makeCtx({ sessionPhase: 'cooldown' });
    const formula = makeFormula({ categories: ['security', 'fix'] });
    const { allow } = getCycleCategories(ctx, formula);

    // Cooldown always returns light categories regardless of formula
    expect(allow).toEqual(['docs', 'cleanup', 'types']);
  });

  // ---------------------------------------------------------------------------
  // Default categories (no formula, no safe mode)
  // ---------------------------------------------------------------------------

  it('returns broad default categories when no formula and not safe', () => {
    const ctx = makeCtx({ sessionPhase: 'deep', options: {} });
    const { allow, block } = getCycleCategories(ctx, null);

    expect(allow).toEqual(['refactor', 'docs', 'types', 'perf', 'security', 'fix', 'cleanup']);
    expect(block).toEqual(['deps', 'auth', 'config', 'migration']);
  });

  // ---------------------------------------------------------------------------
  // Safe mode
  // ---------------------------------------------------------------------------

  it('restricts categories in safe mode', () => {
    const ctx = makeCtx({ options: { safe: true } });
    const { allow, block } = getCycleCategories(ctx, null);

    expect(allow).toEqual(['refactor', 'docs', 'types', 'perf']);
    expect(block).toContain('security');
    expect(block).toContain('fix');
    expect(block).toContain('cleanup');
    expect(block).toContain('deps');
  });

  // ---------------------------------------------------------------------------
  // Formula categories
  // ---------------------------------------------------------------------------

  it('uses formula categories when provided', () => {
    const formula = makeFormula({ categories: ['security', 'fix'] });
    const ctx = makeCtx();
    const { allow, block } = getCycleCategories(ctx, formula);

    expect(allow).toEqual(['security', 'fix']);
    // Formula with categories → empty block list
    expect(block).toEqual([]);
  });

  it('formula categories override safe mode', () => {
    const formula = makeFormula({ categories: ['security'] });
    const ctx = makeCtx({ options: { safe: true } });
    const { allow, block } = getCycleCategories(ctx, formula);

    // Formula categories take precedence over safe mode defaults
    expect(allow).toEqual(['security']);
    expect(block).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // --tests flag
  // ---------------------------------------------------------------------------

  it('adds test to allow list when --tests flag is set', () => {
    const ctx = makeCtx({ options: { tests: true } });
    const { allow } = getCycleCategories(ctx, null);

    expect(allow).toContain('test');
  });

  it('does not duplicate test if formula already includes it', () => {
    const formula = makeFormula({ categories: ['test', 'fix'] });
    const ctx = makeCtx({ options: { tests: true } });
    const { allow } = getCycleCategories(ctx, formula);

    const testCount = allow.filter(c => c === 'test').length;
    expect(testCount).toBe(1);
  });

  it('adds test to safe mode categories when --tests is set', () => {
    const ctx = makeCtx({ options: { safe: true, tests: true } });
    const { allow } = getCycleCategories(ctx, null);

    expect(allow).toContain('test');
    expect(allow).toContain('refactor');
    expect(allow).toContain('docs');
  });

  it('does not include test by default', () => {
    const ctx = makeCtx({ options: {} });
    const { allow } = getCycleCategories(ctx, null);

    expect(allow).not.toContain('test');
  });

  // ---------------------------------------------------------------------------
  // Warmup phase (non-cooldown)
  // ---------------------------------------------------------------------------

  it('returns default categories during warmup phase', () => {
    const ctx = makeCtx({ sessionPhase: 'warmup' });
    const { allow, block } = getCycleCategories(ctx, null);

    // Warmup is not cooldown — gets normal categories
    expect(allow).toEqual(['refactor', 'docs', 'types', 'perf', 'security', 'fix', 'cleanup']);
    expect(block).toEqual(['deps', 'auth', 'config', 'migration']);
  });

  // ---------------------------------------------------------------------------
  // Formula with no categories
  // ---------------------------------------------------------------------------

  it('falls back to defaults when formula has no categories', () => {
    const formula = makeFormula({ categories: undefined });
    const ctx = makeCtx();
    const { allow, block } = getCycleCategories(ctx, formula);

    // No categories on formula → default non-safe list
    expect(allow).toEqual(['refactor', 'docs', 'types', 'perf', 'security', 'fix', 'cleanup']);
    expect(block).toEqual(['deps', 'auth', 'config', 'migration']);
  });
});
