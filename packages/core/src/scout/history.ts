/**
 * Scan history — append-only ndjson persistence + diffing.
 *
 * Each scan appends one line to `.promptwheel/scan-history.ndjson`.
 * Deterministic finding IDs (from finding.ts) make cross-run diffing trivial.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ScanResult, Finding } from './finding.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single history entry — ScanResult plus a timestamp. */
export interface ScanHistoryEntry {
  /** ISO-8601 timestamp of when the scan ran. */
  scanned_at: string;
  /** The full scan result. */
  result: ScanResult;
}

/** Diff between two scans. */
export interface ScanDiff {
  /** Findings present in current but not in previous. */
  new: Finding[];
  /** Findings present in previous but not in current (i.e. resolved). */
  fixed: Finding[];
  /** Findings present in both (by ID). */
  unchanged: Finding[];
  /** Findings where severity changed between runs. */
  severity_changed: Array<{
    finding: Finding;
    previous_severity: string;
  }>;
  /** Summary counts. */
  summary: {
    new_count: number;
    fixed_count: number;
    unchanged_count: number;
    severity_changed_count: number;
  };
}

/** Trend data computed from history. */
export interface ScanTrend {
  /** Total number of scans in history. */
  total_scans: number;
  /** Oldest scan timestamp. */
  first_scan: string;
  /** Most recent scan timestamp. */
  last_scan: string;
  /** Findings count over time (most recent last). */
  counts: Array<{
    scanned_at: string;
    total: number;
    by_severity: Record<string, number>;
  }>;
  /** Net change from first to last scan. */
  net_change: number;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

const HISTORY_FILE = 'scan-history.ndjson';

/** Resolve the history file path for a project. */
export function historyPath(promptwheelDir: string): string {
  return path.join(promptwheelDir, HISTORY_FILE);
}

/** Append a scan result to the history file. */
export function appendScanHistory(
  promptwheelDir: string,
  result: ScanResult,
): void {
  const entry: ScanHistoryEntry = {
    scanned_at: new Date().toISOString(),
    result,
  };

  if (!fs.existsSync(promptwheelDir)) {
    fs.mkdirSync(promptwheelDir, { recursive: true });
  }

  const filePath = historyPath(promptwheelDir);
  fs.appendFileSync(filePath, JSON.stringify(entry) + '\n');
}

/** Load all scan history entries (most recent last). */
export function loadScanHistory(promptwheelDir: string): ScanHistoryEntry[] {
  const filePath = historyPath(promptwheelDir);
  if (!fs.existsSync(filePath)) return [];

  const content = fs.readFileSync(filePath, 'utf-8');
  const entries: ScanHistoryEntry[] = [];

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed) as ScanHistoryEntry);
    } catch {
      // Skip malformed lines
    }
  }

  return entries;
}

/** Get the most recent scan result from history, or null. */
export function getLastScan(promptwheelDir: string): ScanHistoryEntry | null {
  const entries = loadScanHistory(promptwheelDir);
  return entries.length > 0 ? entries[entries.length - 1] : null;
}

// ---------------------------------------------------------------------------
// Diffing
// ---------------------------------------------------------------------------

/** Compute the diff between two scan results. */
export function diffScans(previous: ScanResult, current: ScanResult): ScanDiff {
  const prevById = new Map(previous.findings.map(f => [f.id, f]));
  const currById = new Map(current.findings.map(f => [f.id, f]));

  const newFindings: Finding[] = [];
  const fixed: Finding[] = [];
  const unchanged: Finding[] = [];
  const severityChanged: ScanDiff['severity_changed'] = [];

  // Walk current findings
  for (const [id, finding] of currById) {
    const prev = prevById.get(id);
    if (!prev) {
      newFindings.push(finding);
    } else if (prev.severity !== finding.severity) {
      severityChanged.push({
        finding,
        previous_severity: prev.severity,
      });
    } else {
      unchanged.push(finding);
    }
  }

  // Walk previous findings to find fixed
  for (const [id, finding] of prevById) {
    if (!currById.has(id)) {
      fixed.push(finding);
    }
  }

  return {
    new: newFindings,
    fixed,
    unchanged,
    severity_changed: severityChanged,
    summary: {
      new_count: newFindings.length,
      fixed_count: fixed.length,
      unchanged_count: unchanged.length,
      severity_changed_count: severityChanged.length,
    },
  };
}

// ---------------------------------------------------------------------------
// Trends
// ---------------------------------------------------------------------------

/** Compute trend data from scan history. */
export function computeTrend(entries: ScanHistoryEntry[]): ScanTrend | null {
  if (entries.length === 0) return null;

  const counts = entries.map(e => ({
    scanned_at: e.scanned_at,
    total: e.result.summary.total,
    by_severity: { ...e.result.summary.by_severity },
  }));

  const first = entries[0];
  const last = entries[entries.length - 1];

  return {
    total_scans: entries.length,
    first_scan: first.scanned_at,
    last_scan: last.scanned_at,
    counts,
    net_change: last.result.summary.total - first.result.summary.total,
  };
}
