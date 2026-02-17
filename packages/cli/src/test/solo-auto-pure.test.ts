import { describe, it, expect, vi } from 'vitest';
import {
  normalizeTitle,
  titleSimilarity,
  getAdaptiveParallelCount,
  partitionIntoWaves,
  sleep,
  buildScoutEscalation,
} from '../lib/solo-auto.js';
import type { CodebaseIndex } from '../lib/codebase-index.js';

describe('normalizeTitle', () => {
  it('lowercases text', () => {
    expect(normalizeTitle('Hello World')).toBe('hello world');
  });

  it('removes punctuation', () => {
    expect(normalizeTitle('hello, world!')).toBe('hello world');
  });

  it('collapses whitespace', () => {
    expect(normalizeTitle('hello   world')).toBe('hello world');
  });

  it('trims', () => {
    expect(normalizeTitle('  hello  ')).toBe('hello');
  });

  it('handles empty string', () => {
    expect(normalizeTitle('')).toBe('');
  });
});

describe('titleSimilarity', () => {
  it('returns 1 for identical titles', () => {
    expect(titleSimilarity('refactor utils module', 'refactor utils module')).toBe(1);
  });

  it('returns 0 for completely different titles', () => {
    expect(titleSimilarity('alpha beta gamma', 'delta epsilon zeta')).toBe(0);
  });

  it('returns value between 0-1 for partial overlap', () => {
    const sim = titleSimilarity('refactor utils module', 'refactor auth module');
    expect(sim).toBeGreaterThan(0);
    expect(sim).toBeLessThan(1);
  });

  it('returns 0 for empty title', () => {
    expect(titleSimilarity('', 'hello world')).toBe(0);
    expect(titleSimilarity('hello world', '')).toBe(0);
  });

  it('filters short words (<=2 chars)', () => {
    // "a" and "is" are <= 2 chars, filtered out; only "cat" remains in both
    expect(titleSimilarity('a is cat', 'a is dog')).toBe(0);
  });

  it('is case-insensitive', () => {
    expect(titleSimilarity('Refactor Utils', 'refactor utils')).toBe(1);
  });
});

describe('getAdaptiveParallelCount', () => {
  const makeProposal = (complexity: string) =>
    ({ estimated_complexity: complexity }) as any;

  it('returns 5 for all light proposals', () => {
    const proposals = [
      makeProposal('trivial'),
      makeProposal('simple'),
      makeProposal('trivial'),
    ];
    expect(getAdaptiveParallelCount(proposals)).toBe(5);
  });

  it('returns 2 for all heavy proposals', () => {
    const proposals = [
      makeProposal('moderate'),
      makeProposal('complex'),
    ];
    expect(getAdaptiveParallelCount(proposals)).toBe(2);
  });

  it('returns value between 2-5 for mixed', () => {
    const proposals = [
      makeProposal('simple'),
      makeProposal('moderate'),
      makeProposal('trivial'),
      makeProposal('complex'),
    ];
    const count = getAdaptiveParallelCount(proposals);
    expect(count).toBeGreaterThanOrEqual(2);
    expect(count).toBeLessThanOrEqual(5);
  });

  it('handles empty array', () => {
    // heavy=0, light=0 => heavy===0 branch => 5
    expect(getAdaptiveParallelCount([])).toBe(5);
  });
});

describe('partitionIntoWaves', () => {
  it('non-overlapping proposals go in one wave', () => {
    const proposals = [
      { files: ['alpha/a.ts'] },
      { files: ['beta/b.ts'] },
      { files: ['gamma/c.ts'] },
    ];
    const waves = partitionIntoWaves(proposals);
    expect(waves).toHaveLength(1);
    expect(waves[0]).toHaveLength(3);
  });

  it('overlapping proposals go in separate waves', () => {
    const proposals = [
      { files: ['src/utils.ts'] },
      { files: ['src/utils.ts'] },
    ];
    const waves = partitionIntoWaves(proposals);
    expect(waves).toHaveLength(2);
    expect(waves[0]).toHaveLength(1);
    expect(waves[1]).toHaveLength(1);
  });

  it('complex overlap creates multiple waves', () => {
    const proposals = [
      { files: ['src/a.ts', 'src/b.ts'] },
      { files: ['src/b.ts', 'src/c.ts'] },
      { files: ['src/c.ts', 'src/d.ts'] },
      { files: ['src/e.ts'] },
    ];
    const waves = partitionIntoWaves(proposals);
    // proposal 0: wave 0
    // proposal 1: conflicts with 0 (src/b.ts) -> wave 1
    // proposal 2: conflicts with 1 (src/c.ts) -> wave 0 has no conflict with c.ts?
    //   wave 0 has src/a.ts, src/b.ts — no overlap with src/c.ts, src/d.ts -> wave 0
    // proposal 3: src/e.ts no conflict -> wave 0
    expect(waves.length).toBeGreaterThanOrEqual(2);
    // All proposals accounted for
    const total = waves.reduce((sum, w) => sum + w.length, 0);
    expect(total).toBe(4);
  });

  it('empty array returns empty', () => {
    expect(partitionIntoWaves([])).toEqual([]);
  });

  it('single item returns single wave', () => {
    const waves = partitionIntoWaves([{ files: ['a.ts'] }]);
    expect(waves).toHaveLength(1);
    expect(waves[0]).toHaveLength(1);
  });
});

describe('sleep', () => {
  it('resolves after specified ms', async () => {
    vi.useFakeTimers();
    const promise = sleep(1000);
    vi.advanceTimersByTime(1000);
    await promise;
    vi.useRealTimers();
  });
});

describe('buildScoutEscalation', () => {
  const makeIndex = (modules: { path: string }[]): CodebaseIndex => ({
    built_at: new Date().toISOString(),
    modules: modules.map(m => ({ path: m.path, files: [], test_files: [], loc: 0 })),
    dependency_edges: {},
    untested_modules: [],
    large_files: [],
  });

  it('includes retry header', () => {
    const text = buildScoutEscalation(1, ['src'], null);
    expect(text).toContain('Previous Attempts Found Nothing');
  });

  it('lists previously scouted dirs', () => {
    const text = buildScoutEscalation(1, ['src', 'lib'], null);
    expect(text).toContain('Scouted `src`');
    expect(text).toContain('Scouted `lib`');
  });

  it('suggests unexplored modules from codebase index', () => {
    const index = makeIndex([{ path: 'src' }, { path: 'lib' }, { path: 'packages/core' }]);
    const text = buildScoutEscalation(1, ['src'], index);
    expect(text).toContain('`lib`');
    expect(text).toContain('`packages/core`');
    expect(text).not.toContain('unexplored areas: `src`');
  });

  it('includes category-switching advice', () => {
    const text = buildScoutEscalation(2, ['**'], null);
    expect(text).toContain('Switch categories');
    expect(text).toContain('Read at least 15 NEW source files');
  });
});
