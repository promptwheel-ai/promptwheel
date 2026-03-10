/**
 * Baseline + Suppression — the finding management layer.
 *
 * A baseline snapshots current findings as "accepted." Subsequent scans
 * filter out baselined findings, showing only what's new. Teams commit
 * `.promptwheel/baseline.json` to git so the baseline is shared.
 *
 * Findings are matched by deterministic ID (sha256 of title + files).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Finding } from './finding.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BaselineEntry {
  /** Finding title at time of suppression (for human readability). */
  title: string;
  /** Severity at time of suppression. */
  severity: string;
  /** ISO-8601 timestamp. */
  suppressed_at: string;
  /** Why this finding was suppressed. */
  reason: string;
  /** Who suppressed it (from git config or env). */
  suppressed_by?: string;
  /** ISO-8601 timestamp when this suppression expires (finding becomes active again). */
  expires_at?: string;
}

export interface Baseline {
  version: '1.0';
  created_at: string;
  updated_at: string;
  entries: Record<string, BaselineEntry>;
}

export interface BaselineFilterResult {
  /** Findings NOT in the baseline (new/active). */
  active: Finding[];
  /** Findings that are in the baseline (suppressed). */
  baselined: Finding[];
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

const BASELINE_FILE = 'baseline.json';

export function baselinePath(promptwheelDir: string): string {
  return path.join(promptwheelDir, BASELINE_FILE);
}

export function loadBaseline(promptwheelDir: string): Baseline | null {
  const filePath = baselinePath(promptwheelDir);
  if (!fs.existsSync(filePath)) return null;

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(content) as Baseline;
    if (parsed.version !== '1.0' || !parsed.entries) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveBaseline(promptwheelDir: string, baseline: Baseline): void {
  if (!fs.existsSync(promptwheelDir)) {
    fs.mkdirSync(promptwheelDir, { recursive: true });
  }

  baseline.updated_at = new Date().toISOString();
  const filePath = baselinePath(promptwheelDir);
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(baseline, null, 2) + '\n');
  fs.renameSync(tempPath, filePath);
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

/** Create a new baseline from a set of findings. */
export function createBaseline(
  findings: Finding[],
  reason: string = 'initial baseline',
  suppressedBy?: string,
): Baseline {
  const now = new Date().toISOString();
  const entries: Record<string, BaselineEntry> = {};

  for (const f of findings) {
    entries[f.id] = {
      title: f.title,
      severity: f.severity,
      suppressed_at: now,
      reason,
      ...(suppressedBy && { suppressed_by: suppressedBy }),
    };
  }

  return {
    version: '1.0',
    created_at: now,
    updated_at: now,
    entries,
  };
}

/** Add a finding to the baseline (suppress it). */
export function suppressFinding(
  baseline: Baseline,
  finding: Finding,
  reason: string,
  suppressedBy?: string,
): Baseline {
  baseline.entries[finding.id] = {
    title: finding.title,
    severity: finding.severity,
    suppressed_at: new Date().toISOString(),
    reason,
    ...(suppressedBy && { suppressed_by: suppressedBy }),
  };
  baseline.updated_at = new Date().toISOString();
  return baseline;
}

/** Remove a finding from the baseline (unsuppress it). Returns true if found. */
export function unsuppressFinding(baseline: Baseline, findingId: string): boolean {
  if (!(findingId in baseline.entries)) return false;
  delete baseline.entries[findingId];
  baseline.updated_at = new Date().toISOString();
  return true;
}

/** Split findings into active (not baselined) and baselined (suppressed).
 *  Expired suppressions are treated as active. */
export function filterByBaseline(
  findings: Finding[],
  baseline: Baseline | null,
): BaselineFilterResult & { expired: Finding[] } {
  if (!baseline) {
    return { active: findings, baselined: [], expired: [] };
  }

  const now = Date.now();
  const active: Finding[] = [];
  const baselined: Finding[] = [];
  const expired: Finding[] = [];

  for (const f of findings) {
    const entry = baseline.entries[f.id];
    if (!entry) {
      active.push(f);
    } else if (entry.expires_at && new Date(entry.expires_at).getTime() <= now) {
      active.push(f);
      expired.push(f);
    } else {
      baselined.push(f);
    }
  }

  return { active, baselined, expired };
}

/** Count entries in a baseline. */
export function baselineSize(baseline: Baseline | null): number {
  if (!baseline) return 0;
  return Object.keys(baseline.entries).length;
}

/** Parse a human-friendly duration string (e.g., "90d", "4w", "6m") to milliseconds.
 *  Supports: d (days), w (weeks), m (months ≈ 30d). Returns null if unparseable. */
export function parseDuration(duration: string): number | null {
  const match = duration.trim().match(/^(\d+)\s*(d|w|m)$/i);
  if (!match) return null;
  const value = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  const DAY_MS = 86400000;
  switch (unit) {
    case 'd': return value * DAY_MS;
    case 'w': return value * 7 * DAY_MS;
    case 'm': return value * 30 * DAY_MS;
    default: return null;
  }
}

/** Count expired entries in a baseline. */
export function countExpired(baseline: Baseline | null): number {
  if (!baseline) return 0;
  const now = Date.now();
  return Object.values(baseline.entries)
    .filter(e => e.expires_at && new Date(e.expires_at).getTime() <= now)
    .length;
}
