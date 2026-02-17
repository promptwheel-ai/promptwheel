import { describe, it, expect } from 'vitest';
import { classifyFailure } from '../lib/failure-classifier.js';
import type { ClassifiedFailure } from '../lib/failure-classifier.js';

// ---------------------------------------------------------------------------
// type_error
// ---------------------------------------------------------------------------

describe('classifyFailure — type_error', () => {
  it('detects TypeScript "error TS" pattern', () => {
    const result = classifyFailure('tsc --noEmit', 'src/index.ts(10,5): error TS2345: Argument of type...');
    expect(result.failureType).toBe('type_error');
  });

  it('detects TS error code with colon format', () => {
    const result = classifyFailure('typecheck', 'TS2304: Cannot find name "foo".');
    expect(result.failureType).toBe('type_error');
  });
});

// ---------------------------------------------------------------------------
// compile_error
// ---------------------------------------------------------------------------

describe('classifyFailure — compile_error', () => {
  it('detects "Cannot find module"', () => {
    const result = classifyFailure('build', 'Error: Cannot find module "./missing"');
    expect(result.failureType).toBe('compile_error');
  });

  it('detects SyntaxError', () => {
    const result = classifyFailure('build', 'SyntaxError: Unexpected token }');
    expect(result.failureType).toBe('compile_error');
  });

  it('detects "Module not found"', () => {
    const result = classifyFailure('webpack', 'Module not found: Error: Can\'t resolve \'./foo\'');
    expect(result.failureType).toBe('compile_error');
  });
});

// ---------------------------------------------------------------------------
// test_assertion
// ---------------------------------------------------------------------------

describe('classifyFailure — test_assertion', () => {
  it('detects FAIL in test step', () => {
    const result = classifyFailure('npm test', 'FAIL src/auth.test.ts\n  ✗ should validate token');
    expect(result.failureType).toBe('test_assertion');
  });

  it('detects AssertionError in spec step', () => {
    const result = classifyFailure('run spec', 'AssertionError: expected 1 to equal 2');
    expect(result.failureType).toBe('test_assertion');
  });

  it('detects expect() in test step', () => {
    const result = classifyFailure('vitest test', 'expect(received).toBe(expected)');
    expect(result.failureType).toBe('test_assertion');
  });

  it('detects ✗ marker in test step', () => {
    const result = classifyFailure('test:unit', '✗ should return correct value');
    expect(result.failureType).toBe('test_assertion');
  });

  it('does NOT classify FAIL as test_assertion when step name has no test/spec', () => {
    // The regex requires stepName to match /test|spec/i
    const result = classifyFailure('build', 'FAIL something happened');
    // Falls through to runtime_error or unknown
    expect(result.failureType).not.toBe('test_assertion');
  });
});

// ---------------------------------------------------------------------------
// lint_error
// ---------------------------------------------------------------------------

describe('classifyFailure — lint_error', () => {
  it('detects eslint in step name', () => {
    const result = classifyFailure('eslint src/', '3 errors and 2 warnings');
    expect(result.failureType).toBe('lint_error');
  });

  it('detects prettier in step name', () => {
    const result = classifyFailure('prettier --check', 'Checking formatting...\nfailed');
    expect(result.failureType).toBe('lint_error');
  });

  it('detects lint in step name (case insensitive)', () => {
    const result = classifyFailure('Lint Check', 'some lint output');
    expect(result.failureType).toBe('lint_error');
  });
});

// ---------------------------------------------------------------------------
// timeout
// ---------------------------------------------------------------------------

describe('classifyFailure — timeout', () => {
  it('detects SIGTERM', () => {
    const result = classifyFailure('build', 'Process exited with SIGTERM');
    expect(result.failureType).toBe('timeout');
  });

  it('detects "timed out"', () => {
    const result = classifyFailure('npm test', 'Test timed out after 30000ms');
    expect(result.failureType).toBe('timeout');
  });

  it('detects "timeout"', () => {
    const result = classifyFailure('build', 'Error: timeout waiting for response');
    expect(result.failureType).toBe('timeout');
  });

  it('detects ETIMEDOUT', () => {
    const result = classifyFailure('npm install', 'Error: ETIMEDOUT connecting to registry');
    expect(result.failureType).toBe('timeout');
  });
});

// ---------------------------------------------------------------------------
// runtime_error
// ---------------------------------------------------------------------------

describe('classifyFailure — runtime_error', () => {
  it('detects ReferenceError', () => {
    const result = classifyFailure('start', 'ReferenceError: foo is not defined');
    expect(result.failureType).toBe('runtime_error');
  });

  it('detects TypeError', () => {
    const result = classifyFailure('start', 'TypeError: Cannot read properties of undefined');
    expect(result.failureType).toBe('runtime_error');
  });

  it('detects "Error:" pattern', () => {
    const result = classifyFailure('start', 'Error: something went wrong');
    expect(result.failureType).toBe('runtime_error');
  });

  it('detects ENOENT', () => {
    const result = classifyFailure('start', 'Error: ENOENT: no such file or directory');
    expect(result.failureType).toBe('runtime_error');
  });

  it('detects EACCES', () => {
    const result = classifyFailure('start', 'Error: EACCES: permission denied');
    expect(result.failureType).toBe('runtime_error');
  });
});

// ---------------------------------------------------------------------------
// unknown
// ---------------------------------------------------------------------------

describe('classifyFailure — unknown', () => {
  it('returns unknown for unrecognized output', () => {
    const result = classifyFailure('build', 'Some vague failure message with no patterns');
    expect(result.failureType).toBe('unknown');
  });

  it('returns unknown for empty output', () => {
    const result = classifyFailure('build', '');
    expect(result.failureType).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// errorPattern extraction
// ---------------------------------------------------------------------------

describe('classifyFailure — errorPattern extraction', () => {
  it('extracts the first line matching error pattern', () => {
    const output = 'some info\nerror TS2345: Argument of type...\nmore info';
    const result = classifyFailure('tsc', output);
    expect(result.errorPattern).toContain('error TS2345');
  });

  it('extracts Error: line', () => {
    const output = 'starting build\nError: Cannot find module "./foo"\ndone';
    const result = classifyFailure('build', output);
    expect(result.errorPattern).toContain('Error: Cannot find module');
  });

  it('extracts FAIL line', () => {
    const output = 'Running tests\nFAIL src/auth.test.ts\nDone';
    const result = classifyFailure('test', output);
    expect(result.errorPattern).toContain('FAIL');
  });

  it('truncates errorPattern to 100 chars', () => {
    const longError = 'Error: ' + 'x'.repeat(200);
    const result = classifyFailure('build', longError);
    expect(result.errorPattern.length).toBeLessThanOrEqual(100);
  });

  it('returns empty errorPattern when no matching line found', () => {
    const result = classifyFailure('build', 'no matching lines here');
    expect(result.errorPattern).toBe('');
  });
});

// ---------------------------------------------------------------------------
// failedCommand
// ---------------------------------------------------------------------------

describe('classifyFailure — failedCommand', () => {
  it('records the stepName as failedCommand', () => {
    const result = classifyFailure('npm run build', 'SyntaxError: bad code');
    expect(result.failedCommand).toBe('npm run build');
  });
});

// ---------------------------------------------------------------------------
// tail truncation (only last 5000 chars examined)
// ---------------------------------------------------------------------------

describe('classifyFailure — tail truncation', () => {
  it('only examines the last 5000 chars of output', () => {
    // Put a type error pattern in the first part, then pad with 6000 chars of noise
    const earlyError = 'error TS2345: something wrong\n';
    const padding = 'x'.repeat(6000);
    const output = earlyError + padding;
    // The error is at the beginning, but tail is last 5000 chars (all 'x')
    const result = classifyFailure('tsc', output);
    // Should NOT detect type_error since the pattern is outside the 5000-char tail
    expect(result.failureType).toBe('unknown');
  });

  it('detects patterns within the last 5000 chars', () => {
    const padding = 'y'.repeat(6000);
    const lateError = '\nerror TS2345: something wrong';
    const output = padding + lateError;
    const result = classifyFailure('tsc', output);
    expect(result.failureType).toBe('type_error');
  });
});

// ---------------------------------------------------------------------------
// Priority ordering (type_error before compile_error before test_assertion...)
// ---------------------------------------------------------------------------

describe('classifyFailure — priority ordering', () => {
  it('prefers type_error over compile_error when both patterns present', () => {
    const output = 'Cannot find module "./foo"\nerror TS2345: bad type';
    const result = classifyFailure('build', output);
    expect(result.failureType).toBe('type_error');
  });

  it('prefers compile_error over test_assertion when both present (non-test step)', () => {
    const output = 'SyntaxError: unexpected token\nFAIL test.ts';
    const result = classifyFailure('build', output);
    expect(result.failureType).toBe('compile_error');
  });

  it('prefers lint_error when step name indicates linting even with other patterns', () => {
    // lint step name takes priority in the else-if chain only if
    // no type_error or compile_error or test_assertion matched first
    const result = classifyFailure('eslint', 'some random output with no known patterns');
    expect(result.failureType).toBe('lint_error');
  });
});

// ---------------------------------------------------------------------------
// Return type conformance
// ---------------------------------------------------------------------------

describe('classifyFailure — return shape', () => {
  it('returns all required fields', () => {
    const result: ClassifiedFailure = classifyFailure('build', 'Error: boom');
    expect(result).toHaveProperty('failureType');
    expect(result).toHaveProperty('failedCommand');
    expect(result).toHaveProperty('errorPattern');
    expect(typeof result.failureType).toBe('string');
    expect(typeof result.failedCommand).toBe('string');
    expect(typeof result.errorPattern).toBe('string');
  });
});
