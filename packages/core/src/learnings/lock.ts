/**
 * Advisory file lock for learnings.json.
 *
 * Uses O_CREAT | O_EXCL for atomic creation on POSIX.
 * Zero new dependencies — uses only node:fs and node:path.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const LOCK_MAX_ATTEMPTS = 20;
const LOCK_RETRY_MS = 50;
const LOCK_STALE_MS = 10_000; // 10 seconds — handles crashed processes

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Execute `fn` while holding an advisory file lock on `<filePath>.lock`.
 *
 * Acquire: `fs.openSync(lockPath, O_CREAT | O_EXCL | O_WRONLY)` — atomic on POSIX.
 * Retry: Up to 20 attempts with 50ms busy-wait between.
 * Stale detection: If lock file mtime > 10 seconds old, remove and retry.
 * Release: `fs.unlinkSync(lockPath)` in finally block.
 */
export function withLearningsLock<T>(filePath: string, fn: () => T): T {
  const lockPath = filePath + '.lock';
  const dir = path.dirname(lockPath);

  // Ensure directory exists
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  let fd: number | null = null;

  for (let attempt = 0; attempt < LOCK_MAX_ATTEMPTS; attempt++) {
    try {
      fd = fs.openSync(lockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY);
      break; // Lock acquired
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw err; // Unexpected error — propagate
      }

      // Lock file exists — check if stale
      try {
        const stat = fs.statSync(lockPath);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          // Stale lock from crashed process — remove and retry immediately
          try { fs.unlinkSync(lockPath); } catch { /* another process may have removed it */ }
          continue;
        }
      } catch {
        // Lock was removed between our open and stat — retry immediately
        continue;
      }

      // Lock held by active process — wait and retry
      if (attempt < LOCK_MAX_ATTEMPTS - 1) {
        sleepSync(LOCK_RETRY_MS);
      }
    }
  }

  if (fd === null) {
    // Could not acquire lock after all attempts — run unprotected rather than failing.
    // This is an advisory lock; data loss from a race is better than crashing the session.
    return fn();
  }

  try {
    fs.closeSync(fd);
    return fn();
  } finally {
    try { fs.unlinkSync(lockPath); } catch { /* ignore cleanup failures */ }
  }
}
