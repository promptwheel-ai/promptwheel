import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  appendFixAttempt,
  appendFixOutcome,
  loadFixJournal,
  computeFixStats,
  getFixHistory,
  getRepeatFailures,
  buildFixContext,
  journalPath,
  type FixAttempt,
  type FixOutcome,
} from '../scout/fix-journal.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-fixjournal-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function attempt(findingId: string, overrides: Partial<FixAttempt> = {}): FixAttempt {
  return {
    finding_id: findingId,
    ticket_id: `tkt_${findingId}`,
    title: `Fix ${findingId}`,
    category: 'fix',
    severity: 'degrading',
    attempted_at: new Date().toISOString(),
    ...overrides,
  };
}

function outcome(findingId: string, success: boolean, overrides: Partial<FixOutcome> = {}): FixOutcome {
  return {
    finding_id: findingId,
    ticket_id: `tkt_${findingId}`,
    success,
    completed_at: new Date().toISOString(),
    ...(success ? { files_changed: ['src/a.ts'], pr_url: 'https://github.com/pr/1' } : { failure_reason: 'qa_failed' }),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

describe('fix journal persistence', () => {
  it('returns empty array when no journal', () => {
    expect(loadFixJournal(tmpDir)).toEqual([]);
  });

  it('appends and loads attempts and outcomes', () => {
    appendFixAttempt(tmpDir, attempt('a'));
    appendFixOutcome(tmpDir, outcome('a', true));
    appendFixAttempt(tmpDir, attempt('b'));
    appendFixOutcome(tmpDir, outcome('b', false));

    const entries = loadFixJournal(tmpDir);
    expect(entries).toHaveLength(4);
    expect(entries[0].type).toBe('attempt');
    expect(entries[1].type).toBe('outcome');
    expect(entries[1].data.finding_id).toBe('a');
  });

  it('creates directory if missing', () => {
    const nested = path.join(tmpDir, 'deep', 'dir');
    appendFixAttempt(nested, attempt('a'));
    expect(fs.existsSync(journalPath(nested))).toBe(true);
  });

  it('skips malformed lines', () => {
    fs.writeFileSync(journalPath(tmpDir), '{bad\n' + JSON.stringify({ type: 'attempt', data: attempt('a') }) + '\n');
    const entries = loadFixJournal(tmpDir);
    expect(entries).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// computeFixStats
// ---------------------------------------------------------------------------

describe('computeFixStats', () => {
  it('computes stats by category', () => {
    appendFixAttempt(tmpDir, attempt('a', { category: 'security' }));
    appendFixOutcome(tmpDir, outcome('a', true));
    appendFixAttempt(tmpDir, attempt('b', { category: 'security' }));
    appendFixOutcome(tmpDir, outcome('b', true));
    appendFixAttempt(tmpDir, attempt('c', { category: 'fix' }));
    appendFixOutcome(tmpDir, outcome('c', false));

    const entries = loadFixJournal(tmpDir);
    const stats = computeFixStats(entries, 'category');

    expect(stats['security'].total_attempts).toBe(2);
    expect(stats['security'].successes).toBe(2);
    expect(stats['security'].success_rate).toBe(1);
    expect(stats['fix'].total_attempts).toBe(1);
    expect(stats['fix'].failures).toBe(1);
    expect(stats['fix'].success_rate).toBe(0);
  });

  it('computes stats by severity', () => {
    appendFixAttempt(tmpDir, attempt('a', { severity: 'blocking' }));
    appendFixOutcome(tmpDir, outcome('a', true));
    appendFixAttempt(tmpDir, attempt('b', { severity: 'blocking' }));
    appendFixOutcome(tmpDir, outcome('b', false));

    const entries = loadFixJournal(tmpDir);
    const stats = computeFixStats(entries, 'severity');

    expect(stats['blocking'].total_attempts).toBe(2);
    expect(stats['blocking'].success_rate).toBe(0.5);
  });

  it('includes avg duration and cost when available', () => {
    appendFixAttempt(tmpDir, attempt('a'));
    appendFixOutcome(tmpDir, outcome('a', true, { duration_ms: 10000, cost_usd: 0.05 }));
    appendFixAttempt(tmpDir, attempt('b'));
    appendFixOutcome(tmpDir, outcome('b', true, { duration_ms: 20000, cost_usd: 0.15 }));

    const entries = loadFixJournal(tmpDir);
    const stats = computeFixStats(entries, 'category');

    expect(stats['fix'].avg_duration_ms).toBe(15000);
    expect(stats['fix'].avg_cost_usd).toBeCloseTo(0.1);
  });

  it('handles empty journal', () => {
    const stats = computeFixStats([], 'category');
    expect(Object.keys(stats)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// getFixHistory
// ---------------------------------------------------------------------------

describe('getFixHistory', () => {
  it('returns null for unknown finding', () => {
    expect(getFixHistory([], 'unknown')).toBeNull();
  });

  it('returns history for a finding', () => {
    appendFixAttempt(tmpDir, attempt('a'));
    appendFixOutcome(tmpDir, outcome('a', true));
    appendFixAttempt(tmpDir, attempt('a', { ticket_id: 'tkt_a2' }));
    appendFixOutcome(tmpDir, outcome('a', false, { ticket_id: 'tkt_a2', failure_reason: 'spindle_abort' }));

    const entries = loadFixJournal(tmpDir);
    const history = getFixHistory(entries, 'a');

    expect(history).not.toBeNull();
    expect(history!.attempts).toBe(2);
    expect(history!.successes).toBe(1);
    expect(history!.failures).toBe(1);
    expect(history!.last_outcome).toBe('failure');
    expect(history!.failure_reasons).toEqual(['spindle_abort']);
  });
});

// ---------------------------------------------------------------------------
// getRepeatFailures
// ---------------------------------------------------------------------------

describe('getRepeatFailures', () => {
  it('returns findings with >= minFailures', () => {
    // Finding 'a' fails twice
    appendFixAttempt(tmpDir, attempt('a'));
    appendFixOutcome(tmpDir, outcome('a', false));
    appendFixAttempt(tmpDir, attempt('a', { ticket_id: 'tkt_a2' }));
    appendFixOutcome(tmpDir, outcome('a', false, { ticket_id: 'tkt_a2' }));
    // Finding 'b' fails once (below threshold)
    appendFixAttempt(tmpDir, attempt('b'));
    appendFixOutcome(tmpDir, outcome('b', false));

    const entries = loadFixJournal(tmpDir);
    const repeats = getRepeatFailures(entries, 2);

    expect(repeats).toHaveLength(1);
    expect(repeats[0].finding_id).toBe('a');
    expect(repeats[0].failures).toBe(2);
  });

  it('returns empty array for no failures', () => {
    appendFixAttempt(tmpDir, attempt('a'));
    appendFixOutcome(tmpDir, outcome('a', true));

    const entries = loadFixJournal(tmpDir);
    expect(getRepeatFailures(entries)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// buildFixContext
// ---------------------------------------------------------------------------

describe('buildFixContext', () => {
  it('returns null for empty journal', () => {
    expect(buildFixContext([])).toBeNull();
  });

  it('builds context string with stats', () => {
    appendFixAttempt(tmpDir, attempt('a', { category: 'security' }));
    appendFixOutcome(tmpDir, outcome('a', true));
    appendFixAttempt(tmpDir, attempt('b', { category: 'fix' }));
    appendFixOutcome(tmpDir, outcome('b', false));

    const entries = loadFixJournal(tmpDir);
    const ctx = buildFixContext(entries);

    expect(ctx).toContain('security: 100% fix rate');
    expect(ctx).toContain('fix: 0% fix rate');
  });

  it('includes repeat failures in context', () => {
    appendFixAttempt(tmpDir, attempt('a'));
    appendFixOutcome(tmpDir, outcome('a', false, { failure_reason: 'qa_failed' }));
    appendFixAttempt(tmpDir, attempt('a', { ticket_id: 'tkt_a2' }));
    appendFixOutcome(tmpDir, outcome('a', false, { ticket_id: 'tkt_a2', failure_reason: 'spindle_abort' }));

    const entries = loadFixJournal(tmpDir);
    const ctx = buildFixContext(entries);

    expect(ctx).toContain('repeatedly failed');
    expect(ctx).toContain('Fix a');
    expect(ctx).toContain('failed 2 times');
  });
});
