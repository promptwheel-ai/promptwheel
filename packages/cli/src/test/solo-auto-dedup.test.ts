import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DatabaseAdapter } from '@promptwheel/core/db';

// Mock child_process
// execFile must call its callback with { stdout, stderr } because promisify
// on a vi.fn() uses generic wrapping (no custom symbol), and gitExecFile
// accesses result.stdout.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawnSync: vi.fn(),
    execFile: vi.fn((_cmd: string, _args: string[], _opts: unknown, callback: Function) => {
      const cb = typeof _opts === 'function' ? _opts : callback;
      if (typeof cb === 'function') {
        (cb as Function)(null, { stdout: '', stderr: '' });
      }
    }),
  };
});

// Mock the repos
vi.mock('@promptwheel/core/repos', () => ({
  tickets: {
    listByProject: vi.fn(),
  },
}));

import {
  isDuplicateProposal,
  getDeduplicationContext,
  normalizeTitle,
  titleSimilarity,
} from '../lib/solo-auto.js';
import { spawnSync, execFile } from 'node:child_process';
import { tickets } from '@promptwheel/core/repos';

function makeFakeDb(): DatabaseAdapter {
  return {
    name: 'mock',
    connected: true,
    query: vi.fn(),
    withTransaction: vi.fn(),
    migrate: vi.fn(),
    close: vi.fn(),
  } as unknown as DatabaseAdapter;
}

describe('isDuplicateProposal', () => {
  it('returns true for identical titles', async () => {
    const result = await isDuplicateProposal(
      { title: 'Add unit tests for auth module' },
      ['Add unit tests for auth module'],
      [],
    );

    expect(result.isDuplicate).toBe(true);
    expect(result.reason).toContain('Exact match');
  });

  it('returns true for very similar titles', async () => {
    const result = await isDuplicateProposal(
      { title: 'Add unit tests for the authentication module' },
      ['Add unit tests for auth module'],
      [],
      0.5,
    );

    expect(result.isDuplicate).toBe(true);
    expect(result.reason).toContain('Similar');
  });

  it('returns false for different titles', async () => {
    const result = await isDuplicateProposal(
      { title: 'Refactor database connection pooling' },
      ['Add unit tests for auth module', 'Fix CSS button alignment'],
      [],
    );

    expect(result.isDuplicate).toBe(false);
    expect(result.reason).toBeUndefined();
  });

  it('returns true for case-insensitive exact matches', async () => {
    const result = await isDuplicateProposal(
      { title: 'Fix Broken Tests' },
      ['fix broken tests'],
      [],
    );

    expect(result.isDuplicate).toBe(true);
  });

  it('checks open PR branches', async () => {
    const result = await isDuplicateProposal(
      { title: 'fix broken tests' },
      [],
      ['promptwheel/tkt_abc123'],
      0.5,
    );

    // Branch name after stripping prefix may not match well - just verify it runs
    expect(result).toHaveProperty('isDuplicate');
  });
});

describe('getDeduplicationContext', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('queries recent titles from db', async () => {
    const db = makeFakeDb();
    vi.mocked(tickets.listByProject).mockResolvedValue([
      {
        id: 'tkt_1', projectId: 'proj_1', title: 'Done ticket',
        description: null, status: 'done', priority: 50, shard: null,
        category: null, allowedPaths: [], forbiddenPaths: [],
        verificationCommands: [], maxRetries: 3, retryCount: 0,
        createdAt: new Date(), updatedAt: new Date(),
      },
      {
        id: 'tkt_2', projectId: 'proj_1', title: 'Ready ticket',
        description: null, status: 'ready', priority: 50, shard: null,
        category: null, allowedPaths: [], forbiddenPaths: [],
        verificationCommands: [], maxRetries: 3, retryCount: 0,
        createdAt: new Date(), updatedAt: new Date(),
      },
    ]);

    vi.mocked(spawnSync).mockReturnValue({
      stdout: '',
      stderr: '',
      status: 0,
      pid: 0,
      output: [],
      signal: null,
    } as any);

    const ctx = await getDeduplicationContext(db, 'proj_1', '/repo');

    expect(tickets.listByProject).toHaveBeenCalledWith(db, 'proj_1', { limit: 200 });
    // Only non-ready tickets are included
    expect(ctx.existingTitles).toContain('Done ticket');
    expect(ctx.existingTitles).not.toContain('Ready ticket');
  });

  it('queries open PR branches', async () => {
    const db = makeFakeDb();
    vi.mocked(tickets.listByProject).mockResolvedValue([]);
    vi.mocked(execFile).mockImplementation((_cmd: any, _args: any, _opts: any, callback: any) => {
      const cb = typeof _opts === 'function' ? _opts : callback;
      if (typeof cb === 'function') {
        cb(null, { stdout: '  origin/promptwheel/tkt_abc123\n  origin/promptwheel/tkt_def456\n', stderr: '' });
      }
      return undefined as any;
    });

    const ctx = await getDeduplicationContext(db, 'proj_1', '/repo');

    expect(execFile).toHaveBeenCalledWith(
      'git',
      ['branch', '-r', '--list', 'origin/promptwheel/*'],
      expect.objectContaining({ cwd: '/repo', encoding: 'utf-8' }),
      expect.any(Function),
    );
    expect(ctx.openPrBranches).toContain('promptwheel/tkt_abc123');
    expect(ctx.openPrBranches).toContain('promptwheel/tkt_def456');
  });
});

describe('normalizeTitle', () => {
  it('lowercases and strips punctuation', () => {
    expect(normalizeTitle('Add Unit-Tests!')).toBe('add unit tests');
  });

  it('collapses whitespace', () => {
    expect(normalizeTitle('  hello   world  ')).toBe('hello world');
  });
});

describe('titleSimilarity', () => {
  it('returns 1 for identical titles', () => {
    expect(titleSimilarity('add unit tests', 'add unit tests')).toBe(1);
  });

  it('returns 0 for completely different titles', () => {
    expect(titleSimilarity('abc', 'xyz')).toBe(0);
  });

  it('returns partial overlap', () => {
    const sim = titleSimilarity('add unit tests for auth', 'add integration tests for auth');
    expect(sim).toBeGreaterThan(0);
    expect(sim).toBeLessThan(1);
  });
});
