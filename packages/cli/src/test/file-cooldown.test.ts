/**
 * Tests for file-cooldown PR overlap tracking
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  computeCooldownOverlap,
  recordPrFiles,
  getCooledFiles,
  removePrEntries,
} from '../lib/file-cooldown.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

function cooldownFile(): string {
  return path.join(tmpDir, '.blockspool', 'file-cooldown.json');
}

function readRaw(): Array<{ filePath: string; prUrl: string; createdAt: number }> {
  if (!fs.existsSync(cooldownFile())) return [];
  return JSON.parse(fs.readFileSync(cooldownFile(), 'utf8'));
}

function writeRaw(entries: Array<{ filePath: string; prUrl: string; createdAt: number }>): void {
  const dir = path.join(tmpDir, '.blockspool');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(cooldownFile(), JSON.stringify(entries, null, 2) + '\n', 'utf8');
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-cooldown-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// computeCooldownOverlap
// ---------------------------------------------------------------------------

describe('computeCooldownOverlap', () => {
  it('returns 0 for empty files list', () => {
    const cooled = new Map([['src/a.ts', 'https://github.com/pr/1']]);
    expect(computeCooldownOverlap([], cooled)).toBe(0);
  });

  it('returns 0 for empty cooled files map', () => {
    expect(computeCooldownOverlap(['src/a.ts', 'src/b.ts'], new Map())).toBe(0);
  });

  it('returns 0 when both are empty', () => {
    expect(computeCooldownOverlap([], new Map())).toBe(0);
  });

  it('returns 0 when no files overlap', () => {
    const cooled = new Map([['src/x.ts', 'https://github.com/pr/1']]);
    expect(computeCooldownOverlap(['src/a.ts', 'src/b.ts'], cooled)).toBe(0);
  });

  it('returns correct ratio for partial overlap', () => {
    const cooled = new Map([
      ['src/a.ts', 'https://github.com/pr/1'],
      ['src/c.ts', 'https://github.com/pr/2'],
    ]);
    // 1 out of 3 files overlaps
    expect(computeCooldownOverlap(['src/a.ts', 'src/b.ts', 'src/d.ts'], cooled)).toBeCloseTo(1 / 3);
  });

  it('returns 0.5 for half overlap', () => {
    const cooled = new Map([
      ['src/a.ts', 'https://github.com/pr/1'],
      ['src/b.ts', 'https://github.com/pr/2'],
    ]);
    expect(computeCooldownOverlap(['src/a.ts', 'src/c.ts'], cooled)).toBe(0.5);
  });

  it('returns 1 for full overlap', () => {
    const cooled = new Map([
      ['src/a.ts', 'https://github.com/pr/1'],
      ['src/b.ts', 'https://github.com/pr/2'],
    ]);
    expect(computeCooldownOverlap(['src/a.ts', 'src/b.ts'], cooled)).toBe(1);
  });

  it('handles single file overlap', () => {
    const cooled = new Map([['src/a.ts', 'https://github.com/pr/1']]);
    expect(computeCooldownOverlap(['src/a.ts'], cooled)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// prune (tested indirectly via getCooledFiles and recordPrFiles)
// ---------------------------------------------------------------------------

describe('prune', () => {
  const TTL_MS = 48 * 60 * 60 * 1000; // 48 hours, matching the source

  it('keeps fresh entries', () => {
    const now = Date.now();
    writeRaw([
      { filePath: 'src/a.ts', prUrl: 'https://github.com/pr/1', createdAt: now - 1000 },
    ]);

    const result = getCooledFiles(tmpDir);
    expect(result.size).toBe(1);
    expect(result.get('src/a.ts')).toBe('https://github.com/pr/1');
  });

  it('removes expired entries', () => {
    const now = Date.now();
    writeRaw([
      { filePath: 'src/old.ts', prUrl: 'https://github.com/pr/1', createdAt: now - TTL_MS - 1000 },
      { filePath: 'src/new.ts', prUrl: 'https://github.com/pr/2', createdAt: now - 1000 },
    ]);

    const result = getCooledFiles(tmpDir);
    expect(result.size).toBe(1);
    expect(result.has('src/old.ts')).toBe(false);
    expect(result.has('src/new.ts')).toBe(true);
  });

  it('removes all expired entries', () => {
    const now = Date.now();
    writeRaw([
      { filePath: 'src/a.ts', prUrl: 'https://github.com/pr/1', createdAt: now - TTL_MS - 1000 },
      { filePath: 'src/b.ts', prUrl: 'https://github.com/pr/2', createdAt: now - TTL_MS - 5000 },
    ]);

    const result = getCooledFiles(tmpDir);
    expect(result.size).toBe(0);
  });

  it('keeps entries exactly at the TTL boundary', () => {
    // An entry created exactly TTL_MS ago has createdAt == cutoff, which is NOT > cutoff, so it's pruned
    const now = Date.now();
    writeRaw([
      { filePath: 'src/boundary.ts', prUrl: 'https://github.com/pr/1', createdAt: now - TTL_MS },
    ]);

    const result = getCooledFiles(tmpDir);
    // createdAt == cutoff means filter (e.createdAt > cutoff) is false, so it's pruned
    expect(result.size).toBe(0);
  });

  it('writes back pruned entries to disk', () => {
    const now = Date.now();
    writeRaw([
      { filePath: 'src/old.ts', prUrl: 'https://github.com/pr/1', createdAt: now - TTL_MS - 1000 },
      { filePath: 'src/new.ts', prUrl: 'https://github.com/pr/2', createdAt: now - 1000 },
    ]);

    getCooledFiles(tmpDir);

    // Read the file directly to verify pruned entries were written back
    const onDisk = readRaw();
    expect(onDisk).toHaveLength(1);
    expect(onDisk[0].filePath).toBe('src/new.ts');
  });

  it('does not write back if no pruning occurred', () => {
    const now = Date.now();
    const entries = [
      { filePath: 'src/a.ts', prUrl: 'https://github.com/pr/1', createdAt: now - 1000 },
    ];
    writeRaw(entries);

    // Record mtime before getCooledFiles
    const mtimeBefore = fs.statSync(cooldownFile()).mtimeMs;

    // Small delay to ensure mtime would differ if file were rewritten
    const start = Date.now();
    while (Date.now() - start < 10) { /* busy wait */ }

    getCooledFiles(tmpDir);

    // File should not have been rewritten since no pruning was needed
    const mtimeAfter = fs.statSync(cooldownFile()).mtimeMs;
    expect(mtimeAfter).toBe(mtimeBefore);
  });
});

// ---------------------------------------------------------------------------
// recordPrFiles + getCooledFiles round-trip
// ---------------------------------------------------------------------------

describe('recordPrFiles + getCooledFiles round-trip', () => {
  it('records files and retrieves them', () => {
    recordPrFiles(tmpDir, 'https://github.com/pr/1', ['src/a.ts', 'src/b.ts']);

    const result = getCooledFiles(tmpDir);
    expect(result.size).toBe(2);
    expect(result.get('src/a.ts')).toBe('https://github.com/pr/1');
    expect(result.get('src/b.ts')).toBe('https://github.com/pr/1');
  });

  it('creates .blockspool directory if it does not exist', () => {
    const bsDir = path.join(tmpDir, '.blockspool');
    expect(fs.existsSync(bsDir)).toBe(false);

    recordPrFiles(tmpDir, 'https://github.com/pr/1', ['src/a.ts']);

    expect(fs.existsSync(bsDir)).toBe(true);
    expect(fs.existsSync(cooldownFile())).toBe(true);
  });

  it('appends to existing entries', () => {
    recordPrFiles(tmpDir, 'https://github.com/pr/1', ['src/a.ts']);
    recordPrFiles(tmpDir, 'https://github.com/pr/2', ['src/b.ts']);

    const result = getCooledFiles(tmpDir);
    expect(result.size).toBe(2);
    expect(result.get('src/a.ts')).toBe('https://github.com/pr/1');
    expect(result.get('src/b.ts')).toBe('https://github.com/pr/2');
  });

  it('handles empty file list', () => {
    recordPrFiles(tmpDir, 'https://github.com/pr/1', []);

    const result = getCooledFiles(tmpDir);
    expect(result.size).toBe(0);
  });

  it('last PR URL wins for duplicate file paths in the map', () => {
    recordPrFiles(tmpDir, 'https://github.com/pr/1', ['src/a.ts']);
    recordPrFiles(tmpDir, 'https://github.com/pr/2', ['src/a.ts']);

    const result = getCooledFiles(tmpDir);
    // Map.set overwrites, so last entry for 'src/a.ts' wins
    expect(result.get('src/a.ts')).toBe('https://github.com/pr/2');
  });

  it('returns empty map when no cooldown file exists', () => {
    const result = getCooledFiles(tmpDir);
    expect(result.size).toBe(0);
  });

  it('prunes expired entries during recordPrFiles', () => {
    const now = Date.now();
    const TTL_MS = 48 * 60 * 60 * 1000;
    // Seed with an expired entry
    writeRaw([
      { filePath: 'src/old.ts', prUrl: 'https://github.com/pr/old', createdAt: now - TTL_MS - 1000 },
    ]);

    recordPrFiles(tmpDir, 'https://github.com/pr/new', ['src/new.ts']);

    const onDisk = readRaw();
    // The expired entry should have been pruned during recordPrFiles
    expect(onDisk.every(e => e.filePath !== 'src/old.ts')).toBe(true);
    expect(onDisk.some(e => e.filePath === 'src/new.ts')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// removePrEntries
// ---------------------------------------------------------------------------

describe('removePrEntries', () => {
  it('removes all entries matching the given PR URL', () => {
    recordPrFiles(tmpDir, 'https://github.com/pr/1', ['src/a.ts', 'src/b.ts']);
    recordPrFiles(tmpDir, 'https://github.com/pr/2', ['src/c.ts']);

    removePrEntries(tmpDir, ['https://github.com/pr/1']);

    const result = getCooledFiles(tmpDir);
    expect(result.size).toBe(1);
    expect(result.has('src/a.ts')).toBe(false);
    expect(result.has('src/b.ts')).toBe(false);
    expect(result.has('src/c.ts')).toBe(true);
  });

  it('removes entries matching multiple PR URLs', () => {
    recordPrFiles(tmpDir, 'https://github.com/pr/1', ['src/a.ts']);
    recordPrFiles(tmpDir, 'https://github.com/pr/2', ['src/b.ts']);
    recordPrFiles(tmpDir, 'https://github.com/pr/3', ['src/c.ts']);

    removePrEntries(tmpDir, ['https://github.com/pr/1', 'https://github.com/pr/3']);

    const result = getCooledFiles(tmpDir);
    expect(result.size).toBe(1);
    expect(result.has('src/b.ts')).toBe(true);
  });

  it('does nothing when prUrls list is empty', () => {
    recordPrFiles(tmpDir, 'https://github.com/pr/1', ['src/a.ts']);

    removePrEntries(tmpDir, []);

    const result = getCooledFiles(tmpDir);
    expect(result.size).toBe(1);
  });

  it('handles removal when no matching PR URL exists', () => {
    recordPrFiles(tmpDir, 'https://github.com/pr/1', ['src/a.ts']);

    removePrEntries(tmpDir, ['https://github.com/pr/999']);

    const result = getCooledFiles(tmpDir);
    expect(result.size).toBe(1);
    expect(result.has('src/a.ts')).toBe(true);
  });

  it('handles removal from empty cooldown store', () => {
    // Should not throw
    removePrEntries(tmpDir, ['https://github.com/pr/1']);

    const result = getCooledFiles(tmpDir);
    expect(result.size).toBe(0);
  });

  it('prunes expired entries during removal', () => {
    const now = Date.now();
    const TTL_MS = 48 * 60 * 60 * 1000;
    writeRaw([
      { filePath: 'src/old.ts', prUrl: 'https://github.com/pr/old', createdAt: now - TTL_MS - 1000 },
      { filePath: 'src/keep.ts', prUrl: 'https://github.com/pr/keep', createdAt: now - 1000 },
    ]);

    removePrEntries(tmpDir, ['https://github.com/pr/nonexistent']);

    const onDisk = readRaw();
    // Expired entry should be pruned
    expect(onDisk.every(e => e.filePath !== 'src/old.ts')).toBe(true);
    expect(onDisk.some(e => e.filePath === 'src/keep.ts')).toBe(true);
  });

  it('removes all entries when all PR URLs are removed', () => {
    recordPrFiles(tmpDir, 'https://github.com/pr/1', ['src/a.ts']);
    recordPrFiles(tmpDir, 'https://github.com/pr/2', ['src/b.ts']);

    removePrEntries(tmpDir, ['https://github.com/pr/1', 'https://github.com/pr/2']);

    const result = getCooledFiles(tmpDir);
    expect(result.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('edge cases', () => {
  it('handles corrupted JSON in cooldown file', () => {
    const dir = path.join(tmpDir, '.blockspool');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(cooldownFile(), 'not valid json', 'utf8');

    const result = getCooledFiles(tmpDir);
    expect(result.size).toBe(0);
  });

  it('handles non-array JSON in cooldown file', () => {
    const dir = path.join(tmpDir, '.blockspool');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(cooldownFile(), JSON.stringify({ not: 'an array' }), 'utf8');

    const result = getCooledFiles(tmpDir);
    expect(result.size).toBe(0);
  });

  it('records multiple files for the same PR', () => {
    const files = ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts'];
    recordPrFiles(tmpDir, 'https://github.com/pr/1', files);

    const result = getCooledFiles(tmpDir);
    expect(result.size).toBe(5);
    for (const f of files) {
      expect(result.get(f)).toBe('https://github.com/pr/1');
    }
  });
});
