/**
 * Tests for advisory file lock on learnings.json.
 *
 * Covers:
 *   - Basic lock acquire/release
 *   - Return value propagation
 *   - Stale lock cleanup
 *   - Concurrent access serialization
 *   - Graceful fallback when lock can't be acquired
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { withLearningsLock } from '../learnings/lock.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-lock-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function lockFilePath(): string {
  return path.join(tmpDir, 'learnings.json');
}

// ---------------------------------------------------------------------------
// Basic behavior
// ---------------------------------------------------------------------------

describe('withLearningsLock', () => {
  it('executes fn and returns its result', () => {
    const result = withLearningsLock(lockFilePath(), () => 42);
    expect(result).toBe(42);
  });

  it('removes lock file after successful execution', () => {
    const fp = lockFilePath();
    withLearningsLock(fp, () => {});
    expect(fs.existsSync(fp + '.lock')).toBe(false);
  });

  it('removes lock file after fn throws', () => {
    const fp = lockFilePath();
    expect(() => {
      withLearningsLock(fp, () => { throw new Error('boom'); });
    }).toThrow('boom');
    expect(fs.existsSync(fp + '.lock')).toBe(false);
  });

  it('propagates errors from fn', () => {
    expect(() => {
      withLearningsLock(lockFilePath(), () => { throw new Error('test error'); });
    }).toThrow('test error');
  });

  it('creates parent directory if missing', () => {
    const nested = path.join(tmpDir, 'sub', 'dir', 'learnings.json');
    const result = withLearningsLock(nested, () => 'ok');
    expect(result).toBe('ok');
  });
});

// ---------------------------------------------------------------------------
// Stale lock cleanup
// ---------------------------------------------------------------------------

describe('stale lock detection', () => {
  it('removes stale lock file (mtime > 10s old) and acquires lock', () => {
    const fp = lockFilePath();
    const lockPath = fp + '.lock';

    // Create a stale lock file
    fs.writeFileSync(lockPath, 'stale', 'utf8');

    // Set mtime to 15 seconds ago
    const staleTime = new Date(Date.now() - 15_000);
    fs.utimesSync(lockPath, staleTime, staleTime);

    // Should detect stale lock, remove it, and succeed
    const result = withLearningsLock(fp, () => 'recovered');
    expect(result).toBe('recovered');
    expect(fs.existsSync(lockPath)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

describe('serialization', () => {
  it('serializes concurrent read-modify-write on the same file', () => {
    const fp = lockFilePath();
    const dataPath = path.join(tmpDir, 'data.json');
    fs.writeFileSync(dataPath, '0', 'utf8');

    // Simulate sequential locked increments (synchronous lock, so truly
    // concurrent access would require threads — we verify the lock
    // mechanism works by running two locked operations back-to-back).
    for (let i = 0; i < 10; i++) {
      withLearningsLock(fp, () => {
        const current = parseInt(fs.readFileSync(dataPath, 'utf8'), 10);
        fs.writeFileSync(dataPath, String(current + 1), 'utf8');
      });
    }

    const final = parseInt(fs.readFileSync(dataPath, 'utf8'), 10);
    expect(final).toBe(10);
  });

  it('does not leave lock file after sequential operations', () => {
    const fp = lockFilePath();
    for (let i = 0; i < 5; i++) {
      withLearningsLock(fp, () => {});
    }
    expect(fs.existsSync(fp + '.lock')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Graceful fallback
// ---------------------------------------------------------------------------

describe('graceful fallback', () => {
  it('runs fn unprotected when lock held by active process (non-stale)', () => {
    const fp = lockFilePath();
    const lockPath = fp + '.lock';

    // Create a fresh (non-stale) lock file that won't be cleaned up
    // This simulates another process holding the lock
    fs.writeFileSync(lockPath, 'held', 'utf8');
    // Touch it to make sure mtime is now (not stale)
    fs.utimesSync(lockPath, new Date(), new Date());

    // withLearningsLock should retry and eventually fall back to unprotected execution
    // This will be slow (~1 second) due to retries, but should not throw
    const result = withLearningsLock(fp, () => 'fallback');
    expect(result).toBe('fallback');

    // Clean up the lock we created
    fs.unlinkSync(lockPath);
  });
});
