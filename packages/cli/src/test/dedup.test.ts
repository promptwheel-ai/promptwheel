import { describe, it, expect } from 'vitest';
import { getAdaptiveParallelCount, isDuplicateProposal } from '../lib/dedup.js';
import type { TicketProposal } from '@promptwheel/core/scout';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProposal(
  overrides: Partial<TicketProposal> = {},
): TicketProposal {
  return {
    category: 'test',
    title: 'Fix authentication bug',
    description: 'Fix the auth bug',
    acceptance_criteria: 'Tests pass',
    files: ['src/auth.ts'],
    allowed_paths: ['src/auth.ts'],
    confidence: 80,
    impact_score: 5,
    rationale: 'Improves security',
    estimated_complexity: 'simple',
    verification_commands: ['npm test'],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// getAdaptiveParallelCount
// ---------------------------------------------------------------------------

describe('getAdaptiveParallelCount', () => {
  it('returns 5 when all proposals are light (trivial)', () => {
    const proposals = [
      makeProposal({ estimated_complexity: 'trivial' }),
      makeProposal({ estimated_complexity: 'trivial' }),
      makeProposal({ estimated_complexity: 'trivial' }),
    ];
    expect(getAdaptiveParallelCount(proposals)).toBe(5);
  });

  it('returns 5 when all proposals are light (simple)', () => {
    const proposals = [
      makeProposal({ estimated_complexity: 'simple' }),
      makeProposal({ estimated_complexity: 'simple' }),
    ];
    expect(getAdaptiveParallelCount(proposals)).toBe(5);
  });

  it('returns 5 when all proposals are mixed light (trivial + simple)', () => {
    const proposals = [
      makeProposal({ estimated_complexity: 'trivial' }),
      makeProposal({ estimated_complexity: 'simple' }),
    ];
    expect(getAdaptiveParallelCount(proposals)).toBe(5);
  });

  it('returns 2 when all proposals are heavy (moderate)', () => {
    const proposals = [
      makeProposal({ estimated_complexity: 'moderate' }),
      makeProposal({ estimated_complexity: 'moderate' }),
    ];
    expect(getAdaptiveParallelCount(proposals)).toBe(2);
  });

  it('returns 2 when all proposals are heavy (complex)', () => {
    const proposals = [
      makeProposal({ estimated_complexity: 'complex' }),
      makeProposal({ estimated_complexity: 'complex' }),
    ];
    expect(getAdaptiveParallelCount(proposals)).toBe(2);
  });

  it('returns 2 when all proposals are mixed heavy (moderate + complex)', () => {
    const proposals = [
      makeProposal({ estimated_complexity: 'moderate' }),
      makeProposal({ estimated_complexity: 'complex' }),
    ];
    expect(getAdaptiveParallelCount(proposals)).toBe(2);
  });

  it('scales proportionally for mixed proposals (50/50)', () => {
    const proposals = [
      makeProposal({ estimated_complexity: 'simple' }),
      makeProposal({ estimated_complexity: 'moderate' }),
    ];
    // light=1, heavy=1, ratio=0.5, 2 + 0.5*3 = 3.5, round=4
    expect(getAdaptiveParallelCount(proposals)).toBe(4);
  });

  it('scales proportionally for mostly light proposals (75% light)', () => {
    const proposals = [
      makeProposal({ estimated_complexity: 'trivial' }),
      makeProposal({ estimated_complexity: 'simple' }),
      makeProposal({ estimated_complexity: 'simple' }),
      makeProposal({ estimated_complexity: 'moderate' }),
    ];
    // light=3, heavy=1, ratio=0.75, 2 + 0.75*3 = 4.25, round=4
    expect(getAdaptiveParallelCount(proposals)).toBe(4);
  });

  it('scales proportionally for mostly heavy proposals (75% heavy)', () => {
    const proposals = [
      makeProposal({ estimated_complexity: 'trivial' }),
      makeProposal({ estimated_complexity: 'moderate' }),
      makeProposal({ estimated_complexity: 'complex' }),
      makeProposal({ estimated_complexity: 'moderate' }),
    ];
    // light=1, heavy=3, ratio=0.25, 2 + 0.25*3 = 2.75, round=3
    expect(getAdaptiveParallelCount(proposals)).toBe(3);
  });

  it('returns 5 for empty array (no heavy → all light path)', () => {
    expect(getAdaptiveParallelCount([])).toBe(5);
  });

  it('always returns between 2 and 5 inclusive', () => {
    // Single light
    expect(getAdaptiveParallelCount([makeProposal({ estimated_complexity: 'trivial' })])).toBeGreaterThanOrEqual(2);
    expect(getAdaptiveParallelCount([makeProposal({ estimated_complexity: 'trivial' })])).toBeLessThanOrEqual(5);

    // Single heavy
    expect(getAdaptiveParallelCount([makeProposal({ estimated_complexity: 'complex' })])).toBeGreaterThanOrEqual(2);
    expect(getAdaptiveParallelCount([makeProposal({ estimated_complexity: 'complex' })])).toBeLessThanOrEqual(5);
  });
});

// ---------------------------------------------------------------------------
// isDuplicateProposal
// ---------------------------------------------------------------------------

describe('isDuplicateProposal', () => {
  it('returns not duplicate when no existing titles or branches', async () => {
    const result = await isDuplicateProposal(
      { title: 'Fix authentication bug' },
      [],
      [],
    );
    expect(result.isDuplicate).toBe(false);
    expect(result.reason).toBeUndefined();
  });

  it('detects exact title match (case-insensitive, normalized)', async () => {
    const result = await isDuplicateProposal(
      { title: 'Fix Authentication Bug' },
      ['fix authentication bug'],
      [],
    );
    expect(result.isDuplicate).toBe(true);
    expect(result.reason).toContain('Exact match');
  });

  it('detects exact title match with punctuation normalization', async () => {
    const result = await isDuplicateProposal(
      { title: 'Fix: authentication-bug!' },
      ['fix  authentication bug'],
      [],
    );
    expect(result.isDuplicate).toBe(true);
    expect(result.reason).toContain('Exact match');
  });

  it('detects similar titles above threshold', async () => {
    const result = await isDuplicateProposal(
      { title: 'Add unit tests for authentication module' },
      ['Add unit tests for the auth module'],
      [],
      0.5,
    );
    expect(result.isDuplicate).toBe(true);
    expect(result.reason).toContain('Similar');
    expect(result.reason).toMatch(/\d+%/);
  });

  it('does not flag dissimilar titles', async () => {
    const result = await isDuplicateProposal(
      { title: 'Fix authentication bug' },
      ['Optimize database queries for performance'],
      [],
    );
    expect(result.isDuplicate).toBe(false);
  });

  it('detects duplicate from PR branch name', async () => {
    const result = await isDuplicateProposal(
      { title: 'fix login bug' },
      [],
      ['promptwheel/tkt_abc123/fix-login-bug'],
      0.5,
    );
    expect(result.isDuplicate).toBe(true);
    expect(result.reason).toContain('Open PR branch');
    expect(result.reason).toContain('promptwheel/tkt_abc123/fix-login-bug');
  });

  it('ignores PR branches that do not match', async () => {
    const result = await isDuplicateProposal(
      { title: 'Fix authentication bug' },
      [],
      ['promptwheel/tkt_xyz/optimize-database-queries'],
    );
    expect(result.isDuplicate).toBe(false);
  });

  it('handles branches without the promptwheel prefix', async () => {
    // Branch doesn't match the promptwheel prefix pattern, so full branch name
    // is used as branchTitle after replace (no-op on non-matching pattern)
    const result = await isDuplicateProposal(
      { title: 'feature add logging' },
      [],
      ['feature-add-logging'],
      0.5,
    );
    // The branch name becomes "feature add logging" after replacing dashes
    expect(result.isDuplicate).toBe(true);
  });

  it('respects custom similarity threshold', async () => {
    // With very high threshold, similar titles should not match
    const result = await isDuplicateProposal(
      { title: 'Add unit tests for auth module' },
      ['Add integration tests for auth module'],
      [],
      0.99, // very strict
    );
    expect(result.isDuplicate).toBe(false);
  });

  it('uses default threshold of 0.6 when not specified', async () => {
    // Two titles with moderate overlap — test that default threshold applies
    const result = await isDuplicateProposal(
      { title: 'completely different topic about databases' },
      ['something about network protocols and caching'],
      [],
    );
    expect(result.isDuplicate).toBe(false);
  });

  it('checks exact match before similarity (returns first exact match)', async () => {
    const result = await isDuplicateProposal(
      { title: 'Fix auth bug' },
      ['Fix auth bug', 'Fix authentication bug'], // first is exact
      [],
    );
    expect(result.isDuplicate).toBe(true);
    expect(result.reason).toContain('Exact match');
    expect(result.reason).toContain('Fix auth bug');
  });

  it('checks titles before branches', async () => {
    const result = await isDuplicateProposal(
      { title: 'Fix login bug' },
      ['Fix login bug'], // exact title match
      ['promptwheel/tkt_abc/fix-login-bug'], // also matches branch
    );
    // Should hit title match first
    expect(result.isDuplicate).toBe(true);
    expect(result.reason).toContain('Exact match');
    // Should NOT mention branch
    expect(result.reason).not.toContain('PR branch');
  });

  it('handles empty title gracefully', async () => {
    const result = await isDuplicateProposal(
      { title: '' },
      ['Some existing title'],
      [],
    );
    // normalizeTitle('') = '', similarity with words should be 0
    expect(result.isDuplicate).toBe(false);
  });
});
