import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { buildCodebaseIndex, formatIndexForPrompt, refreshCodebaseIndex, hasStructuralChanges } from '../codebase-index.js';
import type { CodebaseIndex } from '../codebase-index.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bs-idx-'));
}

function writeFile(root: string, relPath: string, content = ''): void {
  const full = path.join(root, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
}

describe('buildCodebaseIndex', () => {
  let root: string;

  beforeEach(() => {
    root = tmpDir();
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('returns empty index for empty directory', () => {
    const idx = buildCodebaseIndex(root);
    expect(idx.modules).toEqual([]);
    expect(idx.dependency_edges).toEqual({});
    expect(idx.untested_modules).toEqual([]);
    expect(idx.large_files).toEqual([]);
    expect(idx.entrypoints).toEqual([]);
    expect(idx.built_at).toBeTruthy();
  });

  it('detects modules with correct purposes', () => {
    writeFile(root, 'src/services/foo.ts', 'export const x = 1;');
    writeFile(root, 'src/services/bar.ts', 'export const y = 2;');
    writeFile(root, 'src/utils/helpers.ts', 'export function h() {}');
    writeFile(root, 'src/api/routes.ts', 'export default {};');
    writeFile(root, 'src/components/Button.tsx'); // .tsx is a source extension

    const idx = buildCodebaseIndex(root);

    const byPath = Object.fromEntries(idx.modules.map(m => [m.path, m]));
    expect(byPath['src/services']).toBeDefined();
    expect(byPath['src/services'].purpose).toBe('services');
    expect(byPath['src/services'].file_count).toBe(2);

    expect(byPath['src/utils']).toBeDefined();
    expect(byPath['src/utils'].purpose).toBe('utils');

    expect(byPath['src/api']).toBeDefined();
    expect(byPath['src/api'].purpose).toBe('api');

    // .tsx is a source extension, so components should appear
    expect(byPath['src/components']).toBeDefined();
    expect(byPath['src/components'].purpose).toBe('ui');
  });

  it('scans JS/TS imports and builds dependency edges', () => {
    writeFile(root, 'src/api/handler.ts', [
      "import { db } from '../db/client.js';",
      "import { validate } from '../utils/validate.js';",
      "import express from 'express';", // package import — ignored
      'export function handle() {}',
    ].join('\n'));
    writeFile(root, 'src/db/client.ts', 'export const db = {};');
    writeFile(root, 'src/utils/validate.ts', 'export function validate() {}');

    const idx = buildCodebaseIndex(root);
    const apiDeps = idx.dependency_edges['src/api'] ?? [];
    expect(apiDeps).toContain('src/db');
    expect(apiDeps).toContain('src/utils');
  });

  it('scans Python imports', () => {
    writeFile(root, 'src/api/views.py', [
      'from src.db import connection',
      'import src.utils',
    ].join('\n'));
    writeFile(root, 'src/db/connection.py', '');
    writeFile(root, 'src/utils/helpers.py', '');

    const idx = buildCodebaseIndex(root);
    // Python imports are module-qualified (src.db) — not relative paths,
    // so they won't resolve to module paths via our relative-import resolver.
    // This is expected: only relative imports produce edges.
    expect(idx.modules.length).toBeGreaterThanOrEqual(3);
  });

  it('respects excludeDirs', () => {
    writeFile(root, 'src/services/a.ts');
    writeFile(root, 'node_modules/pkg/index.ts');
    writeFile(root, 'dist/services/a.js');

    const idx = buildCodebaseIndex(root, ['node_modules', 'dist']);
    const paths = idx.modules.map(m => m.path);
    expect(paths).toContain('src/services');
    expect(paths.some(p => p.includes('node_modules'))).toBe(false);
    expect(paths.some(p => p.includes('dist'))).toBe(false);
  });

  it('identifies untested modules', () => {
    writeFile(root, 'src/services/svc.ts');
    writeFile(root, 'src/api/handler.ts');
    // services has a __tests__ dir
    writeFile(root, 'src/services/__tests__/svc.test.ts');
    // api has no tests at all

    const idx = buildCodebaseIndex(root);
    expect(idx.untested_modules).toContain('src/api');
    expect(idx.untested_modules).not.toContain('src/services');
  });

  it('detects modules with inline test files as tested', () => {
    writeFile(root, 'src/utils/helpers.ts');
    writeFile(root, 'src/utils/helpers.test.ts');

    const idx = buildCodebaseIndex(root);
    expect(idx.untested_modules).not.toContain('src/utils');
  });

  it('detects large files via byte heuristic', () => {
    // 300 LOC * 45 bytes/line = 13500 bytes — need >300 estimated lines
    const bigContent = 'x'.repeat(13600);
    writeFile(root, 'src/services/big.ts', bigContent);
    writeFile(root, 'src/services/small.ts', 'const x = 1;');

    const idx = buildCodebaseIndex(root);
    expect(idx.large_files.length).toBe(1);
    expect(idx.large_files[0].path).toBe('src/services/big.ts');
    expect(idx.large_files[0].lines).toBeGreaterThan(300);
  });

  it('finds entrypoints in root and src/', () => {
    writeFile(root, 'index.ts');
    writeFile(root, 'src/main.ts');
    writeFile(root, 'src/server.ts');

    const idx = buildCodebaseIndex(root);
    expect(idx.entrypoints).toContain('index.ts');
    expect(idx.entrypoints).toContain(path.join('src', 'main.ts'));
    expect(idx.entrypoints).toContain(path.join('src', 'server.ts'));
  });
});

describe('formatIndexForPrompt', () => {
  function makeIndex(moduleCount: number): CodebaseIndex {
    const modules = Array.from({ length: moduleCount }, (_, i) => ({
      path: `src/mod${i}`,
      file_count: i + 1,
      purpose: 'unknown',
    }));
    return {
      built_at: new Date().toISOString(),
      modules,
      dependency_edges: { 'src/mod0': ['src/mod1'] },
      untested_modules: ['src/mod2'],
      large_files: [{ path: 'src/mod0/big.ts', lines: 450 }],
      entrypoints: ['src/index.ts'],
      sampled_file_mtimes: {},
    };
  }

  it('shows chunk 1/1 for small index', () => {
    const idx = makeIndex(5);
    const out = formatIndexForPrompt(idx, 0);
    expect(out).toContain('chunk 1/1');
    expect(out).toContain('src/mod0/');
    expect(out).not.toContain('Other Modules');
  });

  it('chunks modules — cycle 0 gets first 15', () => {
    const idx = makeIndex(30);
    const out = formatIndexForPrompt(idx, 0);
    expect(out).toContain('chunk 1/2');
    expect(out).toContain('src/mod0/');
    expect(out).toContain('src/mod14/');
    // mod15 should be in "Other Modules"
    expect(out).toContain('Other Modules');
    expect(out).toContain('src/mod15/');
  });

  it('chunks modules — cycle 1 gets 15-29', () => {
    const idx = makeIndex(30);
    const out = formatIndexForPrompt(idx, 1);
    expect(out).toContain('chunk 2/2');
    expect(out).toContain('src/mod15/');
    expect(out).toContain('src/mod29/');
  });

  it('wraps around on higher cycles', () => {
    const idx = makeIndex(30); // 2 chunks
    const cycle0 = formatIndexForPrompt(idx, 0);
    const cycle2 = formatIndexForPrompt(idx, 2);
    // cycle 2 % 2 = 0, same as cycle 0
    expect(cycle2).toContain('chunk 1/2');
    expect(cycle0).toContain('chunk 1/2');
  });

  it('always includes untested, hotspots, entrypoints regardless of chunk', () => {
    const idx = makeIndex(30);
    for (let cycle = 0; cycle < 3; cycle++) {
      const out = formatIndexForPrompt(idx, cycle);
      expect(out).toContain('Untested Modules');
      expect(out).toContain('src/mod2/');
      expect(out).toContain('Complexity Hotspots');
      expect(out).toContain('src/mod0/big.ts');
      expect(out).toContain('Entrypoints');
      expect(out).toContain('src/index.ts');
    }
  });

  it('lists other modules not in focus', () => {
    const idx = makeIndex(20);
    const out = formatIndexForPrompt(idx, 0);
    // 20 modules, chunk size 15, so 5 are "other"
    expect(out).toContain('Other Modules');
    expect(out).toContain('src/mod15/');
  });

  it('returns fallback for empty modules', () => {
    const idx = makeIndex(0);
    const out = formatIndexForPrompt(idx, 0);
    expect(out).toContain('No modules detected');
  });

  it('retries advance the chunk (cycles + retries as offset)', () => {
    const idx = makeIndex(30); // 2 chunks
    // Simulate cycle=0 retry=0 → chunk 1
    const c0r0 = formatIndexForPrompt(idx, 0);
    expect(c0r0).toContain('chunk 1/2');
    // Simulate cycle=0 retry=1 → offset=1 → chunk 2
    const c0r1 = formatIndexForPrompt(idx, 1);
    expect(c0r1).toContain('chunk 2/2');
    // Simulate cycle=1 retry=0 → offset=1 → chunk 2 (same)
    // Simulate cycle=1 retry=1 → offset=2 → wraps to chunk 1
    const c1r1 = formatIndexForPrompt(idx, 2);
    expect(c1r1).toContain('chunk 1/2');
  });
});

describe('refreshCodebaseIndex', () => {
  let root: string;

  beforeEach(() => {
    root = tmpDir();
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('picks up new modules added between cycles', () => {
    writeFile(root, 'src/services/a.ts', 'export const x = 1;');
    const idx1 = buildCodebaseIndex(root);
    expect(idx1.modules.map(m => m.path)).toContain('src/services');
    expect(idx1.modules.some(m => m.path === 'src/utils')).toBe(false);

    // Add a new module
    writeFile(root, 'src/utils/helpers.ts', 'export function h() {}');
    const idx2 = refreshCodebaseIndex(idx1, root);
    expect(idx2.modules.map(m => m.path)).toContain('src/utils');
    expect(idx2.modules.map(m => m.path)).toContain('src/services');
  });

  it('detects removed modules', () => {
    writeFile(root, 'src/services/a.ts');
    writeFile(root, 'src/utils/b.ts');
    const idx1 = buildCodebaseIndex(root);
    expect(idx1.modules.length).toBe(2);

    // Remove utils
    fs.rmSync(path.join(root, 'src/utils'), { recursive: true });
    const idx2 = refreshCodebaseIndex(idx1, root);
    expect(idx2.modules.map(m => m.path)).toContain('src/services');
    expect(idx2.modules.some(m => m.path === 'src/utils')).toBe(false);
  });

  it('preserves dependency edges for unchanged modules', () => {
    writeFile(root, 'src/api/handler.ts', "import { db } from '../db/client.js';\nexport function handle() {}");
    writeFile(root, 'src/db/client.ts', 'export const db = {};');
    const idx1 = buildCodebaseIndex(root);
    expect(idx1.dependency_edges['src/api']).toContain('src/db');

    // Refresh without changes — edges should be preserved (not re-scanned)
    const idx2 = refreshCodebaseIndex(idx1, root);
    expect(idx2.dependency_edges['src/api']).toContain('src/db');
  });

  it('re-scans edges when file count changes', () => {
    writeFile(root, 'src/api/handler.ts', "import { db } from '../db/client.js';");
    writeFile(root, 'src/db/client.ts', 'export const db = {};');
    const idx1 = buildCodebaseIndex(root);

    // Add a file to api — file count changes, edges will be re-scanned
    writeFile(root, 'src/api/other.ts', 'export const y = 1;');
    const idx2 = refreshCodebaseIndex(idx1, root);
    const apiMod = idx2.modules.find(m => m.path === 'src/api');
    expect(apiMod?.file_count).toBe(2);
    // Fresh scan still finds the import
    expect(idx2.dependency_edges['src/api']).toContain('src/db');
  });

  it('updates built_at timestamp', () => {
    writeFile(root, 'src/services/a.ts');
    const idx1 = buildCodebaseIndex(root);
    // Backdate so the refresh definitely produces a newer timestamp
    idx1.built_at = new Date(Date.now() - 10000).toISOString();

    const idx2 = refreshCodebaseIndex(idx1, root);
    expect(new Date(idx2.built_at).getTime()).toBeGreaterThan(new Date(idx1.built_at).getTime());
  });
});

describe('hasStructuralChanges', () => {
  let root: string;

  beforeEach(() => {
    root = tmpDir();
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('returns false when nothing changed', () => {
    writeFile(root, 'src/services/a.ts');
    const idx = buildCodebaseIndex(root);
    // Backdate built_at to future to ensure no mtime is newer
    idx.built_at = new Date(Date.now() + 10000).toISOString();
    expect(hasStructuralChanges(idx, root)).toBe(false);
  });

  it('returns true when a file is added to a module dir', () => {
    writeFile(root, 'src/services/a.ts');
    const idx = buildCodebaseIndex(root);
    // Backdate built_at so current state looks "old"
    idx.built_at = new Date(Date.now() - 5000).toISOString();

    // Add a file — updates dir mtime
    writeFile(root, 'src/services/b.ts');
    expect(hasStructuralChanges(idx, root)).toBe(true);
  });

  it('returns true when a new sibling module appears', () => {
    writeFile(root, 'src/services/a.ts');
    const idx = buildCodebaseIndex(root);
    idx.built_at = new Date(Date.now() - 5000).toISOString();

    // New module dir — parent (src/) mtime changes
    writeFile(root, 'src/utils/helpers.ts');
    expect(hasStructuralChanges(idx, root)).toBe(true);
  });

  it('returns true when a module dir is removed', () => {
    writeFile(root, 'src/services/a.ts');
    writeFile(root, 'src/utils/b.ts');
    const idx = buildCodebaseIndex(root);

    fs.rmSync(path.join(root, 'src/utils'), { recursive: true });
    expect(hasStructuralChanges(idx, root)).toBe(true);
  });

  it('returns true when a sampled file content changes', () => {
    writeFile(root, 'src/services/a.ts', "import { x } from '../utils/x.js';");
    writeFile(root, 'src/utils/x.ts', 'export const x = 1;');
    const idx = buildCodebaseIndex(root);
    // Backdate built_at so dir mtimes don't trigger
    idx.built_at = new Date(Date.now() + 10000).toISOString();

    // Edit file content (no file add/delete — dir mtime unchanged)
    // Need a small delay so mtime actually differs
    const filePath = path.join(root, 'src/services/a.ts');
    const oldMtime = fs.statSync(filePath).mtimeMs;
    // Manually set the recorded mtime to something older to simulate a content change
    const relFile = path.relative(root, filePath);
    idx.sampled_file_mtimes[relFile] = oldMtime - 1000;

    expect(hasStructuralChanges(idx, root)).toBe(true);
  });

  it('returns false when sampled files are unchanged', () => {
    writeFile(root, 'src/services/a.ts', 'export const x = 1;');
    const idx = buildCodebaseIndex(root);
    // Backdate built_at so only sampled file mtimes matter
    idx.built_at = new Date(Date.now() + 10000).toISOString();

    // No changes — sampled file mtimes should match
    expect(hasStructuralChanges(idx, root)).toBe(false);
  });
});
