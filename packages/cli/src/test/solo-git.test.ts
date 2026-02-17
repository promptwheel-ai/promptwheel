import { describe, it, expect, vi, beforeEach } from 'vitest';

// We need to mock child_process.exec properly so that when gitExec does
// `await import('child_process')` and then promisifies exec, it gets our mock.
// The key insight: vi.mock intercepts ALL imports of 'child_process', including
// dynamic imports inside functions.

// Create mock exec/execFile functions that we can control in tests
const mockExec = vi.fn();
const mockExecFile = vi.fn();

vi.mock('child_process', () => ({
  exec: mockExec,
  execFile: mockExecFile,
}));

// Mock node:fs
vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

import * as fs from 'node:fs';
import {
  withGitMutex,
  cleanupWorktree,
  createMilestoneBranch,
  mergeTicketToMilestone,
} from '../lib/solo-git.js';

describe('withGitMutex', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('serializes concurrent operations', async () => {
    const order: number[] = [];
    let resolveFirst: () => void;
    const firstBlocks = new Promise<void>((r) => {
      resolveFirst = r;
    });

    const first = withGitMutex(async () => {
      order.push(1);
      await firstBlocks;
      order.push(2);
      return 'first';
    });

    const second = withGitMutex(async () => {
      order.push(3);
      return 'second';
    });

    // Give microtasks a chance to run - second should not start yet
    await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual([1]);

    resolveFirst!();
    await first;
    await second;

    expect(order).toEqual([1, 2, 3]);
  });

  it('returns the value from the inner function', async () => {
    const result = await withGitMutex(async () => 42);
    expect(result).toBe(42);
  });

  it('propagates errors from inner function', async () => {
    await expect(
      withGitMutex(async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
  });
});

describe('cleanupWorktree', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Mock exec to call its callback with (null, { stdout: '', stderr: '' })
    // This is how the real child_process.exec works
    mockExec.mockImplementation((cmd: string, opts: unknown, callback: Function) => {
      callback(null, { stdout: '', stderr: '' });
    });
  });

  it('calls git worktree remove when path exists', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);

    await cleanupWorktree('/repo', '/repo/.promptwheel/worktrees/test');

    expect(fs.existsSync).toHaveBeenCalledWith('/repo/.promptwheel/worktrees/test');
    expect(mockExec).toHaveBeenCalledWith(
      expect.stringContaining('git worktree remove'),
      expect.objectContaining({ cwd: '/repo' }),
      expect.any(Function)
    );
  });

  it('silently succeeds when path does not exist', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);

    await expect(
      cleanupWorktree('/repo', '/repo/.promptwheel/worktrees/test')
    ).resolves.toBeUndefined();

    expect(mockExec).not.toHaveBeenCalled();
  });

  it('ignores errors from git command', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    mockExec.mockImplementation((cmd: string, opts: unknown, callback: Function) => {
      callback(new Error('git failed'));
    });

    await expect(
      cleanupWorktree('/repo', '/repo/.promptwheel/worktrees/test')
    ).resolves.toBeUndefined();
  });
});

describe('createMilestoneBranch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExec.mockImplementation((cmd: string, opts: unknown, callback: Function) => {
      callback(null, { stdout: '', stderr: '' });
    });
    vi.mocked(fs.existsSync).mockReturnValue(false);
  });

  it('returns branch name and worktree path', async () => {
    const result = await createMilestoneBranch('/repo', 'main');

    expect(result).toHaveProperty('milestoneBranch');
    expect(result).toHaveProperty('milestoneWorktreePath');
    expect(typeof result.milestoneBranch).toBe('string');
    expect(typeof result.milestoneWorktreePath).toBe('string');
  });

  it('branch name starts with promptwheel/milestone-', async () => {
    const result = await createMilestoneBranch('/repo', 'main');

    expect(result.milestoneBranch).toMatch(/^promptwheel\/milestone-/);
  });

  it('creates worktrees directory', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);

    await createMilestoneBranch('/repo', 'main');

    expect(fs.mkdirSync).toHaveBeenCalledWith(
      expect.stringContaining('worktrees'),
      { recursive: true }
    );
  });

  it('fetches origin', async () => {
    await createMilestoneBranch('/repo', 'main');

    expect(mockExec).toHaveBeenCalledWith(
      expect.stringContaining('git fetch origin main'),
      expect.objectContaining({ cwd: '/repo' }),
      expect.any(Function)
    );
  });

  it('creates branch and worktree', async () => {
    await createMilestoneBranch('/repo', 'main');

    // Should create branch from origin/main
    expect(mockExec).toHaveBeenCalledWith(
      expect.stringMatching(/git branch "promptwheel\/milestone-.*" "origin\/main"/),
      expect.objectContaining({ cwd: '/repo' }),
      expect.any(Function)
    );

    // Should add worktree
    expect(mockExec).toHaveBeenCalledWith(
      expect.stringContaining('git worktree add'),
      expect.objectContaining({ cwd: '/repo' }),
      expect.any(Function)
    );
  });
});

describe('mergeTicketToMilestone', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns success on clean merge', async () => {
    // The first merge uses gitExecFile
    mockExecFile.mockImplementation((cmd: string, args: string[], opts: unknown, callback: Function) => {
      callback(null, { stdout: '', stderr: '' });
    });

    const result = await mergeTicketToMilestone(
      '/repo',
      'feature-branch',
      '/repo/.promptwheel/worktrees/_milestone'
    );

    expect(result).toEqual({ success: true, conflicted: false });
  });

  it('returns conflicted when merge fails and rebase fails', async () => {
    // gitExecFile calls: merge (fail), rebase (fail)
    // gitExec calls: merge --abort, rev-parse, rebase --abort, merge --abort
    let execFileCallCount = 0;
    mockExecFile.mockImplementation((cmd: string, args: string[], opts: unknown, callback: Function) => {
      execFileCallCount++;
      if (execFileCallCount === 1) {
        // First merge fails
        callback(new Error('merge conflict'));
      } else if (execFileCallCount === 2) {
        // rebase fails
        callback(new Error('rebase conflict'));
      } else {
        callback(null, { stdout: '', stderr: '' });
      }
    });

    let execCallCount = 0;
    mockExec.mockImplementation((cmd: string, opts: unknown, callback: Function) => {
      execCallCount++;
      if (execCallCount === 1) {
        // merge --abort succeeds
        callback(null, { stdout: '', stderr: '' });
      } else if (execCallCount === 2) {
        // rev-parse returns branch name
        callback(null, { stdout: 'promptwheel/milestone-abc\n', stderr: '' });
      } else {
        // abort commands succeed
        callback(null, { stdout: '', stderr: '' });
      }
    });

    const result = await mergeTicketToMilestone(
      '/repo',
      'feature-branch',
      '/repo/.promptwheel/worktrees/_milestone'
    );

    expect(result).toEqual({ success: false, conflicted: true });
  });

  it('retries with rebase on first failure then succeeds', async () => {
    // gitExecFile calls: merge (fail), rebase (success), second merge (success)
    // gitExec calls: merge --abort, rev-parse
    let execFileCallCount = 0;
    mockExecFile.mockImplementation((cmd: string, args: string[], opts: unknown, callback: Function) => {
      execFileCallCount++;
      if (execFileCallCount === 1) {
        // First merge fails
        callback(new Error('merge conflict'));
      } else {
        // rebase and second merge succeed
        callback(null, { stdout: '', stderr: '' });
      }
    });

    let execCallCount = 0;
    mockExec.mockImplementation((cmd: string, opts: unknown, callback: Function) => {
      execCallCount++;
      if (execCallCount === 1) {
        // merge --abort succeeds
        callback(null, { stdout: '', stderr: '' });
      } else if (execCallCount === 2) {
        // rev-parse returns branch name
        callback(null, { stdout: 'promptwheel/milestone-abc\n', stderr: '' });
      } else {
        callback(null, { stdout: '', stderr: '' });
      }
    });

    const result = await mergeTicketToMilestone(
      '/repo',
      'feature-branch',
      '/repo/.promptwheel/worktrees/_milestone'
    );

    expect(result).toEqual({ success: true, conflicted: false });
  });
});
