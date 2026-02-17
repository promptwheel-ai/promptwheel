import { describe, it, expect } from 'vitest';
import {
  isTestFailure,
  extractTestFilesFromQaOutput,
} from '../lib/solo-qa-retry.js';

// ---------------------------------------------------------------------------
// isTestFailure
// ---------------------------------------------------------------------------

describe('isTestFailure', () => {
  it('returns false for undefined input', () => {
    expect(isTestFailure(undefined)).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isTestFailure('')).toBe(false);
  });

  it('detects "test" in step name', () => {
    expect(isTestFailure('run tests')).toBe(true);
  });

  it('detects "vitest" in step name', () => {
    expect(isTestFailure('vitest run')).toBe(true);
  });

  it('detects "jest" in step name', () => {
    expect(isTestFailure('jest --ci')).toBe(true);
  });

  it('detects "pytest" in step name', () => {
    expect(isTestFailure('pytest -v')).toBe(true);
  });

  it('detects "mocha" in step name', () => {
    expect(isTestFailure('mocha specs')).toBe(true);
  });

  it('detects "karma" in step name', () => {
    expect(isTestFailure('karma start')).toBe(true);
  });

  it('is case insensitive', () => {
    expect(isTestFailure('Vitest Run')).toBe(true);
    expect(isTestFailure('JEST')).toBe(true);
    expect(isTestFailure('PyTest')).toBe(true);
  });

  it('returns false for non-test step names', () => {
    expect(isTestFailure('build')).toBe(false);
    expect(isTestFailure('lint')).toBe(false);
    expect(isTestFailure('typecheck')).toBe(false);
    expect(isTestFailure('deploy')).toBe(false);
  });

  it('matches "test" as a substring', () => {
    // "contest" contains "test" — the regex matches substrings
    expect(isTestFailure('contest')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// extractTestFilesFromQaOutput
// ---------------------------------------------------------------------------

describe('extractTestFilesFromQaOutput', () => {
  it('returns empty array for empty string', () => {
    expect(extractTestFilesFromQaOutput('')).toEqual([]);
  });

  it('returns empty array for output with no test files', () => {
    expect(extractTestFilesFromQaOutput('Error: something went wrong\nexit code 1')).toEqual([]);
  });

  // Pattern 1: FAIL/❌/✗ prefix
  it('extracts test files with FAIL prefix', () => {
    const output = 'FAIL src/foo.test.ts\nFAIL src/bar.spec.js';
    const result = extractTestFilesFromQaOutput(output);
    expect(result).toContain('src/foo.test.ts');
    expect(result).toContain('src/bar.spec.js');
  });

  it('extracts test files with ❌ prefix', () => {
    const output = '❌ src/utils.test.tsx';
    const result = extractTestFilesFromQaOutput(output);
    expect(result).toContain('src/utils.test.tsx');
  });

  it('extracts test files with ✗ prefix', () => {
    const output = '✗ lib/helper.spec.ts';
    const result = extractTestFilesFromQaOutput(output);
    expect(result).toContain('lib/helper.spec.ts');
  });

  // Pattern 2: General .test./.spec. file paths
  it('extracts .test.ts file paths from general output', () => {
    const output = 'Error in src/lib/validator.test.ts:42\nsome other output';
    const result = extractTestFilesFromQaOutput(output);
    expect(result).toContain('src/lib/validator.test.ts');
  });

  it('extracts .spec.jsx file paths', () => {
    const output = 'Failed: components/Button.spec.jsx';
    const result = extractTestFilesFromQaOutput(output);
    expect(result).toContain('components/Button.spec.jsx');
  });

  it('extracts .test.tsx file paths', () => {
    const output = 'FAIL components/Form.test.tsx > should render';
    const result = extractTestFilesFromQaOutput(output);
    expect(result).toContain('components/Form.test.tsx');
  });

  // Pattern 3: Python test files
  it('extracts Python test_ prefixed files', () => {
    const output = 'FAILED tests/test_auth.py::test_login - AssertionError';
    const result = extractTestFilesFromQaOutput(output);
    expect(result).toContain('tests/test_auth.py');
  });

  // Pattern 4: __tests__ directory files
  it('extracts files from __tests__ directories', () => {
    const output = 'Error: src/__tests__/utils.ts failed';
    const result = extractTestFilesFromQaOutput(output);
    expect(result).toContain('src/__tests__/utils.ts');
  });

  it('extracts __tests__ files with nested paths', () => {
    const output = 'FAIL packages/core/__tests__/db.tsx';
    const result = extractTestFilesFromQaOutput(output);
    expect(result).toContain('packages/core/__tests__/db.tsx');
  });

  // Deduplication
  it('deduplicates repeated file paths', () => {
    const output = [
      'FAIL src/foo.test.ts',
      'Error in src/foo.test.ts:10',
      'src/foo.test.ts > describe > it',
    ].join('\n');
    const result = extractTestFilesFromQaOutput(output);
    const fooCount = result.filter(f => f === 'src/foo.test.ts').length;
    expect(fooCount).toBe(1);
  });

  // Multiple files from different patterns
  it('extracts files from multiple patterns in one output', () => {
    const output = [
      'FAIL src/a.test.ts',
      'Error in src/b.spec.js:5',
      'tests/test_c.py FAILED',
      'src/__tests__/d.ts errored',
    ].join('\n');
    const result = extractTestFilesFromQaOutput(output);
    expect(result).toContain('src/a.test.ts');
    expect(result).toContain('src/b.spec.js');
    expect(result).toContain('tests/test_c.py');
    expect(result).toContain('src/__tests__/d.ts');
  });

  // Paths with hyphens and underscores
  it('handles paths with hyphens and underscores', () => {
    const output = 'FAIL src/my-module/some_util.test.ts';
    const result = extractTestFilesFromQaOutput(output);
    expect(result).toContain('src/my-module/some_util.test.ts');
  });

  // Paths with dots in directory names
  it('handles paths with dots in directory names', () => {
    const output = 'Error in src/v2.0/api.test.ts:1';
    const result = extractTestFilesFromQaOutput(output);
    expect(result).toContain('src/v2.0/api.test.ts');
  });
});
