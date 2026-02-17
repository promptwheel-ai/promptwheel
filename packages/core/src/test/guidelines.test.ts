/**
 * Guidelines algorithm tests — covers all pure functions in guidelines/shared.ts:
 *   - resolveGuidelinesPaths
 *   - getBaselineFilename
 *   - formatGuidelinesForPrompt
 *   - generateBaselineGuidelines
 *
 * Tests pure functions only (no filesystem).
 */

import { describe, it, expect } from 'vitest';
import {
  resolveGuidelinesPaths,
  getBaselineFilename,
  formatGuidelinesForPrompt,
  generateBaselineGuidelines,
  type ProjectGuidelines,
  type BaselineInput,
} from '../guidelines/shared.js';

// ---------------------------------------------------------------------------
// resolveGuidelinesPaths
// ---------------------------------------------------------------------------

describe('resolveGuidelinesPaths', () => {
  it('returns CLAUDE.md as primary for claude backend', () => {
    const [primary] = resolveGuidelinesPaths('claude');
    expect(primary).toContain('CLAUDE.md');
  });

  it('returns AGENTS.md as primary for codex backend', () => {
    const [primary] = resolveGuidelinesPaths('codex');
    expect(primary).toContain('AGENTS.md');
  });

  it('returns KIMI.md as primary for kimi backend', () => {
    const [primary] = resolveGuidelinesPaths('kimi');
    expect(primary).toContain('KIMI.md');
  });

  it('returns CLAUDE.md as primary for openai-local backend', () => {
    const [primary] = resolveGuidelinesPaths('openai-local');
    expect(primary).toContain('CLAUDE.md');
  });

  it('defaults to claude backend when unspecified', () => {
    const [primary] = resolveGuidelinesPaths();
    expect(primary).toContain('CLAUDE.md');
  });

  it('falls back to CLAUDE.md for unknown backend', () => {
    const [primary] = resolveGuidelinesPaths('unknown-backend');
    expect(primary).toContain('CLAUDE.md');
  });

  it('fallback contains other paths not in primary', () => {
    const [primary, fallback] = resolveGuidelinesPaths('claude');
    // Primary is CLAUDE.md, fallback should include AGENTS.md and others
    expect(fallback.length).toBeGreaterThan(0);
    // No overlap between primary and fallback
    for (const p of primary) {
      expect(fallback).not.toContain(p);
    }
  });

  it('primary and fallback together cover all known paths', () => {
    const [primary, fallback] = resolveGuidelinesPaths('claude');
    const all = [...primary, ...fallback];
    expect(all).toContain('CLAUDE.md');
    expect(all).toContain('AGENTS.md');
    expect(all).toContain('KIMI.md');
  });

  it('returns arrays (not empty) for any backend', () => {
    for (const backend of ['claude', 'codex', 'kimi', 'openai-local', 'random']) {
      const [primary, fallback] = resolveGuidelinesPaths(backend);
      expect(Array.isArray(primary)).toBe(true);
      expect(Array.isArray(fallback)).toBe(true);
      expect(primary.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// getBaselineFilename
// ---------------------------------------------------------------------------

describe('getBaselineFilename', () => {
  it('returns CLAUDE.md for claude backend', () => {
    expect(getBaselineFilename('claude')).toBe('CLAUDE.md');
  });

  it('returns AGENTS.md for codex backend', () => {
    expect(getBaselineFilename('codex')).toBe('AGENTS.md');
  });

  it('returns KIMI.md for kimi backend', () => {
    expect(getBaselineFilename('kimi')).toBe('KIMI.md');
  });

  it('defaults to CLAUDE.md', () => {
    expect(getBaselineFilename()).toBe('CLAUDE.md');
  });

  it('returns CLAUDE.md for unknown backend', () => {
    expect(getBaselineFilename('some-other-backend')).toBe('CLAUDE.md');
  });
});

// ---------------------------------------------------------------------------
// formatGuidelinesForPrompt
// ---------------------------------------------------------------------------

describe('formatGuidelinesForPrompt', () => {
  const guidelines: ProjectGuidelines = {
    content: '# My Project\n\nUse TypeScript.',
    source: 'CLAUDE.md',
    loadedAt: Date.now(),
  };

  it('wraps content in <project-guidelines> tags', () => {
    const result = formatGuidelinesForPrompt(guidelines);
    expect(result).toContain('<project-guidelines>');
    expect(result).toContain('</project-guidelines>');
  });

  it('includes source as HTML comment', () => {
    const result = formatGuidelinesForPrompt(guidelines);
    expect(result).toContain('<!-- Source: CLAUDE.md -->');
  });

  it('includes the guidelines content', () => {
    const result = formatGuidelinesForPrompt(guidelines);
    expect(result).toContain('# My Project');
    expect(result).toContain('Use TypeScript.');
  });

  it('preserves content ordering: tag, source, content, close tag', () => {
    const result = formatGuidelinesForPrompt(guidelines);
    const tagIdx = result.indexOf('<project-guidelines>');
    const sourceIdx = result.indexOf('<!-- Source:');
    const contentIdx = result.indexOf('# My Project');
    const closeIdx = result.indexOf('</project-guidelines>');

    expect(tagIdx).toBeLessThan(sourceIdx);
    expect(sourceIdx).toBeLessThan(contentIdx);
    expect(contentIdx).toBeLessThan(closeIdx);
  });

  it('works with different source names', () => {
    const agentsGuidelines: ProjectGuidelines = {
      content: 'Use Python.',
      source: 'AGENTS.md',
      loadedAt: Date.now(),
    };
    const result = formatGuidelinesForPrompt(agentsGuidelines);
    expect(result).toContain('<!-- Source: AGENTS.md -->');
  });

  it('handles empty content', () => {
    const empty: ProjectGuidelines = {
      content: '',
      source: 'CLAUDE.md',
      loadedAt: Date.now(),
    };
    const result = formatGuidelinesForPrompt(empty);
    expect(result).toContain('<project-guidelines>');
    expect(result).toContain('</project-guidelines>');
  });
});

// ---------------------------------------------------------------------------
// generateBaselineGuidelines
// ---------------------------------------------------------------------------

describe('generateBaselineGuidelines', () => {
  it('includes project name as heading', () => {
    const input: BaselineInput = { projectName: 'my-app' };
    const result = generateBaselineGuidelines(input);
    expect(result).toContain('# my-app');
  });

  it('includes description when provided', () => {
    const input: BaselineInput = {
      projectName: 'my-app',
      description: 'A cool app for cool people.',
    };
    const result = generateBaselineGuidelines(input);
    expect(result).toContain('A cool app for cool people.');
  });

  it('includes TypeScript convention when hasTypeScript is true', () => {
    const input: BaselineInput = {
      projectName: 'my-app',
      hasTypeScript: true,
    };
    const result = generateBaselineGuidelines(input);
    expect(result).toContain('TypeScript');
    expect(result).toContain('strict types');
  });

  it('excludes TypeScript convention when hasTypeScript is false', () => {
    const input: BaselineInput = {
      projectName: 'my-app',
      hasTypeScript: false,
    };
    const result = generateBaselineGuidelines(input);
    expect(result).not.toContain('strict types');
  });

  it('always includes minimal conventions', () => {
    const input: BaselineInput = { projectName: 'my-app' };
    const result = generateBaselineGuidelines(input);
    expect(result).toContain('Keep changes minimal');
    expect(result).toContain('Follow existing code style');
    expect(result).toContain('Do not introduce new dependencies');
  });

  it('includes verification section with lint script', () => {
    const input: BaselineInput = {
      projectName: 'my-app',
      scripts: { lint: 'eslint .' },
    };
    const result = generateBaselineGuidelines(input);
    expect(result).toContain('## Verification');
    expect(result).toContain('npm run lint');
  });

  it('includes verification section with test script', () => {
    const input: BaselineInput = {
      projectName: 'my-app',
      scripts: { test: 'vitest run' },
    };
    const result = generateBaselineGuidelines(input);
    expect(result).toContain('npm test');
  });

  it('includes verification section with build script', () => {
    const input: BaselineInput = {
      projectName: 'my-app',
      scripts: { build: 'tsc' },
    };
    const result = generateBaselineGuidelines(input);
    expect(result).toContain('npm run build');
  });

  it('combines lint and typecheck into one command', () => {
    const input: BaselineInput = {
      projectName: 'my-app',
      scripts: { lint: 'eslint .', typecheck: 'tsc --noEmit' },
    };
    const result = generateBaselineGuidelines(input);
    expect(result).toContain('npm run lint && npm run typecheck');
  });

  it('omits verification section when no scripts', () => {
    const input: BaselineInput = {
      projectName: 'my-app',
      scripts: {},
    };
    const result = generateBaselineGuidelines(input);
    expect(result).not.toContain('## Verification');
  });

  it('includes monorepo section when isMonorepo is true', () => {
    const input: BaselineInput = {
      projectName: 'my-app',
      isMonorepo: true,
    };
    const result = generateBaselineGuidelines(input);
    expect(result).toContain('## Structure');
    expect(result).toContain('monorepo');
    expect(result).toContain('cross-package');
  });

  it('excludes monorepo section when isMonorepo is false', () => {
    const input: BaselineInput = {
      projectName: 'my-app',
      isMonorepo: false,
    };
    const result = generateBaselineGuidelines(input);
    expect(result).not.toContain('## Structure');
  });

  it('includes generated-by header comment', () => {
    const input: BaselineInput = { projectName: 'my-app' };
    const result = generateBaselineGuidelines(input);
    expect(result).toContain('Generated by PromptWheel');
  });

  it('generates complete guidelines with all options', () => {
    const input: BaselineInput = {
      projectName: 'promptwheel',
      description: 'Autonomous coding swarm system.',
      hasTypeScript: true,
      scripts: { lint: 'eslint .', test: 'vitest run', build: 'tsc', typecheck: 'tsc --noEmit' },
      isMonorepo: true,
    };
    const result = generateBaselineGuidelines(input);

    // Has all sections
    expect(result).toContain('# promptwheel');
    expect(result).toContain('Autonomous coding swarm system.');
    expect(result).toContain('## Conventions');
    expect(result).toContain('TypeScript');
    expect(result).toContain('## Verification');
    expect(result).toContain('npm run lint && npm run typecheck');
    expect(result).toContain('npm test');
    expect(result).toContain('npm run build');
    expect(result).toContain('## Structure');
    expect(result).toContain('monorepo');
  });

  it('respects backend parameter (no functional difference currently)', () => {
    const input: BaselineInput = { projectName: 'my-app' };
    const claudeResult = generateBaselineGuidelines(input, 'claude');
    const codexResult = generateBaselineGuidelines(input, 'codex');
    // Currently backend doesn't change output content
    expect(claudeResult).toBe(codexResult);
  });
});
