import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { batchFiles, batchFilesByTokens, estimateTokens, scanFiles } from '../scout/scanner.js';
import type { ScannedFile } from '../scout/scanner.js';

function makeFile(p: string, content = 'x', size = 1): ScannedFile {
  return { path: p, content, size };
}

describe('batchFiles', () => {
  it('with empty array returns empty array', () => {
    expect(batchFiles([])).toEqual([]);
  });

  it('with fewer files than batch size returns single batch', () => {
    const files = [makeFile('a.ts'), makeFile('b.ts')];
    const batches = batchFiles(files);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(2);
  });

  it('with exact multiple returns correct number of batches', () => {
    const files = [makeFile('a'), makeFile('b'), makeFile('c'), makeFile('d'), makeFile('e'), makeFile('f')];
    const batches = batchFiles(files, 3);
    expect(batches).toHaveLength(2);
  });

  it('with remainder creates extra batch', () => {
    const files = [makeFile('a'), makeFile('b'), makeFile('c'), makeFile('d')];
    const batches = batchFiles(files, 3);
    expect(batches).toHaveLength(2);
    expect(batches[1]).toHaveLength(1);
  });

  it('default batch size is 3', () => {
    const files = Array.from({ length: 7 }, (_, i) => makeFile(`f${i}`));
    const batches = batchFiles(files);
    expect(batches).toHaveLength(3);
    expect(batches[0]).toHaveLength(3);
    expect(batches[1]).toHaveLength(3);
    expect(batches[2]).toHaveLength(1);
  });

  it('with custom batch size', () => {
    const files = Array.from({ length: 5 }, (_, i) => makeFile(`f${i}`));
    const batches = batchFiles(files, 2);
    expect(batches).toHaveLength(3);
  });

  it('preserves file order', () => {
    const files = [makeFile('a'), makeFile('b'), makeFile('c'), makeFile('d')];
    const batches = batchFiles(files, 2);
    expect(batches[0][0].path).toBe('a');
    expect(batches[0][1].path).toBe('b');
    expect(batches[1][0].path).toBe('c');
    expect(batches[1][1].path).toBe('d');
  });

  it('each batch has correct files', () => {
    const files = [makeFile('x'), makeFile('y'), makeFile('z')];
    const batches = batchFiles(files, 2);
    expect(batches[0]).toEqual([files[0], files[1]]);
    expect(batches[1]).toEqual([files[2]]);
  });

  it('with batch size 1 creates one batch per file', () => {
    const files = [makeFile('a'), makeFile('b'), makeFile('c')];
    const batches = batchFiles(files, 1);
    expect(batches).toHaveLength(3);
    batches.forEach((b) => expect(b).toHaveLength(1));
  });

  it('with batch size larger than array returns single batch', () => {
    const files = [makeFile('a'), makeFile('b')];
    const batches = batchFiles(files, 100);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(2);
  });
});

describe('scanFiles', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scanner-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeFile(relPath: string, content: string) {
    const full = path.join(tmpDir, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }

  it('finds .ts files with include pattern', () => {
    writeFile('src/a.ts', 'export const a = 1;');
    writeFile('src/b.ts', 'export const b = 2;');
    writeFile('src/c.js', 'module.exports = {}');
    const files = scanFiles({ cwd: tmpDir, include: ['**/*.ts'] });
    expect(files).toHaveLength(2);
    expect(files.every((f) => f.path.endsWith('.ts'))).toBe(true);
  });

  it('excludes node_modules by default', () => {
    writeFile('src/a.ts', 'ok');
    writeFile('node_modules/pkg/index.ts', 'skip');
    const files = scanFiles({ cwd: tmpDir, include: ['**/*.ts'] });
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('src/a.ts');
  });

  it('respects maxFiles limit', () => {
    for (let i = 0; i < 10; i++) {
      writeFile(`src/f${i}.ts`, `const x = ${i};`);
    }
    const files = scanFiles({ cwd: tmpDir, include: ['**/*.ts'], maxFiles: 3 });
    expect(files).toHaveLength(3);
  });

  it('respects maxFileSize limit', () => {
    writeFile('small.ts', 'ok');
    writeFile('big.ts', 'x'.repeat(500));
    const files = scanFiles({ cwd: tmpDir, include: ['**/*.ts'], maxFileSize: 100 });
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('small.ts');
  });

  it('returns empty for non-existent directory', () => {
    const files = scanFiles({ cwd: path.join(tmpDir, 'nope'), include: ['**/*.ts'] });
    expect(files).toEqual([]);
  });

  it('with exclude patterns skips matching files', () => {
    writeFile('src/a.ts', 'ok');
    writeFile('src/b.generated.ts', 'skip');
    const files = scanFiles({ cwd: tmpDir, include: ['**/*.ts'], exclude: ['*.generated.ts'] });
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('src/a.ts');
  });

  it('returns content and size for each file', () => {
    writeFile('src/hello.ts', 'hello world');
    const files = scanFiles({ cwd: tmpDir, include: ['**/*.ts'] });
    expect(files).toHaveLength(1);
    expect(files[0].content).toBe('hello world');
    expect(files[0].size).toBe(11);
  });
});

describe('estimateTokens', () => {
  it('returns ~content.length/4', () => {
    expect(estimateTokens('abcdefgh')).toBe(2);
    expect(estimateTokens('a')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2); // ceil(5/4)
    expect(estimateTokens('')).toBe(0);
  });
});

describe('batchFilesByTokens', () => {
  it('empty input returns empty array', () => {
    expect(batchFilesByTokens([])).toEqual([]);
  });

  it('small files pack together up to budget', () => {
    // Each file ~10 tokens (40 chars)
    const files = Array.from({ length: 5 }, (_, i) =>
      makeFile(`f${i}.ts`, 'x'.repeat(40), 40),
    );
    // Budget of 30 tokens fits 3 files (10+10+10=30), then 2 in next batch
    const batches = batchFilesByTokens(files, 30);
    expect(batches).toHaveLength(2);
    expect(batches[0]).toHaveLength(3);
    expect(batches[1]).toHaveLength(2);
  });

  it('large file gets its own batch', () => {
    const small = makeFile('small.ts', 'x'.repeat(40), 40); // 10 tokens
    const large = makeFile('large.ts', 'x'.repeat(400), 400); // 100 tokens
    const batches = batchFilesByTokens([small, large], 50);
    expect(batches).toHaveLength(2);
    expect(batches[0]).toEqual([small]);
    expect(batches[1]).toEqual([large]);
  });

  it('flushes current batch before oversized file', () => {
    const a = makeFile('a.ts', 'x'.repeat(20), 20); // 5 tokens
    const big = makeFile('big.ts', 'x'.repeat(200), 200); // 50 tokens
    const b = makeFile('b.ts', 'x'.repeat(20), 20); // 5 tokens
    const batches = batchFilesByTokens([a, big, b], 30);
    expect(batches).toHaveLength(3);
    expect(batches[0]).toEqual([a]);
    expect(batches[1]).toEqual([big]);
    expect(batches[2]).toEqual([b]);
  });

  it('mix of sizes produces balanced batches', () => {
    const files = [
      makeFile('tiny.ts', 'x'.repeat(4), 4),     // 1 token
      makeFile('small.ts', 'x'.repeat(40), 40),   // 10 tokens
      makeFile('med.ts', 'x'.repeat(80), 80),     // 20 tokens
      makeFile('big.ts', 'x'.repeat(120), 120),   // 30 tokens
    ];
    // Budget 30: tiny(1)+small(10)+med(20)=31 > 30, so tiny+small then med, then big
    const batches = batchFilesByTokens(files, 30);
    expect(batches).toHaveLength(3);
    expect(batches[0].map(f => f.path)).toEqual(['tiny.ts', 'small.ts']);
    expect(batches[1].map(f => f.path)).toEqual(['med.ts']);
    expect(batches[2].map(f => f.path)).toEqual(['big.ts']);
  });

  it('single file within budget returns one batch', () => {
    const f = makeFile('a.ts', 'hello', 5);
    const batches = batchFilesByTokens([f], 100);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toEqual([f]);
  });
});
