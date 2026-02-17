import { describe, it, expect } from 'vitest';
import {
  parseFailure,
  extractStackTrace,
  testToSourceFile,
  extractFileFromStackLine,
  generateCIFixDescription,
  extractFailureScope,
  generateSpindleRecommendations,
} from '../lib/solo-ci.js';
import type { ParsedFailure, CIStatus } from '../lib/solo-ci.js';

describe('parseFailure', () => {
  it('returns jest failure for "FAIL src/test.test.ts" pattern', () => {
    const result = parseFailure('FAIL src/test.test.ts\n● Suite > test\n\n  Expected true');
    expect(result).not.toBeNull();
    expect(result!.type).toBe('test');
    expect(result!.framework).toBe('jest');
    expect(result!.file).toBe('src/test.test.ts');
  });

  it('returns vitest failure for "❯ src/test.test.ts" pattern', () => {
    const result = parseFailure('❯ src/test.test.ts > should work');
    expect(result).not.toBeNull();
    expect(result!.type).toBe('test');
    expect(result!.framework).toBe('vitest');
    expect(result!.file).toBe('src/test.test.ts');
  });

  it('returns pytest failure for "FAILED test.py::test_name" pattern', () => {
    const result = parseFailure('FAILED test_app.py::test_login - AssertionError');
    expect(result).not.toBeNull();
    expect(result!.type).toBe('test');
    expect(result!.framework).toBe('pytest');
    expect(result!.file).toBe('test_app.py');
    expect(result!.message).toContain('test_login');
  });

  it('returns go test failure for "--- FAIL: TestName" pattern', () => {
    const logs = '--- FAIL: TestLogin (0.01s)\n    auth_test.go:42: expected true';
    const result = parseFailure(logs);
    expect(result).not.toBeNull();
    expect(result!.type).toBe('test');
    expect(result!.framework).toBe('go');
    expect(result!.message).toContain('TestLogin');
  });

  it('returns typecheck failure for TypeScript error pattern', () => {
    const result = parseFailure("src/index.tsx(10,5): error TS2322: Type 'string' is not assignable");
    expect(result).not.toBeNull();
    expect(result!.type).toBe('typecheck');
    expect(result!.framework).toBe('typescript');
    expect(result!.file).toBe('src/index.tsx');
    expect(result!.line).toBe(10);
  });

  it('returns lint failure for ESLint pattern', () => {
    const result = parseFailure('src/app.ts\n  5:3  error  Unexpected var  no-var');
    expect(result).not.toBeNull();
    expect(result!.type).toBe('lint');
    expect(result!.framework).toBe('eslint');
    expect(result!.file).toBe('src/app.ts');
    expect(result!.line).toBe(5);
  });

  it('returns build failure for "Build failed" text', () => {
    const result = parseFailure('Build failed with errors');
    expect(result).not.toBeNull();
    expect(result!.type).toBe('build');
  });

  it('returns null for unrecognized logs', () => {
    expect(parseFailure('Everything is fine, all green')).toBeNull();
  });
});

describe('extractStackTrace', () => {
  it('extracts JS "at" lines', () => {
    const logs = 'Error: boom\n    at foo (src/a.ts:1:1)\n    at bar (src/b.ts:2:2)\nDone.';
    const result = extractStackTrace(logs);
    expect(result).toHaveLength(2);
    expect(result[0]).toContain('at foo');
  });

  it('extracts Python "File" lines', () => {
    const logs = 'Traceback:\n  File "app.py", line 10\n  File "util.py", line 5';
    const result = extractStackTrace(logs);
    expect(result).toHaveLength(2);
    expect(result[0]).toContain('File "app.py"');
  });

  it('extracts Go ".go:" lines', () => {
    const logs = 'goroutine 1:\n  main.go:42\n  handler.go:10';
    const result = extractStackTrace(logs);
    expect(result).toHaveLength(2);
  });

  it('limits to 10 lines', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `    at fn${i} (f.ts:${i}:1)`).join('\n');
    const result = extractStackTrace(lines);
    expect(result).toHaveLength(10);
  });

  it('returns empty array when no stack traces', () => {
    expect(extractStackTrace('just some log output')).toEqual([]);
  });
});

describe('testToSourceFile', () => {
  it('converts .test.ts to .ts', () => {
    expect(testToSourceFile('src/utils.test.ts')).toBe('src/utils.ts');
  });

  it('converts .spec.js to .js', () => {
    expect(testToSourceFile('lib/helper.spec.js')).toBe('lib/helper.js');
  });

  it('converts .test.tsx to .tsx', () => {
    expect(testToSourceFile('App.test.tsx')).toBe('App.tsx');
  });

  it('converts test_file.py to file.py', () => {
    expect(testToSourceFile('test_parser.py')).toBe('parser.py');
  });

  it('converts file_test.go to file.go', () => {
    expect(testToSourceFile('handler_test.go')).toBe('handler.go');
  });

  it('returns null for non-test files', () => {
    expect(testToSourceFile('src/index.ts')).toBeNull();
  });
});

describe('extractFileFromStackLine', () => {
  it('extracts JS file from "(file.ts:10:5)"', () => {
    expect(extractFileFromStackLine('at render (src/App.tsx:10:5)')).toBe('src/App.tsx');
  });

  it('extracts Python file from \'File "file.py"\'', () => {
    expect(extractFileFromStackLine('File "app/views.py", line 42')).toBe('app/views.py');
  });

  it('extracts Go file from "file.go:10"', () => {
    expect(extractFileFromStackLine('main.go:10 +0x1a')).toBe('main.go');
  });

  it('returns null for non-matching lines', () => {
    expect(extractFileFromStackLine('some random text')).toBeNull();
  });
});

describe('generateCIFixDescription', () => {
  const failure: ParsedFailure = {
    type: 'test',
    framework: 'jest',
    message: 'Expected true to be false',
    file: 'src/auth.test.ts',
    line: 42,
    stackTrace: ['at test (src/auth.test.ts:42:5)', 'at run (src/auth.ts:10:3)'],
  };
  const scope = ['src/auth.test.ts', 'src/auth.ts'];
  const ciStatus: CIStatus = { status: 'failure', failedJobs: [] };

  it('includes failure type and message', () => {
    const desc = generateCIFixDescription(failure, scope, ciStatus);
    expect(desc).toContain('**Type:** test');
    expect(desc).toContain('**Message:** Expected true to be false');
  });

  it('includes framework when present', () => {
    const desc = generateCIFixDescription(failure, scope, ciStatus);
    expect(desc).toContain('**Framework:** jest');
  });

  it('includes file and line when present', () => {
    const desc = generateCIFixDescription(failure, scope, ciStatus);
    expect(desc).toContain('**File:** src/auth.test.ts:42');
  });

  it('includes stack trace when present', () => {
    const desc = generateCIFixDescription(failure, scope, ciStatus);
    expect(desc).toContain('at test (src/auth.test.ts:42:5)');
    expect(desc).toContain('```');
  });

  it('lists scope files in constraints', () => {
    const desc = generateCIFixDescription(failure, scope, ciStatus);
    expect(desc).toContain('- src/auth.test.ts');
    expect(desc).toContain('- src/auth.ts');
  });

  it('includes expected outcome section', () => {
    const desc = generateCIFixDescription(failure, scope, ciStatus);
    expect(desc).toContain('## Expected Outcome');
    expect(desc).toContain('The failing test/check should pass');
  });
});

// ---------------------------------------------------------------------------
// extractFailureScope
// ---------------------------------------------------------------------------

describe('extractFailureScope', () => {
  it('includes the failure file itself', () => {
    const failure: ParsedFailure = {
      type: 'test',
      framework: 'jest',
      message: 'test failed',
      file: 'src/auth.test.ts',
    };
    const scope = extractFailureScope(failure);
    expect(scope).toContain('src/auth.test.ts');
  });

  it('includes source file mapped from test file', () => {
    const failure: ParsedFailure = {
      type: 'test',
      framework: 'jest',
      message: 'test failed',
      file: 'src/utils.test.ts',
    };
    const scope = extractFailureScope(failure);
    expect(scope).toContain('src/utils.test.ts');
    expect(scope).toContain('src/utils.ts');
  });

  it('includes files from stack trace', () => {
    const failure: ParsedFailure = {
      type: 'test',
      framework: 'jest',
      message: 'boom',
      file: 'src/a.test.ts',
      stackTrace: ['at fn (src/b.ts:10:5)', 'at run (src/c.ts:20:3)'],
    };
    const scope = extractFailureScope(failure);
    expect(scope).toContain('src/b.ts');
    expect(scope).toContain('src/c.ts');
  });

  it('excludes node_modules from stack trace files', () => {
    const failure: ParsedFailure = {
      type: 'test',
      framework: 'jest',
      message: 'boom',
      file: 'src/a.test.ts',
      stackTrace: [
        'at fn (src/b.ts:10:5)',
        'at run (node_modules/lib/index.js:5:1)',
      ],
    };
    const scope = extractFailureScope(failure);
    expect(scope).toContain('src/b.ts');
    expect(scope.some(f => f.includes('node_modules'))).toBe(false);
  });

  it('deduplicates files', () => {
    const failure: ParsedFailure = {
      type: 'test',
      framework: 'jest',
      message: 'boom',
      file: 'src/a.test.ts',
      stackTrace: ['at fn (src/a.test.ts:10:5)'],
    };
    const scope = extractFailureScope(failure);
    const count = scope.filter(f => f === 'src/a.test.ts').length;
    expect(count).toBe(1);
  });

  it('returns empty array when no file and no stack trace', () => {
    const failure: ParsedFailure = {
      type: 'build',
      message: 'Build failed',
    };
    const scope = extractFailureScope(failure);
    expect(scope).toEqual([]);
  });

  it('handles failure with file but no stack trace', () => {
    const failure: ParsedFailure = {
      type: 'lint',
      framework: 'eslint',
      message: 'lint error',
      file: 'src/app.ts',
    };
    const scope = extractFailureScope(failure);
    expect(scope).toContain('src/app.ts');
    // Non-test files don't get source mapping
    expect(scope).toHaveLength(1);
  });

  it('handles Python test file mapping', () => {
    const failure: ParsedFailure = {
      type: 'test',
      framework: 'pytest',
      message: 'assertion failed',
      file: 'test_parser.py',
    };
    const scope = extractFailureScope(failure);
    expect(scope).toContain('test_parser.py');
    expect(scope).toContain('parser.py');
  });

  it('handles Go test file mapping', () => {
    const failure: ParsedFailure = {
      type: 'test',
      framework: 'go',
      message: 'test failed',
      file: 'handler_test.go',
    };
    const scope = extractFailureScope(failure);
    expect(scope).toContain('handler_test.go');
    expect(scope).toContain('handler.go');
  });
});

// ---------------------------------------------------------------------------
// generateSpindleRecommendations
// ---------------------------------------------------------------------------

describe('generateSpindleRecommendations', () => {
  const ticket = { allowedPaths: ['src/'], forbiddenPaths: [] };
  const config = { tokenBudgetAbort: 200000, maxStallIterations: 5, similarityThreshold: 0.85 };

  it('returns recommendations for token_budget trigger', () => {
    const recs = generateSpindleRecommendations('token_budget', ticket, config);
    expect(recs.length).toBeGreaterThan(0);
    expect(recs.some(r => r.includes('token limit'))).toBe(true);
    expect(recs.some(r => r.includes('200000'))).toBe(true);
  });

  it('returns recommendations for stalling trigger', () => {
    const recs = generateSpindleRecommendations('stalling', ticket, config);
    expect(recs.some(r => r.includes('stuck'))).toBe(true);
    expect(recs.some(r => r.includes('5'))).toBe(true);
  });

  it('returns recommendations for oscillation trigger', () => {
    const recs = generateSpindleRecommendations('oscillation', ticket, config);
    expect(recs.some(r => r.includes('flip-flopping'))).toBe(true);
  });

  it('returns recommendations for repetition trigger', () => {
    const recs = generateSpindleRecommendations('repetition', ticket, config);
    expect(recs.some(r => r.includes('repeating'))).toBe(true);
    expect(recs.some(r => r.includes('0.85'))).toBe(true);
  });

  it('returns recommendations for spinning trigger', () => {
    const recs = generateSpindleRecommendations('spinning', ticket, config);
    expect(recs.some(r => r.includes('high activity'))).toBe(true);
  });

  it('returns recommendations for qa_ping_pong trigger', () => {
    const recs = generateSpindleRecommendations('qa_ping_pong', ticket, config);
    expect(recs.some(r => r.includes('alternating'))).toBe(true);
  });

  it('returns recommendations for command_failure trigger', () => {
    const recs = generateSpindleRecommendations('command_failure', ticket, config);
    expect(recs.some(r => r.includes('command keeps failing'))).toBe(true);
    expect(recs.some(r => r.includes('environmental'))).toBe(true);
  });

  it('always includes diagnostics and disable recommendations', () => {
    const triggers = ['token_budget', 'stalling', 'oscillation', 'repetition', 'spinning', 'qa_ping_pong', 'command_failure'] as const;
    for (const trigger of triggers) {
      const recs = generateSpindleRecommendations(trigger, ticket, config);
      expect(recs.some(r => r.includes('diagnostics'))).toBe(true);
      expect(recs.some(r => r.includes('Disable Spindle'))).toBe(true);
    }
  });

  it('includes config values in relevant recommendations', () => {
    const customConfig = { tokenBudgetAbort: 500000, maxStallIterations: 10, similarityThreshold: 0.95 };
    const recs = generateSpindleRecommendations('token_budget', ticket, customConfig);
    expect(recs.some(r => r.includes('500000'))).toBe(true);
  });
});
