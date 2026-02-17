/**
 * Formulas algorithm tests — covers pure functions in formulas/shared.ts:
 *   - BUILTIN_FORMULAS constant
 *   - parseSimpleYaml
 *   - parseStringList
 *
 * Tests pure functions only (no filesystem).
 */

import { describe, it, expect } from 'vitest';
import {
  BUILTIN_FORMULAS,
  parseSimpleYaml,
  parseStringList,
} from '../formulas/shared.js';

// ---------------------------------------------------------------------------
// BUILTIN_FORMULAS
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

  it('all formulas have required fields', () => {
    for (const f of BUILTIN_FORMULAS) {
      expect(f.name).toBeTruthy();
      expect(f.description).toBeTruthy();
      expect(f.prompt).toBeTruthy();
      expect(f.tags).toBeDefined();
      expect(Array.isArray(f.tags)).toBe(true);
    }
  });

  it('security-audit has low risk tolerance', () => {
    const f = BUILTIN_FORMULAS.find(f => f.name === 'security-audit');
    expect(f?.risk_tolerance).toBe('low');
    expect(f?.categories).toContain('security');
  });

  it('deep uses opus model', () => {
    const f = BUILTIN_FORMULAS.find(f => f.name === 'deep');
    expect(f?.model).toBe('opus');
    expect(f?.risk_tolerance).toBe('high');
  });

  it('each formula has unique name', () => {
    const names = BUILTIN_FORMULAS.map(f => f.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

// ---------------------------------------------------------------------------
// parseSimpleYaml
// ---------------------------------------------------------------------------

describe('parseSimpleYaml', () => {
  it('parses simple key-value pairs', () => {
    const result = parseSimpleYaml('name: my-formula\ndescription: A test formula');
    expect(result.name).toBe('my-formula');
    expect(result.description).toBe('A test formula');
  });

  it('handles multi-line blocks with |', () => {
    const yaml = `prompt: |
  Line one of the prompt
  Line two of the prompt
name: test`;
    const result = parseSimpleYaml(yaml);
    expect(result.prompt).toContain('Line one');
    expect(result.prompt).toContain('Line two');
    expect(result.name).toBe('test');
  });

  it('handles multi-line blocks with >', () => {
    const yaml = `prompt: >
  First line
  Second line
name: test`;
    const result = parseSimpleYaml(yaml);
    expect(result.prompt).toContain('First line');
    expect(result.prompt).toContain('Second line');
  });

  it('skips comments', () => {
    const yaml = '# This is a comment\nname: my-formula\n# Another comment\ndescription: test';
    const result = parseSimpleYaml(yaml);
    expect(result.name).toBe('my-formula');
    expect(result.description).toBe('test');
    expect(Object.keys(result)).not.toContain('#');
  });

  it('skips empty lines', () => {
    const yaml = 'name: test\n\n\ndescription: hello';
    const result = parseSimpleYaml(yaml);
    expect(result.name).toBe('test');
    expect(result.description).toBe('hello');
  });

  it('handles keys with hyphens and underscores', () => {
    const yaml = 'min_confidence: 80\nmax-prs: 10';
    const result = parseSimpleYaml(yaml);
    expect(result.min_confidence).toBe('80');
    expect(result['max-prs']).toBe('10');
  });

  it('handles empty input', () => {
    const result = parseSimpleYaml('');
    expect(result).toEqual({});
  });

  it('handles YAML list values as strings', () => {
    const yaml = 'categories: [security, test]\ntags: quality, cleanup';
    const result = parseSimpleYaml(yaml);
    expect(result.categories).toBe('[security, test]');
    expect(result.tags).toBe('quality, cleanup');
  });

  it('handles trailing multiline at end of file', () => {
    const yaml = `name: test
prompt: |
  This is the last block
  With no key after it`;
    const result = parseSimpleYaml(yaml);
    expect(result.name).toBe('test');
    expect(result.prompt).toContain('This is the last block');
  });
});

// ---------------------------------------------------------------------------
// parseStringList
// ---------------------------------------------------------------------------

describe('parseStringList', () => {
  it('parses YAML array syntax', () => {
    expect(parseStringList('[a, b, c]')).toEqual(['a', 'b', 'c']);
  });

  it('parses comma-separated values', () => {
    expect(parseStringList('security, test, docs')).toEqual(['security', 'test', 'docs']);
  });

  it('trims whitespace', () => {
    expect(parseStringList('  a ,  b  , c  ')).toEqual(['a', 'b', 'c']);
  });

  it('filters empty strings', () => {
    expect(parseStringList('a,,b,')).toEqual(['a', 'b']);
  });

  it('handles single value', () => {
    expect(parseStringList('security')).toEqual(['security']);
  });

  it('handles empty input', () => {
    expect(parseStringList('')).toEqual([]);
  });

  it('handles brackets with spaces', () => {
    expect(parseStringList('[ refactor , perf ]')).toEqual(['refactor', 'perf']);
  });
});
