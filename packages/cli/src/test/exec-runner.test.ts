/**
 * Tests for exec.ts - NodeExecRunner
 *
 * Tests the execution runner that spawns child processes:
 * - Command execution
 * - Timeout handling
 * - Signal handling
 * - Stdout/stderr capture
 * - Artifact file writing
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NodeExecRunner, createExecRunner } from '../lib/exec.js';
import type { ExecSpec, ExecResult } from '@promptwheel/core';

// Mock dependencies
vi.mock('node:child_process');
vi.mock('node:fs');
vi.mock('node:fs/promises');

describe('exec-runner: createExecRunner', () => {
  it('creates NodeExecRunner with defaults', () => {
    const runner = createExecRunner();
    expect(runner).toBeInstanceOf(NodeExecRunner);
  });

  it('creates NodeExecRunner with custom options', () => {
    const runner = createExecRunner({
      defaultMaxLogBytes: 1000,
      defaultTailBytes: 500,
      killGraceMs: 2000,
    });
    expect(runner).toBeInstanceOf(NodeExecRunner);
  });
});

describe('exec-runner: NodeExecRunner.run', () => {
  let mockSpawn: ReturnType<typeof vi.fn>;
  let mockCreateWriteStream: ReturnType<typeof vi.fn>;
  let mockMkdir: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const childProcess = await import('node:child_process');
    const fs = await import('node:fs');
    const fsPromises = await import('node:fs/promises');

    mockSpawn = vi.mocked(childProcess.spawn);
    mockCreateWriteStream = vi.mocked(fs.createWriteStream);
    mockMkdir = vi.mocked(fsPromises.mkdir);

    // Mock mkdir to succeed
    mockMkdir.mockResolvedValue(undefined as any);

    // Default mock write stream
    mockCreateWriteStream.mockImplementation(() => {
      const { EventEmitter } = require('events');
      const stream = new EventEmitter();
      stream.write = vi.fn();
      stream.end = vi.fn(() => {
        setTimeout(() => stream.emit('close'), 5);
      });
      return stream as any;
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('executes command successfully', async () => {
    const mockChild = createMockProcess({
      exitCode: 0,
      stdout: 'Command output',
      stderr: '',
    });
    mockSpawn.mockReturnValue(mockChild as any);

    const runner = new NodeExecRunner();
    const spec: ExecSpec = {
      cmd: 'echo hello',
      repoRoot: '/tmp/repo',
      artifactsDir: '.artifacts',
      runId: 'run-1',
      attempt: 1,
      stepName: 'test-step',
      ordinal: 0,
    };

    const promise = runner.run(spec);

    // Trigger process completion
    await new Promise(resolve => setTimeout(resolve, 20));
    mockChild.emit('close', 0, null);

    const result = await promise;

    expect(result.status).toBe('success');
    expect(result.exitCode).toBe(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('handles command failure with non-zero exit code', async () => {
    const mockChild = createMockProcess({
      exitCode: 1,
      stdout: '',
      stderr: 'Error message',
    });
    mockSpawn.mockReturnValue(mockChild as any);

    const runner = new NodeExecRunner();
    const spec: ExecSpec = {
      cmd: 'exit 1',
      repoRoot: '/tmp/repo',
      artifactsDir: '.artifacts',
      runId: 'run-1',
      attempt: 1,
      stepName: 'failing-step',
      ordinal: 0,
    };

    const promise = runner.run(spec);

    await new Promise(resolve => setTimeout(resolve, 20));
    mockChild.emit('close', 1, null);

    const result = await promise;

    expect(result.status).toBe('failed');
    expect(result.exitCode).toBe(1);
  });

  it('handles timeout', async () => {
    const mockChild = createMockProcess({
      exitCode: null,
      stdout: 'Partial output',
      stderr: '',
      hang: true,
    });
    mockSpawn.mockReturnValue(mockChild as any);

    const runner = new NodeExecRunner();
    const spec: ExecSpec = {
      cmd: 'sleep 100',
      repoRoot: '/tmp/repo',
      artifactsDir: '.artifacts',
      runId: 'run-1',
      attempt: 1,
      stepName: 'slow-step',
      ordinal: 0,
      timeoutMs: 50, // Very short timeout
    };

    const promise = runner.run(spec);

    // Wait for timeout to trigger
    await new Promise(resolve => setTimeout(resolve, 100));
    mockChild.emit('close', null, 'SIGTERM');

    const result = await promise;

    expect(result.status).toBe('timeout');
    expect(mockChild.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('handles abort signal', async () => {
    const mockChild = createMockProcess({
      exitCode: null,
      stdout: '',
      stderr: '',
      hang: true,
    });
    mockSpawn.mockReturnValue(mockChild as any);

    const abortController = new AbortController();
    const runner = new NodeExecRunner();
    const spec: ExecSpec = {
      cmd: 'long-running-command',
      repoRoot: '/tmp/repo',
      artifactsDir: '.artifacts',
      runId: 'run-1',
      attempt: 1,
      stepName: 'cancelable-step',
      ordinal: 0,
      signal: abortController.signal,
    };

    const promise = runner.run(spec);

    // Abort after a short delay
    setTimeout(() => abortController.abort(), 20);

    await new Promise(resolve => setTimeout(resolve, 50));
    mockChild.emit('close', null, 'SIGTERM');

    const result = await promise;

    expect(result.status).toBe('canceled');
    expect(mockChild.kill).toHaveBeenCalled();
  });

  it('handles spawn errors', async () => {
    const mockChild = createMockProcess({
      exitCode: null,
      stdout: '',
      stderr: '',
    });
    mockSpawn.mockReturnValue(mockChild as any);

    const runner = new NodeExecRunner();
    const spec: ExecSpec = {
      cmd: 'nonexistent-command',
      repoRoot: '/tmp/repo',
      artifactsDir: '.artifacts',
      runId: 'run-1',
      attempt: 1,
      stepName: 'error-step',
      ordinal: 0,
    };

    const promise = runner.run(spec);

    // Emit error asynchronously to allow promise handler to be registered
    process.nextTick(() => {
      mockChild.emit('error', new Error('ENOENT: command not found'));
    });

    const result = await promise;

    expect(result.status).toBe('failed');
    expect(result.errorMessage).toContain('ENOENT');
  });

  it('captures stdout and stderr', async () => {
    const mockChild = createMockProcess({
      exitCode: 0,
      stdout: 'Standard output content',
      stderr: 'Standard error content',
    });
    mockSpawn.mockReturnValue(mockChild as any);

    const runner = new NodeExecRunner();
    const spec: ExecSpec = {
      cmd: 'test-command',
      repoRoot: '/tmp/repo',
      artifactsDir: '.artifacts',
      runId: 'run-1',
      attempt: 1,
      stepName: 'capture-step',
      ordinal: 0,
    };

    const promise = runner.run(spec);

    await new Promise(resolve => setTimeout(resolve, 20));
    mockChild.emit('close', 0, null);

    const result = await promise;

    expect(result.stdout.tail).toContain('Standard output content');
    expect(result.stderr.tail).toContain('Standard error content');
  });

  it('respects maxLogBytes limit', async () => {
    const largeOutput = 'x'.repeat(1000);
    const mockChild = createMockProcess({
      exitCode: 0,
      stdout: largeOutput,
      stderr: '',
    });
    mockSpawn.mockReturnValue(mockChild as any);

    const runner = new NodeExecRunner({ defaultMaxLogBytes: 100 });
    const spec: ExecSpec = {
      cmd: 'test-command',
      repoRoot: '/tmp/repo',
      artifactsDir: '.artifacts',
      runId: 'run-1',
      attempt: 1,
      stepName: 'large-output',
      ordinal: 0,
    };

    const promise = runner.run(spec);

    await new Promise(resolve => setTimeout(resolve, 20));
    mockChild.emit('close', 0, null);

    const result = await promise;

    expect(result.stdout.bytes).toBeLessThanOrEqual(100);
    expect(result.stdout.truncated).toBe(true);
  });

  it('calls onStdoutChunk callback', async () => {
    const mockChild = createMockProcess({
      exitCode: 0,
      stdout: 'Output',
      stderr: '',
    });
    mockSpawn.mockReturnValue(mockChild as any);

    const onStdoutChunk = vi.fn();
    const runner = new NodeExecRunner();
    const spec: ExecSpec = {
      cmd: 'test-command',
      repoRoot: '/tmp/repo',
      artifactsDir: '.artifacts',
      runId: 'run-1',
      attempt: 1,
      stepName: 'callback-test',
      ordinal: 0,
      onStdoutChunk,
    };

    const promise = runner.run(spec);

    await new Promise(resolve => setTimeout(resolve, 20));
    mockChild.emit('close', 0, null);

    await promise;

    expect(onStdoutChunk).toHaveBeenCalled();
  });

  it('calls onStderrChunk callback', async () => {
    const mockChild = createMockProcess({
      exitCode: 0,
      stdout: '',
      stderr: 'Error output',
    });
    mockSpawn.mockReturnValue(mockChild as any);

    const onStderrChunk = vi.fn();
    const runner = new NodeExecRunner();
    const spec: ExecSpec = {
      cmd: 'test-command',
      repoRoot: '/tmp/repo',
      artifactsDir: '.artifacts',
      runId: 'run-1',
      attempt: 1,
      stepName: 'stderr-callback',
      ordinal: 0,
      onStderrChunk,
    };

    const promise = runner.run(spec);

    await new Promise(resolve => setTimeout(resolve, 20));
    mockChild.emit('close', 0, null);

    await promise;

    expect(onStderrChunk).toHaveBeenCalled();
  });

  it('uses custom cwd', async () => {
    const mockChild = createMockProcess({
      exitCode: 0,
      stdout: '',
      stderr: '',
    });
    mockSpawn.mockReturnValue(mockChild as any);

    const runner = new NodeExecRunner();
    const spec: ExecSpec = {
      cmd: 'pwd',
      cwd: '/custom/dir',
      repoRoot: '/tmp/repo',
      artifactsDir: '.artifacts',
      runId: 'run-1',
      attempt: 1,
      stepName: 'cwd-test',
      ordinal: 0,
    };

    const promise = runner.run(spec);

    await new Promise(resolve => setTimeout(resolve, 20));
    mockChild.emit('close', 0, null);

    await promise;

    expect(mockSpawn).toHaveBeenCalledWith(
      'pwd',
      expect.objectContaining({
        cwd: '/custom/dir',
      })
    );
  });

  it('uses custom environment variables', async () => {
    const mockChild = createMockProcess({
      exitCode: 0,
      stdout: '',
      stderr: '',
    });
    mockSpawn.mockReturnValue(mockChild as any);

    const runner = new NodeExecRunner();
    const spec: ExecSpec = {
      cmd: 'env',
      env: { CUSTOM_VAR: 'value123' },
      repoRoot: '/tmp/repo',
      artifactsDir: '.artifacts',
      runId: 'run-1',
      attempt: 1,
      stepName: 'env-test',
      ordinal: 0,
    };

    const promise = runner.run(spec);

    await new Promise(resolve => setTimeout(resolve, 20));
    mockChild.emit('close', 0, null);

    await promise;

    expect(mockSpawn).toHaveBeenCalledWith(
      'env',
      expect.objectContaining({
        env: expect.objectContaining({
          CUSTOM_VAR: 'value123',
        }),
      })
    );
  });

  it('kills with SIGKILL after grace period', async () => {
    const mockChild = createMockProcess({
      exitCode: null,
      stdout: '',
      stderr: '',
      hang: true,
    });
    mockSpawn.mockReturnValue(mockChild as any);

    const runner = new NodeExecRunner({ killGraceMs: 50 });
    const spec: ExecSpec = {
      cmd: 'sleep 100',
      repoRoot: '/tmp/repo',
      artifactsDir: '.artifacts',
      runId: 'run-1',
      attempt: 1,
      stepName: 'grace-test',
      ordinal: 0,
      timeoutMs: 10,
    };

    const promise = runner.run(spec);

    // Wait for timeout + grace period
    await new Promise(resolve => setTimeout(resolve, 100));

    // Should have been killed with SIGTERM, then SIGKILL
    expect(mockChild.kill).toHaveBeenCalledWith('SIGTERM');
    expect(mockChild.kill).toHaveBeenCalledWith('SIGKILL');

    mockChild.emit('close', null, 'SIGKILL');
    await promise;
  });

  it('handles already aborted signal', async () => {
    const abortController = new AbortController();
    abortController.abort(); // Abort immediately

    const runner = new NodeExecRunner();
    const spec: ExecSpec = {
      cmd: 'test',
      repoRoot: '/tmp/repo',
      artifactsDir: '.artifacts',
      runId: 'run-1',
      attempt: 1,
      stepName: 'pre-aborted',
      ordinal: 0,
      signal: abortController.signal,
    };

    const result = await runner.run(spec);

    expect(result.status).toBe('canceled');
    expect(result.errorMessage).toContain('already aborted');
  });

  it('records PID when available', async () => {
    const mockChild = createMockProcess({
      exitCode: 0,
      stdout: '',
      stderr: '',
    });
    mockChild.pid = 12345;
    mockSpawn.mockReturnValue(mockChild as any);

    const runner = new NodeExecRunner();
    const spec: ExecSpec = {
      cmd: 'test',
      repoRoot: '/tmp/repo',
      artifactsDir: '.artifacts',
      runId: 'run-1',
      attempt: 1,
      stepName: 'pid-test',
      ordinal: 0,
    };

    const promise = runner.run(spec);

    await new Promise(resolve => setTimeout(resolve, 20));
    mockChild.emit('close', 0, null);

    const result = await promise;

    expect(result.pid).toBe(12345);
  });
});

// Helper to create mock child process
function createMockProcess(opts: {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  hang?: boolean;
}) {
  const { EventEmitter } = require('events');
  const mockChild = new EventEmitter();

  mockChild.stdout = new EventEmitter();
  mockChild.stderr = new EventEmitter();
  mockChild.kill = vi.fn();
  mockChild.killed = false;
  mockChild.pid = undefined;

  // Simulate data emission
  if (!opts.hang) {
    setTimeout(() => {
      if (opts.stdout) {
        mockChild.stdout.emit('data', Buffer.from(opts.stdout));
      }
      if (opts.stderr) {
        mockChild.stderr.emit('data', Buffer.from(opts.stderr));
      }
    }, 10);
  }

  return mockChild;
}
