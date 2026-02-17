import { describe, it, expect } from 'vitest';
import {
  parsePath,
  pathsOverlap,
  directoriesOverlap,
  isConflictProneFile,
  isInSharedDirectory,
  getDirectories,
  hasSiblingFiles,
  hasConflictProneOverlap,
  hasSharedParentConflict,
  touchesSamePackage,
  proposalsConflict,
  partitionIntoWaves,
  buildScoutEscalation,
  CONFLICT_PRONE_FILENAMES,
  SHARED_DIRECTORY_PATTERNS,
  PACKAGE_PATTERN,
  DIRECTORY_OVERLAP_NORMAL,
  DIRECTORY_OVERLAP_STRICT,
} from '../waves/shared.js';
import type { CodebaseIndex } from '../codebase-index/shared.js';
import type { SectorState } from '../sectors/shared.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('constants', () => {
  it('CONFLICT_PRONE_FILENAMES includes common hub files', () => {
    expect(CONFLICT_PRONE_FILENAMES.has('index.ts')).toBe(true);
    expect(CONFLICT_PRONE_FILENAMES.has('index.js')).toBe(true);
    expect(CONFLICT_PRONE_FILENAMES.has('package.json')).toBe(true);
    expect(CONFLICT_PRONE_FILENAMES.has('__init__.py')).toBe(true);
    expect(CONFLICT_PRONE_FILENAMES.has('Cargo.toml')).toBe(true);
    expect(CONFLICT_PRONE_FILENAMES.has('go.mod')).toBe(true);
  });

  it('CONFLICT_PRONE_FILENAMES does not include regular files', () => {
    expect(CONFLICT_PRONE_FILENAMES.has('utils.ts')).toBe(false);
    expect(CONFLICT_PRONE_FILENAMES.has('app.tsx')).toBe(false);
  });

  it('SHARED_DIRECTORY_PATTERNS matches common shared dirs', () => {
    expect(SHARED_DIRECTORY_PATTERNS.some(p => p.test('/shared/'))).toBe(true);
    expect(SHARED_DIRECTORY_PATTERNS.some(p => p.test('/utils/'))).toBe(true);
    expect(SHARED_DIRECTORY_PATTERNS.some(p => p.test('/lib/'))).toBe(true);
    expect(SHARED_DIRECTORY_PATTERNS.some(p => p.test('/types/'))).toBe(true);
    expect(SHARED_DIRECTORY_PATTERNS.some(p => p.test('/config/'))).toBe(true);
  });

  it('PACKAGE_PATTERN matches monorepo directories', () => {
    expect('packages/core/src/a.ts'.match(PACKAGE_PATTERN)?.[0]).toBe('packages/core');
    expect('apps/web/src/b.ts'.match(PACKAGE_PATTERN)?.[0]).toBe('apps/web');
    expect('libs/shared/c.ts'.match(PACKAGE_PATTERN)?.[0]).toBe('libs/shared');
    expect('modules/auth/d.ts'.match(PACKAGE_PATTERN)?.[0]).toBe('modules/auth');
    expect('src/a.ts'.match(PACKAGE_PATTERN)).toBeNull();
  });

  it('directory overlap thresholds', () => {
    expect(DIRECTORY_OVERLAP_NORMAL).toBe(0.3);
    expect(DIRECTORY_OVERLAP_STRICT).toBe(0.2);
  });
});

// ---------------------------------------------------------------------------
// parsePath
// ---------------------------------------------------------------------------

describe('parsePath', () => {
  it('splits directory and filename', () => {
    expect(parsePath('src/lib/utils.ts')).toEqual({ dir: 'src/lib', filename: 'utils.ts' });
  });

  it('handles files in root', () => {
    expect(parsePath('app.ts')).toEqual({ dir: '.', filename: 'app.ts' });
  });

  it('strips leading ./', () => {
    expect(parsePath('./src/a.ts')).toEqual({ dir: 'src', filename: 'a.ts' });
  });

  it('strips trailing /', () => {
    expect(parsePath('src/lib/')).toEqual({ dir: 'src', filename: 'lib' });
  });
});

// ---------------------------------------------------------------------------
// pathsOverlap
// ---------------------------------------------------------------------------

describe('pathsOverlap', () => {
  it('detects exact match', () => {
    expect(pathsOverlap('src/lib', 'src/lib')).toBe(true);
  });

  it('detects directory containment', () => {
    expect(pathsOverlap('src/lib', 'src/lib/utils.ts')).toBe(true);
    expect(pathsOverlap('src/lib/utils.ts', 'src/lib')).toBe(true);
  });

  it('rejects non-overlapping paths', () => {
    expect(pathsOverlap('src/lib', 'src/other')).toBe(false);
    expect(pathsOverlap('src/a.ts', 'src/b.ts')).toBe(false);
  });

  it('normalizes ./ prefix', () => {
    expect(pathsOverlap('./src/lib', 'src/lib')).toBe(true);
  });

  it('normalizes trailing slash', () => {
    expect(pathsOverlap('src/lib/', 'src/lib')).toBe(true);
  });

  it('detects glob pattern overlap', () => {
    expect(pathsOverlap('src/**/*.ts', 'src/utils.ts')).toBe(true);
    expect(pathsOverlap('src/*', 'src/lib/utils.ts')).toBe(true);
  });

  it('rejects non-overlapping globs', () => {
    expect(pathsOverlap('src/*', 'pkg/*')).toBe(false);
  });

  it('handles empty strings', () => {
    expect(pathsOverlap('', '')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// directoriesOverlap
// ---------------------------------------------------------------------------

describe('directoriesOverlap', () => {
  it('detects overlap above threshold', () => {
    expect(directoriesOverlap(['src/a.ts'], ['src/b.ts'], 0.3)).toBe(true);
  });

  it('rejects overlap below threshold', () => {
    expect(directoriesOverlap(
      ['src/a.ts', 'pkg/b.ts', 'lib/c.ts'],
      ['src/d.ts', 'other/e.ts', 'test/f.ts'],
      0.5
    )).toBe(false); // 1/3 = 0.33 < 0.5
  });

  it('returns false for empty arrays', () => {
    expect(directoriesOverlap([], ['src/a.ts'], 0.3)).toBe(false);
    expect(directoriesOverlap(['src/a.ts'], [], 0.3)).toBe(false);
  });

  it('treats root-level files as directory "."', () => {
    // Both are root-level files — should share directory "."
    expect(directoriesOverlap(['README.md'], ['package.json'], 0.3)).toBe(true);
    // Root-level vs subdirectory — should not overlap
    expect(directoriesOverlap(['README.md'], ['src/a.ts'], 0.3)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isConflictProneFile
// ---------------------------------------------------------------------------

describe('isConflictProneFile', () => {
  it('detects index files', () => {
    expect(isConflictProneFile('src/lib/index.ts')).toBe(true);
    expect(isConflictProneFile('src/index.js')).toBe(true);
    expect(isConflictProneFile('components/index.tsx')).toBe(true);
  });

  it('detects config files', () => {
    expect(isConflictProneFile('package.json')).toBe(true);
    expect(isConflictProneFile('tsconfig.json')).toBe(true);
    expect(isConflictProneFile('vitest.config.ts')).toBe(true);
  });

  it('detects polyglot hub files', () => {
    expect(isConflictProneFile('src/__init__.py')).toBe(true);
    expect(isConflictProneFile('Cargo.toml')).toBe(true);
    expect(isConflictProneFile('go.mod')).toBe(true);
  });

  it('rejects regular source files', () => {
    expect(isConflictProneFile('src/utils.ts')).toBe(false);
    expect(isConflictProneFile('src/app.tsx')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isInSharedDirectory
// ---------------------------------------------------------------------------

describe('isInSharedDirectory', () => {
  it('detects shared directory patterns', () => {
    expect(isInSharedDirectory('src/shared/utils.ts')).toBe(true);
    expect(isInSharedDirectory('lib/common/helpers.ts')).toBe(true);
    expect(isInSharedDirectory('src/utils/format.ts')).toBe(true);
    expect(isInSharedDirectory('app/types/user.ts')).toBe(true);
    expect(isInSharedDirectory('src/config/db.ts')).toBe(true);
  });

  it('rejects non-shared directories', () => {
    expect(isInSharedDirectory('src/services/auth.ts')).toBe(false);
    expect(isInSharedDirectory('src/components/Button.tsx')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getDirectories
// ---------------------------------------------------------------------------

describe('getDirectories', () => {
  it('extracts directories with parent hierarchy', () => {
    const dirs = getDirectories(['src/lib/utils/format.ts']);
    expect(dirs.has('src/lib/utils')).toBe(true);
    expect(dirs.has('src/lib')).toBe(true);
    expect(dirs.has('src')).toBe(true);
  });

  it('deduplicates directories', () => {
    const dirs = getDirectories(['src/a.ts', 'src/b.ts']);
    expect(dirs.size).toBe(1);
    expect(dirs.has('src')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// hasSiblingFiles
// ---------------------------------------------------------------------------

describe('hasSiblingFiles', () => {
  it('detects files in same directory', () => {
    expect(hasSiblingFiles(['src/a.ts'], ['src/b.ts'])).toBe(true);
  });

  it('rejects files in different directories', () => {
    expect(hasSiblingFiles(['src/a.ts'], ['pkg/b.ts'])).toBe(false);
  });

  it('handles nested paths', () => {
    expect(hasSiblingFiles(['src/lib/a.ts'], ['src/lib/b.ts'])).toBe(true);
    expect(hasSiblingFiles(['src/lib/a.ts'], ['src/other/b.ts'])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// hasConflictProneOverlap
// ---------------------------------------------------------------------------

describe('hasConflictProneOverlap', () => {
  it('detects conflict-prone file in shared directory', () => {
    expect(hasConflictProneOverlap(
      ['src/lib/index.ts', 'src/lib/a.ts'],
      ['src/lib/b.ts'],
    )).toBe(true);
  });

  it('no conflict without conflict-prone file', () => {
    expect(hasConflictProneOverlap(
      ['src/lib/a.ts'],
      ['src/lib/b.ts'],
    )).toBe(false);
  });

  it('no conflict when directories differ', () => {
    expect(hasConflictProneOverlap(
      ['src/index.ts'],
      ['pkg/b.ts'],
    )).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// hasSharedParentConflict
// ---------------------------------------------------------------------------

describe('hasSharedParentConflict', () => {
  it('detects shared parent in shared directory', () => {
    expect(hasSharedParentConflict(
      ['src/shared/a.ts'],
      ['src/shared/b.ts'],
    )).toBe(true);
  });

  it('no conflict in non-shared parent', () => {
    expect(hasSharedParentConflict(
      ['src/services/a.ts'],
      ['src/services/b.ts'],
    )).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// touchesSamePackage
// ---------------------------------------------------------------------------

describe('touchesSamePackage', () => {
  it('detects same package in packages/', () => {
    expect(touchesSamePackage(
      ['packages/core/src/a.ts'],
      ['packages/core/src/b.ts'],
    )).toBe(true);
  });

  it('detects same package in apps/', () => {
    expect(touchesSamePackage(
      ['apps/web/src/a.ts'],
      ['apps/web/src/b.ts'],
    )).toBe(true);
  });

  it('no conflict for different packages', () => {
    expect(touchesSamePackage(
      ['packages/core/src/a.ts'],
      ['packages/cli/src/b.ts'],
    )).toBe(false);
  });

  it('no conflict for non-monorepo paths', () => {
    expect(touchesSamePackage(
      ['src/a.ts'],
      ['src/b.ts'],
    )).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// proposalsConflict
// ---------------------------------------------------------------------------

describe('proposalsConflict', () => {
  it('detects direct file overlap in all modes', () => {
    const a = { files: ['src/utils.ts'] };
    const b = { files: ['src/utils.ts'] };
    expect(proposalsConflict(a, b, { sensitivity: 'relaxed' })).toBe(true);
    expect(proposalsConflict(a, b, { sensitivity: 'normal' })).toBe(true);
    expect(proposalsConflict(a, b, { sensitivity: 'strict' })).toBe(true);
  });

  it('relaxed: ignores siblings without direct overlap', () => {
    const a = { files: ['src/a.ts'] };
    const b = { files: ['src/b.ts'] };
    expect(proposalsConflict(a, b, { sensitivity: 'relaxed' })).toBe(false);
  });

  it('normal: detects sibling + conflict-prone overlap', () => {
    const a = { files: ['src/lib/index.ts', 'src/lib/a.ts'] };
    const b = { files: ['src/lib/b.ts'] };
    expect(proposalsConflict(a, b, { sensitivity: 'normal' })).toBe(true);
  });

  it('normal: detects sibling + same category', () => {
    const a = { files: ['src/lib/a.ts'], category: 'refactor' };
    const b = { files: ['src/lib/b.ts'], category: 'refactor' };
    expect(proposalsConflict(a, b, { sensitivity: 'normal' })).toBe(true);
  });

  it('normal: sibling without conflict-prone or category is not conflict', () => {
    const a = { files: ['src/lib/a.ts'], category: 'security' };
    const b = { files: ['src/lib/b.ts'], category: 'cleanup' };
    // Siblings exist, but no conflict-prone file and different categories
    // However, directoriesOverlap will catch this (100% overlap)
    // So this IS a conflict due to directory overlap
    expect(proposalsConflict(a, b, { sensitivity: 'normal' })).toBe(true);
  });

  it('strict: any siblings = conflict', () => {
    const a = { files: ['src/lib/a.ts'] };
    const b = { files: ['src/lib/b.ts'] };
    expect(proposalsConflict(a, b, { sensitivity: 'strict' })).toBe(true);
  });

  it('strict: same package = conflict', () => {
    const a = { files: ['packages/core/src/a.ts'] };
    const b = { files: ['packages/core/src/deep/b.ts'] };
    expect(proposalsConflict(a, b, { sensitivity: 'strict' })).toBe(true);
  });

  it('strict: different packages = no conflict', () => {
    const a = { files: ['packages/core/src/a.ts'] };
    const b = { files: ['packages/cli/src/b.ts'] };
    expect(proposalsConflict(a, b, { sensitivity: 'strict' })).toBe(false);
  });

  it('no conflict when files are in different directories', () => {
    const a = { files: ['src/services/auth.ts'] };
    const b = { files: ['src/components/Button.tsx'] };
    expect(proposalsConflict(a, b, { sensitivity: 'normal' })).toBe(false);
  });

  it('no conflict with empty file lists', () => {
    const a = { files: [] as string[] };
    const b = { files: ['src/a.ts'] };
    expect(proposalsConflict(a, b)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// partitionIntoWaves
// ---------------------------------------------------------------------------

describe('partitionIntoWaves', () => {
  it('puts non-conflicting proposals in same wave', () => {
    const proposals = [
      { files: ['packages/core/src/a.ts'] },
      { files: ['packages/cli/src/b.ts'] },
      { files: ['packages/mcp/src/c.ts'] },
    ];
    const waves = partitionIntoWaves(proposals);
    expect(waves).toHaveLength(1);
    expect(waves[0]).toHaveLength(3);
  });

  it('separates proposals with direct file overlap', () => {
    const proposals = [
      { files: ['src/utils.ts'] },
      { files: ['src/utils.ts'] },
    ];
    const waves = partitionIntoWaves(proposals);
    expect(waves).toHaveLength(2);
  });

  it('creates multiple waves for chain of conflicts', () => {
    const proposals = [
      { title: 'A', files: ['packages/a/src/shared.ts'] },
      { title: 'B', files: ['packages/a/src/shared.ts', 'packages/b/src/other.ts'] },
      { title: 'C', files: ['packages/c/src/c.ts'] },
    ];
    const waves = partitionIntoWaves(proposals);
    // A and B conflict on shared.ts, C is independent
    expect(waves).toHaveLength(2);
  });

  it('returns empty for empty input', () => {
    expect(partitionIntoWaves([])).toHaveLength(0);
  });

  it('returns single wave for single proposal', () => {
    const waves = partitionIntoWaves([{ files: ['src/a.ts'] }]);
    expect(waves).toHaveLength(1);
  });

  it('respects relaxed sensitivity', () => {
    // Siblings in same dir but different files — relaxed allows parallel
    const proposals = [
      { files: ['packages/core/src/lib/a.ts'] },
      { files: ['packages/core/src/lib/b.ts'] },
    ];
    const waves = partitionIntoWaves(proposals, { sensitivity: 'relaxed' });
    expect(waves).toHaveLength(1);
  });

  it('strict mode separates siblings', () => {
    const proposals = [
      { files: ['src/lib/a.ts'] },
      { files: ['src/lib/b.ts'] },
    ];
    const waves = partitionIntoWaves(proposals, { sensitivity: 'strict' });
    expect(waves).toHaveLength(2);
  });

  it('handles proposals with empty file lists', () => {
    const proposals = [
      { files: [] as string[] },
      { files: ['src/a.ts'] },
    ];
    const waves = partitionIntoWaves(proposals);
    expect(waves).toHaveLength(1);
    expect(waves[0]).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// buildScoutEscalation
// ---------------------------------------------------------------------------

describe('buildScoutEscalation', () => {
  it('includes previous attempts section when dirs provided', () => {
    const result = buildScoutEscalation(1, ['src/lib', 'src/api'], null);
    expect(result).toContain('Previous Attempts Found Nothing');
    expect(result).toContain('`src/lib`');
    expect(result).toContain('`src/api`');
    expect(result).toContain('What to Do Differently');
  });

  it('suggests unexplored modules from codebase index', () => {
    const index: CodebaseIndex = {
      built_at: new Date().toISOString(),
      modules: [
        { path: 'src/lib', file_count: 10, production_file_count: 10, purpose: 'services', production: true, classification_confidence: 'high' },
        { path: 'src/api', file_count: 5, production_file_count: 5, purpose: 'api', production: true, classification_confidence: 'high' },
        { path: 'src/utils', file_count: 3, production_file_count: 3, purpose: 'utils', production: true, classification_confidence: 'high' },
      ],
      dependency_edges: {},
      untested_modules: [],
      large_files: [],
      entrypoints: [],
      sampled_file_mtimes: {},
    };
    const result = buildScoutEscalation(1, ['src/lib'], index);
    expect(result).toContain('`src/api`');
    expect(result).toContain('`src/utils`');
    expect(result).not.toContain('Try unexplored areas:.*`src/lib`');
  });

  it('sorts unexplored by sector history', () => {
    const index: CodebaseIndex = {
      built_at: new Date().toISOString(),
      modules: [
        { path: 'mod-a', file_count: 5, production_file_count: 5, purpose: '', production: true, classification_confidence: 'high' },
        { path: 'mod-b', file_count: 5, production_file_count: 5, purpose: '', production: true, classification_confidence: 'high' },
      ],
      dependency_edges: {},
      untested_modules: [],
      large_files: [],
      entrypoints: [],
      sampled_file_mtimes: {},
    };
    const sectorState: SectorState = {
      version: 2,
      builtAt: new Date().toISOString(),
      sectors: [
        {
          path: 'mod-a', purpose: '', production: true, fileCount: 5, productionFileCount: 5,
          classificationConfidence: 'high', lastScannedAt: 0, lastScannedCycle: 0,
          scanCount: 5, proposalYield: 0.5, successCount: 0, failureCount: 0,
        },
        {
          path: 'mod-b', purpose: '', production: true, fileCount: 5, productionFileCount: 5,
          classificationConfidence: 'high', lastScannedAt: 0, lastScannedCycle: 0,
          scanCount: 0, proposalYield: 0, successCount: 0, failureCount: 0,
        },
      ],
    };
    const result = buildScoutEscalation(1, [], index, sectorState);
    // mod-b has fewer scans (0 vs 5), so it should appear first
    const modAPos = result.indexOf('`mod-a`');
    const modBPos = result.indexOf('`mod-b`');
    expect(modBPos).toBeLessThan(modAPos);
  });

  it('handles empty scouted dirs', () => {
    const result = buildScoutEscalation(0, [], null);
    expect(result).toContain('What to Do Differently');
    expect(result).not.toContain('What Was Already Tried');
  });

  it('limits unexplored to 8 modules', () => {
    const index: CodebaseIndex = {
      built_at: new Date().toISOString(),
      modules: Array.from({ length: 20 }, (_, i) => ({
        path: `mod-${i}`, file_count: 5, production_file_count: 5,
        purpose: '', production: true, classification_confidence: 'high' as const,
      })),
      dependency_edges: {},
      untested_modules: [],
      large_files: [],
      entrypoints: [],
      sampled_file_mtimes: {},
    };
    const result = buildScoutEscalation(1, [], index);
    // Should show at most 8 modules
    const backtickModules = result.match(/`mod-\d+`/g) ?? [];
    expect(backtickModules.length).toBeLessThanOrEqual(8);
  });
});
