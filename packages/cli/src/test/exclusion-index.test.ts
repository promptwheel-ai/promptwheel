/**
 * Tests for the exclusion index — organic artifact pattern discovery.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { buildExclusionIndex, resolveGitDir } from '../lib/exclusion-index.js';

describe('buildExclusionIndex', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'excl-idx-'));
    execSync('git init', { cwd: tmpDir, stdio: 'ignore' });
    fs.writeFileSync(path.join(tmpDir, 'README.md'), '');
    execSync('git add . && git commit -m init', { cwd: tmpDir, stdio: 'ignore' });
  });

  afterEach(() => {
    // Clean up worktrees before removing tmpDir
    try {
      execSync('git worktree prune', { cwd: tmpDir, stdio: 'ignore' });
    } catch { /* ignore */ }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Framework detection ─────────────────────────────────────────

  it('discovers node_modules/ from package.json', () => {
    fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}');

    const patterns = buildExclusionIndex(tmpDir);

    expect(patterns).toContain('node_modules/');
  });

  it('discovers Python artifacts from pyproject.toml', () => {
    fs.writeFileSync(path.join(tmpDir, 'pyproject.toml'), '');

    const patterns = buildExclusionIndex(tmpDir);

    expect(patterns).toContain('__pycache__/');
    expect(patterns).toContain('*.pyc');
    expect(patterns).toContain('.venv/');
  });

  it('discovers target/ from Cargo.toml', () => {
    fs.writeFileSync(path.join(tmpDir, 'Cargo.toml'), '');

    const patterns = buildExclusionIndex(tmpDir);

    expect(patterns).toContain('target/');
  });

  it('discovers vendor/ from go.mod', () => {
    fs.writeFileSync(path.join(tmpDir, 'go.mod'), '');

    const patterns = buildExclusionIndex(tmpDir);

    expect(patterns).toContain('vendor/');
  });

  it('discovers vendor/ from composer.json (PHP)', () => {
    fs.writeFileSync(path.join(tmpDir, 'composer.json'), '{}');

    const patterns = buildExclusionIndex(tmpDir);

    expect(patterns).toContain('vendor/');
  });

  it('discovers _build/ and deps/ from mix.exs (Elixir)', () => {
    fs.writeFileSync(path.join(tmpDir, 'mix.exs'), '');

    const patterns = buildExclusionIndex(tmpDir);

    expect(patterns).toContain('_build/');
    expect(patterns).toContain('deps/');
  });

  it('discovers .next/ from next.config.ts', () => {
    fs.writeFileSync(path.join(tmpDir, 'next.config.ts'), '');

    const patterns = buildExclusionIndex(tmpDir);

    expect(patterns).toContain('.next/');
  });

  it('discovers build/ and .gradle/ from build.gradle', () => {
    fs.writeFileSync(path.join(tmpDir, 'build.gradle'), '');

    const patterns = buildExclusionIndex(tmpDir);

    expect(patterns).toContain('build/');
    expect(patterns).toContain('.gradle/');
  });

  it('discovers .build/ from Package.swift', () => {
    fs.writeFileSync(path.join(tmpDir, 'Package.swift'), '');

    const patterns = buildExclusionIndex(tmpDir);

    expect(patterns).toContain('.build/');
  });

  it('discovers bin/ and obj/ from .csproj extension', () => {
    fs.writeFileSync(path.join(tmpDir, 'MyApp.csproj'), '');

    const patterns = buildExclusionIndex(tmpDir);

    expect(patterns).toContain('bin/');
    expect(patterns).toContain('obj/');
  });

  it('discovers patterns from monorepo sub-projects', () => {
    fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}');
    fs.mkdirSync(path.join(tmpDir, 'services', 'engine'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'services', 'engine', 'Cargo.toml'), '');

    const patterns = buildExclusionIndex(tmpDir);

    expect(patterns).toContain('node_modules/');
    expect(patterns).toContain('target/');
  });

  it('handles multiple frameworks in one project', () => {
    fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}');
    fs.writeFileSync(path.join(tmpDir, 'pyproject.toml'), '');
    fs.writeFileSync(path.join(tmpDir, 'vitest.config.ts'), '');

    const patterns = buildExclusionIndex(tmpDir);

    expect(patterns).toContain('node_modules/');
    expect(patterns).toContain('__pycache__/');
    expect(patterns).toContain('coverage/');
  });

  it('returns empty array when no indicators found', () => {
    const patterns = buildExclusionIndex(tmpDir);

    expect(patterns).toEqual([]);
  });

  // ── .git/info/exclude integration ───────────────────────────────

  it('writes patterns to .git/info/exclude', () => {
    fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}');

    buildExclusionIndex(tmpDir);

    const excludePath = path.join(tmpDir, '.git', 'info', 'exclude');
    const content = fs.readFileSync(excludePath, 'utf-8');
    expect(content).toContain('node_modules/');
    expect(content).toContain('Auto-discovered by PromptWheel');
  });

  it('makes git status ignore discovered patterns', () => {
    fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}');

    buildExclusionIndex(tmpDir);

    // Create a node_modules directory — should now be invisible to git
    fs.mkdirSync(path.join(tmpDir, 'node_modules', 'lodash'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'node_modules', 'lodash', 'index.js'), '');

    // Also create a source file — should be visible
    fs.writeFileSync(path.join(tmpDir, 'src.ts'), 'export const x = 1;');

    const status = execSync('git status --porcelain', {
      cwd: tmpDir,
      encoding: 'utf-8',
    }).trim();

    expect(status).toContain('src.ts');
    expect(status).not.toContain('node_modules');
  });

  it('does not corrupt existing .git/info/exclude content', () => {
    const excludePath = path.join(tmpDir, '.git', 'info', 'exclude');
    fs.writeFileSync(excludePath, '# Existing rule\n*.log\n');

    fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}');
    buildExclusionIndex(tmpDir);

    const content = fs.readFileSync(excludePath, 'utf-8');
    expect(content).toContain('*.log');
    expect(content).toContain('node_modules/');
  });

  it('respects maxDepth to limit scanning', () => {
    // Place indicator at depth 5, beyond default maxDepth=4
    const deep = path.join(tmpDir, 'a', 'b', 'c', 'd', 'e');
    fs.mkdirSync(deep, { recursive: true });
    fs.writeFileSync(path.join(deep, 'Cargo.toml'), '');

    const shallow = buildExclusionIndex(tmpDir, 4);
    expect(shallow).not.toContain('target/');

    // Reset for next call (remove marker so it's not a no-op)
    const excludePath = path.join(tmpDir, '.git', 'info', 'exclude');
    try { fs.writeFileSync(excludePath, ''); } catch { /* ignore */ }

    const deeper = buildExclusionIndex(tmpDir, 6);
    expect(deeper).toContain('target/');
  });

  // ── Gap #3: Idempotent writes ───────────────────────────────────

  it('is idempotent — second call does not duplicate patterns', () => {
    fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}');

    buildExclusionIndex(tmpDir);
    buildExclusionIndex(tmpDir);

    const excludePath = path.join(tmpDir, '.git', 'info', 'exclude');
    const content = fs.readFileSync(excludePath, 'utf-8');

    // The marker should appear exactly once
    const markerCount = content.split('Auto-discovered by PromptWheel').length - 1;
    expect(markerCount).toBe(1);
  });

  it('second call still returns discovered patterns (not empty)', () => {
    fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}');

    const first = buildExclusionIndex(tmpDir);
    const second = buildExclusionIndex(tmpDir);

    expect(first).toContain('node_modules/');
    expect(second).toContain('node_modules/');
  });

  // ── Gap #4: Linked worktree .git file ───────────────────────────

  it('resolves .git file in a linked worktree to common dir', () => {
    const wtPath = path.join(tmpDir, 'my-worktree');
    execSync(`git worktree add "${wtPath}" -b test-branch`, {
      cwd: tmpDir,
      stdio: 'ignore',
    });

    // In a linked worktree, .git is a file, not a directory
    const gitEntry = path.join(wtPath, '.git');
    expect(fs.statSync(gitEntry).isFile()).toBe(true);

    // resolveGitDir should follow the pointer to the COMMON dir
    const resolved = resolveGitDir(wtPath);
    expect(resolved).toBe(path.join(tmpDir, '.git'));

    // Cleanup
    execSync(`git worktree remove "${wtPath}"`, { cwd: tmpDir, stdio: 'ignore' });
  });

  it('writes exclude to common dir so linked worktrees respect it', () => {
    const wtPath = path.join(tmpDir, 'wt-exclude');
    execSync(`git worktree add "${wtPath}" -b excl-branch`, {
      cwd: tmpDir,
      stdio: 'ignore',
    });

    // Add an indicator inside the worktree
    fs.writeFileSync(path.join(wtPath, 'package.json'), '{}');

    const patterns = buildExclusionIndex(wtPath);
    expect(patterns).toContain('node_modules/');

    // Verify exclude was written to the COMMON .git/info/exclude
    // (git reads info/exclude from the common dir, not per-worktree)
    const mainExclude = path.join(tmpDir, '.git', 'info', 'exclude');
    const mainContent = fs.readFileSync(mainExclude, 'utf-8');
    expect(mainContent).toContain('node_modules/');

    // git status in the worktree should respect the exclude
    fs.mkdirSync(path.join(wtPath, 'node_modules', 'x'), { recursive: true });
    fs.writeFileSync(path.join(wtPath, 'node_modules', 'x', 'y.js'), '');
    fs.writeFileSync(path.join(wtPath, 'app.ts'), 'export default 1;');

    const status = execSync('git status --porcelain', {
      cwd: wtPath,
      encoding: 'utf-8',
    }).trim();

    expect(status).toContain('app.ts');
    expect(status).not.toContain('node_modules');

    // Cleanup (--force needed because we created untracked files)
    execSync(`git worktree remove --force "${wtPath}"`, { cwd: tmpDir, stdio: 'ignore' });
  });

  // ── Gap #5: SCAN_SKIP derived from indicator map ────────────────

  it('skips scanning into discovered artifact directories', () => {
    // If node_modules/ exists with a Cargo.toml inside, we should NOT
    // descend into it and discover target/. The Cargo.toml inside
    // node_modules is not a real Rust project indicator.
    fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}');
    fs.mkdirSync(path.join(tmpDir, 'node_modules', 'some-crate'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'node_modules', 'some-crate', 'Cargo.toml'),
      '',
    );

    const patterns = buildExclusionIndex(tmpDir);

    expect(patterns).toContain('node_modules/');
    // target/ should NOT be discovered — it came from inside node_modules
    expect(patterns).not.toContain('target/');
  });
});
