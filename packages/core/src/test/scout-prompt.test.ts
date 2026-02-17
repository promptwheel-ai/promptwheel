import { describe, it, expect } from 'vitest';
import { buildScoutPrompt, buildCategoryPrompt } from '../scout/prompt.js';

describe('buildScoutPrompt', () => {
  const baseOptions = {
    files: [{ path: 'src/index.ts', content: 'console.log("hello")' }],
    scope: 'src/**/*.ts',
    maxProposals: 10,
    minConfidence: 70,
  };

  it('returns string containing scope, maxProposals, minConfidence', () => {
    const result = buildScoutPrompt(baseOptions);
    expect(result).toContain('"src/**/*.ts"');
    expect(result).toContain('10');
    expect(result).toContain('70');
  });

  it('with types filter includes "Focus ONLY on these categories"', () => {
    const result = buildScoutPrompt({ ...baseOptions, types: ['refactor', 'test'] });
    expect(result).toContain('Focus ONLY on these categories: refactor, test');
  });

  it('with excludeTypes includes "EXCLUDE these categories"', () => {
    const result = buildScoutPrompt({ ...baseOptions, excludeTypes: ['docs', 'perf'] });
    expect(result).toContain('EXCLUDE these categories: docs, perf');
  });

  it('with no type filters includes "Consider all categories"', () => {
    const result = buildScoutPrompt(baseOptions);
    expect(result).toContain('Consider all categories');
  });

  it('includes file contents formatted as markdown', () => {
    const result = buildScoutPrompt(baseOptions);
    expect(result).toContain('### src/index.ts');
    expect(result).toContain('```\nconsole.log("hello")\n```');
  });

  it('with customPrompt includes Strategic Focus section', () => {
    const result = buildScoutPrompt({ ...baseOptions, customPrompt: 'Focus on error handling' });
    expect(result).toContain('## Strategic Focus');
    expect(result).toContain('Focus on error handling');
  });

  it('with recentlyCompletedTitles includes avoidance text', () => {
    const result = buildScoutPrompt({
      ...baseOptions,
      recentlyCompletedTitles: ['Fix auth bug', 'Add logging'],
    });
    expect(result).toContain('AVOID proposing work similar to these recently completed tickets');
    expect(result).toContain('- Fix auth bug');
    expect(result).toContain('- Add logging');
  });

  it('with empty files array still returns valid prompt', () => {
    const result = buildScoutPrompt({ ...baseOptions, files: [] });
    expect(typeof result).toBe('string');
    expect(result).toContain('scope');
    expect(result).toContain('## Files to Analyze');
  });
});

describe('buildCategoryPrompt', () => {
  const files = [{ path: 'a.ts', content: 'code' }];

  it('calls buildScoutPrompt with correct defaults', () => {
    const result = buildCategoryPrompt('refactor', files);
    expect(result).toContain('Focus ONLY on these categories: refactor');
  });

  it('uses scope "*" and minConfidence 50', () => {
    const result = buildCategoryPrompt('test', files);
    expect(result).toContain('"*"');
    expect(result).toContain('confidence >= 50');
  });

  it('respects custom maxProposals', () => {
    const result = buildCategoryPrompt('docs', files, 3);
    expect(result).toContain('at most 3 proposals');
  });

  it('sets types to single category array', () => {
    const result = buildCategoryPrompt('security', files);
    expect(result).toContain('Focus ONLY on these categories: security');
    expect(result).not.toContain('Consider all categories');
  });

  it.each(['refactor', 'test', 'security', 'docs', 'perf'] as const)(
    'works with category "%s"',
    (category) => {
      const result = buildCategoryPrompt(category, files);
      expect(result).toContain(`Focus ONLY on these categories: ${category}`);
    },
  );
});
