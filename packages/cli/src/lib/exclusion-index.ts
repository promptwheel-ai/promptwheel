/**
 * Exclusion index — discovers what artifact patterns a project generates
 * by scanning for indicator files (lockfiles, configs, build manifests)
 * and writes any patterns missing from .gitignore to the worktree's
 * .git/info/exclude so `git status` filters them natively.
 *
 * Detection is organic: the project's own files tell us what frameworks
 * and languages are in use, and therefore what artifact directories will
 * exist.  The INDICATOR_MAP below is a knowledge base that drives
 * detection — it only fires when we actually find the indicator file in
 * the worktree, not unconditionally.
 *
 * As a second layer, solo-ticket.ts captures a baseline `git status`
 * snapshot after dep install (before the agent runs).  Anything present
 * in the baseline is subtracted from the post-agent status, so even
 * artifacts the indicator map doesn't know about are filtered out.
 *
 * Note: the enterprise worker path (src/worker/) uses `git diff --name-only`
 * which only shows tracked changes and is not affected by untracked
 * artifacts.  This module is only used by the CLI solo path.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

// ─── Knowledge base ───────────────────────────────────────────────

/**
 * Map from indicator filenames to the artifact patterns that framework generates.
 * When we find an indicator file in the worktree, we know those artifact paths
 * may appear and should be excluded from scope validation.
 */
const INDICATOR_MAP: Record<string, string[]> = {
  // ── Node.js / JavaScript / TypeScript ──
  'package.json':        ['node_modules/'],
  'next.config.js':      ['.next/'],
  'next.config.mjs':     ['.next/'],
  'next.config.ts':      ['.next/'],
  'nuxt.config.ts':      ['.nuxt/', '.output/'],
  'nuxt.config.js':      ['.nuxt/', '.output/'],
  'svelte.config.js':    ['.svelte-kit/'],
  'turbo.json':          ['.turbo/'],
  'vite.config.ts':      ['dist/'],
  'vite.config.js':      ['dist/'],
  'rollup.config.js':    ['dist/'],
  'rollup.config.mjs':   ['dist/'],
  'webpack.config.js':   ['dist/', 'build/'],
  'webpack.config.ts':   ['dist/', 'build/'],
  '.parcelrc':           ['.parcel-cache/'],
  'tsconfig.json':       ['*.tsbuildinfo'],

  // ── Python ──
  'pyproject.toml':      ['__pycache__/', '*.pyc', '.venv/', 'venv/', '.pytest_cache/', '.mypy_cache/', '.ruff_cache/'],
  'requirements.txt':    ['__pycache__/', '*.pyc', '.venv/', 'venv/', '.eggs/', '*.egg-info/'],
  'Pipfile':             ['__pycache__/', '*.pyc', '.venv/'],
  'setup.py':            ['__pycache__/', '*.pyc', '*.egg-info/', 'dist/', 'build/'],
  'setup.cfg':           ['__pycache__/', '*.pyc', '*.egg-info/'],

  // ── Rust ──
  'Cargo.toml':          ['target/'],

  // ── Go ──
  'go.mod':              ['vendor/'],

  // ── PHP ──
  'composer.json':       ['vendor/'],

  // ── Ruby ──
  'Gemfile':             ['.bundle/', 'vendor/bundle/'],

  // ── Elixir ──
  'mix.exs':             ['_build/', 'deps/', '.elixir_ls/'],

  // ── Java / Kotlin / Scala ──
  'pom.xml':             ['target/'],
  'build.gradle':        ['build/', '.gradle/'],
  'build.gradle.kts':    ['build/', '.gradle/'],

  // ── .NET / C# ──
  // *.csproj and *.sln handled via extension check below

  // ── Swift ──
  'Package.swift':       ['.build/', '.swiftpm/'],

  // ── Dart / Flutter ──
  'pubspec.yaml':        ['.dart_tool/', 'build/'],

  // ── Coverage / testing tools ──
  'jest.config.js':      ['coverage/'],
  'jest.config.ts':      ['coverage/'],
  'vitest.config.ts':    ['coverage/'],
  'vitest.config.js':    ['coverage/'],
  'pytest.ini':          ['.pytest_cache/'],
  '.nycrc':              ['coverage/', '.nyc_output/'],
  '.nycrc.json':         ['coverage/', '.nyc_output/'],

  // ── PromptWheel internals ──
  '.promptwheel':         ['.promptwheel/'],
};

/**
 * Extension-based indicators for project types where the config filename
 * isn't fixed (e.g. *.csproj, *.sln for .NET).
 */
const EXTENSION_INDICATORS: Record<string, string[]> = {
  '.csproj': ['bin/', 'obj/'],
  '.fsproj': ['bin/', 'obj/'],
  '.sln':    ['bin/', 'obj/'],
};

// ─── Derived constants ────────────────────────────────────────────

/**
 * Directories to skip when scanning for indicators.
 * Derived automatically from INDICATOR_MAP + EXTENSION_INDICATORS values
 * so there is no separate list to maintain — if an artifact pattern is
 * added above, the scanner will skip it during traversal too.
 */
const SCAN_SKIP: Set<string> = /* @__PURE__ */ (() => {
  // VCS internals are always skipped even though they aren't in the map.
  const dirs = new Set<string>(['.git', '.hg', '.svn']);
  const allPatterns = [
    ...Object.values(INDICATOR_MAP).flat(),
    ...Object.values(EXTENSION_INDICATORS).flat(),
  ];
  for (const p of allPatterns) {
    // 'node_modules/' → 'node_modules', '.next/' → '.next'
    if (p.endsWith('/')) dirs.add(p.slice(0, -1));
  }
  return dirs;
})();

/** Marker written to the exclude file so we can detect prior runs. */
const EXCLUDE_MARKER = '# Auto-discovered by PromptWheel exclusion index';

// ─── Internal helpers ─────────────────────────────────────────────

/**
 * Scan a directory tree for indicator files and collect the artifact
 * patterns they imply.
 */
function scanIndicators(
  dir: string,
  patterns: Set<string>,
  depth: number,
  maxDepth: number,
): void {
  if (depth > maxDepth) return;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const name = entry.name;

    // Check exact-name indicators
    if (INDICATOR_MAP[name]) {
      for (const p of INDICATOR_MAP[name]) patterns.add(p);
    }

    // Check extension-based indicators
    for (const ext of Object.keys(EXTENSION_INDICATORS)) {
      if (name.endsWith(ext)) {
        for (const p of EXTENSION_INDICATORS[ext]) patterns.add(p);
        break;
      }
    }

    // Recurse into subdirectories, skipping artifact dirs and hidden dirs
    if (entry.isDirectory() && !SCAN_SKIP.has(name) && !name.startsWith('.')) {
      scanIndicators(path.join(dir, name), patterns, depth + 1, maxDepth);
    }
  }
}

/**
 * Resolve the git common directory for a worktree.
 *
 * Git reads `info/exclude` from the *common* dir — not the per-worktree
 * dir.  For a normal repo `.git/` IS the common dir.  For a linked
 * worktree `.git` is a file pointing to `.git/worktrees/<name>/`; the
 * common dir is its grandparent (`.git/`).
 *
 * Exported for testing.
 */
export function resolveGitDir(worktreePath: string): string {
  const gitPath = path.join(worktreePath, '.git');

  let stat: fs.Stats;
  try {
    stat = fs.statSync(gitPath);
  } catch {
    return gitPath; // Doesn't exist yet — return default path
  }

  // Normal repo — .git is already the common dir
  if (stat.isDirectory()) return gitPath;

  // Linked worktree: .git is a file containing "gitdir: /path/to/..."
  // e.g. "gitdir: /repo/.git/worktrees/my-ticket"
  const content = fs.readFileSync(gitPath, 'utf-8').trim();
  const match = content.match(/^gitdir:\s+(.+)$/);
  if (match) {
    const worktreeGitDir = path.isAbsolute(match[1])
      ? match[1]
      : path.resolve(worktreePath, match[1]);

    // Walk up to the common dir: .git/worktrees/<name> → .git/
    // The worktree gitdir is always <common>/worktrees/<name>
    const worktreesParent = path.dirname(worktreeGitDir);
    if (path.basename(worktreesParent) === 'worktrees') {
      return path.dirname(worktreesParent);
    }

    // Fallback: return the worktree gitdir itself
    return worktreeGitDir;
  }

  return gitPath;
}

// ─── Public API ───────────────────────────────────────────────────

/**
 * Build an exclusion index for a worktree by scanning the project tree
 * for indicator files and writing any inferred artifact patterns to
 * `.git/info/exclude`.
 *
 * Call this after worktree creation but before installing dependencies
 * or running the agent. After this, `git status --porcelain` natively
 * filters out all discovered artifact directories.
 *
 * Idempotent — safe to call multiple times on the same worktree
 * (e.g. on ticket retry).  Subsequent calls are no-ops.
 *
 * @param worktreePath - Absolute path to the worktree root
 * @param maxDepth - How deep to scan for indicators (default 4, sufficient for monorepos)
 * @returns List of patterns written to the exclude file (empty on no-op)
 */
export function buildExclusionIndex(worktreePath: string, maxDepth = 4): string[] {
  const patterns = new Set<string>();

  // Scan the worktree for indicator files
  scanIndicators(worktreePath, patterns, 0, maxDepth);

  if (patterns.size === 0) return [];

  const patternList = [...patterns].sort();

  // Write to .git/info/exclude (worktree-local, never committed)
  try {
    const gitDir = resolveGitDir(worktreePath);
    const infoDir = path.join(gitDir, 'info');
    if (!fs.existsSync(infoDir)) {
      fs.mkdirSync(infoDir, { recursive: true });
    }

    const excludePath = path.join(infoDir, 'exclude');

    // Idempotency: if we've already written, don't append again
    try {
      const existing = fs.readFileSync(excludePath, 'utf-8');
      if (existing.includes(EXCLUDE_MARKER)) {
        return patternList;
      }
    } catch {
      // File doesn't exist yet — that's fine, we'll create it
    }

    const block = [
      '',
      EXCLUDE_MARKER,
      ...patternList,
      '',
    ].join('\n');

    fs.appendFileSync(excludePath, block);
  } catch {
    // Non-fatal: scope check will still run, just might flag extra files
  }

  return patternList;
}
