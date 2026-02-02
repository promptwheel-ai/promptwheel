/**
 * Tests for the Claude Code plugin (Phase 8).
 * Tests the hook-driver.js script behavior for Stop and PreToolUse hooks.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';

const HOOK_DRIVER = path.resolve(
  __dirname, '..', '..', '..', 'plugin', 'scripts', 'hook-driver.js',
);

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-plugin-test-'));
  fs.mkdirSync(path.join(tmpDir, '.blockspool'), { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function runHook(hookType: string, stdin?: string): { stdout: string; exitCode: number } {
  try {
    const stdout = execFileSync('node', [HOOK_DRIVER, hookType], {
      cwd: tmpDir,
      input: stdin,
      encoding: 'utf8',
      timeout: 5000,
    });
    return { stdout, exitCode: 0 };
  } catch (e: any) {
    return { stdout: e.stdout ?? '', exitCode: e.status ?? 1 };
  }
}

// ---------------------------------------------------------------------------
// Stop hook
// ---------------------------------------------------------------------------

describe('Stop hook', () => {
  it('allows exit when no loop-state.json exists', () => {
    const { stdout, exitCode } = runHook('stop');
    expect(exitCode).toBe(0);
    // No output means allow (exit 0 with no stdout)
    expect(stdout).toBe('');
  });

  it('blocks exit when session is active (SCOUT phase)', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.blockspool', 'loop-state.json'),
      JSON.stringify({ run_id: 'run_123', session_id: 'ses_456', phase: 'SCOUT' }),
    );

    const { stdout, exitCode } = runHook('stop');
    expect(exitCode).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.decision).toBe('block');
    expect(result.reason).toContain('BlockSpool session is still active');
    expect(result.reason).toContain('SCOUT');
    expect(result.reason).toContain('blockspool_advance');
  });

  it('blocks exit during EXECUTE phase', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.blockspool', 'loop-state.json'),
      JSON.stringify({ run_id: 'run_123', session_id: 'ses_456', phase: 'EXECUTE' }),
    );

    const { stdout } = runHook('stop');
    const result = JSON.parse(stdout);
    expect(result.decision).toBe('block');
    expect(result.reason).toContain('EXECUTE');
  });

  it('allows exit on terminal phase DONE and cleans up', () => {
    const loopStatePath = path.join(tmpDir, '.blockspool', 'loop-state.json');
    fs.writeFileSync(
      loopStatePath,
      JSON.stringify({ run_id: 'run_123', session_id: 'ses_456', phase: 'DONE' }),
    );

    const { stdout, exitCode } = runHook('stop');
    expect(exitCode).toBe(0);
    expect(stdout).toBe(''); // No output = allow
    expect(fs.existsSync(loopStatePath)).toBe(false); // Cleaned up
  });

  it('allows exit on terminal phase FAILED_SPINDLE', () => {
    const loopStatePath = path.join(tmpDir, '.blockspool', 'loop-state.json');
    fs.writeFileSync(
      loopStatePath,
      JSON.stringify({ run_id: 'run_123', phase: 'FAILED_SPINDLE' }),
    );

    const { exitCode } = runHook('stop');
    expect(exitCode).toBe(0);
    expect(fs.existsSync(loopStatePath)).toBe(false);
  });

  it('allows exit on terminal phase BLOCKED_NEEDS_HUMAN', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.blockspool', 'loop-state.json'),
      JSON.stringify({ run_id: 'run_123', phase: 'BLOCKED_NEEDS_HUMAN' }),
    );

    const { exitCode, stdout } = runHook('stop');
    expect(exitCode).toBe(0);
    expect(stdout).toBe('');
  });

  it('allows exit on corrupt loop-state.json', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.blockspool', 'loop-state.json'),
      'not json',
    );

    const { exitCode, stdout } = runHook('stop');
    expect(exitCode).toBe(0);
    expect(stdout).toBe('');
  });
});

// ---------------------------------------------------------------------------
// PreToolUse hook
// ---------------------------------------------------------------------------

describe('PreToolUse hook', () => {
  it('allows non-write tools', () => {
    const { stdout, exitCode } = runHook('PreToolUse', JSON.stringify({
      tool_name: 'Read',
      tool_input: { file_path: '/etc/passwd' },
    }));
    expect(exitCode).toBe(0);
    expect(stdout).toBe(''); // No output = allow
  });

  it('allows writes when no scope policy exists', () => {
    const { stdout, exitCode } = runHook('PreToolUse', JSON.stringify({
      tool_name: 'Write',
      tool_input: { file_path: 'src/foo.ts' },
    }));
    expect(exitCode).toBe(0);
    expect(stdout).toBe('');
  });

  it('denies writes to denied paths', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.blockspool', 'scope-policy.json'),
      JSON.stringify({
        allowed_paths: ['src/**'],
        denied_paths: ['node_modules/**', '.env'],
        denied_patterns: [],
      }),
    );

    const { stdout } = runHook('PreToolUse', JSON.stringify({
      tool_name: 'Write',
      tool_input: { file_path: '.env' },
    }));
    const result = JSON.parse(stdout);
    expect(result.decision).toBe('deny');
    expect(result.reason).toContain('.env');
  });

  it('denies writes outside allowed paths', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.blockspool', 'scope-policy.json'),
      JSON.stringify({
        allowed_paths: ['src/**'],
        denied_paths: [],
        denied_patterns: [],
      }),
    );

    const { stdout } = runHook('PreToolUse', JSON.stringify({
      tool_name: 'Edit',
      tool_input: { file_path: 'test/foo.ts' },
    }));
    const result = JSON.parse(stdout);
    expect(result.decision).toBe('deny');
    expect(result.reason).toContain('outside allowed paths');
  });

  it('allows writes within allowed paths', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.blockspool', 'scope-policy.json'),
      JSON.stringify({
        allowed_paths: ['src/**'],
        denied_paths: [],
        denied_patterns: [],
      }),
    );

    const { stdout, exitCode } = runHook('PreToolUse', JSON.stringify({
      tool_name: 'Write',
      tool_input: { file_path: 'src/index.ts' },
    }));
    expect(exitCode).toBe(0);
    expect(stdout).toBe('');
  });

  it('denies writes matching denied patterns', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.blockspool', 'scope-policy.json'),
      JSON.stringify({
        allowed_paths: [],
        denied_paths: [],
        denied_patterns: ['\\.pem$'],
      }),
    );

    const { stdout } = runHook('PreToolUse', JSON.stringify({
      tool_name: 'Write',
      tool_input: { file_path: 'keys/server.pem' },
    }));
    const result = JSON.parse(stdout);
    expect(result.decision).toBe('deny');
    expect(result.reason).toContain('denied pattern');
  });

  it('allows on invalid stdin', () => {
    const { exitCode, stdout } = runHook('PreToolUse', 'not json');
    expect(exitCode).toBe(0);
    expect(stdout).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Plugin structure validation
// ---------------------------------------------------------------------------

describe('Plugin structure', () => {
  const pluginDir = path.resolve(__dirname, '..', '..', '..', 'plugin');

  it('has plugin.json manifest', () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(pluginDir, '.claude-plugin', 'plugin.json'), 'utf8'),
    );
    expect(manifest.name).toBe('blockspool');
    expect(manifest.skills).toHaveLength(4);
  });

  it('has all 4 skill directories', () => {
    for (const skill of ['run', 'status', 'nudge', 'cancel']) {
      expect(fs.existsSync(path.join(pluginDir, 'skills', skill))).toBe(true);
    }
  });

  it('has hooks.json with Stop and PreToolUse', () => {
    const hooks = JSON.parse(
      fs.readFileSync(path.join(pluginDir, 'hooks', 'hooks.json'), 'utf8'),
    );
    const eventNames = Object.keys(hooks.hooks);
    expect(eventNames).toContain('Stop');
    expect(eventNames).toContain('PreToolUse');
    expect(eventNames).toHaveLength(2);
  });

  it('has .mcp.json with blockspool server', () => {
    const mcp = JSON.parse(
      fs.readFileSync(path.join(pluginDir, '.mcp.json'), 'utf8'),
    );
    expect(mcp.mcpServers.blockspool).toBeDefined();
    expect(mcp.mcpServers.blockspool.command).toBe('npx');
  });

  it('has hook-driver.js script', () => {
    expect(fs.existsSync(path.join(pluginDir, 'scripts', 'hook-driver.js'))).toBe(true);
  });
});
