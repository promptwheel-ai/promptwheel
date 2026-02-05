/**
 * Wave scheduling utilities for conflict-free parallel execution.
 */

import { pathsOverlap, directoriesOverlap } from './solo-utils.js';
import type { CodebaseIndex } from './codebase-index.js';
import type { SectorState } from './sectors.js';

// ---------------------------------------------------------------------------
// Conflict-prone file patterns
// ---------------------------------------------------------------------------

/**
 * Files that frequently cause merge conflicts when multiple tickets
 * touch the same directory. These are "hub" files that re-export or
 * aggregate content from sibling files.
 */
const CONFLICT_PRONE_FILENAMES = new Set([
  'index.ts',
  'index.tsx',
  'index.js',
  'index.jsx',
  'index.mjs',
  'index.cjs',
  'mod.ts',           // Deno convention
  'mod.js',
  'package.json',
  'tsconfig.json',
  'vite.config.ts',
  'vitest.config.ts',
  'jest.config.js',
  'jest.config.ts',
  '.eslintrc.js',
  '.eslintrc.json',
  'eslint.config.js',
  'eslint.config.mjs',
  '__init__.py',      // Python
  'Cargo.toml',       // Rust
  'go.mod',           // Go
  'build.gradle',     // Java/Kotlin
  'pom.xml',          // Maven
  'Gemfile',          // Ruby
  'mix.exs',          // Elixir
]);

/**
 * Directory patterns that indicate shared/common code.
 * Files in these directories are more likely to be touched by multiple tickets.
 */
const SHARED_DIRECTORY_PATTERNS = [
  /\/shared\//,
  /\/common\//,
  /\/utils\//,
  /\/helpers\//,
  /\/lib\//,
  /\/types\//,
  /\/interfaces\//,
  /\/constants\//,
  /\/config\//,
];

// ---------------------------------------------------------------------------
// Enhanced conflict detection helpers
// ---------------------------------------------------------------------------

/**
 * Extract the directory and filename from a path.
 */
function parsePath(filePath: string): { dir: string; filename: string } {
  const normalized = filePath.replace(/^\.\//, '').replace(/\/$/, '');
  const lastSlash = normalized.lastIndexOf('/');
  if (lastSlash === -1) {
    return { dir: '.', filename: normalized };
  }
  return {
    dir: normalized.slice(0, lastSlash),
    filename: normalized.slice(lastSlash + 1),
  };
}

/**
 * Check if a file is conflict-prone (index files, configs, etc.)
 */
export function isConflictProneFile(filePath: string): boolean {
  const { filename } = parsePath(filePath);
  return CONFLICT_PRONE_FILENAMES.has(filename);
}

/**
 * Check if a path is in a shared/common directory.
 */
export function isInSharedDirectory(filePath: string): boolean {
  return SHARED_DIRECTORY_PATTERNS.some(pattern => pattern.test(filePath));
}

/**
 * Get all unique directories from a list of file paths.
 */
function getDirectories(files: string[]): Set<string> {
  const dirs = new Set<string>();
  for (const file of files) {
    const { dir } = parsePath(file);
    dirs.add(dir);
    // Also add parent directories for hierarchical conflict detection
    const parts = dir.split('/');
    for (let i = 1; i < parts.length; i++) {
      dirs.add(parts.slice(0, i).join('/'));
    }
  }
  return dirs;
}

/**
 * Check if two proposals have sibling files (different files in the same directory).
 * Sibling files often conflict because:
 * 1. index.ts may need to re-export both
 * 2. Both may import from shared local modules
 * 3. Refactoring one often affects the other
 */
export function hasSiblingFiles(filesA: string[], filesB: string[]): boolean {
  const dirsA = new Set(filesA.map(f => parsePath(f).dir));
  const dirsB = new Set(filesB.map(f => parsePath(f).dir));

  for (const dir of dirsA) {
    if (dirsB.has(dir)) {
      return true;
    }
  }
  return false;
}

/**
 * Check if either proposal touches conflict-prone files in overlapping directories.
 */
export function hasConflictProneOverlap(filesA: string[], filesB: string[]): boolean {
  const dirsA = new Set(filesA.map(f => parsePath(f).dir));
  const dirsB = new Set(filesB.map(f => parsePath(f).dir));

  // Check if any conflict-prone file's directory overlaps
  for (const file of [...filesA, ...filesB]) {
    if (isConflictProneFile(file)) {
      const { dir } = parsePath(file);
      if (dirsA.has(dir) && dirsB.has(dir)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Check if proposals share a common parent directory that might have
 * configuration or index files affected by both changes.
 */
export function hasSharedParentConflict(filesA: string[], filesB: string[]): boolean {
  const dirsA = getDirectories(filesA);
  const dirsB = getDirectories(filesB);

  for (const dir of dirsA) {
    if (dirsB.has(dir) && isInSharedDirectory(dir + '/')) {
      return true;
    }
  }
  return false;
}

/**
 * Monorepo-aware: check if both proposals touch the same package.
 * Common patterns: packages/*, apps/*, libs/*, modules/*
 */
export function touchesSamePackage(filesA: string[], filesB: string[]): boolean {
  const packagePatterns = [
    /^(packages|apps|libs|modules)\/([^/]+)/,
  ];

  const packagesA = new Set<string>();
  const packagesB = new Set<string>();

  for (const file of filesA) {
    for (const pattern of packagePatterns) {
      const match = file.match(pattern);
      if (match) {
        packagesA.add(match[0]);
      }
    }
  }

  for (const file of filesB) {
    for (const pattern of packagePatterns) {
      const match = file.match(pattern);
      if (match) {
        packagesB.add(match[0]);
      }
    }
  }

  for (const pkg of packagesA) {
    if (packagesB.has(pkg)) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Conflict detection modes
// ---------------------------------------------------------------------------

export type ConflictSensitivity = 'strict' | 'normal' | 'relaxed';

export interface ConflictDetectionOptions {
  /**
   * Sensitivity level:
   * - 'strict': Any shared directory or package = conflict (safest, most sequential)
   * - 'normal': Sibling files + conflict-prone files + shared dirs (balanced)
   * - 'relaxed': Only direct file overlap + glob overlap (most parallel, riskier)
   */
  sensitivity?: ConflictSensitivity;
}

/**
 * Check if two proposals have a potential conflict based on their file lists.
 */
export function proposalsConflict<T extends { files: string[]; category?: string }>(
  a: T,
  b: T,
  options: ConflictDetectionOptions = {}
): boolean {
  const { sensitivity = 'normal' } = options;

  // Always check: direct file path overlap (exact match or containment)
  if (a.files.some(fA => b.files.some(fB => pathsOverlap(fA, fB)))) {
    return true;
  }

  if (sensitivity === 'relaxed') {
    // Relaxed mode: only direct overlap
    return false;
  }

  // Normal and strict: check sibling files in same directory
  if (hasSiblingFiles(a.files, b.files)) {
    // In normal mode, only conflict if there's also a conflict-prone file involved
    if (sensitivity === 'strict') {
      return true;
    }
    // Normal: sibling + (conflict-prone OR same category)
    if (hasConflictProneOverlap(a.files, b.files)) {
      return true;
    }
    if (a.category && b.category && a.category === b.category) {
      return true;
    }
  }

  // Normal and strict: check directory overlap threshold
  if (directoriesOverlap(a.files, b.files, sensitivity === 'strict' ? 0.2 : 0.3)) {
    return true;
  }

  // Strict only: same package in monorepo
  if (sensitivity === 'strict' && touchesSamePackage(a.files, b.files)) {
    return true;
  }

  // Strict only: shared parent directory
  if (sensitivity === 'strict' && hasSharedParentConflict(a.files, b.files)) {
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Main partitioning function
// ---------------------------------------------------------------------------

/**
 * Partition proposals into conflict-free waves.
 * Proposals with overlapping file paths go into separate waves
 * so they run sequentially, avoiding merge conflicts.
 *
 * @param proposals - List of proposals with file paths
 * @param options - Conflict detection options
 * @returns Array of waves, each wave containing non-conflicting proposals
 */
export function partitionIntoWaves<T extends { files: string[]; category?: string }>(
  proposals: T[],
  options: ConflictDetectionOptions = {}
): T[][] {
  const waves: T[][] = [];

  for (const proposal of proposals) {
    let placed = false;
    for (const wave of waves) {
      const conflicts = wave.some(existing => proposalsConflict(existing, proposal, options));
      if (!conflicts) {
        wave.push(proposal);
        placed = true;
        break;
      }
    }
    if (!placed) {
      waves.push([proposal]);
    }
  }

  return waves;
}

/**
 * Build escalation prompt text for scout retries.
 * Suggests unexplored modules and fresh angles when previous attempts found nothing.
 */
export function buildScoutEscalation(
  retryCount: number,
  scoutedDirs: string[],
  codebaseIndex: CodebaseIndex | null,
  sectorState?: SectorState,
): string {
  const parts = [
    '## Previous Attempts Found Nothing — Fresh Approach Required',
    '',
  ];

  if (scoutedDirs.length > 0) {
    parts.push('### What Was Already Tried');
    for (const dir of scoutedDirs) {
      parts.push(`- Scouted \`${dir}\``);
    }
    parts.push('');
  }

  // Suggest unexplored modules from codebase index
  const exploredSet = new Set(scoutedDirs.map(d => d.replace(/\/$/, '')));
  const unexplored: string[] = [];
  if (codebaseIndex) {
    for (const mod of codebaseIndex.modules) {
      if (!exploredSet.has(mod.path) && !exploredSet.has(mod.path + '/')) {
        unexplored.push(mod.path);
      }
    }
  }

  // Sort unexplored by sector history when available
  if (sectorState && unexplored.length > 0) {
    const sectorByPath = new Map(sectorState.sectors.map(s => [s.path, s]));
    unexplored.sort((a, b) => {
      const sa = sectorByPath.get(a);
      const sb = sectorByPath.get(b);
      // Fewer scans first
      const scanA = sa?.scanCount ?? 0;
      const scanB = sb?.scanCount ?? 0;
      if (scanA !== scanB) return scanA - scanB;
      // Higher yield first
      const yieldA = sa?.proposalYield ?? 0;
      const yieldB = sb?.proposalYield ?? 0;
      return yieldB - yieldA;
    });
  }

  parts.push('### What to Do Differently');
  parts.push('');
  parts.push('Knowing everything from the attempts above, take a completely different angle:');
  parts.push('- Do NOT re-read the directories listed above.');
  if (unexplored.length > 0) {
    parts.push(`- Try unexplored areas: ${unexplored.slice(0, 8).map(d => `\`${d}\``).join(', ')}`);
  }
  parts.push('- Switch categories: if you looked for bugs, look for tests. If tests, try security.');
  parts.push('- Read at least 15 NEW source files.');
  parts.push('- If genuinely nothing to improve, explain your analysis across all attempts.');

  return parts.join('\n');
}
