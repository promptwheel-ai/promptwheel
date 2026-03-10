import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  appendScanHistory,
  loadScanHistory,
  getLastScan,
  diffScans,
  computeTrend,
  historyPath,
} from '../scout/history.js';
import type { ScanResult, Finding } from '../scout/finding.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-history-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function finding(id: string, overrides: Partial<Finding> = {}): Finding {
  return {
    id,
    title: `Finding ${id}`,
    category: 'fix',
    severity: 'degrading',
    description: 'desc',
    files: ['src/a.ts'],
    confidence: 80,
    impact: 7,
    complexity: 'simple',
    fix_available: true,
    ...overrides,
  };
}

function scan(findings: Finding[], overrides: Partial<ScanResult> = {}): ScanResult {
  const by_severity: Record<string, number> = {};
  const by_category: Record<string, number> = {};
  for (const f of findings) {
    by_severity[f.severity] = (by_severity[f.severity] ?? 0) + 1;
    by_category[f.category] = (by_category[f.category] ?? 0) + 1;
  }
  return {
    schema_version: '1.0',
    project: 'test',
    scanned_files: 50,
    duration_ms: 1000,
    findings,
    summary: { total: findings.length, by_severity, by_category },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

describe('scan history persistence', () => {
  it('returns empty array when no history file', () => {
    expect(loadScanHistory(tmpDir)).toEqual([]);
  });

  it('appends and loads entries', () => {
    const r1 = scan([finding('a')]);
    const r2 = scan([finding('a'), finding('b')]);

    appendScanHistory(tmpDir, r1);
    appendScanHistory(tmpDir, r2);

    const entries = loadScanHistory(tmpDir);
    expect(entries).toHaveLength(2);
    expect(entries[0].result.findings).toHaveLength(1);
    expect(entries[1].result.findings).toHaveLength(2);
    expect(entries[0].scanned_at).toBeDefined();
  });

  it('creates directory if missing', () => {
    const nested = path.join(tmpDir, 'sub', 'dir');
    appendScanHistory(nested, scan([]));
    expect(fs.existsSync(historyPath(nested))).toBe(true);
  });

  it('skips malformed lines', () => {
    const filePath = historyPath(tmpDir);
    fs.writeFileSync(filePath, '{"bad json\n' + JSON.stringify({ scanned_at: 'x', result: scan([]) }) + '\n');
    const entries = loadScanHistory(tmpDir);
    expect(entries).toHaveLength(1);
  });

  it('getLastScan returns null when empty', () => {
    expect(getLastScan(tmpDir)).toBeNull();
  });

  it('getLastScan returns most recent entry', () => {
    appendScanHistory(tmpDir, scan([finding('a')]));
    appendScanHistory(tmpDir, scan([finding('a'), finding('b')]));
    const last = getLastScan(tmpDir);
    expect(last?.result.findings).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Diffing
// ---------------------------------------------------------------------------

describe('diffScans', () => {
  it('identifies new findings', () => {
    const prev = scan([finding('a')]);
    const curr = scan([finding('a'), finding('b')]);
    const diff = diffScans(prev, curr);

    expect(diff.new).toHaveLength(1);
    expect(diff.new[0].id).toBe('b');
    expect(diff.fixed).toHaveLength(0);
    expect(diff.unchanged).toHaveLength(1);
    expect(diff.summary.new_count).toBe(1);
  });

  it('identifies fixed findings', () => {
    const prev = scan([finding('a'), finding('b')]);
    const curr = scan([finding('a')]);
    const diff = diffScans(prev, curr);

    expect(diff.fixed).toHaveLength(1);
    expect(diff.fixed[0].id).toBe('b');
    expect(diff.new).toHaveLength(0);
    expect(diff.summary.fixed_count).toBe(1);
  });

  it('detects severity changes', () => {
    const prev = scan([finding('a', { severity: 'blocking' })]);
    const curr = scan([finding('a', { severity: 'polish' })]);
    const diff = diffScans(prev, curr);

    expect(diff.severity_changed).toHaveLength(1);
    expect(diff.severity_changed[0].previous_severity).toBe('blocking');
    expect(diff.severity_changed[0].finding.severity).toBe('polish');
    expect(diff.unchanged).toHaveLength(0);
  });

  it('handles empty scans', () => {
    const diff = diffScans(scan([]), scan([]));
    expect(diff.new).toHaveLength(0);
    expect(diff.fixed).toHaveLength(0);
    expect(diff.unchanged).toHaveLength(0);
  });

  it('handles completely different findings', () => {
    const prev = scan([finding('a'), finding('b')]);
    const curr = scan([finding('c'), finding('d')]);
    const diff = diffScans(prev, curr);

    expect(diff.new).toHaveLength(2);
    expect(diff.fixed).toHaveLength(2);
    expect(diff.unchanged).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Trends
// ---------------------------------------------------------------------------

describe('computeTrend', () => {
  it('returns null for empty history', () => {
    expect(computeTrend([])).toBeNull();
  });

  it('computes trend from entries', () => {
    const entries = [
      { scanned_at: '2025-01-01T00:00:00Z', result: scan([finding('a')]) },
      { scanned_at: '2025-01-02T00:00:00Z', result: scan([finding('a'), finding('b')]) },
      { scanned_at: '2025-01-03T00:00:00Z', result: scan([finding('b')]) },
    ];

    const trend = computeTrend(entries);
    expect(trend).not.toBeNull();
    expect(trend!.total_scans).toBe(3);
    expect(trend!.first_scan).toBe('2025-01-01T00:00:00Z');
    expect(trend!.last_scan).toBe('2025-01-03T00:00:00Z');
    expect(trend!.counts).toHaveLength(3);
    expect(trend!.counts[0].total).toBe(1);
    expect(trend!.counts[1].total).toBe(2);
    expect(trend!.counts[2].total).toBe(1);
    expect(trend!.net_change).toBe(0); // 1 → 1
  });

  it('computes positive net change', () => {
    const entries = [
      { scanned_at: '2025-01-01T00:00:00Z', result: scan([]) },
      { scanned_at: '2025-01-02T00:00:00Z', result: scan([finding('a'), finding('b'), finding('c')]) },
    ];

    const trend = computeTrend(entries);
    expect(trend!.net_change).toBe(3);
  });

  it('includes severity breakdown in counts', () => {
    const entries = [
      {
        scanned_at: '2025-01-01T00:00:00Z',
        result: scan([
          finding('a', { severity: 'blocking' }),
          finding('b', { severity: 'polish' }),
        ]),
      },
    ];

    const trend = computeTrend(entries);
    expect(trend!.counts[0].by_severity).toEqual({ blocking: 1, polish: 1 });
  });
});
