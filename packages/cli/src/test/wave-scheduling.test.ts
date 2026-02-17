/**
 * Tests for conflict-aware wave scheduling
 */

import { describe, it, expect } from 'vitest';
import {
  partitionIntoWaves,
  proposalsConflict,
  hasSiblingFiles,
  hasConflictProneOverlap,
  touchesSamePackage,
  isConflictProneFile,
  isInSharedDirectory,
} from '../lib/wave-scheduling.js';

type Proposal = { title: string; files: string[]; category?: string };

// ---------------------------------------------------------------------------
// Helper function tests
// ---------------------------------------------------------------------------

describe('isConflictProneFile', () => {
  it('identifies index files as conflict-prone', () => {
    expect(isConflictProneFile('src/lib/index.ts')).toBe(true);
    expect(isConflictProneFile('src/lib/index.tsx')).toBe(true);
    expect(isConflictProneFile('src/lib/index.js')).toBe(true);
    expect(isConflictProneFile('components/index.jsx')).toBe(true);
  });

  it('identifies config files as conflict-prone', () => {
    expect(isConflictProneFile('package.json')).toBe(true);
    expect(isConflictProneFile('src/package.json')).toBe(true);
    expect(isConflictProneFile('tsconfig.json')).toBe(true);
    expect(isConflictProneFile('vite.config.ts')).toBe(true);
    expect(isConflictProneFile('eslint.config.js')).toBe(true);
  });

  it('identifies Python __init__.py as conflict-prone', () => {
    expect(isConflictProneFile('src/utils/__init__.py')).toBe(true);
  });

  it('identifies Rust/Go/Java build files as conflict-prone', () => {
    expect(isConflictProneFile('Cargo.toml')).toBe(true);
    expect(isConflictProneFile('go.mod')).toBe(true);
    expect(isConflictProneFile('build.gradle')).toBe(true);
  });

  it('returns false for regular source files', () => {
    expect(isConflictProneFile('src/lib/utils.ts')).toBe(false);
    expect(isConflictProneFile('src/components/Button.tsx')).toBe(false);
    expect(isConflictProneFile('main.py')).toBe(false);
  });
});

describe('isInSharedDirectory', () => {
  it('identifies shared/common directories', () => {
    expect(isInSharedDirectory('src/shared/utils.ts')).toBe(true);
    expect(isInSharedDirectory('lib/common/helpers.ts')).toBe(true);
    expect(isInSharedDirectory('packages/utils/index.ts')).toBe(true);
    expect(isInSharedDirectory('src/lib/constants.ts')).toBe(true);
    expect(isInSharedDirectory('src/types/index.ts')).toBe(true);
  });

  it('returns false for non-shared directories', () => {
    expect(isInSharedDirectory('src/components/Button.tsx')).toBe(false);
    expect(isInSharedDirectory('src/pages/Home.tsx')).toBe(false);
    expect(isInSharedDirectory('src/features/auth/login.ts')).toBe(false);
  });
});

describe('hasSiblingFiles', () => {
  it('detects files in the same directory', () => {
    expect(hasSiblingFiles(
      ['src/lib/utils.ts'],
      ['src/lib/helpers.ts']
    )).toBe(true);
  });

  it('returns false for files in different directories', () => {
    expect(hasSiblingFiles(
      ['src/lib/utils.ts'],
      ['src/components/Button.tsx']
    )).toBe(false);
  });

  it('handles multiple files', () => {
    expect(hasSiblingFiles(
      ['src/a.ts', 'src/b.ts'],
      ['lib/c.ts', 'src/d.ts']  // src/d.ts shares dir with src/a.ts and src/b.ts
    )).toBe(true);
  });
});

describe('hasConflictProneOverlap', () => {
  it('detects when both touch files in same directory with index', () => {
    expect(hasConflictProneOverlap(
      ['src/lib/utils.ts', 'src/lib/index.ts'],
      ['src/lib/helpers.ts']
    )).toBe(true);
  });

  it('returns false when no conflict-prone files are involved', () => {
    expect(hasConflictProneOverlap(
      ['src/lib/utils.ts'],
      ['src/lib/helpers.ts']
    )).toBe(false);
  });
});

describe('touchesSamePackage', () => {
  it('detects same package in packages/* monorepo', () => {
    expect(touchesSamePackage(
      ['packages/core/src/utils.ts'],
      ['packages/core/src/helpers.ts']
    )).toBe(true);
  });

  it('detects same app in apps/* monorepo', () => {
    expect(touchesSamePackage(
      ['apps/web/pages/index.tsx'],
      ['apps/web/components/Header.tsx']
    )).toBe(true);
  });

  it('returns false for different packages', () => {
    expect(touchesSamePackage(
      ['packages/core/src/utils.ts'],
      ['packages/cli/src/main.ts']
    )).toBe(false);
  });

  it('returns false for non-monorepo paths', () => {
    expect(touchesSamePackage(
      ['src/utils.ts'],
      ['src/helpers.ts']
    )).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// proposalsConflict tests
// ---------------------------------------------------------------------------

describe('proposalsConflict', () => {
  it('detects direct file overlap in all modes', () => {
    const a = { title: 'A', files: ['src/utils.ts'] };
    const b = { title: 'B', files: ['src/utils.ts'] };

    expect(proposalsConflict(a, b, { sensitivity: 'relaxed' })).toBe(true);
    expect(proposalsConflict(a, b, { sensitivity: 'normal' })).toBe(true);
    expect(proposalsConflict(a, b, { sensitivity: 'strict' })).toBe(true);
  });

  it('relaxed mode ignores sibling files', () => {
    const a = { title: 'A', files: ['src/lib/utils.ts'] };
    const b = { title: 'B', files: ['src/lib/helpers.ts'] };

    expect(proposalsConflict(a, b, { sensitivity: 'relaxed' })).toBe(false);
  });

  it('normal mode detects sibling files with conflict-prone overlap', () => {
    const a = { title: 'A', files: ['src/lib/utils.ts', 'src/lib/index.ts'] };
    const b = { title: 'B', files: ['src/lib/helpers.ts'] };

    expect(proposalsConflict(a, b, { sensitivity: 'normal' })).toBe(true);
  });

  it('normal mode detects sibling files with same category', () => {
    const a = { title: 'A', files: ['src/lib/utils.ts'], category: 'fix' };
    const b = { title: 'B', files: ['src/lib/helpers.ts'], category: 'fix' };

    expect(proposalsConflict(a, b, { sensitivity: 'normal' })).toBe(true);
  });

  it('strict mode detects any sibling files', () => {
    const a = { title: 'A', files: ['src/lib/utils.ts'] };
    const b = { title: 'B', files: ['src/lib/helpers.ts'] };

    expect(proposalsConflict(a, b, { sensitivity: 'strict' })).toBe(true);
  });

  it('strict mode detects same package', () => {
    const a = { title: 'A', files: ['packages/core/src/a.ts'] };
    const b = { title: 'B', files: ['packages/core/tests/b.test.ts'] };

    expect(proposalsConflict(a, b, { sensitivity: 'strict' })).toBe(true);
    expect(proposalsConflict(a, b, { sensitivity: 'normal' })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// partitionIntoWaves tests
// ---------------------------------------------------------------------------

describe('partitionIntoWaves', () => {
  it('puts non-overlapping proposals in the same wave', () => {
    const proposals: Proposal[] = [
      { title: 'A', files: ['alpha/a.ts'] },
      { title: 'B', files: ['beta/b.ts'] },
      { title: 'C', files: ['gamma/c.ts'] },
    ];

    const waves = partitionIntoWaves(proposals);

    expect(waves).toHaveLength(1);
    expect(waves[0]).toHaveLength(3);
  });

  it('separates proposals with overlapping files into different waves', () => {
    const proposals: Proposal[] = [
      { title: 'A', files: ['src/utils.ts'] },
      { title: 'B', files: ['src/utils.ts'] },
    ];

    const waves = partitionIntoWaves(proposals);

    expect(waves).toHaveLength(2);
    expect(waves[0]).toHaveLength(1);
    expect(waves[1]).toHaveLength(1);
    expect(waves[0][0].title).toBe('A');
    expect(waves[1][0].title).toBe('B');
  });

  it('separates proposals with directory containment overlap', () => {
    const proposals: Proposal[] = [
      { title: 'A', files: ['src/lib/utils.ts'] },
      { title: 'B', files: ['src/lib/helpers.ts'] },
      { title: 'C', files: ['src/lib/utils.ts', 'src/lib/types.ts'] },
    ];

    const waves = partitionIntoWaves(proposals);

    // A and C overlap on src/lib/utils.ts, so they must be in different waves
    // B doesn't overlap with either
    expect(waves.length).toBeGreaterThanOrEqual(2);

    // A and C should not be in the same wave
    for (const wave of waves) {
      const titles = wave.map(p => p.title);
      expect(titles.includes('A') && titles.includes('C')).toBe(false);
    }
  });

  it('handles glob pattern overlaps', () => {
    const proposals: Proposal[] = [
      { title: 'A', files: ['src/lib/**'] },
      { title: 'B', files: ['src/lib/utils.ts'] },
    ];

    const waves = partitionIntoWaves(proposals);

    expect(waves).toHaveLength(2);
  });

  it('returns single wave for single proposal', () => {
    const proposals: Proposal[] = [
      { title: 'A', files: ['src/a.ts'] },
    ];

    const waves = partitionIntoWaves(proposals);

    expect(waves).toHaveLength(1);
    expect(waves[0]).toHaveLength(1);
  });

  it('returns empty for empty input', () => {
    const waves = partitionIntoWaves([]);

    expect(waves).toHaveLength(0);
  });

  it('creates multiple waves for chain of conflicts', () => {
    // A overlaps B via shared file, C is in a different directory (independent)
    const proposals: Proposal[] = [
      { title: 'A', files: ['src/a.ts', 'src/shared.ts'] },
      { title: 'B', files: ['src/shared.ts', 'src/other.ts'] },
      { title: 'C', files: ['pkg/c.ts'] },
    ];

    const waves = partitionIntoWaves(proposals);

    // A and B conflict (shared file), C is independent (different directory)
    // A goes to wave 0, B to wave 1, C to wave 0
    expect(waves).toHaveLength(2);

    const wave0Titles = waves[0].map(p => p.title);
    expect(wave0Titles).toContain('A');
    expect(wave0Titles).toContain('C');
    expect(wave0Titles).not.toContain('B');
  });

  it('handles proposals with multiple files each', () => {
    const proposals: Proposal[] = [
      { title: 'A', files: ['src/a.ts', 'src/b.ts'] },
      { title: 'B', files: ['src/c.ts', 'src/d.ts'] },
      { title: 'C', files: ['src/b.ts', 'src/e.ts'] },
    ];

    const waves = partitionIntoWaves(proposals);

    // A and C overlap on src/b.ts
    expect(waves.length).toBeGreaterThanOrEqual(2);

    for (const wave of waves) {
      const titles = wave.map(p => p.title);
      expect(titles.includes('A') && titles.includes('C')).toBe(false);
    }
  });

  it('handles proposals with empty files arrays', () => {
    const proposals: Proposal[] = [
      { title: 'A', files: [] },
      { title: 'B', files: [] },
      { title: 'C', files: ['src/c.ts'] },
    ];

    const waves = partitionIntoWaves(proposals);

    // Empty files don't overlap with anything
    expect(waves).toHaveLength(1);
  });

  // New tests for enhanced conflict detection

  it('strict mode separates sibling files into different waves', () => {
    const proposals: Proposal[] = [
      { title: 'A', files: ['src/lib/utils.ts'] },
      { title: 'B', files: ['src/lib/helpers.ts'] },
      { title: 'C', files: ['src/components/Button.tsx'] },
    ];

    const waves = partitionIntoWaves(proposals, { sensitivity: 'strict' });

    // A and B are siblings, should be in different waves
    expect(waves.length).toBeGreaterThanOrEqual(2);

    for (const wave of waves) {
      const titles = wave.map(p => p.title);
      expect(titles.includes('A') && titles.includes('B')).toBe(false);
    }

    // C should be in wave with either A or B (doesn't conflict with them)
    const allTitles = waves.flat().map(p => p.title);
    expect(allTitles).toContain('C');
  });

  it('relaxed mode keeps non-overlapping siblings in same wave', () => {
    const proposals: Proposal[] = [
      { title: 'A', files: ['src/lib/utils.ts'] },
      { title: 'B', files: ['src/lib/helpers.ts'] },
    ];

    const waves = partitionIntoWaves(proposals, { sensitivity: 'relaxed' });

    // Relaxed mode: siblings without direct overlap can be in same wave
    expect(waves).toHaveLength(1);
  });

  it('normal mode separates same-category siblings', () => {
    const proposals: Proposal[] = [
      { title: 'A', files: ['src/lib/utils.ts'], category: 'refactor' },
      { title: 'B', files: ['src/lib/helpers.ts'], category: 'refactor' },
      { title: 'C', files: ['src/lib/types.ts'], category: 'fix' },
    ];

    const waves = partitionIntoWaves(proposals, { sensitivity: 'normal' });

    // A and B are same category + siblings, should be separated
    for (const wave of waves) {
      const titles = wave.map(p => p.title);
      expect(titles.includes('A') && titles.includes('B')).toBe(false);
    }
  });

  it('strict mode separates same-package proposals in monorepo', () => {
    const proposals: Proposal[] = [
      { title: 'A', files: ['packages/core/src/utils.ts'] },
      { title: 'B', files: ['packages/core/tests/utils.test.ts'] },
      { title: 'C', files: ['packages/cli/src/main.ts'] },
    ];

    const waves = partitionIntoWaves(proposals, { sensitivity: 'strict' });

    // A and B are in same package, should be separated
    for (const wave of waves) {
      const titles = wave.map(p => p.title);
      expect(titles.includes('A') && titles.includes('B')).toBe(false);
    }
  });

  it('detects conflict-prone index.ts overlap', () => {
    const proposals: Proposal[] = [
      { title: 'A', files: ['src/lib/utils.ts', 'src/lib/index.ts'] },
      { title: 'B', files: ['src/lib/helpers.ts'] },
    ];

    const waves = partitionIntoWaves(proposals, { sensitivity: 'normal' });

    // A touches index.ts in same dir as B's helpers.ts
    expect(waves.length).toBeGreaterThanOrEqual(2);
  });
});
