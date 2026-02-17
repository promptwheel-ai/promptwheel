import { describe, it, expect } from 'vitest';
import { expandPathsForTests } from '../lib/solo-utils.js';

// ---------------------------------------------------------------------------
// expandPathsForTests
// ---------------------------------------------------------------------------

describe('expandPathsForTests', () => {
  // ---------------------------------------------------------------------------
  // Basic expansion
  // ---------------------------------------------------------------------------

  it('returns original paths plus test variants', () => {
    const result = expandPathsForTests(['src/lib/utils.ts']);
    expect(result).toContain('src/lib/utils.ts');
    expect(result).toContain('src/lib/utils.test.ts');
    expect(result).toContain('src/lib/utils.spec.ts');
  });

  it('adds __tests__ directory variants', () => {
    const result = expandPathsForTests(['src/lib/utils.ts']);
    expect(result).toContain('src/lib/__tests__/utils.test.ts');
    expect(result).toContain('src/lib/__tests__/utils.ts');
  });

  it('adds src/test/ directory variants for src/ prefixed paths', () => {
    const result = expandPathsForTests(['src/lib/utils.ts']);
    expect(result).toContain('src/test/lib/utils.test.ts');
    expect(result).toContain('test/lib/utils.test.ts');
    expect(result).toContain('tests/lib/utils.test.ts');
  });

  it('adds global test directory variants', () => {
    const result = expandPathsForTests(['src/lib/utils.ts']);
    expect(result).toContain('src/test/utils.test.ts');
    expect(result).toContain('test/utils.test.ts');
    expect(result).toContain('tests/utils.test.ts');
    expect(result).toContain('__tests__/utils.test.ts');
  });

  // ---------------------------------------------------------------------------
  // Test files are NOT re-expanded
  // ---------------------------------------------------------------------------

  it('does not re-expand .test. files', () => {
    const result = expandPathsForTests(['src/foo.test.ts']);
    // Should include the original but not generate .test.test.ts
    expect(result).toContain('src/foo.test.ts');
    expect(result).not.toContain('src/foo.test.test.ts');
  });

  it('does not re-expand .spec. files', () => {
    const result = expandPathsForTests(['src/foo.spec.ts']);
    expect(result).toContain('src/foo.spec.ts');
    expect(result).not.toContain('src/foo.spec.test.ts');
  });

  it('does not re-expand __tests__ files', () => {
    const result = expandPathsForTests(['src/__tests__/foo.ts']);
    expect(result).toContain('src/__tests__/foo.ts');
    expect(result).not.toContain('src/__tests__/foo.test.ts');
  });

  // ---------------------------------------------------------------------------
  // Multiple input paths
  // ---------------------------------------------------------------------------

  it('expands multiple paths', () => {
    const result = expandPathsForTests(['src/a.ts', 'src/b.ts']);
    expect(result).toContain('src/a.ts');
    expect(result).toContain('src/a.test.ts');
    expect(result).toContain('src/b.ts');
    expect(result).toContain('src/b.test.ts');
  });

  // ---------------------------------------------------------------------------
  // Deduplication
  // ---------------------------------------------------------------------------

  it('deduplicates paths', () => {
    const result = expandPathsForTests(['src/a.ts', 'src/a.ts']);
    const count = result.filter(p => p === 'src/a.ts').length;
    expect(count).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // Different extensions
  // ---------------------------------------------------------------------------

  it('preserves .tsx extension in test variants', () => {
    const result = expandPathsForTests(['src/Button.tsx']);
    expect(result).toContain('src/Button.test.tsx');
    expect(result).toContain('src/Button.spec.tsx');
  });

  it('preserves .js extension in test variants', () => {
    const result = expandPathsForTests(['lib/helper.js']);
    expect(result).toContain('lib/helper.test.js');
    expect(result).toContain('lib/helper.spec.js');
  });

  // ---------------------------------------------------------------------------
  // Files without directory prefix
  // ---------------------------------------------------------------------------

  it('handles files without directory', () => {
    const result = expandPathsForTests(['index.ts']);
    expect(result).toContain('index.ts');
    expect(result).toContain('index.test.ts');
    expect(result).toContain('index.spec.ts');
  });

  // ---------------------------------------------------------------------------
  // Non-src/ prefixed paths
  // ---------------------------------------------------------------------------

  it('does not add src/test/ variants for non-src paths', () => {
    const result = expandPathsForTests(['lib/utils.ts']);
    // Should have general test dir variants but NOT src/test/lib/ variants
    expect(result).toContain('lib/utils.test.ts');
    expect(result).toContain('test/utils.test.ts');
    expect(result).not.toContain('src/test/lib/utils.test.ts');
  });

  // ---------------------------------------------------------------------------
  // Empty input
  // ---------------------------------------------------------------------------

  it('returns empty array for empty input', () => {
    expect(expandPathsForTests([])).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // Nested src/ paths
  // ---------------------------------------------------------------------------

  it('handles deeply nested src/ paths', () => {
    const result = expandPathsForTests(['src/components/ui/Button.tsx']);
    expect(result).toContain('src/test/components/ui/Button.test.tsx');
    expect(result).toContain('test/components/ui/Button.test.tsx');
    expect(result).toContain('tests/components/ui/Button.test.tsx');
  });

  // ---------------------------------------------------------------------------
  // src/ direct child
  // ---------------------------------------------------------------------------

  it('handles src/ direct child', () => {
    const result = expandPathsForTests(['src/index.ts']);
    expect(result).toContain('src/index.test.ts');
    expect(result).toContain('src/test/index.test.ts');
  });
});
