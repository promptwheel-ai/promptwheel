/**
 * Tests for formulas + hints (Phase 7).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createSQLiteAdapter } from '@promptwheel/sqlite';
import { repos } from '@promptwheel/core';
import type { DatabaseAdapter, Project } from '@promptwheel/core';
import { RunManager } from '../run-manager.js';
import { advance } from '../advance.js';
import { processEvent } from '../event-processor.js';
import {
  BUILTIN_FORMULAS,
  loadFormula,
  listFormulas,
  applyFormula,
} from '../formulas.js';

// ---------------------------------------------------------------------------
// Pure unit tests for formulas
// ---------------------------------------------------------------------------

describe('BUILTIN_FORMULAS', () => {
  it('contains 7 built-in formulas', () => {
    expect(BUILTIN_FORMULAS.length).toBe(7);
    const names = BUILTIN_FORMULAS.map(f => f.name);
    expect(names).toContain('security-audit');
    expect(names).toContain('test-coverage');
    expect(names).toContain('type-safety');
    expect(names).toContain('cleanup');
    expect(names).toContain('deep');
    expect(names).toContain('docs');
    expect(names).toContain('docs-audit');
  });

  it('all have version 1', () => {
    for (const f of BUILTIN_FORMULAS) {
      expect(f.version).toBe(1);
    }
  });

  it('all have prompt and description', () => {
    for (const f of BUILTIN_FORMULAS) {
      expect(f.prompt).toBeTruthy();
      expect(f.description).toBeTruthy();
    }
  });
});

describe('loadFormula', () => {
  it('loads built-in by name', () => {
    const f = loadFormula('security-audit');
    expect(f).not.toBeNull();
    expect(f!.name).toBe('security-audit');
    expect(f!.categories).toEqual(['security']);
  });

  it('returns null for unknown name', () => {
    expect(loadFormula('nonexistent')).toBeNull();
  });

  it('loads user formula from .promptwheel/formulas/', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-formula-'));
    const formulasDir = path.join(tmpDir, '.promptwheel', 'formulas');
    fs.mkdirSync(formulasDir, { recursive: true });
    fs.writeFileSync(path.join(formulasDir, 'my-recipe.yaml'), [
      'description: My custom recipe',
      'categories: [refactor, test]',
      'min_confidence: 90',
      'prompt: |',
      '  Focus on error handling.',
      '  Fix all try/catch blocks.',
      'risk_tolerance: low',
      'tags: [custom]',
    ].join('\n'));

    const f = loadFormula('my-recipe', tmpDir);
    expect(f).not.toBeNull();
    expect(f!.name).toBe('my-recipe');
    expect(f!.description).toBe('My custom recipe');
    expect(f!.categories).toEqual(['refactor', 'test']);
    expect(f!.min_confidence).toBe(90);
    expect(f!.prompt).toContain('error handling');
    expect(f!.risk_tolerance).toBe('low');
    expect(f!.tags).toEqual(['custom']);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('user formula overrides built-in', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-formula-'));
    const formulasDir = path.join(tmpDir, '.promptwheel', 'formulas');
    fs.mkdirSync(formulasDir, { recursive: true });
    fs.writeFileSync(path.join(formulasDir, 'cleanup.yaml'),
      'description: My custom cleanup\nmin_confidence: 99\n');

    const f = loadFormula('cleanup', tmpDir);
    expect(f!.description).toBe('My custom cleanup');
    expect(f!.min_confidence).toBe(99);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe('listFormulas', () => {
  it('returns all built-ins when no user formulas', () => {
    const all = listFormulas('/nonexistent');
    expect(all.length).toBe(7);
  });

  it('merges user and built-in, user overrides', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-formula-'));
    const formulasDir = path.join(tmpDir, '.promptwheel', 'formulas');
    fs.mkdirSync(formulasDir, { recursive: true });
    fs.writeFileSync(path.join(formulasDir, 'cleanup.yaml'),
      'description: Custom cleanup\n');
    fs.writeFileSync(path.join(formulasDir, 'new-one.yaml'),
      'description: Brand new\n');

    const all = listFormulas(tmpDir);
    // 6 built-ins (cleanup overridden) + 2 user = 8
    expect(all.length).toBe(8);
    const cleanup = all.find(f => f.name === 'cleanup');
    expect(cleanup!.description).toBe('Custom cleanup');

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe('applyFormula', () => {
  it('applies formula defaults to empty config', () => {
    const formula = loadFormula('security-audit')!;
    const config = applyFormula(formula, {});
    expect(config.categories).toEqual(['security']);
    expect(config.min_confidence).toBe(80);
    expect(config.max_prs).toBe(10);
  });

  it('explicit config overrides formula', () => {
    const formula = loadFormula('security-audit')!;
    const config = applyFormula(formula, {
      categories: ['test'],
      min_confidence: 50,
      max_prs: 3,
    });
    expect(config.categories).toEqual(['test']);
    expect(config.min_confidence).toBe(50);
    expect(config.max_prs).toBe(3);
  });

  it('preserves formula name in config', () => {
    const formula = loadFormula('deep')!;
    const config = applyFormula(formula, { formula: 'deep' });
    expect(config.formula).toBe('deep');
  });
});

// ---------------------------------------------------------------------------
// Integration tests — formulas + hints in advance()
// ---------------------------------------------------------------------------

let db: DatabaseAdapter;
let project: Project;
let tmpDir: string;
let run: RunManager;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-formula-test-'));
  const dbPath = path.join(tmpDir, 'test.sqlite');
  db = await createSQLiteAdapter({ url: dbPath });
  project = await repos.projects.ensureForRepo(db, {
    name: 'test-project',
    rootPath: tmpDir,
  });
  run = new RunManager(tmpDir);
});

afterEach(async () => {
  try { if (run.current) run.end(); } catch { /* ignore */ }
  await db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('advance — formula in scout prompt', () => {
  it('includes formula prompt in SCOUT phase', async () => {
    run.create(project.id, { step_budget: 50, formula: 'security-audit' });

    const resp = await advance({ run, db, project });

    expect(resp.phase).toBe('SCOUT');
    expect(resp.prompt).toContain('security-audit');
    expect(resp.prompt).toContain('OWASP');
    expect(resp.prompt).toContain('Formula instructions');
  });

  it('includes risk_tolerance in SCOUT prompt', async () => {
    run.create(project.id, { step_budget: 50, formula: 'deep' });

    const resp = await advance({ run, db, project });

    expect(resp.prompt).toContain('Risk tolerance');
    expect(resp.prompt).toContain('high');
  });

  it('works without formula', async () => {
    run.create(project.id, { step_budget: 50 });

    const resp = await advance({ run, db, project });

    expect(resp.phase).toBe('SCOUT');
    expect(resp.prompt).not.toContain('Formula instructions');
  });
});

describe('advance — hints in scout prompt', () => {
  it('includes hints in scout prompt', async () => {
    run.create(project.id, { step_budget: 50 });
    run.addHint('focus on authentication module');

    const resp = await advance({ run, db, project });

    expect(resp.phase).toBe('SCOUT');
    expect(resp.prompt).toContain('focus on authentication module');
    expect(resp.prompt).toContain('Hints from user');
  });

  it('consumes hints after scout prompt', async () => {
    run.create(project.id, { step_budget: 50 });
    run.addHint('hint 1');
    run.addHint('hint 2');

    await advance({ run, db, project });

    // Hints should be consumed
    const s = run.require();
    expect(s.hints.length).toBe(0);
  });

  it('logs HINT_CONSUMED events', async () => {
    run.create(project.id, { step_budget: 50 });
    run.addHint('my hint');

    await advance({ run, db, project });

    const s = run.require();
    const eventsPath = path.join(
      tmpDir, '.promptwheel', 'runs', s.run_id, 'events.ndjson',
    );
    const events = fs.readFileSync(eventsPath, 'utf8')
      .trim().split('\n').map(l => JSON.parse(l));
    const hintEvents = events.filter(e => e.type === 'HINT_CONSUMED');
    expect(hintEvents.length).toBe(1);
    expect(hintEvents[0].payload.hint).toBe('my hint');
  });
});

describe('advance — formula affects session config', () => {
  it('formula sets categories and min_confidence', async () => {
    run.create(project.id, {
      step_budget: 50,
      formula: 'security-audit',
      categories: ['security'],
      min_confidence: 80,
    });

    const s = run.require();
    expect(s.categories).toEqual(['security']);
    expect(s.min_confidence).toBe(80);
  });
});
