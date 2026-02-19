/**
 * Tests for trajectory-generate pure functions: slugify() and validateAndBuild().
 */

import { describe, it, expect } from 'vitest';
import { slugify, validateAndBuild } from '../lib/trajectory-generate.js';

// ---------------------------------------------------------------------------
// slugify
// ---------------------------------------------------------------------------

describe('slugify', () => {
  it('converts basic text to lowercase kebab-case', () => {
    expect(slugify('Add Auth Module')).toBe('add-auth-module');
  });

  it('replaces special characters with hyphens', () => {
    expect(slugify('hello@world! #test')).toBe('hello-world-test');
  });

  it('collapses consecutive special characters into a single hyphen', () => {
    expect(slugify('foo---bar___baz')).toBe('foo-bar-baz');
  });

  it('strips leading and trailing hyphens', () => {
    expect(slugify('---leading-trailing---')).toBe('leading-trailing');
  });

  it('truncates to 60 characters', () => {
    const long = 'a'.repeat(100);
    expect(slugify(long).length).toBeLessThanOrEqual(60);
    expect(slugify(long)).toBe('a'.repeat(60));
  });

  it('truncates at 60 chars from longer slugified input', () => {
    // 59 a's + space + more text → "aaa...aaa-continuation-text-here" truncated to 60
    const input = 'a'.repeat(59) + ' continuation text here';
    const result = slugify(input);
    expect(result.length).toBeLessThanOrEqual(60);
  });

  it('handles empty string', () => {
    expect(slugify('')).toBe('');
  });

  it('handles string with only special characters', () => {
    expect(slugify('!@#$%^&*()')).toBe('');
  });

  it('preserves numbers', () => {
    expect(slugify('v2.0 release')).toBe('v2-0-release');
  });
});

// ---------------------------------------------------------------------------
// validateAndBuild
// ---------------------------------------------------------------------------

describe('validateAndBuild', () => {
  const validRaw = {
    name: 'test-trajectory',
    description: 'A test trajectory',
    steps: [
      {
        id: 'step-1',
        title: 'First step',
        description: 'Do the first thing',
        scope: 'src/**',
        categories: ['refactor'],
        acceptance_criteria: ['It works'],
        verification_commands: ['npm test'],
        depends_on: [],
      },
      {
        id: 'step-2',
        title: 'Second step',
        description: 'Do the second thing',
        depends_on: ['step-1'],
      },
    ],
  };

  it('builds a valid Trajectory from well-formed input', () => {
    const result = validateAndBuild(validRaw);
    expect(result.name).toBe('test-trajectory');
    expect(result.description).toBe('A test trajectory');
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0].id).toBe('step-1');
    expect(result.steps[0].title).toBe('First step');
    expect(result.steps[0].scope).toBe('src/**');
    expect(result.steps[0].categories).toEqual(['refactor']);
    expect(result.steps[0].acceptance_criteria).toEqual(['It works']);
    expect(result.steps[0].verification_commands).toEqual(['npm test']);
    expect(result.steps[0].depends_on).toEqual([]);
  });

  it('resolves depends_on references', () => {
    const result = validateAndBuild(validRaw);
    expect(result.steps[1].depends_on).toEqual(['step-1']);
  });

  it('throws on duplicate step IDs', () => {
    const raw = {
      name: 'dup',
      description: 'Duplicate IDs',
      steps: [
        { id: 'same-id', title: 'A', description: 'First' },
        { id: 'same-id', title: 'B', description: 'Second' },
      ],
    };
    expect(() => validateAndBuild(raw)).toThrow('Duplicate step ID: same-id');
  });

  it('throws on unknown depends_on reference', () => {
    const raw = {
      name: 'bad-dep',
      description: 'Bad dependency',
      steps: [
        { id: 'step-a', title: 'A', description: 'First', depends_on: ['nonexistent'] },
      ],
    };
    expect(() => validateAndBuild(raw)).toThrow('depends on unknown step "nonexistent"');
  });

  it('throws when step has empty ID', () => {
    const raw = {
      name: 'no-id',
      description: 'Missing ID',
      steps: [
        { id: '', title: 'No ID', description: 'Missing' },
      ],
    };
    expect(() => validateAndBuild(raw)).toThrow('Step missing ID');
  });

  it('sanitizes step IDs (removes non-alphanumeric chars, lowercases)', () => {
    const raw = {
      name: 'sanitize',
      description: 'Sanitize IDs',
      steps: [
        { id: 'Step_One!@#', title: 'Test', description: 'Test' },
      ],
    };
    const result = validateAndBuild(raw);
    expect(result.steps[0].id).toBe('step-one---');
  });

  it('handles optional fields gracefully', () => {
    const raw = {
      name: 'minimal',
      description: 'Minimal steps',
      steps: [
        { id: 'step-1', title: 'Minimal', description: 'Just basics' },
      ],
    };
    const result = validateAndBuild(raw);
    expect(result.steps[0].scope).toBeUndefined();
    expect(result.steps[0].categories).toBeUndefined();
    expect(result.steps[0].acceptance_criteria).toEqual([]);
    expect(result.steps[0].verification_commands).toEqual([]);
    expect(result.steps[0].depends_on).toEqual([]);
    expect(result.steps[0].measure).toBeUndefined();
  });

  it('parses measure field when all properties present', () => {
    const raw = {
      name: 'with-measure',
      description: 'Has measure',
      steps: [
        {
          id: 'step-1',
          title: 'Measured',
          description: 'With measure',
          measure: { cmd: 'wc -l src/**', target: 100, direction: 'down' },
        },
      ],
    };
    const result = validateAndBuild(raw);
    expect(result.steps[0].measure).toEqual({
      cmd: 'wc -l src/**',
      target: 100,
      direction: 'down',
    });
  });

  it('ignores partial measure field (missing target)', () => {
    const raw = {
      name: 'partial-measure',
      description: 'Partial measure',
      steps: [
        {
          id: 'step-1',
          title: 'Test',
          description: 'Test',
          measure: { cmd: 'wc -l' },
        },
      ],
    };
    const result = validateAndBuild(raw);
    expect(result.steps[0].measure).toBeUndefined();
  });

  it('defaults measure direction to "up" for unknown values', () => {
    const raw = {
      name: 'measure-dir',
      description: 'Measure direction',
      steps: [
        {
          id: 'step-1',
          title: 'Test',
          description: 'Test',
          measure: { cmd: 'coverage', target: 80, direction: 'invalid' },
        },
      ],
    };
    const result = validateAndBuild(raw);
    expect(result.steps[0].measure?.direction).toBe('up');
  });

  it('throws on circular dependencies (simple A↔B)', () => {
    const raw = {
      name: 'cycle',
      description: 'Circular deps',
      steps: [
        { id: 'a', title: 'A', description: 'First', depends_on: ['b'] },
        { id: 'b', title: 'B', description: 'Second', depends_on: ['a'] },
      ],
    };
    expect(() => validateAndBuild(raw)).toThrow('Circular dependency detected');
  });

  it('throws on longer circular dependency chain (A→B→C→D→A)', () => {
    const raw = {
      name: 'long-cycle',
      description: 'Long cycle',
      steps: [
        { id: 'a', title: 'A', description: 'First', depends_on: ['d'] },
        { id: 'b', title: 'B', description: 'Second', depends_on: ['a'] },
        { id: 'c', title: 'C', description: 'Third', depends_on: ['b'] },
        { id: 'd', title: 'D', description: 'Fourth', depends_on: ['c'] },
      ],
    };
    expect(() => validateAndBuild(raw)).toThrow('Circular dependency detected');
  });

  it('coerces non-string fields to strings', () => {
    const raw = {
      name: 'coerce',
      description: 'Coercion test',
      steps: [
        {
          id: 123,
          title: 456,
          description: null,
          acceptance_criteria: [789],
          verification_commands: [true],
          depends_on: [],
        },
      ],
    };
    // @ts-expect-error — testing runtime coercion of bad types
    const result = validateAndBuild(raw);
    expect(result.steps[0].id).toBe('123');
    expect(result.steps[0].title).toBe('456');
    expect(result.steps[0].description).toBe(''); // null || '' → ''
    expect(result.steps[0].acceptance_criteria).toEqual(['789']);
    expect(result.steps[0].verification_commands).toEqual(['true']);
  });
});
