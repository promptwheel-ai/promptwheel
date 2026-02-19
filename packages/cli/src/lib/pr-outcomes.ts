/**
 * PR lifecycle tracking.
 *
 * Stores PR creation and resolution events in `.promptwheel/pr-outcomes.ndjson`
 * so merge rates and time-to-merge can be surfaced by analytics.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface PrOutcomeEntry {
  ts: number;
  prUrl: string;
  createdAt: number;
  resolvedAt?: number;
  outcome: 'open' | 'merged' | 'closed';
  timeToResolveMs?: number;
  formula?: string;
  category?: string;
  ticketTitle: string;
}

export interface PrOutcomeSummary {
  total: number;
  merged: number;
  closed: number;
  open: number;
  mergeRate: number;
  avgTimeToMergeMs: number | null;
}

const OUTCOMES_FILE = 'pr-outcomes.ndjson';

function outcomesPath(repoRoot: string): string {
  return path.join(repoRoot, '.promptwheel', OUTCOMES_FILE);
}

/**
 * Append a PR outcome entry. Lazily creates the file on first write.
 */
export function appendPrOutcome(repoRoot: string, entry: PrOutcomeEntry): void {
  const fp = outcomesPath(repoRoot);
  const dir = path.dirname(fp);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.appendFileSync(fp, JSON.stringify(entry) + '\n', 'utf-8');
}

/**
 * Record PR resolution by appending a new entry with resolved data.
 */
export function updatePrOutcome(
  repoRoot: string,
  prUrl: string,
  outcome: 'merged' | 'closed',
  resolvedAt: number,
): void {
  const entries = readPrOutcomes(repoRoot);
  // Find the original creation entry to compute time-to-resolve
  const creation = entries.find(e => e.prUrl === prUrl && e.outcome === 'open');
  const createdAt = creation?.createdAt ?? resolvedAt;
  const timeToResolveMs = resolvedAt - createdAt;

  appendPrOutcome(repoRoot, {
    ts: resolvedAt,
    prUrl,
    createdAt,
    resolvedAt,
    outcome,
    timeToResolveMs,
    formula: creation?.formula,
    category: creation?.category,
    ticketTitle: creation?.ticketTitle ?? '',
  });
}

/**
 * Read all PR outcome entries, most recent first.
 */
export function readPrOutcomes(repoRoot: string, limit?: number): PrOutcomeEntry[] {
  const fp = outcomesPath(repoRoot);
  if (!fs.existsSync(fp)) return [];

  const content = fs.readFileSync(fp, 'utf-8');
  const lines = content.trim().split('\n').filter(l => l.length > 0);

  const entries: PrOutcomeEntry[] = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      entries.push(JSON.parse(lines[i]));
    } catch {
      // Skip malformed lines
    }
    if (limit && entries.length >= limit) break;
  }

  return entries;
}

/**
 * Analyze PR outcomes: merge rate, avg time-to-merge, current open count.
 */
export function analyzePrOutcomes(repoRoot: string): PrOutcomeSummary {
  const entries = readPrOutcomes(repoRoot);

  // Deduplicate: for each PR URL, use the latest entry
  const byUrl = new Map<string, PrOutcomeEntry>();
  // Entries are most-recent-first, so reverse to let latest win
  for (const entry of [...entries].reverse()) {
    byUrl.set(entry.prUrl, entry);
  }

  const latest = [...byUrl.values()];
  const merged = latest.filter(e => e.outcome === 'merged');
  const closed = latest.filter(e => e.outcome === 'closed');
  const open = latest.filter(e => e.outcome === 'open');

  const resolvedCount = merged.length + closed.length;
  const mergeRate = resolvedCount > 0 ? merged.length / resolvedCount : 0;

  const mergeTimes = merged.filter(e => e.timeToResolveMs !== undefined && e.timeToResolveMs !== null).map(e => e.timeToResolveMs!);
  const avgTimeToMergeMs = mergeTimes.length > 0
    ? mergeTimes.reduce((a, b) => a + b, 0) / mergeTimes.length
    : null;

  return {
    total: latest.length,
    merged: merged.length,
    closed: closed.length,
    open: open.length,
    mergeRate,
    avgTimeToMergeMs,
  };
}
