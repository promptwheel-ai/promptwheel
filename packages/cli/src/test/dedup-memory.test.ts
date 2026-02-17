import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  loadDedupMemory,
  recordDedupEntry,
  recordDedupEntries,
  formatDedupForPrompt,
  getEnabledProposals,
  type DedupEntry,
} from '../lib/dedup-memory.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dedup-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function readRaw(): DedupEntry[] {
  const fp = path.join(tmpDir, '.promptwheel', 'dedup-memory.json');
  if (!fs.existsSync(fp)) return [];
  return JSON.parse(fs.readFileSync(fp, 'utf8'));
}

describe('recordDedupEntry', () => {
  it('creates a new entry', () => {
    recordDedupEntry(tmpDir, 'Add tests for utils', false);
    const entries = readRaw();
    expect(entries).toHaveLength(1);
    expect(entries[0].title).toBe('Add tests for utils');
    expect(entries[0].weight).toBe(60); // DEFAULT_WEIGHT
    expect(entries[0].completed).toBe(false);
    expect(entries[0].hit_count).toBe(1);
  });

  it('creates completed entry with higher weight', () => {
    recordDedupEntry(tmpDir, 'Refactor auth', true);
    const entries = readRaw();
    expect(entries[0].weight).toBe(80); // COMPLETED_WEIGHT
    expect(entries[0].completed).toBe(true);
  });

  it('bumps existing entry on re-encounter', () => {
    recordDedupEntry(tmpDir, 'Add tests for utils', false);
    recordDedupEntry(tmpDir, 'Add tests for utils', false);
    const entries = readRaw();
    expect(entries).toHaveLength(1);
    expect(entries[0].hit_count).toBe(2);
    expect(entries[0].weight).toBe(75); // 60 + 15 BUMP
  });

  it('upgrades to completed on re-encounter', () => {
    recordDedupEntry(tmpDir, 'Add tests for utils', false);
    recordDedupEntry(tmpDir, 'add tests for utils', true); // case-insensitive match
    const entries = readRaw();
    expect(entries).toHaveLength(1);
    expect(entries[0].completed).toBe(true);
  });
});

describe('recordDedupEntries', () => {
  it('batch-records multiple titles', () => {
    recordDedupEntries(tmpDir, [
      { title: 'A', completed: true },
      { title: 'B', completed: false },
    ]);
    const entries = readRaw();
    expect(entries).toHaveLength(2);
  });

  it('skips empty array without writing', () => {
    recordDedupEntries(tmpDir, []);
    expect(fs.existsSync(path.join(tmpDir, '.promptwheel', 'dedup-memory.json'))).toBe(false);
  });
});

describe('loadDedupMemory', () => {
  it('applies decay and prunes dead entries', () => {
    // Seed an entry with weight 3 — should die after one load (decay 5)
    const fp = path.join(tmpDir, '.promptwheel', 'dedup-memory.json');
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    const now = new Date().toISOString();
    const entries: DedupEntry[] = [{
      title: 'Dying entry',
      weight: 3,
      created_at: now,
      last_seen_at: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(), // old
      hit_count: 1,
      completed: false,
    }];
    fs.writeFileSync(fp, JSON.stringify(entries));

    const result = loadDedupMemory(tmpDir);
    expect(result).toHaveLength(0);
  });

  it('halves decay for recently-seen entries', () => {
    const fp = path.join(tmpDir, '.promptwheel', 'dedup-memory.json');
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    const entries: DedupEntry[] = [{
      title: 'Fresh entry',
      weight: 50,
      created_at: new Date().toISOString(),
      last_seen_at: new Date().toISOString(), // recent — halves decay
      hit_count: 3,
      completed: false,
    }];
    fs.writeFileSync(fp, JSON.stringify(entries));

    const result = loadDedupMemory(tmpDir);
    expect(result).toHaveLength(1);
    // decay = 5 / 2 (recent) = 2.5 → weight = 50 - 2.5 = 47.5
    expect(result[0].weight).toBe(47.5);
  });

  it('halves decay again for completed entries', () => {
    const fp = path.join(tmpDir, '.promptwheel', 'dedup-memory.json');
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    const entries: DedupEntry[] = [{
      title: 'Completed fresh',
      weight: 50,
      created_at: new Date().toISOString(),
      last_seen_at: new Date().toISOString(),
      hit_count: 1,
      completed: true, // halves decay again
    }];
    fs.writeFileSync(fp, JSON.stringify(entries));

    const result = loadDedupMemory(tmpDir);
    // decay = 5 / 2 (recent) / 2 (completed) = 1.25 → weight = 48.75
    expect(result[0].weight).toBe(48.75);
  });

  it('returns empty for missing file', () => {
    expect(loadDedupMemory(tmpDir)).toEqual([]);
  });
});

describe('formatDedupForPrompt', () => {
  const makeEntry = (title: string, weight: number, completed: boolean): DedupEntry => ({
    title,
    weight,
    created_at: new Date().toISOString(),
    last_seen_at: new Date().toISOString(),
    hit_count: 2,
    completed,
  });

  it('returns empty string for no entries', () => {
    expect(formatDedupForPrompt([])).toBe('');
  });

  it('includes header and footer tags', () => {
    const text = formatDedupForPrompt([makeEntry('Test thing', 50, true)]);
    expect(text).toContain('<already-completed>');
    expect(text).toContain('</already-completed>');
    expect(text).toContain('Do NOT Propose These');
  });

  it('sorts by weight descending', () => {
    const entries = [
      makeEntry('Low priority', 20, false),
      makeEntry('High priority', 90, true),
    ];
    const text = formatDedupForPrompt(entries);
    const highIdx = text.indexOf('High priority');
    const lowIdx = text.indexOf('Low priority');
    expect(highIdx).toBeLessThan(lowIdx);
  });

  it('shows completion status', () => {
    const text = formatDedupForPrompt([
      makeEntry('Done thing', 50, true),
      makeEntry('Tried thing', 50, false),
    ]);
    expect(text).toContain('✓ done');
    expect(text).toContain('attempted');
  });

  it('respects budget', () => {
    const entries = Array.from({ length: 100 }, (_, i) =>
      makeEntry(`Entry number ${i} with a somewhat long title to eat budget`, 50, true)
    );
    const text = formatDedupForPrompt(entries, 500);
    // Should have fewer than 100 entries due to budget
    const lineCount = text.split('\n').filter(l => l.startsWith('- ')).length;
    expect(lineCount).toBeLessThan(100);
    expect(lineCount).toBeGreaterThan(0);
  });

  it('shows scope_violation status for entries with that failureReason', () => {
    const entry: DedupEntry = {
      ...makeEntry('Out of scope fix', 50, false),
      failureReason: 'scope_violation',
    };
    const text = formatDedupForPrompt([entry]);
    expect(text).toContain('scope issue — may work with broader scope');
  });

  it('shows no_changes status for entries with that failureReason', () => {
    const entry: DedupEntry = {
      ...makeEntry('Already applied', 50, false),
      failureReason: 'no_changes',
    };
    const text = formatDedupForPrompt([entry]);
    expect(text).toContain('no changes produced');
  });

  it('shows generic attempted status for other failureReasons', () => {
    const entry: DedupEntry = {
      ...makeEntry('Broken agent', 50, false),
      failureReason: 'agent_error',
    };
    const text = formatDedupForPrompt([entry]);
    expect(text).toContain('attempted — failed');
  });
});

// ---------------------------------------------------------------------------
// recordDedupEntry — failureReason and relatedTitles
// ---------------------------------------------------------------------------

describe('recordDedupEntry — extended fields', () => {
  it('stores failureReason on new entry', () => {
    recordDedupEntry(tmpDir, 'Scope issue fix', false, 'scope_violation');
    const entries = readRaw();
    expect(entries).toHaveLength(1);
    expect(entries[0].failureReason).toBe('scope_violation');
  });

  it('stores relatedTitles on new entry', () => {
    recordDedupEntry(tmpDir, 'Refactor auth', true, undefined, ['Add auth tests', 'Fix auth bug']);
    const entries = readRaw();
    expect(entries).toHaveLength(1);
    expect(entries[0].relatedTitles).toEqual(['Add auth tests', 'Fix auth bug']);
  });

  it('updates failureReason on re-encounter', () => {
    recordDedupEntry(tmpDir, 'Flaky fix', false, 'agent_error');
    recordDedupEntry(tmpDir, 'flaky fix', false, 'qa_failed');
    const entries = readRaw();
    expect(entries).toHaveLength(1);
    expect(entries[0].failureReason).toBe('qa_failed');
  });

  it('updates relatedTitles on re-encounter', () => {
    recordDedupEntry(tmpDir, 'Main task', true, undefined, ['Related A']);
    recordDedupEntry(tmpDir, 'main task', true, undefined, ['Related B', 'Related C']);
    const entries = readRaw();
    expect(entries).toHaveLength(1);
    expect(entries[0].relatedTitles).toEqual(['Related B', 'Related C']);
  });

  it('preserves existing failureReason when re-encounter has no failureReason', () => {
    recordDedupEntry(tmpDir, 'Has reason', false, 'spindle_abort');
    recordDedupEntry(tmpDir, 'has reason', false);
    const entries = readRaw();
    expect(entries[0].failureReason).toBe('spindle_abort');
  });
});

// ---------------------------------------------------------------------------
// getEnabledProposals
// ---------------------------------------------------------------------------

describe('getEnabledProposals', () => {
  function seedEntries(entries: DedupEntry[]): void {
    const fp = path.join(tmpDir, '.promptwheel', 'dedup-memory.json');
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, JSON.stringify(entries), 'utf8');
  }

  it('returns empty array when no entries exist', () => {
    expect(getEnabledProposals(tmpDir)).toEqual([]);
  });

  it('returns related titles from recently completed entries', () => {
    seedEntries([{
      title: 'Refactor auth',
      weight: 80,
      created_at: new Date().toISOString(),
      last_seen_at: new Date().toISOString(),
      hit_count: 1,
      completed: true,
      relatedTitles: ['Add auth tests', 'Fix auth validation'],
    }]);

    const result = getEnabledProposals(tmpDir);
    expect(result).toContain('Add auth tests');
    expect(result).toContain('Fix auth validation');
  });

  it('excludes entries older than 48 hours', () => {
    const staleDate = new Date(Date.now() - 49 * 60 * 60 * 1000).toISOString();
    seedEntries([{
      title: 'Old task',
      weight: 80,
      created_at: staleDate,
      last_seen_at: staleDate,
      hit_count: 1,
      completed: true,
      relatedTitles: ['Should not appear'],
    }]);

    expect(getEnabledProposals(tmpDir)).toEqual([]);
  });

  it('includes entries within 48 hours', () => {
    const freshDate = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    seedEntries([{
      title: 'Recent task',
      weight: 80,
      created_at: freshDate,
      last_seen_at: freshDate,
      hit_count: 1,
      completed: true,
      relatedTitles: ['Follow-up task'],
    }]);

    expect(getEnabledProposals(tmpDir)).toEqual(['Follow-up task']);
  });

  it('excludes related titles that are themselves completed', () => {
    seedEntries([
      {
        title: 'Main task',
        weight: 80,
        created_at: new Date().toISOString(),
        last_seen_at: new Date().toISOString(),
        hit_count: 1,
        completed: true,
        relatedTitles: ['Already done', 'Not done yet'],
      },
      {
        title: 'Already done',
        weight: 80,
        created_at: new Date().toISOString(),
        last_seen_at: new Date().toISOString(),
        hit_count: 1,
        completed: true,
      },
    ]);

    const result = getEnabledProposals(tmpDir);
    expect(result).toEqual(['Not done yet']);
  });

  it('deduplicates returned titles', () => {
    const now = new Date().toISOString();
    seedEntries([
      {
        title: 'Task A',
        weight: 80,
        created_at: now,
        last_seen_at: now,
        hit_count: 1,
        completed: true,
        relatedTitles: ['Shared follow-up'],
      },
      {
        title: 'Task B',
        weight: 80,
        created_at: now,
        last_seen_at: now,
        hit_count: 1,
        completed: true,
        relatedTitles: ['Shared follow-up'],
      },
    ]);

    const result = getEnabledProposals(tmpDir);
    expect(result).toEqual(['Shared follow-up']);
  });

  it('skips non-completed entries even if they have relatedTitles', () => {
    seedEntries([{
      title: 'Incomplete task',
      weight: 60,
      created_at: new Date().toISOString(),
      last_seen_at: new Date().toISOString(),
      hit_count: 1,
      completed: false,
      relatedTitles: ['Should not appear'],
    }]);

    expect(getEnabledProposals(tmpDir)).toEqual([]);
  });

  it('skips completed entries without relatedTitles', () => {
    seedEntries([{
      title: 'No relations',
      weight: 80,
      created_at: new Date().toISOString(),
      last_seen_at: new Date().toISOString(),
      hit_count: 1,
      completed: true,
    }]);

    expect(getEnabledProposals(tmpDir)).toEqual([]);
  });
});
