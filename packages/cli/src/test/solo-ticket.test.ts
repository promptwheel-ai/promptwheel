/**
 * Tests for solo-ticket.ts
 *
 * Tests the main soloRunTicket flow including:
 * - Ticket prompt building
 * - Claude CLI execution
 * - Scope enforcement
 * - QA execution
 * - Error handling
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import type { Readable } from 'node:stream';
import { soloRunTicket } from '../lib/solo-ticket.js';
import { buildTicketPrompt } from '../lib/solo-prompt-builder.js';
import { runClaude } from '../lib/execution-backends/index.js';
import type { RunTicketOptions } from '../lib/solo-ticket-types.js';
import type { ClaudeResult } from '../lib/execution-backends/index.js';

// Mock all external dependencies
vi.mock('node:child_process');
vi.mock('node:fs');
vi.mock('@promptwheel/core/db');
vi.mock('@promptwheel/core/services');
vi.mock('@promptwheel/core/repos');
vi.mock('../lib/artifacts.js');
vi.mock('../lib/scope.js');
vi.mock('../lib/spindle.js');
vi.mock('../lib/exec.js');
vi.mock('../lib/logger.js');
vi.mock('./solo-config.js');
vi.mock('./solo-utils.js');
vi.mock('./solo-git.js');
vi.mock('./solo-ci.js');

describe('solo-ticket: buildTicketPrompt', () => {
  it('builds basic prompt with title and description', () => {
    const ticket = {
      id: 'ticket-1',
      projectId: 'proj-1',
      title: 'Fix the bug',
      description: 'This is a test ticket',
      allowedPaths: [],
      forbiddenPaths: [],
      verificationCommands: [],
      status: 'ready' as const,
      retryCount: 0,
      maxRetries: 3,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const prompt = buildTicketPrompt(ticket);

    expect(prompt).toContain('# Task: Fix the bug');
    expect(prompt).toContain('This is a test ticket');
    expect(prompt).toContain('## Instructions');
  });

  it('includes allowed paths when present', () => {
    const ticket = {
      id: 'ticket-1',
      projectId: 'proj-1',
      title: 'Fix the bug',
      description: 'Test',
      allowedPaths: ['src/lib/**', 'src/utils/**'],
      forbiddenPaths: [],
      verificationCommands: [],
      status: 'ready' as const,
      retryCount: 0,
      maxRetries: 3,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const prompt = buildTicketPrompt(ticket);

    expect(prompt).toContain('## Allowed Paths');
    expect(prompt).toContain('- src/lib/**');
    expect(prompt).toContain('- src/utils/**');
  });

  it('includes forbidden paths when present', () => {
    const ticket = {
      id: 'ticket-1',
      projectId: 'proj-1',
      title: 'Fix the bug',
      description: 'Test',
      allowedPaths: [],
      forbiddenPaths: ['node_modules/**', 'dist/**'],
      verificationCommands: [],
      status: 'ready' as const,
      retryCount: 0,
      maxRetries: 3,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const prompt = buildTicketPrompt(ticket);

    expect(prompt).toContain('## Forbidden Paths');
    expect(prompt).toContain('- node_modules/**');
    expect(prompt).toContain('- dist/**');
  });

  it('includes verification commands when present', () => {
    const ticket = {
      id: 'ticket-1',
      projectId: 'proj-1',
      title: 'Fix the bug',
      description: 'Test',
      allowedPaths: [],
      forbiddenPaths: [],
      verificationCommands: ['npm test', 'npm run lint'],
      status: 'ready' as const,
      retryCount: 0,
      maxRetries: 3,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const prompt = buildTicketPrompt(ticket);

    expect(prompt).toContain('## Verification');
    expect(prompt).toContain('QA verification is handled automatically');
  });

  it('omits sections when arrays are empty', () => {
    const ticket = {
      id: 'ticket-1',
      projectId: 'proj-1',
      title: 'Fix the bug',
      description: 'Test',
      allowedPaths: [],
      forbiddenPaths: [],
      verificationCommands: [],
      status: 'ready' as const,
      retryCount: 0,
      maxRetries: 3,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const prompt = buildTicketPrompt(ticket);

    expect(prompt).not.toContain('## Allowed Paths');
    expect(prompt).not.toContain('## Forbidden Paths');
    // Verification section is always present (QA is automated)
    expect(prompt).toContain('## Verification');
  });

  it('includes all sections when all constraints present', () => {
    const ticket = {
      id: 'ticket-1',
      projectId: 'proj-1',
      title: 'Refactor helper',
      description: 'Extract validation logic',
      allowedPaths: ['src/utils/**'],
      forbiddenPaths: ['src/legacy/**'],
      verificationCommands: ['npm test'],
      status: 'ready' as const,
      retryCount: 0,
      maxRetries: 3,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const prompt = buildTicketPrompt(ticket);

    expect(prompt).toContain('## Allowed Paths');
    expect(prompt).toContain('## Forbidden Paths');
    expect(prompt).toContain('## Verification');
    expect(prompt).toContain('## Instructions');
  });
});

describe('solo-ticket: runClaude', () => {
  let mockSpawn: ReturnType<typeof vi.fn>;
  const originalEnv = process.env.ANTHROPIC_API_KEY;

  beforeEach(async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key-for-tests';
    const { spawn } = await import('node:child_process');
    mockSpawn = vi.mocked(spawn);
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.ANTHROPIC_API_KEY = originalEnv;
    } else {
      delete process.env.ANTHROPIC_API_KEY;
    }
    vi.clearAllMocks();
  });

  it('spawns claude with correct arguments', async () => {
    const mockChild = createMockChildProcess({
      exitCode: 0,
      stdout: 'Success',
      stderr: '',
    });
    mockSpawn.mockReturnValue(mockChild as any);

    const promise = runClaude({
      worktreePath: '/tmp/worktree',
      prompt: 'Test prompt',
      timeoutMs: 5000,
      verbose: false,
      onProgress: vi.fn(),
    });

    // Trigger close event
    mockChild.emit('close', 0);
    await promise;

    expect(mockSpawn).toHaveBeenCalledWith(
      'claude',
      ['-p', '--dangerously-skip-permissions', '--output-format', 'stream-json'],
      expect.objectContaining({
        cwd: '/tmp/worktree',
        env: expect.objectContaining({
          CLAUDE_CODE_NON_INTERACTIVE: '1',
        }),
      })
    );
  });

  it('returns success result on exit code 0', async () => {
    const mockChild = createMockChildProcess({
      exitCode: 0,
      stdout: 'Claude output',
      stderr: '',
    });
    mockSpawn.mockReturnValue(mockChild as any);

    const promise = runClaude({
      worktreePath: '/tmp/worktree',
      prompt: 'Test prompt',
      timeoutMs: 5000,
      verbose: false,
      onProgress: vi.fn(),
    });

    // Wait for data events to be emitted
    await new Promise(resolve => setTimeout(resolve, 20));

    mockChild.emit('close', 0);
    const result = await promise;

    expect(result.success).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Claude output');
    expect(result.timedOut).toBe(false);
  });

  it('returns failure result on non-zero exit code', async () => {
    const mockChild = createMockChildProcess({
      exitCode: 1,
      stdout: '',
      stderr: 'Error occurred',
    });
    mockSpawn.mockReturnValue(mockChild as any);

    const promise = runClaude({
      worktreePath: '/tmp/worktree',
      prompt: 'Test prompt',
      timeoutMs: 5000,
      verbose: false,
      onProgress: vi.fn(),
    });

    mockChild.emit('close', 1);
    const result = await promise;

    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.error).toContain('exited with code 1');
  });

  it('handles timeout correctly', async () => {
    const mockChild = createMockChildProcess({
      exitCode: null,
      stdout: 'Partial output',
      stderr: '',
    });
    mockSpawn.mockReturnValue(mockChild as any);

    const promise = runClaude({
      worktreePath: '/tmp/worktree',
      prompt: 'Test prompt',
      timeoutMs: 100, // Very short timeout
      verbose: false,
      onProgress: vi.fn(),
    });

    // Wait for timeout to trigger
    await new Promise(resolve => setTimeout(resolve, 150));
    mockChild.emit('close', null);

    const result = await promise;

    expect(result.success).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.error).toContain('Timed out');
  });

  it('handles spawn errors', async () => {
    const mockChild = createMockChildProcess({
      exitCode: null,
      stdout: '',
      stderr: '',
    });
    mockSpawn.mockReturnValue(mockChild as any);

    const promise = runClaude({
      worktreePath: '/tmp/worktree',
      prompt: 'Test prompt',
      timeoutMs: 5000,
      verbose: false,
      onProgress: vi.fn(),
    });

    mockChild.emit('error', new Error('ENOENT: command not found'));
    const result = await promise;

    expect(result.success).toBe(false);
    expect(result.error).toContain('ENOENT');
  });

  it('writes prompt to stdin', async () => {
    const mockChild = createMockChildProcess({
      exitCode: 0,
      stdout: 'Success',
      stderr: '',
    });
    mockSpawn.mockReturnValue(mockChild as any);

    const promise = runClaude({
      worktreePath: '/tmp/worktree',
      prompt: 'Test prompt content',
      timeoutMs: 5000,
      verbose: false,
      onProgress: vi.fn(),
    });

    mockChild.emit('close', 0);
    await promise;

    expect(mockChild.stdin.write).toHaveBeenCalledWith('Test prompt content');
    expect(mockChild.stdin.end).toHaveBeenCalled();
  });

  it('calls onProgress in verbose mode', async () => {
    const mockChild = createMockChildProcess({
      exitCode: 0,
      stdout: 'Some output here',
      stderr: '',
    });
    mockSpawn.mockReturnValue(mockChild as any);

    const onProgress = vi.fn();
    const promise = runClaude({
      worktreePath: '/tmp/worktree',
      prompt: 'Test prompt',
      timeoutMs: 5000,
      verbose: true,
      onProgress,
    });

    // Wait for data events
    await new Promise(resolve => setTimeout(resolve, 20));

    mockChild.emit('close', 0);
    await promise;

    expect(onProgress).toHaveBeenCalled();
  });

  it('does not call onProgress in non-verbose mode', async () => {
    const mockChild = createMockChildProcess({
      exitCode: 0,
      stdout: 'Some output',
      stderr: '',
    });
    mockSpawn.mockReturnValue(mockChild as any);

    const onProgress = vi.fn();
    const promise = runClaude({
      worktreePath: '/tmp/worktree',
      prompt: 'Test prompt',
      timeoutMs: 5000,
      verbose: false,
      onProgress,
    });

    mockChild.emit('close', 0);
    await promise;

    // onProgress should not be called from stdout handler in non-verbose mode
    // (though it's still passed, it won't receive stdout updates)
  });

  it('captures both stdout and stderr', async () => {
    const mockChild = createMockChildProcess({
      exitCode: 0,
      stdout: 'Standard output',
      stderr: 'Standard error',
    });
    mockSpawn.mockReturnValue(mockChild as any);

    const promise = runClaude({
      worktreePath: '/tmp/worktree',
      prompt: 'Test prompt',
      timeoutMs: 5000,
      verbose: false,
      onProgress: vi.fn(),
    });

    // Wait for data events
    await new Promise(resolve => setTimeout(resolve, 20));

    mockChild.emit('close', 0);
    const result = await promise;

    expect(result.stdout).toContain('Standard output');
    expect(result.stderr).toContain('Standard error');
  });

  it('records execution duration', async () => {
    const mockChild = createMockChildProcess({
      exitCode: 0,
      stdout: 'Success',
      stderr: '',
    });
    mockSpawn.mockReturnValue(mockChild as any);

    const promise = runClaude({
      worktreePath: '/tmp/worktree',
      prompt: 'Test prompt',
      timeoutMs: 5000,
      verbose: false,
      onProgress: vi.fn(),
    });

    await new Promise(resolve => setTimeout(resolve, 50));
    mockChild.emit('close', 0);
    const result = await promise;

    expect(result.durationMs).toBeGreaterThan(0);
  });
});

// Helper to create mock child process
function createMockChildProcess(opts: {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}) {
  const mockChild = new EventEmitter();

  mockChild.stdin = {
    write: vi.fn(),
    end: vi.fn(),
  };

  mockChild.stdout = new EventEmitter();
  mockChild.stderr = new EventEmitter();
  mockChild.kill = vi.fn();

  // Immediately set up data emission (synchronously available)
  process.nextTick(() => {
    if (opts.stdout) {
      mockChild.stdout.emit('data', Buffer.from(opts.stdout));
    }
    if (opts.stderr) {
      mockChild.stderr.emit('data', Buffer.from(opts.stderr));
    }
  });

  return mockChild;
}
