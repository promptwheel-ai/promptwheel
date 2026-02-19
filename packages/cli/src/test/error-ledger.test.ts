/**
 * Unit tests for error-ledger.ts — persistent error log for post-session analysis.
 *
 * Exercises:
 * - NDJSON append (appendErrorLedger)
 * - Reverse-chronological reads with limit (readErrorLedger)
 * - Pattern grouping with sinceMs cutoff (analyzeErrorLedger)
 * - Edge cases: empty/missing file, malformed lines
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  appendErrorLedger,
  readErrorLedger,
  analyzeErrorLedger,
} from '../lib/error-ledger.js';
import type { ErrorLedgerEntry } from '../lib/error-ledger.js';

let tmpDir: string;

function ledgerFile(): string {
  return path.join(tmpDir, '.promptwheel', 'error-ledger.ndjson');
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'error-ledger-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeEntry(overrides: Partial<ErrorLedgerEntry> = {}): ErrorLedgerEntry {
  return {
    ts: 1700000000000,
    ticketId: 'tkt_1',
    ticketTitle: 'Fix tests',
    failureType: 'test_failure',
    failedCommand: 'npm test',
    errorPattern: 'FAIL src/foo.test.ts',
    errorMessage: 'Expected true to be false',
    phase: 'qa',
    sessionCycle: 1,
    ...overrides,
  };
}

describe('appendErrorLedger', () => {
  it('creates .promptwheel directory and file on first write', () => {
    const entry = makeEntry();
    appendErrorLedger(tmpDir, entry);

    expect(fs.existsSync(ledgerFile())).toBe(true);
    const content = fs.readFileSync(ledgerFile(), 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toEqual(entry);
  });

  it('appends multiple entries as NDJSON lines', () => {
    appendErrorLedger(tmpDir, makeEntry({ ticketId: 'tkt_1' }));
    appendErrorLedger(tmpDir, makeEntry({ ticketId: 'tkt_2' }));
    appendErrorLedger(tmpDir, makeEntry({ ticketId: 'tkt_3' }));

    const content = fs.readFileSync(ledgerFile(), 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[1]).ticketId).toBe('tkt_2');
  });
});

describe('readErrorLedger', () => {
  it('returns empty array when file does not exist', () => {
    expect(readErrorLedger(tmpDir)).toEqual([]);
  });

  it('returns entries in reverse-chronological order', () => {
    appendErrorLedger(tmpDir, makeEntry({ ts: 1000 }));
    appendErrorLedger(tmpDir, makeEntry({ ts: 2000 }));
    appendErrorLedger(tmpDir, makeEntry({ ts: 3000 }));

    const entries = readErrorLedger(tmpDir);
    expect(entries).toHaveLength(3);
    expect(entries[0].ts).toBe(3000);
    expect(entries[1].ts).toBe(2000);
    expect(entries[2].ts).toBe(1000);
  });

  it('respects the limit parameter', () => {
    appendErrorLedger(tmpDir, makeEntry({ ts: 1000 }));
    appendErrorLedger(tmpDir, makeEntry({ ts: 2000 }));
    appendErrorLedger(tmpDir, makeEntry({ ts: 3000 }));

    const entries = readErrorLedger(tmpDir, 2);
    expect(entries).toHaveLength(2);
    expect(entries[0].ts).toBe(3000);
    expect(entries[1].ts).toBe(2000);
  });

  it('skips malformed NDJSON lines', () => {
    fs.mkdirSync(path.dirname(ledgerFile()), { recursive: true });
    const valid = makeEntry({ ts: 5000 });
    fs.writeFileSync(
      ledgerFile(),
      JSON.stringify(valid) + '\n' + 'not valid json\n' + JSON.stringify(makeEntry({ ts: 9000 })) + '\n',
      'utf-8',
    );

    const entries = readErrorLedger(tmpDir);
    expect(entries).toHaveLength(2);
    expect(entries[0].ts).toBe(9000);
    expect(entries[1].ts).toBe(5000);
  });

  it('handles empty file', () => {
    fs.mkdirSync(path.dirname(ledgerFile()), { recursive: true });
    fs.writeFileSync(ledgerFile(), '', 'utf-8');

    expect(readErrorLedger(tmpDir)).toEqual([]);
  });
});

describe('analyzeErrorLedger', () => {
  it('returns empty array when no ledger exists', () => {
    expect(analyzeErrorLedger(tmpDir)).toEqual([]);
  });

  it('groups entries by failureType + failedCommand', () => {
    const now = Date.now();
    appendErrorLedger(tmpDir, makeEntry({ ts: now, failureType: 'test_failure', failedCommand: 'npm test' }));
    appendErrorLedger(tmpDir, makeEntry({ ts: now, failureType: 'test_failure', failedCommand: 'npm test' }));
    appendErrorLedger(tmpDir, makeEntry({ ts: now, failureType: 'build_failure', failedCommand: 'npm run build' }));

    const summaries = analyzeErrorLedger(tmpDir, now - 1000);
    expect(summaries).toHaveLength(2);
    // Sorted by count desc
    expect(summaries[0].failureType).toBe('test_failure');
    expect(summaries[0].failedCommand).toBe('npm test');
    expect(summaries[0].count).toBe(2);
    expect(summaries[1].failureType).toBe('build_failure');
    expect(summaries[1].count).toBe(1);
  });

  it('filters entries older than sinceMs cutoff', () => {
    const now = Date.now();
    const old = now - 60 * 24 * 60 * 60 * 1000; // 60 days ago

    appendErrorLedger(tmpDir, makeEntry({ ts: old, failureType: 'test_failure', failedCommand: 'npm test' }));
    appendErrorLedger(tmpDir, makeEntry({ ts: now, failureType: 'build_failure', failedCommand: 'npm run build' }));

    // sinceMs cutoff = 1 day ago — old entry should be excluded
    const cutoff = now - 1 * 24 * 60 * 60 * 1000;
    const summaries = analyzeErrorLedger(tmpDir, cutoff);
    expect(summaries).toHaveLength(1);
    expect(summaries[0].failureType).toBe('build_failure');
  });

  it('tracks lastSeen as the maximum timestamp per group', () => {
    const now = Date.now();
    appendErrorLedger(tmpDir, makeEntry({ ts: now - 5000, failureType: 'test_failure', failedCommand: 'npm test' }));
    appendErrorLedger(tmpDir, makeEntry({ ts: now - 1000, failureType: 'test_failure', failedCommand: 'npm test' }));
    appendErrorLedger(tmpDir, makeEntry({ ts: now - 3000, failureType: 'test_failure', failedCommand: 'npm test' }));

    const summaries = analyzeErrorLedger(tmpDir, now - 10000);
    expect(summaries).toHaveLength(1);
    expect(summaries[0].lastSeen).toBe(now - 1000);
  });

  it('sorts groups by count descending', () => {
    const now = Date.now();
    // 1x lint
    appendErrorLedger(tmpDir, makeEntry({ ts: now, failureType: 'lint_failure', failedCommand: 'npm run lint' }));
    // 3x test
    appendErrorLedger(tmpDir, makeEntry({ ts: now, failureType: 'test_failure', failedCommand: 'npm test' }));
    appendErrorLedger(tmpDir, makeEntry({ ts: now, failureType: 'test_failure', failedCommand: 'npm test' }));
    appendErrorLedger(tmpDir, makeEntry({ ts: now, failureType: 'test_failure', failedCommand: 'npm test' }));
    // 2x build
    appendErrorLedger(tmpDir, makeEntry({ ts: now, failureType: 'build_failure', failedCommand: 'npm run build' }));
    appendErrorLedger(tmpDir, makeEntry({ ts: now, failureType: 'build_failure', failedCommand: 'npm run build' }));

    const summaries = analyzeErrorLedger(tmpDir, now - 1000);
    expect(summaries).toHaveLength(3);
    expect(summaries[0].count).toBe(3);
    expect(summaries[1].count).toBe(2);
    expect(summaries[2].count).toBe(1);
  });
});
