/**
 * Tests for scope enforcement utilities
 */

import { describe, it, expect } from 'vitest';
import {
  matchesPattern,
  parseChangedFiles,
  checkScopeViolations,
  analyzeViolationsForExpansion,
  type ScopeViolation,
} from '../lib/scope.js';

describe('matchesPattern', () => {
  it('matches exact paths', () => {
    expect(matchesPattern('src/index.ts', 'src/index.ts')).toBe(true);
    expect(matchesPattern('src/index.ts', 'src/main.ts')).toBe(false);
  });

  it('matches single wildcard (*)', () => {
    expect(matchesPattern('src/index.ts', 'src/*.ts')).toBe(true);
    expect(matchesPattern('src/foo.ts', 'src/*.ts')).toBe(true);
    expect(matchesPattern('src/nested/index.ts', 'src/*.ts')).toBe(false); // * doesn't match /
  });

  it('matches globstar (**)', () => {
    expect(matchesPattern('src/index.ts', 'src/**')).toBe(true);
    expect(matchesPattern('src/nested/deep/file.ts', 'src/**')).toBe(true);
    expect(matchesPattern('lib/index.ts', 'src/**')).toBe(false);
  });

  it('matches combined patterns', () => {
    expect(matchesPattern('src/components/Button.tsx', 'src/**/*.tsx')).toBe(true);
    expect(matchesPattern('src/Button.tsx', 'src/**/*.tsx')).toBe(true);
    expect(matchesPattern('src/components/Button.ts', 'src/**/*.tsx')).toBe(false);
  });

  it('matches single char wildcard (?)', () => {
    expect(matchesPattern('src/a.ts', 'src/?.ts')).toBe(true);
    expect(matchesPattern('src/ab.ts', 'src/?.ts')).toBe(false);
  });

  it('escapes special regex chars', () => {
    expect(matchesPattern('src/file.test.ts', 'src/file.test.ts')).toBe(true);
    expect(matchesPattern('src/file[0].ts', 'src/file[0].ts')).toBe(true);
    expect(matchesPattern('src/file(1).ts', 'src/file(1).ts')).toBe(true);
  });

  it('normalizes Windows paths', () => {
    expect(matchesPattern('src\\index.ts', 'src/index.ts')).toBe(true);
    expect(matchesPattern('src/index.ts', 'src\\index.ts')).toBe(true);
  });
});

describe('parseChangedFiles', () => {
  it('parses empty output', () => {
    expect(parseChangedFiles('')).toEqual([]);
    expect(parseChangedFiles('   \n   ')).toEqual([]);
  });

  it('parses modified files', () => {
    const output = ' M src/index.ts\n M src/utils.ts';
    expect(parseChangedFiles(output)).toEqual(['src/index.ts', 'src/utils.ts']);
  });

  it('parses added files', () => {
    const output = 'A  src/new.ts\n?? src/untracked.ts';
    expect(parseChangedFiles(output)).toEqual(['src/new.ts', 'src/untracked.ts']);
  });

  it('parses renamed files (returns destination)', () => {
    const output = 'R  src/old.ts -> src/new.ts';
    expect(parseChangedFiles(output)).toEqual(['src/new.ts']);
  });

  it('parses mixed status output', () => {
    const output = `
 M src/modified.ts
A  src/added.ts
D  src/deleted.ts
R  src/renamed-old.ts -> src/renamed-new.ts
?? src/untracked.ts
`;
    expect(parseChangedFiles(output)).toEqual([
      'src/modified.ts',
      'src/added.ts',
      'src/deleted.ts',
      'src/renamed-new.ts',
      'src/untracked.ts',
    ]);
  });

  it('handles files with spaces', () => {
    const output = ' M src/my file.ts';
    expect(parseChangedFiles(output)).toEqual(['src/my file.ts']);
  });
});

describe('checkScopeViolations', () => {
  it('returns empty for no constraints', () => {
    const files = ['src/index.ts', 'lib/utils.ts'];
    expect(checkScopeViolations(files, [], [])).toEqual([]);
  });

  it('returns empty when all files in allowed paths', () => {
    const files = ['src/index.ts', 'src/utils.ts'];
    const allowed = ['src/**'];
    expect(checkScopeViolations(files, allowed, [])).toEqual([]);
  });

  it('detects files outside allowed paths', () => {
    const files = ['src/index.ts', 'lib/utils.ts'];
    const allowed = ['src/**'];
    const violations = checkScopeViolations(files, allowed, []);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toEqual({
      file: 'lib/utils.ts',
      violation: 'not_in_allowed',
    });
  });

  it('detects files in forbidden paths', () => {
    const files = ['src/index.ts', 'config/secrets.json'];
    const forbidden = ['config/**', '**/*.env'];
    const violations = checkScopeViolations(files, [], forbidden);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toEqual({
      file: 'config/secrets.json',
      violation: 'in_forbidden',
      pattern: 'config/**',
    });
  });

  it('forbidden takes priority over allowed', () => {
    const files = ['src/internal/private.ts'];
    const allowed = ['src/**'];
    const forbidden = ['src/internal/**'];
    const violations = checkScopeViolations(files, allowed, forbidden);

    expect(violations).toHaveLength(1);
    expect(violations[0].violation).toBe('in_forbidden');
  });

  it('handles multiple violations', () => {
    const files = ['src/index.ts', 'lib/utils.ts', 'config/db.json', 'test/spec.ts'];
    const allowed = ['src/**'];
    const forbidden = ['config/**'];
    const violations = checkScopeViolations(files, allowed, forbidden);

    expect(violations).toHaveLength(3);
    expect(violations.map(v => v.file).sort()).toEqual([
      'config/db.json',
      'lib/utils.ts',
      'test/spec.ts',
    ]);
  });

  it('handles multiple allowed patterns', () => {
    const files = ['src/index.ts', 'lib/utils.ts', 'docs/README.md'];
    const allowed = ['src/**', 'lib/**'];
    const violations = checkScopeViolations(files, allowed, []);

    expect(violations).toHaveLength(1);
    expect(violations[0].file).toBe('docs/README.md');
  });
});

describe('analyzeViolationsForExpansion', () => {
  it('expands for sibling files in allowed directory', () => {
    const violations: ScopeViolation[] = [
      { file: 'src/lib/types.ts', violation: 'not_in_allowed' },
    ];
    const currentPaths = ['src/lib/utils.ts'];

    const result = analyzeViolationsForExpansion(violations, currentPaths);

    expect(result.canExpand).toBe(true);
    expect(result.addedPaths).toContain('src/lib/types.ts');
    expect(result.expandedPaths).toContain('src/lib/utils.ts');
    expect(result.expandedPaths).toContain('src/lib/types.ts');
  });

  it('expands for related file types (types.ts)', () => {
    const violations: ScopeViolation[] = [
      { file: 'src/types.ts', violation: 'not_in_allowed' },
    ];
    const currentPaths = ['src/index.ts'];

    const result = analyzeViolationsForExpansion(violations, currentPaths);

    expect(result.canExpand).toBe(true);
    expect(result.addedPaths).toContain('src/types.ts');
  });

  it('expands for test files', () => {
    const violations: ScopeViolation[] = [
      { file: 'src/lib/utils.test.ts', violation: 'not_in_allowed' },
    ];
    const currentPaths = ['src/lib/utils.ts'];

    const result = analyzeViolationsForExpansion(violations, currentPaths);

    expect(result.canExpand).toBe(true);
    expect(result.addedPaths).toContain('src/lib/utils.test.ts');
  });

  it('expands for subdirectory files', () => {
    const violations: ScopeViolation[] = [
      { file: 'src/lib/helpers/format.ts', violation: 'not_in_allowed' },
    ];
    const currentPaths = ['src/lib/index.ts'];

    const result = analyzeViolationsForExpansion(violations, currentPaths);

    expect(result.canExpand).toBe(true);
    expect(result.addedPaths).toContain('src/lib/helpers/format.ts');
  });

  it('rejects expansion for forbidden violations', () => {
    const violations: ScopeViolation[] = [
      { file: 'config/secrets.json', violation: 'in_forbidden', pattern: 'config/**' },
    ];
    const currentPaths = ['src/index.ts'];

    const result = analyzeViolationsForExpansion(violations, currentPaths);

    expect(result.canExpand).toBe(false);
    expect(result.reason).toContain('forbidden');
    expect(result.addedPaths).toEqual([]);
  });

  it('rejects expansion for hallucinated paths', () => {
    const violations: ScopeViolation[] = [
      { file: 'src/src/index.ts', violation: 'not_in_allowed', pattern: 'hallucinated: Repeated path segment' },
    ];
    const currentPaths = ['src/index.ts'];

    const result = analyzeViolationsForExpansion(violations, currentPaths);

    expect(result.canExpand).toBe(false);
    expect(result.reason).toContain('hallucinated');
  });

  it('rejects expansion for unrelated directories', () => {
    const violations: ScopeViolation[] = [
      { file: 'completely/different/path.ts', violation: 'not_in_allowed' },
    ];
    const currentPaths = ['src/lib/utils.ts'];

    const result = analyzeViolationsForExpansion(violations, currentPaths);

    expect(result.canExpand).toBe(false);
    expect(result.reason).toContain('unrelated');
  });

  it('rejects expansion for too many files', () => {
    const violations: ScopeViolation[] = [
      { file: 'src/lib/a.ts', violation: 'not_in_allowed' },
      { file: 'src/lib/b.ts', violation: 'not_in_allowed' },
      { file: 'src/lib/c.ts', violation: 'not_in_allowed' },
      { file: 'src/lib/d.ts', violation: 'not_in_allowed' },
      { file: 'src/lib/e.ts', violation: 'not_in_allowed' },
      { file: 'src/lib/f.ts', violation: 'not_in_allowed' },
    ];
    const currentPaths = ['src/lib/utils.ts'];

    const result = analyzeViolationsForExpansion(violations, currentPaths, 5);

    expect(result.canExpand).toBe(false);
    expect(result.reason).toContain('6 files');
    expect(result.reason).toContain('max: 5');
  });

  it('respects custom maxExpansions', () => {
    const violations: ScopeViolation[] = [
      { file: 'src/lib/a.ts', violation: 'not_in_allowed' },
      { file: 'src/lib/b.ts', violation: 'not_in_allowed' },
      { file: 'src/lib/c.ts', violation: 'not_in_allowed' },
    ];
    const currentPaths = ['src/lib/utils.ts'];

    // With maxExpansions=2, should reject
    const result2 = analyzeViolationsForExpansion(violations, currentPaths, 2);
    expect(result2.canExpand).toBe(false);

    // With maxExpansions=5, should accept
    const result5 = analyzeViolationsForExpansion(violations, currentPaths, 5);
    expect(result5.canExpand).toBe(true);
    expect(result5.addedPaths).toHaveLength(3);
  });

  it('deduplicates expanded paths', () => {
    const violations: ScopeViolation[] = [
      { file: 'src/lib/utils.ts', violation: 'not_in_allowed' },
    ];
    // Already in current paths but still showing as violation
    const currentPaths = ['src/lib/utils.ts', 'src/lib/index.ts'];

    const result = analyzeViolationsForExpansion(violations, currentPaths);

    // Should still succeed but not duplicate the path
    expect(result.expandedPaths.filter(p => p === 'src/lib/utils.ts')).toHaveLength(1);
  });

  it('expands for root-level config files', () => {
    const violations: ScopeViolation[] = [
      { file: 'vitest.config.ts', violation: 'not_in_allowed' },
    ];
    const currentPaths = ['src/lib/utils.ts'];

    const result = analyzeViolationsForExpansion(violations, currentPaths);

    expect(result.canExpand).toBe(true);
    expect(result.addedPaths).toContain('vitest.config.ts');
  });

  it('expands for various root config types', () => {
    const configs = [
      'tsconfig.json',
      'eslint.config.js',
      'prettier.config.js',
      'jest.config.ts',
      'vite.config.ts',
      'next.config.js',
      'tailwind.config.ts',
      'babel.config.js',
    ];

    for (const config of configs) {
      const violations: ScopeViolation[] = [
        { file: config, violation: 'not_in_allowed' },
      ];
      const result = analyzeViolationsForExpansion(violations, ['src/index.ts']);
      expect(result.canExpand).toBe(true);
      expect(result.addedPaths).toContain(config);
    }
  });

  it('does not expand non-config root files', () => {
    const violations: ScopeViolation[] = [
      { file: 'random-script.ts', violation: 'not_in_allowed' },
    ];
    const currentPaths = ['src/lib/utils.ts'];

    const result = analyzeViolationsForExpansion(violations, currentPaths);

    expect(result.canExpand).toBe(false);
  });

  it('expands for cross-package monorepo paths', () => {
    const violations: ScopeViolation[] = [
      { file: 'packages/core/src/repos/tickets.ts', violation: 'not_in_allowed' },
    ];
    const currentPaths = ['packages/cli/src/lib/utils.ts'];

    const result = analyzeViolationsForExpansion(violations, currentPaths);

    expect(result.canExpand).toBe(true);
    expect(result.addedPaths).toContain('packages/core/src/repos/tickets.ts');
  });

  it('expands for files in same top-level module', () => {
    const violations: ScopeViolation[] = [
      { file: 'src/services/auth.ts', violation: 'not_in_allowed' },
    ];
    const currentPaths = ['src/lib/utils.ts'];

    const result = analyzeViolationsForExpansion(violations, currentPaths);

    expect(result.canExpand).toBe(true);
    expect(result.addedPaths).toContain('src/services/auth.ts');
  });
});

