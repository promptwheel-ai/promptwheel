/**
 * Tests for detectQaCommands metadata fallback (Feature 1).
 *
 * Uses real temp directories (like project-metadata.test.ts) because
 * detectQaCommands now calls detectProjectMetadata which needs real files.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { detectQaCommands } from '../lib/solo-config.js';

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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'detect-qa-meta-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Rust projects
// ---------------------------------------------------------------------------

describe('Rust project detection', () => {
  it('detects cargo test and clippy for Rust project', () => {
    mkfile('Cargo.toml', '[package]\nname = "myapp"\n');

    const cmds = detectQaCommands(tmpDir);

    const test = cmds.find(c => c.name === 'test');
    expect(test).toBeDefined();
    expect(test!.cmd).toBe('cargo test');
    expect(test!.source).toBe('detected');

    const lint = cmds.find(c => c.name === 'lint');
    expect(lint).toBeDefined();
    expect(lint!.cmd).toBe('cargo clippy -- -D warnings');
    expect(lint!.source).toBe('detected');
  });
});

// ---------------------------------------------------------------------------
// Python projects
// ---------------------------------------------------------------------------

describe('Python project detection', () => {
  it('detects pytest for Python project', () => {
    mkfile('pyproject.toml', '[tool.pytest]\n');

    const cmds = detectQaCommands(tmpDir);

    const test = cmds.find(c => c.name === 'test');
    expect(test).toBeDefined();
    expect(test!.cmd).toBe('pytest');
  });

  it('detects ruff linter', () => {
    mkfile('pyproject.toml', '[tool.ruff]\nline-length = 100\n');

    const cmds = detectQaCommands(tmpDir);

    const lint = cmds.find(c => c.name === 'lint');
    expect(lint).toBeDefined();
    expect(lint!.cmd).toBe('ruff check .');
  });

  it('detects mypy type checker', () => {
    mkfile('pyproject.toml', '[tool.mypy]\n');

    const cmds = detectQaCommands(tmpDir);

    const tc = cmds.find(c => c.name === 'typecheck');
    expect(tc).toBeDefined();
    expect(tc!.cmd).toBe('mypy .');
  });
});

// ---------------------------------------------------------------------------
// Go projects
// ---------------------------------------------------------------------------

describe('Go project detection', () => {
  it('detects go test for Go project', () => {
    mkfile('go.mod', 'module example.com/app\n\ngo 1.21\n');

    const cmds = detectQaCommands(tmpDir);

    const test = cmds.find(c => c.name === 'test');
    expect(test).toBeDefined();
    expect(test!.cmd).toBe('go test ./...');
  });
});

// ---------------------------------------------------------------------------
// Node dedup
// ---------------------------------------------------------------------------

describe('Node dedup — metadata does not override package.json', () => {
  it('does not add duplicate test command when package.json has test script', () => {
    mkfile('package.json', JSON.stringify({
      devDependencies: { vitest: '^1.0.0' },
      scripts: { test: 'vitest run' },
    }));

    const cmds = detectQaCommands(tmpDir);

    const testCmds = cmds.filter(c => c.name === 'test');
    expect(testCmds).toHaveLength(1);
    expect(testCmds[0].cmd).toBe('npm run test');
    expect(testCmds[0].source).toBe('package.json');
  });

  it('does not add duplicate lint command when package.json has lint script', () => {
    mkfile('package.json', JSON.stringify({
      devDependencies: { eslint: '^8.0.0' },
      scripts: { lint: 'eslint .' },
    }));

    const cmds = detectQaCommands(tmpDir);

    const lintCmds = cmds.filter(c => c.name === 'lint');
    expect(lintCmds).toHaveLength(1);
    expect(lintCmds[0].cmd).toBe('npm run lint');
  });

  it('does not add duplicate typecheck when package.json has typecheck script', () => {
    mkfile('package.json', JSON.stringify({
      devDependencies: { typescript: '^5.0.0' },
      scripts: { typecheck: 'tsc --noEmit' },
    }));

    const cmds = detectQaCommands(tmpDir);

    const tcCmds = cmds.filter(c => c.name === 'typecheck');
    expect(tcCmds).toHaveLength(1);
    expect(tcCmds[0].cmd).toBe('npm run typecheck');
  });
});

// ---------------------------------------------------------------------------
// Sort order
// ---------------------------------------------------------------------------

describe('sort order with metadata-detected commands', () => {
  it('sorts typecheck before lint before test', () => {
    mkfile('pyproject.toml', '[tool.pytest]\n[tool.ruff]\n[tool.mypy]\n');

    const cmds = detectQaCommands(tmpDir);

    const names = cmds.map(c => c.name);
    const tcIdx = names.indexOf('typecheck');
    const lintIdx = names.indexOf('lint');
    const testIdx = names.indexOf('test');

    expect(tcIdx).toBeLessThan(lintIdx);
    expect(lintIdx).toBeLessThan(testIdx);
  });
});

// ---------------------------------------------------------------------------
// Empty project
// ---------------------------------------------------------------------------

describe('empty project', () => {
  it('returns empty array for project with no recognizable files', () => {
    mkfile('random.txt', 'hello');

    const cmds = detectQaCommands(tmpDir);
    expect(cmds).toEqual([]);
  });
});
