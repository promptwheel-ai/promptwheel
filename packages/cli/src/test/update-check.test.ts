/**
 * Unit tests for update-check.ts — version comparison, caching, and dismissal.
 *
 * Strategy: Mock os.homedir() so CACHE_FILE points to a temp directory.
 * Mock child_process.spawn to prevent npm registry calls.
 * Test compareVersions indirectly through checkForUpdate's cache path.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import EventEmitter from 'node:events';

// vi.hoisted runs before vi.mock — gives us a shared object accessible from mock factories.
const testState = vi.hoisted(() => ({ home: '' }));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  const _fs = await import('node:fs');
  const _path = await import('node:path');
  testState.home = _fs.mkdtempSync(_path.join(actual.tmpdir(), 'uc-test-'));
  return { ...actual, homedir: () => testState.home };
});

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn() };
});

import { checkForUpdate, dismissUpdate } from '../lib/update-check.js';
import { spawn } from 'node:child_process';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function cacheDir(): string {
  return path.join(testState.home, '.promptwheel');
}

function cacheFile(): string {
  return path.join(cacheDir(), 'update-check.json');
}

function writeCache(data: {
  lastCheck: number;
  latestVersion: string | null;
  dismissed: string | null;
}): void {
  if (!fs.existsSync(cacheDir())) fs.mkdirSync(cacheDir(), { recursive: true });
  fs.writeFileSync(cacheFile(), JSON.stringify(data));
}

function readCache(): {
  lastCheck: number;
  latestVersion: string | null;
  dismissed: string | null;
} {
  return JSON.parse(fs.readFileSync(cacheFile(), 'utf-8'));
}

/** Mock spawn so fetchLatestVersion() returns a controlled version string. */
function mockFetchVersion(version: string | null): void {
  vi.mocked(spawn).mockImplementation((() => {
    const proc = new EventEmitter() as any;
    proc.stdout = new EventEmitter();
    // nextTick ensures listeners are attached before events fire
    process.nextTick(() => {
      if (version) {
        proc.stdout.emit('data', Buffer.from(version + '\n'));
      }
      proc.emit('close', version ? 0 : 1);
    });
    return proc;
  }) as any);
}

beforeEach(() => {
  vi.mocked(spawn).mockReset();
  if (fs.existsSync(cacheFile())) fs.unlinkSync(cacheFile());
});

afterAll(() => {
  fs.rmSync(testState.home, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// compareVersions (tested indirectly through cached checkForUpdate)
// ---------------------------------------------------------------------------

describe('compareVersions (via fresh cache)', () => {
  /** Write a fresh cache so checkForUpdate skips the npm fetch. */
  function freshCache(latestVersion: string) {
    writeCache({ lastCheck: Date.now(), latestVersion, dismissed: null });
  }

  it('detects newer major version', async () => {
    freshCache('2.0.0');
    expect(await checkForUpdate('1.0.0')).toBe('2.0.0');
  });

  it('detects newer minor version', async () => {
    freshCache('1.1.0');
    expect(await checkForUpdate('1.0.0')).toBe('1.1.0');
  });

  it('detects newer patch version', async () => {
    freshCache('1.0.1');
    expect(await checkForUpdate('1.0.0')).toBe('1.0.1');
  });

  it('returns null when versions are equal', async () => {
    freshCache('1.0.0');
    expect(await checkForUpdate('1.0.0')).toBeNull();
  });

  it('returns null when current is newer', async () => {
    freshCache('1.0.0');
    expect(await checkForUpdate('2.0.0')).toBeNull();
  });

  it('strips v-prefix for comparison', async () => {
    freshCache('v2.0.0');
    expect(await checkForUpdate('1.0.0')).toBe('v2.0.0');
  });

  it('handles uneven segments (latest longer)', async () => {
    freshCache('1.0.1');
    // "1.0" → [1, 0] vs "1.0.1" → [1, 0, 1]; missing segment defaults to 0
    expect(await checkForUpdate('1.0')).toBe('1.0.1');
  });

  it('handles uneven segments (current longer)', async () => {
    freshCache('1.0');
    // "1.0" → [1, 0] vs "1.0.1" → [1, 0, 1]; latest is older
    expect(await checkForUpdate('1.0.1')).toBeNull();
  });

  it('does not call spawn when cache is fresh', async () => {
    freshCache('9.9.9');
    await checkForUpdate('1.0.0');
    expect(spawn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Cache staleness → npm fetch
// ---------------------------------------------------------------------------

describe('checkForUpdate fetch behavior', () => {
  it('fetches from npm when cache is stale', async () => {
    writeCache({ lastCheck: 0, latestVersion: null, dismissed: null });
    mockFetchVersion('3.0.0');
    expect(await checkForUpdate('1.0.0')).toBe('3.0.0');
    expect(spawn).toHaveBeenCalled();
  });

  it('fetches from npm when no cache exists', async () => {
    mockFetchVersion('2.0.0');
    expect(await checkForUpdate('1.0.0')).toBe('2.0.0');
  });

  it('returns null when npm fetch fails', async () => {
    mockFetchVersion(null);
    expect(await checkForUpdate('1.0.0')).toBeNull();
  });

  it('persists fetched version to cache file', async () => {
    mockFetchVersion('5.0.0');
    await checkForUpdate('1.0.0');
    const cache = readCache();
    expect(cache.latestVersion).toBe('5.0.0');
    expect(cache.lastCheck).toBeGreaterThan(0);
  });

  it('returns null when fetched version equals current', async () => {
    mockFetchVersion('1.0.0');
    expect(await checkForUpdate('1.0.0')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Dismissal
// ---------------------------------------------------------------------------

describe('dismissUpdate', () => {
  it('persists dismissed version to cache', () => {
    writeCache({ lastCheck: Date.now(), latestVersion: '2.0.0', dismissed: null });
    dismissUpdate('2.0.0');
    expect(readCache().dismissed).toBe('2.0.0');
  });

  it('suppresses notification for dismissed version', async () => {
    writeCache({ lastCheck: Date.now(), latestVersion: '2.0.0', dismissed: null });
    expect(await checkForUpdate('1.0.0')).toBe('2.0.0');

    dismissUpdate('2.0.0');
    expect(await checkForUpdate('1.0.0')).toBeNull();
  });

  it('does not suppress notification for a different version', async () => {
    writeCache({ lastCheck: Date.now(), latestVersion: '3.0.0', dismissed: '2.0.0' });
    expect(await checkForUpdate('1.0.0')).toBe('3.0.0');
  });

  it('creates cache directory if missing', () => {
    // No cache file exists yet — dismissUpdate should create .promptwheel/
    dismissUpdate('1.0.0');
    expect(fs.existsSync(cacheFile())).toBe(true);
    expect(readCache().dismissed).toBe('1.0.0');
  });
});
