import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { loadGuidelines } from '../lib/guidelines.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'guidelines-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// loadGuidelines — disabled
// ---------------------------------------------------------------------------

describe('loadGuidelines — disabled', () => {
  it('returns null when customPath is false', () => {
    const result = loadGuidelines(tmpDir, { customPath: false });
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// loadGuidelines — custom path
// ---------------------------------------------------------------------------

describe('loadGuidelines — custom path', () => {
  it('reads guidelines from a custom path', () => {
    const customFile = 'docs/MY_GUIDELINES.md';
    const fullPath = path.join(tmpDir, customFile);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, '# Custom Guidelines\nDo things right.', 'utf-8');

    const result = loadGuidelines(tmpDir, { customPath: customFile });
    expect(result).not.toBeNull();
    expect(result!.content).toBe('# Custom Guidelines\nDo things right.');
    expect(result!.source).toBe(customFile);
    expect(result!.loadedAt).toBeGreaterThan(0);
  });

  it('returns null when custom path file does not exist', () => {
    const result = loadGuidelines(tmpDir, { customPath: 'missing.md' });
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// loadGuidelines — default search
// ---------------------------------------------------------------------------

describe('loadGuidelines — default search', () => {
  it('finds CLAUDE.md for claude backend', () => {
    fs.writeFileSync(path.join(tmpDir, 'CLAUDE.md'), '# Claude Guide', 'utf-8');

    const result = loadGuidelines(tmpDir, { backend: 'claude' });
    expect(result).not.toBeNull();
    expect(result!.source).toBe('CLAUDE.md');
    expect(result!.content).toBe('# Claude Guide');
  });

  it('finds AGENTS.md for codex backend', () => {
    fs.writeFileSync(path.join(tmpDir, 'AGENTS.md'), '# Codex Agents Guide', 'utf-8');

    const result = loadGuidelines(tmpDir, { backend: 'codex' });
    expect(result).not.toBeNull();
    expect(result!.source).toBe('AGENTS.md');
    expect(result!.content).toBe('# Codex Agents Guide');
  });

  it('prefers primary path over fallback', () => {
    // For claude backend, primary is CLAUDE.md, fallback includes AGENTS.md
    fs.writeFileSync(path.join(tmpDir, 'CLAUDE.md'), '# Primary', 'utf-8');
    fs.writeFileSync(path.join(tmpDir, 'AGENTS.md'), '# Fallback', 'utf-8');

    const result = loadGuidelines(tmpDir, { backend: 'claude' });
    expect(result).not.toBeNull();
    expect(result!.source).toBe('CLAUDE.md');
    expect(result!.content).toBe('# Primary');
  });

  it('falls back to secondary path when primary absent', () => {
    // For codex backend, primary is AGENTS.md. If absent, fallback includes CLAUDE.md
    fs.writeFileSync(path.join(tmpDir, 'CLAUDE.md'), '# Fallback Claude', 'utf-8');

    const result = loadGuidelines(tmpDir, { backend: 'codex' });
    expect(result).not.toBeNull();
    expect(result!.source).toBe('CLAUDE.md');
    expect(result!.content).toBe('# Fallback Claude');
  });

  it('returns null when no guidelines files exist and autoCreate disabled', () => {
    const result = loadGuidelines(tmpDir, { autoCreate: false });
    expect(result).toBeNull();
  });

  it('returns null with empty options on empty directory', () => {
    const result = loadGuidelines(tmpDir);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// loadGuidelines — autoCreate
// ---------------------------------------------------------------------------

describe('loadGuidelines — autoCreate', () => {
  it('generates baseline CLAUDE.md for claude backend', () => {
    const result = loadGuidelines(tmpDir, { autoCreate: true, backend: 'claude' });
    expect(result).not.toBeNull();
    expect(result!.source).toBe('CLAUDE.md');
    expect(result!.content).toBeTruthy();
    // Verify file was actually written
    expect(fs.existsSync(path.join(tmpDir, 'CLAUDE.md'))).toBe(true);
  });

  it('generates baseline AGENTS.md for codex backend', () => {
    const result = loadGuidelines(tmpDir, { autoCreate: true, backend: 'codex' });
    expect(result).not.toBeNull();
    expect(result!.source).toBe('AGENTS.md');
    expect(fs.existsSync(path.join(tmpDir, 'AGENTS.md'))).toBe(true);
  });

  it('includes project name from directory in generated content', () => {
    const result = loadGuidelines(tmpDir, { autoCreate: true });
    expect(result).not.toBeNull();
    // The project name is derived from path.basename(repoRoot)
    const projectName = path.basename(tmpDir);
    expect(result!.content).toContain(projectName);
  });

  it('picks up package.json metadata when available', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({
        name: 'my-project',
        description: 'A test project',
        scripts: { test: 'vitest run', lint: 'eslint .' },
        devDependencies: { typescript: '^5.0.0' },
      }),
      'utf-8',
    );

    const result = loadGuidelines(tmpDir, { autoCreate: true });
    expect(result).not.toBeNull();
    // Generated content should reflect the project metadata
    expect(result!.content).toBeTruthy();
    expect(result!.content.length).toBeGreaterThan(50);
  });

  it('does not overwrite an existing file', () => {
    // Write a CLAUDE.md manually
    fs.writeFileSync(path.join(tmpDir, 'CLAUDE.md'), '# Existing', 'utf-8');

    // loadGuidelines should find the existing file via default search,
    // not trigger autoCreate
    const result = loadGuidelines(tmpDir, { autoCreate: true, backend: 'claude' });
    expect(result).not.toBeNull();
    expect(result!.content).toBe('# Existing');
  });
});
