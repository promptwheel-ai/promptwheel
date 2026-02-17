import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  appendRunHistory,
  readRunHistory,
  formatHistoryEntry,
  getBillingReminder,
  type RunHistoryEntry,
} from '../lib/run-history.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

function historyFile(): string {
  return path.join(tmpDir, '.promptwheel', 'history.ndjson');
}

function makeEntry(overrides: Partial<RunHistoryEntry> = {}): RunHistoryEntry {
  return {
    timestamp: new Date().toISOString(),
    mode: 'auto',
    scope: '**',
    ticketsProposed: 5,
    ticketsApproved: 4,
    ticketsCompleted: 3,
    ticketsFailed: 1,
    prsCreated: 3,
    prsMerged: 2,
    durationMs: 60000,
    parallel: 2,
    ...overrides,
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-history-test-'));
  fs.mkdirSync(path.join(tmpDir, '.promptwheel'), { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// appendRunHistory
// ---------------------------------------------------------------------------

describe('appendRunHistory', () => {
  it('creates file and returns file path', () => {
    const entry = makeEntry();
    const filePath = appendRunHistory(entry, tmpDir);

    expect(filePath).toBe(historyFile());
    expect(fs.existsSync(historyFile())).toBe(true);

    const content = fs.readFileSync(historyFile(), 'utf-8');
    const parsed = JSON.parse(content.trim());
    expect(parsed.mode).toBe('auto');
  });

  it('appends to existing file', () => {
    const entry1 = makeEntry({ mode: 'auto', scope: 'src/**' });
    const entry2 = makeEntry({ mode: 'ci', scope: 'tests/**' });

    appendRunHistory(entry1, tmpDir);
    appendRunHistory(entry2, tmpDir);

    const lines = fs.readFileSync(historyFile(), 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);

    const parsed1 = JSON.parse(lines[0]);
    const parsed2 = JSON.parse(lines[1]);
    expect(parsed1.mode).toBe('auto');
    expect(parsed1.scope).toBe('src/**');
    expect(parsed2.mode).toBe('ci');
    expect(parsed2.scope).toBe('tests/**');
  });
});

// ---------------------------------------------------------------------------
// readRunHistory
// ---------------------------------------------------------------------------

describe('readRunHistory', () => {
  it('returns entries most-recent-first', () => {
    const entry1 = makeEntry({ timestamp: '2024-01-01T00:00:00.000Z', scope: 'first' });
    const entry2 = makeEntry({ timestamp: '2024-01-02T00:00:00.000Z', scope: 'second' });
    const entry3 = makeEntry({ timestamp: '2024-01-03T00:00:00.000Z', scope: 'third' });

    appendRunHistory(entry1, tmpDir);
    appendRunHistory(entry2, tmpDir);
    appendRunHistory(entry3, tmpDir);

    const entries = readRunHistory(tmpDir);
    expect(entries).toHaveLength(3);
    expect(entries[0].scope).toBe('third');
    expect(entries[1].scope).toBe('second');
    expect(entries[2].scope).toBe('first');
  });

  it('respects limit parameter', () => {
    for (let i = 0; i < 5; i++) {
      appendRunHistory(makeEntry({ scope: `scope-${i}` }), tmpDir);
    }

    const entries = readRunHistory(tmpDir, 3);
    expect(entries).toHaveLength(3);
    // Most recent first, so scope-4, scope-3, scope-2
    expect(entries[0].scope).toBe('scope-4');
    expect(entries[1].scope).toBe('scope-3');
    expect(entries[2].scope).toBe('scope-2');
  });

  it('handles malformed lines gracefully', () => {
    // Write a mix of garbage and valid JSON directly to the file
    const validEntry = makeEntry({ scope: 'valid-entry' });
    const content = [
      'this is not json',
      JSON.stringify(validEntry),
      '{broken json{{{',
      JSON.stringify(makeEntry({ scope: 'another-valid' })),
      '',
    ].join('\n');

    fs.writeFileSync(historyFile(), content, 'utf-8');

    const entries = readRunHistory(tmpDir);
    expect(entries).toHaveLength(2);
    // Most recent first (last valid line first)
    expect(entries[0].scope).toBe('another-valid');
    expect(entries[1].scope).toBe('valid-entry');
  });

  it('returns empty array for missing file', () => {
    // Remove the .promptwheel dir so history file does not exist
    fs.rmSync(path.join(tmpDir, '.promptwheel'), { recursive: true, force: true });

    const entries = readRunHistory(tmpDir);
    expect(entries).toEqual([]);
  });

  it('returns empty array from non-existent repo path', () => {
    const nonExistentPath = path.join(os.tmpdir(), 'non-existent-repo-' + Date.now());
    const entries = readRunHistory(nonExistentPath);
    expect(entries).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Round-trip: specific fields
// ---------------------------------------------------------------------------

describe('round-trip field correctness', () => {
  it('preserves all fields through append and read', () => {
    const entry: RunHistoryEntry = {
      timestamp: '2024-06-15T12:30:00.000Z',
      mode: 'manual',
      scope: 'packages/cli/**',
      formula: 'security-audit',
      ticketsProposed: 10,
      ticketsApproved: 8,
      ticketsCompleted: 6,
      ticketsFailed: 2,
      prsCreated: 5,
      prsMerged: 4,
      durationMs: 120000,
      parallel: 3,
      stoppedReason: 'budget_exhausted',
      errors: ['lint failed', 'type error in foo.ts'],
      tickets: [
        {
          id: 'tkt-abc',
          title: 'Fix auth bug',
          category: 'bug',
          status: 'completed',
          prUrl: 'https://github.com/org/repo/pull/42',
          durationMs: 30000,
        },
        {
          id: 'tkt-def',
          title: 'Add tests',
          status: 'failed',
          error: 'timeout',
          durationMs: 60000,
        },
      ],
    };

    appendRunHistory(entry, tmpDir);
    const entries = readRunHistory(tmpDir);

    expect(entries).toHaveLength(1);
    const result = entries[0];

    expect(result.timestamp).toBe('2024-06-15T12:30:00.000Z');
    expect(result.mode).toBe('manual');
    expect(result.scope).toBe('packages/cli/**');
    expect(result.formula).toBe('security-audit');
    expect(result.ticketsProposed).toBe(10);
    expect(result.ticketsApproved).toBe(8);
    expect(result.ticketsCompleted).toBe(6);
    expect(result.ticketsFailed).toBe(2);
    expect(result.prsCreated).toBe(5);
    expect(result.prsMerged).toBe(4);
    expect(result.durationMs).toBe(120000);
    expect(result.parallel).toBe(3);
    expect(result.stoppedReason).toBe('budget_exhausted');
    expect(result.errors).toEqual(['lint failed', 'type error in foo.ts']);
    expect(result.tickets).toHaveLength(2);
    expect(result.tickets![0].id).toBe('tkt-abc');
    expect(result.tickets![0].title).toBe('Fix auth bug');
    expect(result.tickets![0].category).toBe('bug');
    expect(result.tickets![0].status).toBe('completed');
    expect(result.tickets![0].prUrl).toBe('https://github.com/org/repo/pull/42');
    expect(result.tickets![1].id).toBe('tkt-def');
    expect(result.tickets![1].status).toBe('failed');
    expect(result.tickets![1].error).toBe('timeout');
  });
});

// ---------------------------------------------------------------------------
// formatHistoryEntry
// ---------------------------------------------------------------------------

describe('formatHistoryEntry', () => {
  it('includes mode, scope, parallel, ticket counts, and PR counts', () => {
    const entry = makeEntry({
      timestamp: '2024-06-15T12:30:00.000Z',
      mode: 'auto',
      scope: 'src/**',
      parallel: 2,
      ticketsProposed: 5,
      ticketsCompleted: 3,
      ticketsFailed: 1,
      prsCreated: 3,
      prsMerged: 2,
      durationMs: 60000,
    });
    const result = formatHistoryEntry(entry);
    expect(result).toContain('auto');
    expect(result).toContain('Scope: src/**');
    expect(result).toContain('Parallel: 2');
    expect(result).toContain('3 completed, 1 failed (5 proposed)');
    expect(result).toContain('3 created, 2 merged');
  });

  it('includes formula when present', () => {
    const entry = makeEntry({ formula: 'security-audit' });
    const result = formatHistoryEntry(entry);
    expect(result).toContain('(security-audit)');
  });

  it('omits formula when absent', () => {
    const entry = makeEntry({ formula: undefined });
    const result = formatHistoryEntry(entry);
    expect(result).not.toContain('(undefined)');
    // First line should have mode without parentheses
    const firstLine = result.split('\n')[0];
    expect(firstLine).toContain('auto');
    expect(firstLine).not.toContain('(');
  });

  it('includes stopped reason when present', () => {
    const entry = makeEntry({ stoppedReason: 'budget_exhausted' });
    const result = formatHistoryEntry(entry);
    expect(result).toContain('Stopped: budget_exhausted');
  });

  it('omits stopped reason when absent', () => {
    const entry = makeEntry({ stoppedReason: undefined });
    const result = formatHistoryEntry(entry);
    expect(result).not.toContain('Stopped:');
  });

  it('includes error count when errors present', () => {
    const entry = makeEntry({ errors: ['lint failed', 'type error'] });
    const result = formatHistoryEntry(entry);
    expect(result).toContain('Errors: 2');
  });

  it('omits error line when no errors', () => {
    const entry = makeEntry({ errors: undefined });
    const result = formatHistoryEntry(entry);
    expect(result).not.toContain('Errors:');
  });

  it('formats seconds-only duration', () => {
    const entry = makeEntry({ durationMs: 30000 }); // 30 seconds
    const result = formatHistoryEntry(entry);
    expect(result).toContain('Duration: 30s');
  });

  it('formats minutes and seconds duration', () => {
    const entry = makeEntry({ durationMs: 150000 }); // 2m 30s
    const result = formatHistoryEntry(entry);
    expect(result).toContain('Duration: 2m 30s');
  });

  it('formats hours and minutes duration', () => {
    const entry = makeEntry({ durationMs: 3900000 }); // 1h 5m
    const result = formatHistoryEntry(entry);
    expect(result).toContain('Duration: 1h 5m');
  });
});

// ---------------------------------------------------------------------------
// getBillingReminder
// ---------------------------------------------------------------------------

describe('getBillingReminder', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns null when no API keys set', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.stubEnv('OPENAI_API_KEY', '');
    expect(getBillingReminder(tmpDir)).toBeNull();
  });

  it('returns null when no tickets completed', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test-key');
    // No entries written — readRunHistory returns []
    expect(getBillingReminder(tmpDir)).toBeNull();
  });

  it('returns null when total tickets not a multiple of 10', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test-key');
    appendRunHistory(makeEntry({ ticketsCompleted: 7 }), tmpDir);
    expect(getBillingReminder(tmpDir)).toBeNull();
  });

  it('returns banner at exactly 10 completed tickets with ANTHROPIC_API_KEY', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test-key');
    vi.stubEnv('OPENAI_API_KEY', '');
    appendRunHistory(makeEntry({ ticketsCompleted: 10 }), tmpDir);
    const result = getBillingReminder(tmpDir);
    expect(result).not.toBeNull();
    expect(result).toContain('ANTHROPIC_API_KEY');
    expect(result).toContain('10');
  });

  it('returns banner with OPENAI_API_KEY when only that is set', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.stubEnv('OPENAI_API_KEY', 'sk-openai-test');
    appendRunHistory(makeEntry({ ticketsCompleted: 10 }), tmpDir);
    const result = getBillingReminder(tmpDir);
    expect(result).not.toBeNull();
    expect(result).toContain('OPENAI_API_KEY');
  });

  it('returns banner at 20 total across multiple entries', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test-key');
    appendRunHistory(makeEntry({ ticketsCompleted: 12 }), tmpDir);
    appendRunHistory(makeEntry({ ticketsCompleted: 8 }), tmpDir);
    const result = getBillingReminder(tmpDir);
    expect(result).not.toBeNull();
    expect(result).toContain('20');
  });

  it('prefers ANTHROPIC_API_KEY over OPENAI_API_KEY when both set', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-anthropic');
    vi.stubEnv('OPENAI_API_KEY', 'sk-openai');
    appendRunHistory(makeEntry({ ticketsCompleted: 10 }), tmpDir);
    const result = getBillingReminder(tmpDir);
    expect(result).not.toBeNull();
    expect(result).toContain('ANTHROPIC_API_KEY');
  });
});
