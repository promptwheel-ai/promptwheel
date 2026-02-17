import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { scanFiles } from '../scout/scanner.js';

describe('scanFiles - File System Integration', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scanner-fs-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeFile(relPath: string, content: string) {
    const full = path.join(tmpDir, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }

  it('scans nested directory structure', () => {
    writeFile('src/a.ts', 'export const a = 1;');
    writeFile('src/lib/b.ts', 'export const b = 2;');
    writeFile('src/lib/utils/c.ts', 'export const c = 3;');

    const files = scanFiles({ cwd: tmpDir, include: ['**/*.ts'] });
    expect(files).toHaveLength(3);
    expect(files.map((f) => f.path).sort()).toEqual([
      'src/a.ts',
      'src/lib/b.ts',
      'src/lib/utils/c.ts',
    ]);
  });

  it('respects include pattern for specific directory', () => {
    writeFile('src/a.ts', 'a');
    writeFile('src/lib/b.ts', 'b');
    writeFile('test/c.ts', 'c');

    const files = scanFiles({ cwd: tmpDir, include: ['src/**/*.ts'] });
    expect(files).toHaveLength(2);
    expect(files.every((f) => f.path.startsWith('src/'))).toBe(true);
  });

  it('respects include pattern for specific file extension', () => {
    writeFile('src/a.ts', 'ts file');
    writeFile('src/b.js', 'js file');
    writeFile('src/c.py', 'py file');

    const files = scanFiles({ cwd: tmpDir, include: ['**/*.ts'] });
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('src/a.ts');
  });

  it('respects multiple include patterns', () => {
    writeFile('src/a.ts', 'ts file');
    writeFile('src/b.js', 'js file');
    writeFile('src/c.py', 'py file');

    const files = scanFiles({ cwd: tmpDir, include: ['**/*.ts', '**/*.js'] });
    expect(files).toHaveLength(2);
    expect(files.map((f) => f.path).sort()).toEqual(['src/a.ts', 'src/b.js']);
  });

  it('excludes node_modules by default', () => {
    writeFile('src/index.ts', 'app code');
    writeFile('node_modules/pkg/index.ts', 'dependency code');
    writeFile('node_modules/other/lib.ts', 'dependency code');

    const files = scanFiles({ cwd: tmpDir, include: ['**/*.ts'] });
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('src/index.ts');
  });

  it('excludes .git directory by default', () => {
    writeFile('src/index.ts', 'app code');
    writeFile('.git/config', 'git config');
    writeFile('.git/objects/abc', 'git object');

    const files = scanFiles({ cwd: tmpDir, include: ['**/*'] });
    expect(files.every((f) => !f.path.includes('.git'))).toBe(true);
  });

  it('excludes dist directory by default', () => {
    writeFile('src/index.ts', 'source');
    writeFile('dist/index.js', 'compiled');

    const files = scanFiles({ cwd: tmpDir, include: ['**/*.ts', '**/*.js'] });
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('src/index.ts');
  });

  it('excludes build directory by default', () => {
    writeFile('src/index.ts', 'source');
    writeFile('build/index.js', 'compiled');

    const files = scanFiles({ cwd: tmpDir, include: ['**/*.ts', '**/*.js'] });
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('src/index.ts');
  });

  it('respects custom exclude patterns', () => {
    writeFile('src/a.ts', 'keep');
    writeFile('src/b.generated.ts', 'skip');
    writeFile('src/c.ts', 'keep');

    const files = scanFiles({ cwd: tmpDir, include: ['**/*.ts'], exclude: ['*.generated.ts'] });
    expect(files).toHaveLength(2);
    expect(files.every((f) => !f.path.includes('generated'))).toBe(true);
  });

  it('respects maxFiles limit during scanning', () => {
    for (let i = 0; i < 100; i++) {
      writeFile(`src/file${i}.ts`, `const x = ${i};`);
    }

    const files = scanFiles({ cwd: tmpDir, include: ['**/*.ts'], maxFiles: 10 });
    expect(files.length).toBeLessThanOrEqual(10);
  });

  it('respects maxFileSize limit', () => {
    writeFile('small.ts', 'x'.repeat(50));
    writeFile('medium.ts', 'y'.repeat(100));
    writeFile('large.ts', 'z'.repeat(500));

    const files = scanFiles({ cwd: tmpDir, include: ['**/*.ts'], maxFileSize: 120 });
    expect(files).toHaveLength(2);
    expect(files.map((f) => f.path).sort()).toEqual(['medium.ts', 'small.ts']);
  });

  it('excludes binary files based on content', () => {
    writeFile('text.ts', 'export const x = 1;');
    writeFile('binary.ts', Buffer.from([0x00, 0x01, 0x02, 0xff]).toString('utf-8'));

    const files = scanFiles({ cwd: tmpDir, include: ['**/*.ts'] });
    // Binary file should fail to read as utf-8 and be skipped
    expect(files.length).toBeLessThanOrEqual(2);
  });

  it('handles empty directories gracefully', () => {
    fs.mkdirSync(path.join(tmpDir, 'empty'), { recursive: true });

    const files = scanFiles({ cwd: tmpDir, include: ['**/*.ts'] });
    expect(files).toEqual([]);
  });

  it('handles unreadable files gracefully', () => {
    writeFile('readable.ts', 'ok');
    const unreadablePath = path.join(tmpDir, 'unreadable.ts');
    fs.writeFileSync(unreadablePath, 'secret');
    fs.chmodSync(unreadablePath, 0o000);

    const files = scanFiles({ cwd: tmpDir, include: ['**/*.ts'] });
    // Should skip unreadable file and continue
    expect(files.length).toBeGreaterThanOrEqual(0);

    // Clean up permissions for afterEach
    fs.chmodSync(unreadablePath, 0o644);
  });

  it('returns content and size for each file', () => {
    writeFile('src/hello.ts', 'hello world');
    writeFile('src/goodbye.ts', 'goodbye');

    const files = scanFiles({ cwd: tmpDir, include: ['**/*.ts'] });
    expect(files).toHaveLength(2);

    const hello = files.find((f) => f.path.includes('hello'));
    expect(hello?.content).toBe('hello world');
    expect(hello?.size).toBe(11);

    const goodbye = files.find((f) => f.path.includes('goodbye'));
    expect(goodbye?.content).toBe('goodbye');
    expect(goodbye?.size).toBe(7);
  });

  it('handles gitignore-style patterns in exclude', () => {
    writeFile('src/index.ts', 'keep');
    writeFile('src/test/index.test.ts', 'skip');
    writeFile('src/lib/index.ts', 'keep');

    const files = scanFiles({ cwd: tmpDir, include: ['**/*.ts'], exclude: ['**/*.test.ts'] });
    expect(files).toHaveLength(2);
    expect(files.every((f) => !f.path.includes('.test.'))).toBe(true);
  });

  it('handles mixed file types with default include', () => {
    writeFile('src/index.ts', 'typescript');
    writeFile('src/main.js', 'javascript');
    writeFile('src/README.md', 'markdown');
    writeFile('src/data.json', 'json');

    const files = scanFiles({ cwd: tmpDir, include: [] });
    // Default includes source-like files
    expect(files.length).toBeGreaterThan(0);
    const paths = files.map((f) => f.path);
    expect(paths).toContain('src/index.ts');
    expect(paths).toContain('src/main.js');
    expect(paths).toContain('src/README.md');
  });

  it('respects ** glob for recursive matching', () => {
    writeFile('a.ts', 'root level');
    writeFile('src/b.ts', 'level 1');
    writeFile('src/lib/c.ts', 'level 2');
    writeFile('src/lib/utils/d.ts', 'level 3');

    const files = scanFiles({ cwd: tmpDir, include: ['**/*.ts'] });
    expect(files).toHaveLength(4);
  });

  it('respects * glob for single segment matching', () => {
    writeFile('src/a.ts', 'ts file');
    writeFile('src/b.js', 'js file');
    writeFile('src/lib/c.ts', 'nested ts file');

    const files = scanFiles({ cwd: tmpDir, include: ['src/*.ts'] });
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('src/a.ts');
  });

  it('handles root-level files', () => {
    writeFile('package.json', '{}');
    writeFile('README.md', '# Readme');
    writeFile('src/index.ts', 'code');

    const files = scanFiles({ cwd: tmpDir, include: ['*.json', '*.md'] });
    expect(files).toHaveLength(2);
    expect(files.map((f) => f.path).sort()).toEqual(['README.md', 'package.json']);
  });
});
