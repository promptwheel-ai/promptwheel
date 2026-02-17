import { describe, it, expect } from 'vitest';
import {
  formatDuration,
  formatRelativeTime,
  pathsOverlap,
  expandPathsForTests,
  regenerateAllowedPaths,
  normalizeQaConfig,
} from '../lib/solo-utils.js';

describe('formatDuration', () => {
  it('returns "500ms" for < 1000', () => {
    expect(formatDuration(500)).toBe('500ms');
  });

  it('returns "1.5s" for 1500', () => {
    expect(formatDuration(1500)).toBe('1.5s');
  });

  it('returns "2.5m" for 150000', () => {
    expect(formatDuration(150000)).toBe('2.5m');
  });

  it('returns "0ms" for 0', () => {
    expect(formatDuration(0)).toBe('0ms');
  });
});

describe('formatRelativeTime', () => {
  it('returns "just now" for < 60s ago', () => {
    const date = new Date(Date.now() - 30000);
    expect(formatRelativeTime(date)).toBe('just now');
  });

  it('returns "Xm ago" for minutes', () => {
    const date = new Date(Date.now() - 5 * 60000);
    expect(formatRelativeTime(date)).toBe('5m ago');
  });

  it('returns "Xh ago" for hours', () => {
    const date = new Date(Date.now() - 3 * 3600000);
    expect(formatRelativeTime(date)).toBe('3h ago');
  });

  it('returns "Xd ago" for days', () => {
    const date = new Date(Date.now() - 2 * 86400000);
    expect(formatRelativeTime(date)).toBe('2d ago');
  });
});

describe('pathsOverlap', () => {
  it('exact match returns true', () => {
    expect(pathsOverlap('src/lib', 'src/lib')).toBe(true);
  });

  it('"src/lib" and "src/lib/utils.ts" returns true (containment)', () => {
    expect(pathsOverlap('src/lib', 'src/lib/utils.ts')).toBe(true);
  });

  it('"src/lib" and "src/other" returns false', () => {
    expect(pathsOverlap('src/lib', 'src/other')).toBe(false);
  });

  it('"./src/lib" and "src/lib" returns true (normalized)', () => {
    expect(pathsOverlap('./src/lib', 'src/lib')).toBe(true);
  });

  it('"src/lib/" and "src/lib" returns true (trailing slash)', () => {
    expect(pathsOverlap('src/lib/', 'src/lib')).toBe(true);
  });

  it('"src/**/*.ts" and "src/utils.ts" returns true (glob base overlap)', () => {
    expect(pathsOverlap('src/**/*.ts', 'src/utils.ts')).toBe(true);
  });

  it('"src/*" and "pkg/*" returns false', () => {
    expect(pathsOverlap('src/*', 'pkg/*')).toBe(false);
  });

  it('empty strings match each other', () => {
    expect(pathsOverlap('', '')).toBe(true);
  });
});

describe('expandPathsForTests', () => {
  it('adds .test and .spec variants', () => {
    const result = expandPathsForTests(['src/lib/utils.ts']);
    expect(result).toContain('src/lib/utils.test.ts');
    expect(result).toContain('src/lib/utils.spec.ts');
  });

  it('adds __tests__ variants', () => {
    const result = expandPathsForTests(['src/lib/utils.ts']);
    expect(result).toContain('src/lib/__tests__/utils.test.ts');
    expect(result).toContain('src/lib/__tests__/utils.ts');
  });

  it('adds src/test/ variants for src/ paths', () => {
    const result = expandPathsForTests(['src/lib/utils.ts']);
    expect(result).toContain('src/test/lib/utils.test.ts');
  });

  it('skips already-test files', () => {
    const result = expandPathsForTests(['src/lib/utils.test.ts']);
    // The original file should be included, but no double .test.test variants
    expect(result).toContain('src/lib/utils.test.ts');
    expect(result).not.toContain('src/lib/utils.test.test.ts');
  });

  it('handles files without directory', () => {
    const result = expandPathsForTests(['utils.ts']);
    expect(result).toContain('utils.ts');
    expect(result).toContain('utils.test.ts');
    expect(result).toContain('utils.spec.ts');
  });

  it('handles files without extension', () => {
    const result = expandPathsForTests(['src/Makefile']);
    expect(result).toContain('src/Makefile');
    expect(result).toContain('src/Makefile.test');
    expect(result).toContain('src/Makefile.spec');
  });
});

describe('regenerateAllowedPaths', () => {
  const makeTicket = (paths: string[], category = 'refactor') =>
    ({
      id: 'tkt_1',
      projectId: 'prj_1',
      title: 'Test',
      description: 'Test',
      priority: 2,
      status: 'ready' as const,
      category,
      allowedPaths: paths,
      forbiddenPaths: [],
      retryCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    }) as any;

  it('returns empty for empty paths', () => {
    expect(regenerateAllowedPaths(makeTicket([]))).toEqual([]);
  });

  it('adds package.json for test category', () => {
    const result = regenerateAllowedPaths(makeTicket(['src/lib/utils.ts'], 'test'));
    expect(result).toContain('package.json');
    expect(result).toContain('package-lock.json');
  });

  it('returns original paths for non-test category', () => {
    const paths = ['src/lib/utils.ts'];
    const result = regenerateAllowedPaths(makeTicket(paths, 'refactor'));
    expect(result).toEqual(paths);
  });

  it('expands test paths for test category', () => {
    const result = regenerateAllowedPaths(makeTicket(['src/lib/utils.ts'], 'test'));
    expect(result).toContain('src/lib/utils.test.ts');
    expect(result).toContain('src/lib/utils.spec.ts');
  });
});

describe('normalizeQaConfig', () => {
  const makeConfig = (qa?: any) => ({ qa }) as any;

  it('throws for missing commands', () => {
    expect(() => normalizeQaConfig(makeConfig())).toThrow('QA is not configured');
  });

  it('throws for empty commands array', () => {
    expect(() => normalizeQaConfig(makeConfig({ commands: [] }))).toThrow('QA is not configured');
  });

  it('maps commands correctly with defaults', () => {
    const config = makeConfig({
      commands: [{ name: 'lint', cmd: 'npm run lint' }],
    });
    const result = normalizeQaConfig(config);
    expect(result.commands).toEqual([
      { name: 'lint', cmd: 'npm run lint', cwd: '.', timeoutMs: undefined },
    ]);
  });

  it('respects custom timeoutMs', () => {
    const config = makeConfig({
      commands: [{ name: 'test', cmd: 'npm test', timeoutMs: 30000 }],
    });
    const result = normalizeQaConfig(config);
    expect(result.commands[0].timeoutMs).toBe(30000);
  });

  it('converts timeoutSec to timeoutMs', () => {
    const config = makeConfig({
      commands: [{ name: 'test', cmd: 'npm test', timeoutSec: 60 }],
    });
    const result = normalizeQaConfig(config);
    expect(result.commands[0].timeoutMs).toBe(60000);
  });

  it('sets default artifact config', () => {
    const config = makeConfig({
      commands: [{ name: 'test', cmd: 'npm test' }],
    });
    const result = normalizeQaConfig(config);
    expect(result.artifacts).toEqual({
      dir: '.promptwheel/artifacts',
      maxLogBytes: 200_000,
      tailBytes: 16_384,
    });
  });

  it('respects retry config', () => {
    const config = makeConfig({
      commands: [{ name: 'test', cmd: 'npm test' }],
      retry: { enabled: true, maxAttempts: 3 },
    });
    const result = normalizeQaConfig(config);
    expect(result.retry).toEqual({ enabled: true, maxAttempts: 3 });
  });

  it('override maxAttempts enables retry', () => {
    const config = makeConfig({
      commands: [{ name: 'test', cmd: 'npm test' }],
    });
    const result = normalizeQaConfig(config, { maxAttempts: 5 });
    expect(result.retry).toEqual({ enabled: true, maxAttempts: 5 });
  });
});
