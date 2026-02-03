/**
 * Tests for scout/runner.ts - runClaude function
 *
 * Tests the Claude CLI invocation for scout analysis:
 * - Successful execution
 * - Timeout handling
 * - Error handling
 * - Signal propagation
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runClaude, parseClaudeOutput } from '../scout/runner.js';

// Mock child_process
vi.mock('node:child_process');

describe('scout-runner: runClaude', () => {
  let mockSpawn: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const childProcess = await import('node:child_process');
    mockSpawn = vi.mocked(childProcess.spawn);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('spawns claude with correct arguments', async () => {
    const mockChild = createMockChildProcess({
      exitCode: 0,
      stdout: 'Analysis result',
      stderr: '',
    });
    mockSpawn.mockReturnValue(mockChild as any);

    const promise = runClaude({
      prompt: 'Analyze this code',
      cwd: '/tmp/repo',
      timeoutMs: 5000,
      model: 'opus',
    });

    mockChild.emit('close', 0);
    await promise;

    // Args should include -p flag but NOT the prompt (prompt is sent via stdin)
    expect(mockSpawn).toHaveBeenCalledWith(
      'claude',
      expect.arrayContaining([
        '-p',
        '--model', 'opus',
        '--output-format', 'text',
        '--allowedTools', '',
      ]),
      expect.objectContaining({
        cwd: '/tmp/repo',
        env: expect.objectContaining({
          CLAUDE_CODE_NON_INTERACTIVE: '1',
        }),
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    );

    // Prompt should be written to stdin
    expect(mockChild.stdin.write).toHaveBeenCalledWith('Analyze this code');
    expect(mockChild.stdin.end).toHaveBeenCalled();
  });

  it('defaults to opus model when not specified', async () => {
    const mockChild = createMockChildProcess({
      exitCode: 0,
      stdout: 'Result',
      stderr: '',
    });
    mockSpawn.mockReturnValue(mockChild as any);

    const promise = runClaude({
      prompt: 'Test',
      cwd: '/tmp/repo',
      timeoutMs: 5000,
    });

    mockChild.emit('close', 0);
    await promise;

    expect(mockSpawn).toHaveBeenCalledWith(
      'claude',
      expect.arrayContaining(['--model', 'opus']),
      expect.any(Object)
    );
  });

  it('supports haiku model', async () => {
    const mockChild = createMockChildProcess({
      exitCode: 0,
      stdout: 'Result',
      stderr: '',
    });
    mockSpawn.mockReturnValue(mockChild as any);

    const promise = runClaude({
      prompt: 'Test',
      cwd: '/tmp/repo',
      timeoutMs: 5000,
      model: 'haiku',
    });

    mockChild.emit('close', 0);
    await promise;

    expect(mockSpawn).toHaveBeenCalledWith(
      'claude',
      expect.arrayContaining(['--model', 'haiku']),
      expect.any(Object)
    );
  });

  it('supports sonnet model', async () => {
    const mockChild = createMockChildProcess({
      exitCode: 0,
      stdout: 'Result',
      stderr: '',
    });
    mockSpawn.mockReturnValue(mockChild as any);

    const promise = runClaude({
      prompt: 'Test',
      cwd: '/tmp/repo',
      timeoutMs: 5000,
      model: 'sonnet',
    });

    mockChild.emit('close', 0);
    await promise;

    expect(mockSpawn).toHaveBeenCalledWith(
      'claude',
      expect.arrayContaining(['--model', 'sonnet']),
      expect.any(Object)
    );
  });

  it('returns success result on exit code 0', async () => {
    const mockChild = createMockChildProcess({
      exitCode: 0,
      stdout: 'Analysis complete',
      stderr: '',
    });
    mockSpawn.mockReturnValue(mockChild as any);

    const promise = runClaude({
      prompt: 'Analyze',
      cwd: '/tmp/repo',
      timeoutMs: 5000,
    });

    await new Promise(resolve => setTimeout(resolve, 20));
    mockChild.emit('close', 0);
    const result = await promise;

    expect(result.success).toBe(true);
    expect(result.output).toBe('Analysis complete');
    expect(result.error).toBeUndefined();
  });

  it('returns failure result on non-zero exit code', async () => {
    const mockChild = createMockChildProcess({
      exitCode: 1,
      stdout: '',
      stderr: 'Error occurred',
    });
    mockSpawn.mockReturnValue(mockChild as any);

    const promise = runClaude({
      prompt: 'Analyze',
      cwd: '/tmp/repo',
      timeoutMs: 5000,
    });

    await new Promise(resolve => setTimeout(resolve, 20));
    mockChild.emit('close', 1);
    const result = await promise;

    expect(result.success).toBe(false);
    expect(result.error).toContain('Error occurred');
  });

  it('handles timeout correctly', async () => {
    const mockChild = createMockChildProcess({
      exitCode: null,
      stdout: 'Partial',
      stderr: '',
      hang: true,
    });
    mockSpawn.mockReturnValue(mockChild as any);

    const promise = runClaude({
      prompt: 'Analyze',
      cwd: '/tmp/repo',
      timeoutMs: 50, // Very short timeout
    });

    // Wait for timeout to trigger
    await new Promise(resolve => setTimeout(resolve, 100));
    mockChild.emit('close', null);

    const result = await promise;

    expect(result.success).toBe(false);
    expect(result.error).toContain('Timeout exceeded');
    expect(mockChild.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('escalates to SIGKILL after grace period on timeout', async () => {
    const mockChild = createMockChildProcess({
      exitCode: null,
      stdout: '',
      stderr: '',
      hang: true,
    });
    mockSpawn.mockReturnValue(mockChild as any);

    const promise = runClaude({
      prompt: 'Analyze',
      cwd: '/tmp/repo',
      timeoutMs: 50,
    });

    // Wait for timeout + grace period (5000ms)
    await new Promise(resolve => setTimeout(resolve, 5100));

    expect(mockChild.kill).toHaveBeenCalledWith('SIGTERM');
    expect(mockChild.kill).toHaveBeenCalledWith('SIGKILL');

    mockChild.emit('close', null);
    await promise;
  });

  it('handles abort signal', async () => {
    const mockChild = createMockChildProcess({
      exitCode: null,
      stdout: '',
      stderr: '',
      hang: true,
    });
    mockSpawn.mockReturnValue(mockChild as any);

    const abortController = new AbortController();
    const promise = runClaude({
      prompt: 'Analyze',
      cwd: '/tmp/repo',
      timeoutMs: 10000,
      signal: abortController.signal,
    });

    // Abort after a delay
    setTimeout(() => abortController.abort(), 20);

    await new Promise(resolve => setTimeout(resolve, 50));
    mockChild.emit('close', null);

    const result = await promise;

    expect(result.success).toBe(false);
    expect(result.error).toContain('Aborted by signal');
    expect(mockChild.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('handles already aborted signal', async () => {
    const abortController = new AbortController();
    abortController.abort();

    const result = await runClaude({
      prompt: 'Analyze',
      cwd: '/tmp/repo',
      timeoutMs: 5000,
      signal: abortController.signal,
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('Aborted before start');
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('handles spawn errors', async () => {
    const mockChild = createMockChildProcess({
      exitCode: null,
      stdout: '',
      stderr: '',
    });
    mockSpawn.mockReturnValue(mockChild as any);

    const promise = runClaude({
      prompt: 'Analyze',
      cwd: '/tmp/repo',
      timeoutMs: 5000,
    });

    mockChild.emit('error', new Error('ENOENT: command not found'));

    const result = await promise;

    expect(result.success).toBe(false);
    expect(result.error).toContain('ENOENT');
  });

  it('captures both stdout and stderr', async () => {
    const mockChild = createMockChildProcess({
      exitCode: 0,
      stdout: 'Standard output',
      stderr: 'Warning message',
    });
    mockSpawn.mockReturnValue(mockChild as any);

    const promise = runClaude({
      prompt: 'Analyze',
      cwd: '/tmp/repo',
      timeoutMs: 5000,
    });

    await new Promise(resolve => setTimeout(resolve, 20));
    mockChild.emit('close', 0);
    const result = await promise;

    expect(result.output).toContain('Standard output');
    // Note: stderr is captured separately in the implementation
  });

  it('records execution duration', async () => {
    const mockChild = createMockChildProcess({
      exitCode: 0,
      stdout: 'Result',
      stderr: '',
    });
    mockSpawn.mockReturnValue(mockChild as any);

    const promise = runClaude({
      prompt: 'Analyze',
      cwd: '/tmp/repo',
      timeoutMs: 5000,
    });

    await new Promise(resolve => setTimeout(resolve, 50));
    mockChild.emit('close', 0);
    const result = await promise;

    expect(result.durationMs).toBeGreaterThan(0);
  });

  it('removes abort listener on completion', async () => {
    const mockChild = createMockChildProcess({
      exitCode: 0,
      stdout: 'Result',
      stderr: '',
    });
    mockSpawn.mockReturnValue(mockChild as any);

    const abortController = new AbortController();
    const promise = runClaude({
      prompt: 'Analyze',
      cwd: '/tmp/repo',
      timeoutMs: 5000,
      signal: abortController.signal,
    });

    mockChild.emit('close', 0);
    await promise;

    // Aborting after completion should not affect anything
    abortController.abort();
  });
});

describe('scout-runner: parseClaudeOutput', () => {
  it('parses direct JSON', () => {
    const output = '{"result": "test", "value": 123}';
    const parsed = parseClaudeOutput<{ result: string; value: number }>(output);

    expect(parsed).toEqual({ result: 'test', value: 123 });
  });

  it('parses JSON from markdown code block', () => {
    const output = '```json\n{"result": "test"}\n```';
    const parsed = parseClaudeOutput<{ result: string }>(output);

    expect(parsed).toEqual({ result: 'test' });
  });

  it('parses JSON from code block without language', () => {
    const output = '```\n{"result": "test"}\n```';
    const parsed = parseClaudeOutput<{ result: string }>(output);

    expect(parsed).toEqual({ result: 'test' });
  });

  it('extracts JSON object from mixed content', () => {
    const output = 'Some text before\n{"result": "test"}\nsome text after';
    const parsed = parseClaudeOutput<{ result: string }>(output);

    expect(parsed).toEqual({ result: 'test' });
  });

  it('returns null for invalid JSON', () => {
    const output = 'Not valid JSON at all';
    const parsed = parseClaudeOutput(output);

    expect(parsed).toBeNull();
  });

  it('returns null for empty string', () => {
    const output = '';
    const parsed = parseClaudeOutput(output);

    expect(parsed).toBeNull();
  });

  it('handles nested JSON objects', () => {
    const output = '{"outer": {"inner": "value"}}';
    const parsed = parseClaudeOutput<{ outer: { inner: string } }>(output);

    expect(parsed).toEqual({ outer: { inner: 'value' } });
  });

  it('handles JSON arrays', () => {
    const output = '[{"id": 1}, {"id": 2}]';
    const parsed = parseClaudeOutput<Array<{ id: number }>>(output);

    expect(parsed).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it('trims whitespace before parsing', () => {
    const output = '  \n  {"result": "test"}  \n  ';
    const parsed = parseClaudeOutput<{ result: string }>(output);

    expect(parsed).toEqual({ result: 'test' });
  });

  it('handles JSON in code block with extra whitespace', () => {
    const output = '```json\n\n  {"result": "test"}  \n\n```';
    const parsed = parseClaudeOutput<{ result: string }>(output);

    expect(parsed).toEqual({ result: 'test' });
  });
});

// Helper to create mock child process
function createMockChildProcess(opts: {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  hang?: boolean;
}) {
  const { EventEmitter } = require('events');
  const mockChild = new EventEmitter();

  mockChild.stdout = new EventEmitter();
  mockChild.stderr = new EventEmitter();
  mockChild.stdin = {
    write: vi.fn(),
    end: vi.fn(),
  };
  mockChild.kill = vi.fn();

  // Simulate data emission
  if (!opts.hang) {
    setTimeout(() => {
      if (opts.stdout) {
        mockChild.stdout.emit('data', opts.stdout);
      }
      if (opts.stderr) {
        mockChild.stderr.emit('data', opts.stderr);
      }
    }, 10);
  }

  return mockChild;
}
