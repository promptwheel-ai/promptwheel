/**
 * Tests for solo-hints module: addHint, readHints, consumePendingHints, clearHints, pruning, atomic writes
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  readHints,
  addHint,
  consumePendingHints,
  clearHints,
  type Hint,
} from '../lib/solo-hints.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hints-test-'));
  // Create .promptwheel dir like a real repo would have
  fs.mkdirSync(path.join(tmpDir, '.promptwheel'), { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function hintsFile(): string {
  return path.join(tmpDir, '.promptwheel', 'hints.json');
}

function readRawHints(): Hint[] {
  return JSON.parse(fs.readFileSync(hintsFile(), 'utf-8'));
}

describe('readHints', () => {
  it('returns empty array when no file exists', () => {
    expect(readHints(tmpDir)).toEqual([]);
  });

  it('returns empty array when file is invalid JSON', () => {
    fs.writeFileSync(hintsFile(), 'not json', 'utf-8');
    expect(readHints(tmpDir)).toEqual([]);
  });

  it('reads existing hints', () => {
    const hint: Hint = { id: 'abc', text: 'test hint', createdAt: Date.now(), consumed: false };
    fs.writeFileSync(hintsFile(), JSON.stringify([hint]), 'utf-8');
    const result = readHints(tmpDir);
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe('test hint');
  });
});

describe('addHint', () => {
  it('creates a hint with correct fields', () => {
    const hint = addHint(tmpDir, 'focus on security');
    expect(hint.text).toBe('focus on security');
    expect(hint.consumed).toBe(false);
    expect(hint.id).toBeTruthy();
    expect(hint.createdAt).toBeGreaterThan(0);
  });

  it('persists to disk', () => {
    addHint(tmpDir, 'hint one');
    addHint(tmpDir, 'hint two');
    const raw = readRawHints();
    expect(raw).toHaveLength(2);
    expect(raw[0].text).toBe('hint one');
    expect(raw[1].text).toBe('hint two');
  });

  it('truncates text longer than 500 characters', () => {
    const longText = 'x'.repeat(600);
    const hint = addHint(tmpDir, longText);
    expect(hint.text).toHaveLength(500);
  });

  it('creates .promptwheel directory if missing', () => {
    const freshDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hints-fresh-'));
    try {
      const hint = addHint(freshDir, 'auto-create dir');
      expect(hint.text).toBe('auto-create dir');
      expect(fs.existsSync(path.join(freshDir, '.promptwheel', 'hints.json'))).toBe(true);
    } finally {
      fs.rmSync(freshDir, { recursive: true, force: true });
    }
  });
});

describe('consumePendingHints', () => {
  it('returns null when no hints exist', () => {
    expect(consumePendingHints(tmpDir)).toBeNull();
  });

  it('returns null when all hints are consumed', () => {
    const hint: Hint = { id: 'abc', text: 'old', createdAt: Date.now(), consumed: true };
    fs.writeFileSync(hintsFile(), JSON.stringify([hint]), 'utf-8');
    expect(consumePendingHints(tmpDir)).toBeNull();
  });

  it('returns formatted prompt block with pending hints', () => {
    addHint(tmpDir, 'focus on security vulnerabilities');
    addHint(tmpDir, 'skip test files for now');

    const block = consumePendingHints(tmpDir);
    expect(block).toContain('## User Steering Hints');
    expect(block).toContain('- "focus on security vulnerabilities"');
    expect(block).toContain('- "skip test files for now"');
  });

  it('marks hints as consumed on disk', () => {
    addHint(tmpDir, 'hint A');
    addHint(tmpDir, 'hint B');

    consumePendingHints(tmpDir);

    const raw = readRawHints();
    expect(raw.every((h) => h.consumed)).toBe(true);
  });

  it('does not re-consume already consumed hints', () => {
    addHint(tmpDir, 'first');
    consumePendingHints(tmpDir);

    addHint(tmpDir, 'second');
    const block = consumePendingHints(tmpDir);

    expect(block).toContain('- "second"');
    expect(block).not.toContain('- "first"');
  });
});

describe('clearHints', () => {
  it('removes all hints', () => {
    addHint(tmpDir, 'one');
    addHint(tmpDir, 'two');
    clearHints(tmpDir);

    expect(readHints(tmpDir)).toEqual([]);
    expect(readRawHints()).toEqual([]);
  });
});

describe('pruning', () => {
  it('prunes consumed hints older than 1 hour on read', () => {
    const oneHourAgo = Date.now() - 61 * 60 * 1000;
    const stale: Hint = { id: 'old', text: 'stale', createdAt: oneHourAgo, consumed: true };
    const fresh: Hint = { id: 'new', text: 'fresh', createdAt: Date.now(), consumed: false };
    fs.writeFileSync(hintsFile(), JSON.stringify([stale, fresh]), 'utf-8');

    const result = readHints(tmpDir);
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe('fresh');

    // Verify pruned on disk too
    const raw = readRawHints();
    expect(raw).toHaveLength(1);
  });

  it('keeps old unconsumed hints', () => {
    const oneHourAgo = Date.now() - 61 * 60 * 1000;
    const old: Hint = { id: 'old', text: 'still pending', createdAt: oneHourAgo, consumed: false };
    fs.writeFileSync(hintsFile(), JSON.stringify([old]), 'utf-8');

    const result = readHints(tmpDir);
    expect(result).toHaveLength(1);
  });

  it('keeps recently consumed hints', () => {
    const recent: Hint = { id: 'r', text: 'just consumed', createdAt: Date.now(), consumed: true };
    fs.writeFileSync(hintsFile(), JSON.stringify([recent]), 'utf-8');

    const result = readHints(tmpDir);
    expect(result).toHaveLength(1);
  });
});

describe('atomic writes', () => {
  it('does not leave tmp file after write', () => {
    addHint(tmpDir, 'test');
    const tmpFile = path.join(tmpDir, '.promptwheel', 'hints.json.tmp');
    expect(fs.existsSync(tmpFile)).toBe(false);
  });
});

describe('concurrent add safety', () => {
  it('handles rapid sequential adds without data loss', () => {
    for (let i = 0; i < 20; i++) {
      addHint(tmpDir, `hint ${i}`);
    }
    const hints = readHints(tmpDir);
    expect(hints).toHaveLength(20);
  });
});
