/**
 * Critic scoring tests — covers pure functions in critic/shared.ts:
 *   - computeRetryRisk
 *   - scoreStrategies
 *   - buildCriticBlock
 *   - buildPlanRejectionCriticBlock
 */

import { describe, it, expect } from 'vitest';
import {
  computeRetryRisk,
  scoreStrategies,
  buildCriticBlock,
  buildPlanRejectionCriticBlock,
  type FailureContext,
  type RetryRiskScore,
} from '../critic/shared.js';
import type { Learning } from '../learnings/shared.js';

function makeLearning(overrides: Partial<Learning> = {}): Learning {
  return {
    id: 'test-1',
    text: 'Test learning',
    category: 'gotcha',
    source: { type: 'qa_failure' },
    tags: [],
    weight: 50,
    created_at: new Date().toISOString(),
    last_confirmed_at: new Date().toISOString(),
    access_count: 0,
    ...overrides,
  };
}

function makeFailureContext(overrides: Partial<FailureContext> = {}): FailureContext {
  return {
    failed_commands: ['npm test'],
    error_output: 'TypeError: x is not a function',
    attempt: 1,
    max_attempts: 3,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// computeRetryRisk
// ---------------------------------------------------------------------------

describe('computeRetryRisk', () => {
  it('returns low risk with no learnings', () => {
    const risk = computeRetryRisk(['src/**'], [], [], makeFailureContext());
    expect(risk.level).toBe('low');
    expect(risk.score).toBe(20); // attempt(1) * 20
  });

  it('increases risk with attempt count', () => {
    const r1 = computeRetryRisk([], [], [], makeFailureContext({ attempt: 1 }));
    const r2 = computeRetryRisk([], [], [], makeFailureContext({ attempt: 3 }));
    expect(r2.score).toBeGreaterThan(r1.score);
  });

  it('adds fragile path signal', () => {
    const learnings = [makeLearning({
      structured: { fragile_paths: ['src/config.ts'] },
      tags: ['path:src'],
    })];
    const risk = computeRetryRisk(['src/config.ts'], [], learnings, makeFailureContext());
    expect(risk.signals.some(s => s.includes('Fragile'))).toBe(true);
  });

  it('adds error signature signal', () => {
    const learnings = [makeLearning({
      structured: { failure_context: { command: 'npm test', error_signature: 'TypeError: x is not a function' } },
    })];
    const risk = computeRetryRisk([], [], learnings, makeFailureContext({ error_output: 'TypeError: x is not a function at line 42' }));
    expect(risk.signals.some(s => s.includes('Known error'))).toBe(true);
  });

  it('adds missing cochange signal', () => {
    const learnings = [makeLearning({
      structured: { cochange_files: ['src/auth.ts', 'src/middleware.ts'] },
    })];
    const risk = computeRetryRisk(['src/auth.ts'], [], learnings, makeFailureContext());
    expect(risk.signals.some(s => s.includes('Missing cochange'))).toBe(true);
  });

  it('caps at 100', () => {
    const learnings = Array.from({ length: 20 }, () => makeLearning({
      structured: {
        fragile_paths: ['src/config.ts'],
        failure_context: { command: 'npm test', error_signature: 'TypeError: x is not a function' },
        cochange_files: ['src/auth.ts', 'src/middleware.ts'],
      },
    }));
    const risk = computeRetryRisk(['src/config.ts'], [], learnings, makeFailureContext({ attempt: 3 }));
    expect(risk.score).toBeLessThanOrEqual(100);
  });

  it('maps score to correct level', () => {
    // low: < 30
    const low = computeRetryRisk([], [], [], makeFailureContext({ attempt: 1 }));
    expect(low.level).toBe('low');

    // medium: 30-60
    const medium = computeRetryRisk([], [], [], makeFailureContext({ attempt: 2 }));
    expect(medium.level).toBe('medium');

    // high: > 60 (score 60 is still medium per <= 60 check, so we need learnings to push past)
    const learnings = [makeLearning({
      structured: { failure_context: { command: 'npm test', error_signature: 'TypeError: x is not a function' } },
    })];
    const high = computeRetryRisk([], [], learnings, makeFailureContext({ attempt: 3 }));
    // 3*20 + 20 (error signature) = 80
    expect(high.level).toBe('high');
  });
});

// ---------------------------------------------------------------------------
// scoreStrategies
// ---------------------------------------------------------------------------

describe('scoreStrategies', () => {
  it('returns empty for no learnings', () => {
    const strategies = scoreStrategies([], makeFailureContext(), []);
    expect(strategies).toHaveLength(0);
  });

  it('generates known fix strategy', () => {
    const learnings = [makeLearning({
      weight: 80,
      structured: { failure_context: { command: 'npm test', error_signature: 'TypeError', fix_applied: 'Added null check' } },
    })];
    const strategies = scoreStrategies([], makeFailureContext(), learnings);
    expect(strategies.some(s => s.label === 'Apply known fix')).toBe(true);
    expect(strategies.find(s => s.label === 'Apply known fix')?.instruction).toContain('null check');
  });

  it('generates cochange strategy', () => {
    const learnings = [makeLearning({
      weight: 60,
      structured: { cochange_files: ['src/auth.ts', 'src/middleware.ts'] },
    })];
    const strategies = scoreStrategies(['src/auth.ts'], makeFailureContext(), learnings);
    expect(strategies.some(s => s.label === 'Include cochange files')).toBe(true);
  });

  it('generates antipattern strategy', () => {
    const learnings = [makeLearning({
      text: 'Do not use execSync here',
      weight: 70,
      structured: { pattern_type: 'antipattern' },
    })];
    const strategies = scoreStrategies([], makeFailureContext(), learnings);
    expect(strategies.some(s => s.label === 'Avoid antipattern')).toBe(true);
  });

  it('generates fallback on attempt >= 2', () => {
    const strategies = scoreStrategies([], makeFailureContext({ attempt: 2 }), []);
    expect(strategies.some(s => s.label === 'Different approach')).toBe(true);
  });

  it('returns max 3 strategies', () => {
    const learnings = Array.from({ length: 10 }, (_, i) => makeLearning({
      id: `l-${i}`,
      text: `Antipattern ${i}`,
      weight: 80 - i,
      structured: { pattern_type: 'antipattern' },
    }));
    const strategies = scoreStrategies([], makeFailureContext({ attempt: 2 }), learnings);
    expect(strategies.length).toBeLessThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// buildCriticBlock
// ---------------------------------------------------------------------------

describe('buildCriticBlock', () => {
  it('returns empty string for low risk with no confident strategies', () => {
    const risk: RetryRiskScore = { score: 10, level: 'low', signals: [] };
    const result = buildCriticBlock(makeFailureContext(), risk, [], []);
    expect(result).toBe('');
  });

  it('returns content for medium risk', () => {
    const risk: RetryRiskScore = { score: 40, level: 'medium', signals: ['Fragile: src/config.ts'] };
    const result = buildCriticBlock(makeFailureContext(), risk, [], []);
    expect(result).toContain('<critic-review>');
    expect(result).toContain('MEDIUM');
    expect(result).toContain('Fragile: src/config.ts');
    expect(result).toContain('</critic-review>');
  });

  it('includes strategies', () => {
    const risk: RetryRiskScore = { score: 50, level: 'medium', signals: [] };
    const strategies = [{ label: 'Apply known fix', instruction: 'Add null check', confidence: 80 }];
    const result = buildCriticBlock(makeFailureContext(), risk, strategies, []);
    expect(result).toContain('Apply known fix');
    expect(result).toContain('Add null check');
  });

  it('includes failed commands and error', () => {
    const fc = makeFailureContext({ failed_commands: ['npm test', 'npx tsc'] });
    const risk: RetryRiskScore = { score: 50, level: 'medium', signals: [] };
    const result = buildCriticBlock(fc, risk, [], []);
    expect(result).toContain('npm test');
    expect(result).toContain('npx tsc');
    expect(result).toContain('TypeError');
  });
});

// ---------------------------------------------------------------------------
// buildPlanRejectionCriticBlock
// ---------------------------------------------------------------------------

describe('buildPlanRejectionCriticBlock', () => {
  it('returns empty string with no rejection reason and no learnings', () => {
    const result = buildPlanRejectionCriticBlock(
      { rejection_reason: '', attempt: 1, max_attempts: 3 },
      [],
      [],
    );
    expect(result).toBe('');
  });

  it('includes rejection reason', () => {
    const result = buildPlanRejectionCriticBlock(
      { rejection_reason: 'File outside allowed paths', attempt: 2, max_attempts: 3 },
      [],
      ['src/**'],
    );
    expect(result).toContain('File outside allowed paths');
    expect(result).toContain('attempt 2/3');
  });

  it('includes relevant plan rejection learnings', () => {
    const learnings = [makeLearning({
      text: 'Plan rejected: too many files',
      source: { type: 'plan_rejection' },
      tags: ['path:src/auth'],
      structured: { root_cause: 'Exceeded max files' },
    })];
    const result = buildPlanRejectionCriticBlock(
      { rejection_reason: 'Scope violation', attempt: 1, max_attempts: 3 },
      learnings,
      ['src/auth/**'],
    );
    expect(result).toContain('Plan rejected: too many files');
    expect(result).toContain('Exceeded max files');
  });
});
