import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  loadFormula,
  listFormulas,
  applyFormula,
  BUILTIN_FORMULAS,
  type Formula,
} from '../lib/formulas.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

function formulasDir(): string {
  return path.join(tmpDir, '.promptwheel', 'formulas');
}

function writeUserFormula(name: string, yaml: string): void {
  fs.mkdirSync(formulasDir(), { recursive: true });
  fs.writeFileSync(path.join(formulasDir(), `${name}.yaml`), yaml, 'utf-8');
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'formulas-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// loadFormula
// ---------------------------------------------------------------------------

describe('loadFormula', () => {
  it('returns a builtin formula by name', () => {
    const formula = loadFormula('security-audit', tmpDir);
    expect(formula).not.toBeNull();
    expect(formula!.name).toBe('security-audit');
    expect(formula!.categories).toContain('security');
  });

  it('returns null for unknown formula name', () => {
    expect(loadFormula('nonexistent-formula', tmpDir)).toBeNull();
  });

  it('loads user formula from .yaml file', () => {
    writeUserFormula('my-formula', [
      'description: My custom formula',
      'scope: lib/**',
      'categories: fix, test',
      'min_confidence: 60',
      'prompt: Find bugs',
      'max_prs: 3',
      'tags: custom, local',
    ].join('\n'));

    const formula = loadFormula('my-formula', tmpDir);
    expect(formula).not.toBeNull();
    expect(formula!.name).toBe('my-formula');
    expect(formula!.description).toBe('My custom formula');
    expect(formula!.scope).toBe('lib/**');
    expect(formula!.categories).toEqual(['fix', 'test']);
    expect(formula!.minConfidence).toBe(60);
    expect(formula!.prompt).toBe('Find bugs');
    expect(formula!.maxPrs).toBe(3);
    expect(formula!.tags).toEqual(['custom', 'local']);
  });

  it('loads user formula from .yml file', () => {
    fs.mkdirSync(formulasDir(), { recursive: true });
    fs.writeFileSync(
      path.join(formulasDir(), 'alt.yml'),
      'description: Alt formula\ncategories: docs',
      'utf-8',
    );

    const formula = loadFormula('alt', tmpDir);
    expect(formula).not.toBeNull();
    expect(formula!.name).toBe('alt');
    expect(formula!.description).toBe('Alt formula');
  });

  it('prefers .yaml over .yml when both exist', () => {
    fs.mkdirSync(formulasDir(), { recursive: true });
    fs.writeFileSync(
      path.join(formulasDir(), 'both.yaml'),
      'description: From yaml',
      'utf-8',
    );
    fs.writeFileSync(
      path.join(formulasDir(), 'both.yml'),
      'description: From yml',
      'utf-8',
    );

    const formula = loadFormula('both', tmpDir);
    expect(formula!.description).toBe('From yaml');
  });

  it('user formula overrides builtin with same name', () => {
    writeUserFormula('security-audit', [
      'description: Custom security audit',
      'categories: security',
      'min_confidence: 95',
    ].join('\n'));

    const formula = loadFormula('security-audit', tmpDir);
    expect(formula).not.toBeNull();
    expect(formula!.description).toBe('Custom security audit');
    expect(formula!.minConfidence).toBe(95);
  });

  it('returns null when formulas directory does not exist', () => {
    // tmpDir has no .promptwheel/formulas/
    expect(loadFormula('anything', tmpDir)).toBeNull();
    // Falls back to builtins — 'anything' is not a builtin either
  });

  it('returns formula with defaults for malformed YAML (parser is lenient)', () => {
    writeUserFormula('bad', ':::not valid yaml:::');

    // parseSimpleYaml is lenient — doesn't throw on garbage, returns sparse result
    const formula = loadFormula('bad', tmpDir);
    expect(formula).not.toBeNull();
    expect(formula!.name).toBe('bad');
    expect(formula!.description).toBe('Formula: bad');
    expect(formula!.categories).toBeUndefined();
  });

  it('uses default description when YAML has no description', () => {
    writeUserFormula('nodesc', 'scope: src/**');

    const formula = loadFormula('nodesc', tmpDir);
    expect(formula).not.toBeNull();
    expect(formula!.description).toBe('Formula: nodesc');
  });
});

// ---------------------------------------------------------------------------
// listFormulas
// ---------------------------------------------------------------------------

describe('listFormulas', () => {
  it('returns all builtins when no user formulas exist', () => {
    const formulas = listFormulas(tmpDir);
    expect(formulas.length).toBe(BUILTIN_FORMULAS.length);
    const names = formulas.map(f => f.name);
    for (const builtin of BUILTIN_FORMULAS) {
      expect(names).toContain(builtin.name);
    }
  });

  it('includes user formulas alongside builtins', () => {
    writeUserFormula('custom', 'description: Custom formula');

    const formulas = listFormulas(tmpDir);
    const names = formulas.map(f => f.name);
    expect(names).toContain('custom');
    // All builtins should still be present
    for (const builtin of BUILTIN_FORMULAS) {
      expect(names).toContain(builtin.name);
    }
    expect(formulas.length).toBe(BUILTIN_FORMULAS.length + 1);
  });

  it('user formula with same name replaces builtin', () => {
    writeUserFormula('cleanup', [
      'description: My cleanup',
      'categories: refactor',
    ].join('\n'));

    const formulas = listFormulas(tmpDir);
    const cleanup = formulas.filter(f => f.name === 'cleanup');
    // Should be exactly one 'cleanup' entry (user replaces builtin)
    expect(cleanup).toHaveLength(1);
    expect(cleanup[0].description).toBe('My cleanup');
    // Total should be same as builtins (replaced, not added)
    expect(formulas.length).toBe(BUILTIN_FORMULAS.length);
  });

  it('handles multiple user formulas overriding multiple builtins', () => {
    writeUserFormula('cleanup', 'description: Custom cleanup');
    fs.writeFileSync(
      path.join(formulasDir(), 'deep.yaml'),
      'description: Custom deep',
      'utf-8',
    );

    const formulas = listFormulas(tmpDir);
    // Two builtins replaced → same total
    expect(formulas.length).toBe(BUILTIN_FORMULAS.length);

    const cleanupFormula = formulas.find(f => f.name === 'cleanup');
    const deepFormula = formulas.find(f => f.name === 'deep');
    expect(cleanupFormula!.description).toBe('Custom cleanup');
    expect(deepFormula!.description).toBe('Custom deep');
  });

  it('returns empty user list when .promptwheel/formulas does not exist', () => {
    // No formulas dir, but builtins should still work
    const formulas = listFormulas(tmpDir);
    expect(formulas.length).toBe(BUILTIN_FORMULAS.length);
  });
});

// ---------------------------------------------------------------------------
// applyFormula
// ---------------------------------------------------------------------------

describe('applyFormula', () => {
  const baseFormula: Formula = {
    name: 'test-formula',
    description: 'A test formula',
    scope: 'lib/**',
    categories: ['test', 'fix'],
    minConfidence: 70,
    maxPrs: 5,
    maxTime: '30m',
    exclude: ['vendor/**'],
    useRoadmap: true,
    focusAreas: ['auth', 'db'],
    prompt: 'Look for bugs in auth',
  };

  it('uses formula defaults when no CLI options provided', () => {
    const result = applyFormula(baseFormula, {});

    expect(result.scope).toBe('lib/**');
    expect(result.types).toEqual(['test', 'fix']);
    expect(result.minConfidence).toBe(70);
    expect(result.maxPrs).toBe(5);
    expect(result.maxTime).toBe('30m');
    expect(result.exclude).toEqual(['vendor/**']);
    expect(result.prompt).toBe('Look for bugs in auth');
    expect(result.focusAreas).toEqual(['auth', 'db']);
    // useRoadmap true → noRoadmap undefined
    expect(result.noRoadmap).toBeUndefined();
  });

  it('CLI options override formula defaults', () => {
    const result = applyFormula(baseFormula, {
      scope: 'src/**',
      types: ['security'],
      minConfidence: 90,
      maxPrs: 3,
      maxTime: '1h',
      exclude: ['dist/**'],
    });

    expect(result.scope).toBe('src/**');
    expect(result.types).toEqual(['security']);
    expect(result.minConfidence).toBe(90);
    expect(result.maxPrs).toBe(3);
    expect(result.maxTime).toBe('1h');
    expect(result.exclude).toEqual(['dist/**']);
    // prompt and focusAreas always come from formula
    expect(result.prompt).toBe('Look for bugs in auth');
    expect(result.focusAreas).toEqual(['auth', 'db']);
  });

  it('falls back to "src" when neither CLI nor formula has scope', () => {
    const minimal: Formula = { name: 'minimal', description: 'Minimal' };
    const result = applyFormula(minimal, {});
    expect(result.scope).toBe('src');
  });

  it('sets noRoadmap true when formula has useRoadmap=false', () => {
    const noRoadmapFormula: Formula = {
      ...baseFormula,
      useRoadmap: false,
    };
    const result = applyFormula(noRoadmapFormula, {});
    expect(result.noRoadmap).toBe(true);
  });

  it('CLI noRoadmap overrides formula useRoadmap', () => {
    const result = applyFormula(baseFormula, { noRoadmap: true });
    expect(result.noRoadmap).toBe(true);
  });

  it('handles undefined formula fields gracefully', () => {
    const sparse: Formula = { name: 'sparse', description: 'Sparse' };
    const result = applyFormula(sparse, {});

    expect(result.scope).toBe('src');
    expect(result.types).toBeUndefined();
    expect(result.minConfidence).toBeUndefined();
    expect(result.maxPrs).toBeUndefined();
    expect(result.maxTime).toBeUndefined();
    expect(result.exclude).toBeUndefined();
    expect(result.prompt).toBeUndefined();
    expect(result.focusAreas).toBeUndefined();
  });

  it('preserves minConfidence=0 from CLI (falsy but valid)', () => {
    const result = applyFormula(baseFormula, { minConfidence: 0 });
    expect(result.minConfidence).toBe(0);
  });

  it('preserves maxPrs=0 from CLI (falsy but valid)', () => {
    const result = applyFormula(baseFormula, { maxPrs: 0 });
    expect(result.maxPrs).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// BUILTIN_FORMULAS sanity checks
// ---------------------------------------------------------------------------

describe('BUILTIN_FORMULAS', () => {
  it('contains expected formula names', () => {
    const names = BUILTIN_FORMULAS.map(f => f.name);
    expect(names).toContain('security-audit');
    expect(names).toContain('test-coverage');
    expect(names).toContain('type-safety');
    expect(names).toContain('cleanup');
    expect(names).toContain('deep');
    expect(names).toContain('docs');
    expect(names).toContain('docs-audit');
  });

  it('all builtins have required fields', () => {
    for (const formula of BUILTIN_FORMULAS) {
      expect(formula.name).toBeTruthy();
      expect(formula.description).toBeTruthy();
      expect(formula.categories).toBeDefined();
      expect(formula.categories!.length).toBeGreaterThan(0);
    }
  });
});
