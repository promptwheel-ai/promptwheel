/**
 * Fix Journal — tracks outcomes of auto-fix attempts.
 *
 * Links finding_id → ticket_id → outcome in an append-only ndjson file.
 * Used to:
 * 1. Compute fix success rates by category/severity
 * 2. Flag findings that repeatedly fail auto-fix
 * 3. Enrich scout prompts with "what worked before" context
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FixAttempt {
  /** Deterministic finding ID (sha256 of title + files). */
  finding_id: string;
  /** Ticket created for this fix. */
  ticket_id: string;
  /** Finding title for readability. */
  title: string;
  /** Finding category. */
  category: string;
  /** Finding severity at time of fix. */
  severity: string;
  /** ISO-8601 timestamp when fix was attempted. */
  attempted_at: string;
}

export interface FixOutcome {
  /** Deterministic finding ID. */
  finding_id: string;
  /** Ticket that attempted the fix. */
  ticket_id: string;
  /** Whether the fix succeeded. */
  success: boolean;
  /** ISO-8601 timestamp of outcome. */
  completed_at: string;
  /** Files changed by the fix (if successful). */
  files_changed?: string[];
  /** PR URL (if created). */
  pr_url?: string;
  /** Failure reason (if failed). */
  failure_reason?: string;
  /** Duration of the fix attempt in ms. */
  duration_ms?: number;
  /** Cost of the fix attempt in USD. */
  cost_usd?: number;
}

/** Combined journal entry — either an attempt or an outcome. */
export type FixJournalEntry =
  | { type: 'attempt'; data: FixAttempt }
  | { type: 'outcome'; data: FixOutcome };

/** Aggregated stats for a category or severity. */
export interface FixStats {
  total_attempts: number;
  successes: number;
  failures: number;
  success_rate: number;
  avg_duration_ms?: number;
  avg_cost_usd?: number;
}

/** Per-finding fix history. */
export interface FindingFixHistory {
  finding_id: string;
  title: string;
  attempts: number;
  successes: number;
  failures: number;
  last_attempt: string;
  last_outcome?: 'success' | 'failure';
  failure_reasons: string[];
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

const JOURNAL_FILE = 'fix-journal.ndjson';

export function journalPath(promptwheelDir: string): string {
  return path.join(promptwheelDir, JOURNAL_FILE);
}

export function appendFixAttempt(promptwheelDir: string, attempt: FixAttempt): void {
  appendEntry(promptwheelDir, { type: 'attempt', data: attempt });
}

export function appendFixOutcome(promptwheelDir: string, outcome: FixOutcome): void {
  appendEntry(promptwheelDir, { type: 'outcome', data: outcome });
}

function appendEntry(promptwheelDir: string, entry: FixJournalEntry): void {
  if (!fs.existsSync(promptwheelDir)) {
    fs.mkdirSync(promptwheelDir, { recursive: true });
  }
  fs.appendFileSync(journalPath(promptwheelDir), JSON.stringify(entry) + '\n');
}

export function loadFixJournal(promptwheelDir: string): FixJournalEntry[] {
  const filePath = journalPath(promptwheelDir);
  if (!fs.existsSync(filePath)) return [];

  const entries: FixJournalEntry[] = [];
  for (const line of fs.readFileSync(filePath, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed) as FixJournalEntry);
    } catch {
      // Skip malformed lines
    }
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

/** Compute fix stats grouped by a key (category or severity). */
export function computeFixStats(
  entries: FixJournalEntry[],
  groupBy: 'category' | 'severity',
): Record<string, FixStats> {
  const attempts = new Map<string, FixAttempt[]>();
  const outcomes = new Map<string, FixOutcome[]>();

  for (const e of entries) {
    if (e.type === 'attempt') {
      const key = groupBy === 'category' ? e.data.category : e.data.severity;
      const list = attempts.get(key) ?? [];
      list.push(e.data);
      attempts.set(key, list);
    } else {
      // Look up the attempt to get the groupBy key
      const attempt = findAttemptForOutcome(entries, e.data);
      if (!attempt) continue;
      const key = groupBy === 'category' ? attempt.category : attempt.severity;
      const list = outcomes.get(key) ?? [];
      list.push(e.data);
      outcomes.set(key, list);
    }
  }

  const result: Record<string, FixStats> = {};
  const allKeys = new Set([...attempts.keys(), ...outcomes.keys()]);

  for (const key of allKeys) {
    const outs = outcomes.get(key) ?? [];
    const atts = attempts.get(key) ?? [];
    const successes = outs.filter(o => o.success).length;
    const failures = outs.filter(o => !o.success).length;
    const total = atts.length;

    const durations = outs.filter(o => o.duration_ms !== null && o.duration_ms !== undefined).map(o => o.duration_ms as number);
    const costs = outs.filter(o => o.cost_usd !== null && o.cost_usd !== undefined).map(o => o.cost_usd as number);

    result[key] = {
      total_attempts: total,
      successes,
      failures,
      success_rate: total > 0 ? successes / total : 0,
      ...(durations.length > 0 && {
        avg_duration_ms: Math.round(durations.reduce((a, b) => a + b, 0) / durations.length),
      }),
      ...(costs.length > 0 && {
        avg_cost_usd: costs.reduce((a, b) => a + b, 0) / costs.length,
      }),
    };
  }

  return result;
}

/** Get fix history for a specific finding. */
export function getFixHistory(
  entries: FixJournalEntry[],
  findingId: string,
): FindingFixHistory | null {
  const attempts: FixAttempt[] = [];
  const outcomes: FixOutcome[] = [];

  for (const e of entries) {
    if (e.type === 'attempt' && e.data.finding_id === findingId) {
      attempts.push(e.data);
    } else if (e.type === 'outcome' && e.data.finding_id === findingId) {
      outcomes.push(e.data);
    }
  }

  if (attempts.length === 0) return null;

  const successes = outcomes.filter(o => o.success).length;
  const failures = outcomes.filter(o => !o.success).length;
  const lastAttempt = attempts[attempts.length - 1];
  const lastOutcome = outcomes.length > 0 ? outcomes[outcomes.length - 1] : undefined;

  return {
    finding_id: findingId,
    title: lastAttempt.title,
    attempts: attempts.length,
    successes,
    failures,
    last_attempt: lastAttempt.attempted_at,
    last_outcome: lastOutcome ? (lastOutcome.success ? 'success' : 'failure') : undefined,
    failure_reasons: outcomes.filter(o => !o.success && o.failure_reason).map(o => o.failure_reason!),
  };
}

/** Get findings that have repeatedly failed fixes. */
export function getRepeatFailures(
  entries: FixJournalEntry[],
  minFailures: number = 2,
): FindingFixHistory[] {
  // Collect unique finding IDs
  const findingIds = new Set<string>();
  for (const e of entries) {
    findingIds.add(e.data.finding_id);
  }

  const results: FindingFixHistory[] = [];
  for (const id of findingIds) {
    const history = getFixHistory(entries, id);
    if (history && history.failures >= minFailures) {
      results.push(history);
    }
  }

  return results.sort((a, b) => b.failures - a.failures);
}

/** Build a context string for the scout prompt based on fix history. */
export function buildFixContext(entries: FixJournalEntry[]): string | null {
  if (entries.length === 0) return null;

  const stats = computeFixStats(entries, 'category');
  const lines: string[] = [];

  for (const [category, s] of Object.entries(stats)) {
    if (s.total_attempts === 0) continue;
    const rate = Math.round(s.success_rate * 100);
    lines.push(`- ${category}: ${rate}% fix rate (${s.successes}/${s.total_attempts})`);
  }

  const repeatFails = getRepeatFailures(entries);
  if (repeatFails.length > 0) {
    lines.push('');
    lines.push('Findings that have repeatedly failed auto-fix:');
    for (const f of repeatFails.slice(0, 5)) {
      lines.push(`- "${f.title}" — failed ${f.failures} times (${f.failure_reasons.slice(0, 2).join(', ')})`);
    }
  }

  return lines.length > 0 ? lines.join('\n') : null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findAttemptForOutcome(
  entries: FixJournalEntry[],
  outcome: FixOutcome,
): FixAttempt | undefined {
  // Walk backwards to find the matching attempt
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.type === 'attempt' && e.data.finding_id === outcome.finding_id && e.data.ticket_id === outcome.ticket_id) {
      return e.data;
    }
  }
  return undefined;
}
