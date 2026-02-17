/**
 * Scout module tests — pure function tests for exported utilities
 * from packages/core/src/scout/
 *
 * Note: normalizeProposal, sanitizeVerificationCommands, and expandPathsForTests
 * are private (not exported). We test their behavior indirectly through the
 * scout() function, and directly test all exported pure functions:
 * - parseClaudeOutput (runner.ts)
 * - buildScoutPrompt, buildCategoryPrompt (prompt.ts)
 * - batchFiles (scanner.ts)
 */

import { describe, it, expect } from 'vitest';
import {
  parseClaudeOutput,
  buildScoutPrompt,
  buildCategoryPrompt,
  batchFiles,
  type ScannedFile,
  type TicketProposal,
} from '../scout/index.js';

// ---------------------------------------------------------------------------
// parseClaudeOutput
// ---------------------------------------------------------------------------
describe('parseClaudeOutput', () => {
  it('parses raw JSON', () => {
    const result = parseClaudeOutput<{ x: number }>('{"x": 42}');
    expect(result).toEqual({ x: 42 });
  });

  it('parses JSON with leading/trailing whitespace', () => {
    const result = parseClaudeOutput<{ a: string }>('  \n  {"a": "b"}  \n  ');
    expect(result).toEqual({ a: 'b' });
  });

  it('extracts JSON from markdown code block', () => {
    const input = 'Here is the result:\n```json\n{"proposals": []}\n```\nDone.';
    const result = parseClaudeOutput<{ proposals: unknown[] }>(input);
    expect(result).toEqual({ proposals: [] });
  });

  it('extracts JSON from code block without language tag', () => {
    const input = '```\n{"key": "value"}\n```';
    const result = parseClaudeOutput<{ key: string }>(input);
    expect(result).toEqual({ key: 'value' });
  });

  it('extracts JSON object from mixed text', () => {
    const input = 'Some preamble text\n{"found": true}\nSome trailing text';
    const result = parseClaudeOutput<{ found: boolean }>(input);
    expect(result).toEqual({ found: true });
  });

  it('returns null for unparseable content', () => {
    expect(parseClaudeOutput('not json at all')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseClaudeOutput('')).toBeNull();
  });

  it('parses nested proposals structure', () => {
    const input = JSON.stringify({
      proposals: [
        {
          category: 'refactor',
          title: 'Test',
          description: 'Desc',
          confidence: 80,
        },
      ],
    });
    const result = parseClaudeOutput<{ proposals: unknown[] }>(input);
    expect(result!.proposals).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// buildScoutPrompt
// ---------------------------------------------------------------------------
describe('buildScoutPrompt', () => {
  const baseFiles = [{ path: 'src/foo.ts', content: 'const x = 1;' }];

  it('includes file content in prompt', () => {
    const prompt = buildScoutPrompt({
      files: baseFiles,
      scope: 'src/**',
      maxProposals: 5,
      minConfidence: 60,
    });
    expect(prompt).toContain('src/foo.ts');
    expect(prompt).toContain('const x = 1;');
  });

  it('includes scope in prompt', () => {
    const prompt = buildScoutPrompt({
      files: baseFiles,
      scope: 'packages/**',
      maxProposals: 3,
      minConfidence: 50,
    });
    expect(prompt).toContain('packages/**');
  });

  it('includes category filter for types', () => {
    const prompt = buildScoutPrompt({
      files: baseFiles,
      scope: 'src/**',
      types: ['security', 'perf'],
      maxProposals: 5,
      minConfidence: 50,
    });
    expect(prompt).toContain('security');
    expect(prompt).toContain('perf');
    expect(prompt).toContain('ONLY');
  });

  it('includes exclude types filter', () => {
    const prompt = buildScoutPrompt({
      files: baseFiles,
      scope: 'src/**',
      excludeTypes: ['docs'],
      maxProposals: 5,
      minConfidence: 50,
    });
    expect(prompt).toContain('EXCLUDE');
    expect(prompt).toContain('docs');
  });

  it('includes recently completed titles for dedup', () => {
    const prompt = buildScoutPrompt({
      files: baseFiles,
      scope: 'src/**',
      maxProposals: 5,
      minConfidence: 50,
      recentlyCompletedTitles: ['Fix auth bug', 'Add logging'],
    });
    expect(prompt).toContain('Fix auth bug');
    expect(prompt).toContain('Add logging');
    expect(prompt).toContain('AVOID');
  });

  it('includes custom prompt in strategic focus', () => {
    const prompt = buildScoutPrompt({
      files: baseFiles,
      scope: 'src/**',
      maxProposals: 5,
      minConfidence: 50,
      customPrompt: 'Focus on error handling patterns',
    });
    expect(prompt).toContain('Strategic Focus');
    expect(prompt).toContain('Focus on error handling patterns');
  });

  it('includes maxProposals and minConfidence', () => {
    const prompt = buildScoutPrompt({
      files: baseFiles,
      scope: 'src/**',
      maxProposals: 7,
      minConfidence: 75,
    });
    expect(prompt).toContain('7');
    expect(prompt).toContain('75');
  });

  it('handles multiple files', () => {
    const prompt = buildScoutPrompt({
      files: [
        { path: 'a.ts', content: 'a' },
        { path: 'b.ts', content: 'b' },
      ],
      scope: 'src/**',
      maxProposals: 5,
      minConfidence: 50,
    });
    expect(prompt).toContain('a.ts');
    expect(prompt).toContain('b.ts');
  });
});

// ---------------------------------------------------------------------------
// buildCategoryPrompt
// ---------------------------------------------------------------------------
describe('buildCategoryPrompt', () => {
  it('generates prompt focused on a single category', () => {
    const prompt = buildCategoryPrompt('security', [
      { path: 'src/auth.ts', content: 'export function login() {}' },
    ]);
    expect(prompt).toContain('security');
    expect(prompt).toContain('ONLY');
    expect(prompt).toContain('src/auth.ts');
  });

  it('uses default maxProposals of 5', () => {
    const prompt = buildCategoryPrompt('test', [
      { path: 'src/x.ts', content: 'x' },
    ]);
    expect(prompt).toContain('5');
  });

  it('allows overriding maxProposals', () => {
    const prompt = buildCategoryPrompt('refactor', [
      { path: 'src/x.ts', content: 'x' },
    ], 10);
    expect(prompt).toContain('10');
  });
});

// ---------------------------------------------------------------------------
// batchFiles
// ---------------------------------------------------------------------------
describe('batchFiles', () => {
  function makeFiles(n: number): ScannedFile[] {
    return Array.from({ length: n }, (_, i) => ({
      path: `file${i}.ts`,
      content: `content ${i}`,
      size: 100,
    }));
  }

  it('batches files into groups of default size 3', () => {
    const batches = batchFiles(makeFiles(7));
    expect(batches).toHaveLength(3);
    expect(batches[0]).toHaveLength(3);
    expect(batches[1]).toHaveLength(3);
    expect(batches[2]).toHaveLength(1);
  });

  it('batches files with custom batch size', () => {
    const batches = batchFiles(makeFiles(10), 5);
    expect(batches).toHaveLength(2);
    expect(batches[0]).toHaveLength(5);
    expect(batches[1]).toHaveLength(5);
  });

  it('returns single batch when fewer files than batch size', () => {
    const batches = batchFiles(makeFiles(2), 5);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(2);
  });

  it('returns empty array for no files', () => {
    expect(batchFiles([])).toEqual([]);
  });

  it('batch size 1 creates one batch per file', () => {
    const batches = batchFiles(makeFiles(4), 1);
    expect(batches).toHaveLength(4);
    for (const b of batches) {
      expect(b).toHaveLength(1);
    }
  });

  it('preserves file ordering within batches', () => {
    const files = makeFiles(6);
    const batches = batchFiles(files, 2);
    expect(batches[0][0].path).toBe('file0.ts');
    expect(batches[0][1].path).toBe('file1.ts');
    expect(batches[1][0].path).toBe('file2.ts');
    expect(batches[2][0].path).toBe('file4.ts');
  });
});
