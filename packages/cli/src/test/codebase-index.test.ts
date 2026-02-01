/**
 * Tests for CLI codebase-index module
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  buildCodebaseIndex,
  refreshCodebaseIndex,
  hasStructuralChanges,
  formatIndexForPrompt,
  type CodebaseIndex,
} from '../lib/codebase-index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

function mkfile(relPath: string, content = ''): void {
  const full = path.join(tmpDir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codebase-index-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// buildCodebaseIndex
// ---------------------------------------------------------------------------

describe('buildCodebaseIndex', () => {
  it('returns empty index for empty project', () => {
    const idx = buildCodebaseIndex(tmpDir);
    expect(idx.modules).toEqual([]);
    expect(idx.entrypoints).toEqual([]);
    expect(idx.large_files).toEqual([]);
    expect(idx.untested_modules).toEqual([]);
  });

  it('detects modules at depth 1 and 2', () => {
    mkfile('src/utils/helper.ts', 'export function foo() {}');
    mkfile('src/services/api.ts', 'export class Api {}');
    mkfile('lib/core.js', 'module.exports = {}');

    const idx = buildCodebaseIndex(tmpDir);
    const paths = idx.modules.map(m => m.path);
    expect(paths).toContain('src/utils');
    expect(paths).toContain('src/services');
    expect(paths).toContain('lib');
  });

  it('infers purpose from directory name', () => {
    mkfile('src/controllers/user.ts', '');
    mkfile('src/tests/user.test.ts', '');
    mkfile('src/components/Button.ts', '');

    const idx = buildCodebaseIndex(tmpDir);
    const byPath = new Map(idx.modules.map(m => [m.path, m]));
    expect(byPath.get('src/controllers')?.purpose).toBe('api');
    expect(byPath.get('src/tests')?.purpose).toBe('tests');
    expect(byPath.get('src/components')?.purpose).toBe('ui');
  });

  it('excludes specified directories', () => {
    mkfile('src/lib/code.ts', '');
    mkfile('node_modules/pkg/index.js', '');
    mkfile('dist/bundle.js', '');

    const idx = buildCodebaseIndex(tmpDir, ['node_modules', 'dist']);
    const paths = idx.modules.map(m => m.path);
    expect(paths).toContain('src/lib');
    expect(paths).not.toContain('node_modules/pkg');
    expect(paths).not.toContain('dist');
  });

  it('excludes dot directories', () => {
    mkfile('src/lib/code.ts', '');
    mkfile('.hidden/secret.ts', '');

    const idx = buildCodebaseIndex(tmpDir);
    const paths = idx.modules.map(m => m.path);
    expect(paths).toContain('src/lib');
    expect(paths).not.toContain('.hidden');
  });

  it('detects dependency edges from imports', () => {
    mkfile('src/lib/helper.ts', 'export function help() {}');
    mkfile('src/services/api.ts', "import { help } from '../lib/helper.js';\n");

    const idx = buildCodebaseIndex(tmpDir);
    expect(idx.dependency_edges['src/services']).toContain('src/lib');
  });

  it('detects entrypoints', () => {
    mkfile('src/index.ts', 'console.log("entry");');
    mkfile('src/lib/util.ts', '');

    const idx = buildCodebaseIndex(tmpDir);
    expect(idx.entrypoints).toContain('src/index.ts');
  });

  it('detects large files (>300 LOC estimated)', () => {
    // 40 bytes per line heuristic, so 301 * 40 = 12040 bytes
    mkfile('src/lib/big.ts', 'x'.repeat(12100));

    const idx = buildCodebaseIndex(tmpDir);
    expect(idx.large_files.length).toBeGreaterThan(0);
    expect(idx.large_files[0].path).toBe('src/lib/big.ts');
    expect(idx.large_files[0].lines).toBeGreaterThan(300);
  });

  it('identifies untested modules', () => {
    mkfile('src/services/api.ts', '');
    // No test files or test directories

    const idx = buildCodebaseIndex(tmpDir);
    expect(idx.untested_modules).toContain('src/services');
  });

  it('marks module as tested when __tests__ dir exists', () => {
    mkfile('src/services/api.ts', '');
    mkfile('src/services/__tests__/api.test.ts', '');

    const idx = buildCodebaseIndex(tmpDir);
    expect(idx.untested_modules).not.toContain('src/services');
  });

  it('marks module as tested when .test. files exist within', () => {
    mkfile('src/lib/util.ts', '');
    mkfile('src/lib/util.test.ts', '');

    const idx = buildCodebaseIndex(tmpDir);
    expect(idx.untested_modules).not.toContain('src/lib');
  });

  it('caps modules at 50', () => {
    for (let i = 0; i < 60; i++) {
      mkfile(`src/mod${i}/file.ts`, '');
    }
    const idx = buildCodebaseIndex(tmpDir);
    expect(idx.modules.length).toBeLessThanOrEqual(50);
  });

  it('records sampled file mtimes', () => {
    mkfile('src/lib/a.ts', 'const x = 1;');
    const idx = buildCodebaseIndex(tmpDir);
    expect(Object.keys(idx.sampled_file_mtimes).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// formatIndexForPrompt
// ---------------------------------------------------------------------------

describe('formatIndexForPrompt', () => {
  it('returns "No modules detected" for empty index', () => {
    const idx = buildCodebaseIndex(tmpDir);
    const result = formatIndexForPrompt(idx, 1);
    expect(result).toContain('No modules detected');
  });

  it('formats modules with chunk info', () => {
    mkfile('src/lib/a.ts', '');
    mkfile('src/utils/b.ts', '');
    const idx = buildCodebaseIndex(tmpDir);
    const result = formatIndexForPrompt(idx, 1);
    expect(result).toContain('Codebase Structure');
    expect(result).toContain('Modules in Focus');
  });

  it('rotates chunks across cycles', () => {
    // Create 20 modules to get 2 chunks (15 per chunk)
    for (let i = 0; i < 20; i++) {
      mkfile(`src/mod${String(i).padStart(2, '0')}/file.ts`, '');
    }
    const idx = buildCodebaseIndex(tmpDir);

    const cycle1 = formatIndexForPrompt(idx, 0);
    const cycle2 = formatIndexForPrompt(idx, 1);

    expect(cycle1).toContain('chunk 1/2');
    expect(cycle2).toContain('chunk 2/2');
    // They should show different modules in focus
    expect(cycle1).not.toEqual(cycle2);
  });

  it('includes untested modules section', () => {
    mkfile('src/services/api.ts', '');
    const idx = buildCodebaseIndex(tmpDir);
    const result = formatIndexForPrompt(idx, 1);
    expect(result).toContain('Untested Modules');
  });

  it('includes complexity hotspots section', () => {
    mkfile('src/lib/big.ts', 'x'.repeat(15000));
    const idx = buildCodebaseIndex(tmpDir);
    const result = formatIndexForPrompt(idx, 1);
    expect(result).toContain('Complexity Hotspots');
  });

  it('includes entrypoints section', () => {
    mkfile('src/index.ts', '');
    mkfile('src/lib/util.ts', '');
    const idx = buildCodebaseIndex(tmpDir);
    const result = formatIndexForPrompt(idx, 1);
    expect(result).toContain('Entrypoints');
    expect(result).toContain('src/index.ts');
  });
});

// ---------------------------------------------------------------------------
// hasStructuralChanges
// ---------------------------------------------------------------------------

describe('hasStructuralChanges', () => {
  it('returns false for unchanged project', async () => {
    mkfile('src/lib/a.ts', 'const x = 1;');
    // Wait so that built_at is strictly after all file/dir mtimes
    await new Promise(r => setTimeout(r, 50));
    const idx = buildCodebaseIndex(tmpDir);
    // No changes after build
    expect(hasStructuralChanges(idx, tmpDir)).toBe(false);
  });

  it('returns true when a new file is added to a module dir', async () => {
    mkfile('src/lib/a.ts', 'const x = 1;');
    const idx = buildCodebaseIndex(tmpDir);

    // Wait a bit so mtime differs
    await new Promise(r => setTimeout(r, 50));
    mkfile('src/lib/b.ts', 'const y = 2;');

    expect(hasStructuralChanges(idx, tmpDir)).toBe(true);
  });

  it('returns true when a sampled file is modified', async () => {
    mkfile('src/lib/a.ts', 'const x = 1;');
    const idx = buildCodebaseIndex(tmpDir);

    await new Promise(r => setTimeout(r, 50));
    fs.writeFileSync(path.join(tmpDir, 'src/lib/a.ts'), 'const x = 2;');

    expect(hasStructuralChanges(idx, tmpDir)).toBe(true);
  });

  it('returns true when a sampled file is deleted', () => {
    mkfile('src/lib/a.ts', 'const x = 1;');
    const idx = buildCodebaseIndex(tmpDir);

    fs.unlinkSync(path.join(tmpDir, 'src/lib/a.ts'));

    expect(hasStructuralChanges(idx, tmpDir)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// refreshCodebaseIndex
// ---------------------------------------------------------------------------

describe('refreshCodebaseIndex', () => {
  it('reuses edges for unchanged modules', () => {
    mkfile('src/lib/helper.ts', 'export const x = 1;');
    mkfile('src/services/api.ts', "import { x } from '../lib/helper.js';\n");

    const idx1 = buildCodebaseIndex(tmpDir);
    expect(idx1.dependency_edges['src/services']).toContain('src/lib');

    // Refresh without changes — edges should be preserved
    const idx2 = refreshCodebaseIndex(idx1, tmpDir);
    expect(idx2.dependency_edges['src/services']).toContain('src/lib');
  });

  it('picks up new modules', () => {
    mkfile('src/lib/a.ts', '');
    const idx1 = buildCodebaseIndex(tmpDir);
    expect(idx1.modules.map(m => m.path)).not.toContain('src/utils');

    mkfile('src/utils/b.ts', '');
    const idx2 = refreshCodebaseIndex(idx1, tmpDir);
    expect(idx2.modules.map(m => m.path)).toContain('src/utils');
  });

  it('detects file count changes in existing modules', () => {
    mkfile('src/lib/a.ts', '');
    const idx1 = buildCodebaseIndex(tmpDir);
    const oldCount = idx1.modules.find(m => m.path === 'src/lib')?.file_count;

    mkfile('src/lib/b.ts', '');
    const idx2 = refreshCodebaseIndex(idx1, tmpDir);
    const newCount = idx2.modules.find(m => m.path === 'src/lib')?.file_count;

    expect(newCount).toBe((oldCount ?? 0) + 1);
  });
});
