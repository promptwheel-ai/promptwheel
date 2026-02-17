/**
 * Cross-run dedup memory with temporal decay.
 *
 * Persists completed/rejected proposal titles to `.promptwheel/dedup-memory.json`
 * so the scout prompt knows what NOT to propose.
 *
 * Pure algorithms (decay, entry management) live in @promptwheel/core/dedup/shared.
 * This file wraps them with filesystem I/O and adds CLI-specific extensions
 * (failureReason, relatedTitles, metrics).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { metric } from './metrics.js';
import {
  type DedupEntry as CoreDedupEntry,
  applyDecay,
  DEDUP_DEFAULTS,
} from '@promptwheel/core/dedup/shared';

// ---------------------------------------------------------------------------
// Types (extends core with CLI-specific fields)
// ---------------------------------------------------------------------------

export interface DedupEntry extends CoreDedupEntry {
  /** Why this entry failed (if not completed) */
  failureReason?: 'qa_failed' | 'scope_violation' | 'spindle_abort' | 'agent_error' | 'no_changes';
  /** Titles of proposals that were in the same batch (dependency tracking) */
  relatedTitles?: string[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEDUP_FILE = 'dedup-memory.json';
const MAX_WEIGHT = DEDUP_DEFAULTS.MAX_WEIGHT;
const BUMP_AMOUNT = DEDUP_DEFAULTS.BUMP_AMOUNT;
const COMPLETED_WEIGHT = DEDUP_DEFAULTS.COMPLETED_WEIGHT;
const DEFAULT_WEIGHT = DEDUP_DEFAULTS.DEFAULT_WEIGHT;
const DEFAULT_BUDGET = DEDUP_DEFAULTS.DEFAULT_BUDGET;

// ---------------------------------------------------------------------------
// File I/O
// ---------------------------------------------------------------------------

function dedupPath(projectRoot: string): string {
  return path.join(projectRoot, '.promptwheel', DEDUP_FILE);
}

function readEntries(projectRoot: string): DedupEntry[] {
  const fp = dedupPath(projectRoot);
  if (!fs.existsSync(fp)) return [];
  try {
    const raw = fs.readFileSync(fp, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeEntries(projectRoot: string, entries: DedupEntry[]): void {
  const fp = dedupPath(projectRoot);
  const dir = path.dirname(fp);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(fp, JSON.stringify(entries, null, 2) + '\n', 'utf8');
}

// ---------------------------------------------------------------------------
// Core API
// ---------------------------------------------------------------------------

/**
 * Load dedup memory, apply decay, prune dead entries, write back.
 * Call once per session start (mirrors learnings.loadLearnings).
 */
export function loadDedupMemory(projectRoot: string): DedupEntry[] {
  const entries = readEntries(projectRoot);
  const surviving = applyDecay(entries, DEDUP_DEFAULTS.DECAY_RATE) as DedupEntry[];
  writeEntries(projectRoot, surviving);

  // Instrument: track dedup memory load
  metric('dedup', 'loaded', {
    count: surviving.length,
    decayed: entries.length - surviving.length,
    completed: surviving.filter(e => e.completed).length,
  });

  return surviving;
}

/**
 * Record a title as "seen" — either a new duplicate rejection or a completed ticket.
 * If the title already exists, bumps weight and hit_count (re-confirmation).
 */
export function recordDedupEntry(
  projectRoot: string,
  title: string,
  completed: boolean,
  failureReason?: 'qa_failed' | 'scope_violation' | 'spindle_abort' | 'agent_error' | 'no_changes',
  relatedTitles?: string[],
): void {
  const entries = readEntries(projectRoot);
  const now = new Date().toISOString();
  const normalized = title.toLowerCase().trim();

  const existing = entries.find(e => e.title.toLowerCase().trim() === normalized);
  if (existing) {
    existing.weight = Math.min(MAX_WEIGHT, existing.weight + BUMP_AMOUNT);
    existing.last_seen_at = now;
    existing.hit_count++;
    if (completed) existing.completed = true;
    if (failureReason) existing.failureReason = failureReason;
    if (relatedTitles?.length) existing.relatedTitles = relatedTitles;

    // Instrument: duplicate detected
    metric('dedup', 'duplicate_found', { hitCount: existing.hit_count, completed });
  } else {
    entries.push({
      title,
      weight: completed ? COMPLETED_WEIGHT : DEFAULT_WEIGHT,
      created_at: now,
      last_seen_at: now,
      hit_count: 1,
      completed,
      failureReason,
      relatedTitles,
    });
  }

  writeEntries(projectRoot, entries);
}

/**
 * Batch-record multiple titles at once (avoids repeated file I/O).
 */
export function recordDedupEntries(
  projectRoot: string,
  titles: { title: string; completed: boolean }[],
): void {
  if (titles.length === 0) return;
  const entries = readEntries(projectRoot);
  const now = new Date().toISOString();

  for (const { title, completed } of titles) {
    const normalized = title.toLowerCase().trim();
    const existing = entries.find(e => e.title.toLowerCase().trim() === normalized);
    if (existing) {
      existing.weight = Math.min(MAX_WEIGHT, existing.weight + BUMP_AMOUNT);
      existing.last_seen_at = now;
      existing.hit_count++;
      if (completed) existing.completed = true;
    } else {
      entries.push({
        title,
        weight: completed ? COMPLETED_WEIGHT : DEFAULT_WEIGHT,
        created_at: now,
        last_seen_at: now,
        hit_count: 1,
        completed,
      });
    }
  }

  writeEntries(projectRoot, entries);
}

/**
 * Format dedup memory for prompt injection.
 * Highest-weight entries first, respects char budget.
 */
export function formatDedupForPrompt(entries: DedupEntry[], budget: number = DEFAULT_BUDGET): string {
  if (entries.length === 0) return '';

  const sorted = [...entries].sort((a, b) => b.weight - a.weight);
  const lines: string[] = [];
  let charCount = 0;

  const header = '<already-completed>\n## Already Completed — Do NOT Propose These\n\nThe following improvements have already been done or attempted. Do NOT propose similar changes:\n';
  const footer = '\n</already-completed>';
  charCount += header.length + footer.length;

  for (const e of sorted) {
    const status = e.completed ? '✓ done'
      : e.failureReason === 'scope_violation' ? 'scope issue — may work with broader scope'
      : e.failureReason === 'no_changes' ? 'no changes produced'
      : 'attempted — failed';
    const line = `- ${e.title} (${status}, seen ${e.hit_count}x)`;
    if (charCount + line.length + 1 > budget) break;
    lines.push(line);
    charCount += line.length + 1;
  }

  if (lines.length === 0) return '';
  return header + lines.join('\n') + footer;
}

/**
 * Find proposals enabled by recently completed work.
 * Returns related titles from completed entries within 48h
 * that are NOT themselves completed.
 */
export function getEnabledProposals(projectRoot: string): string[] {
  const entries = readEntries(projectRoot);
  const now = Date.now();
  const cutoff = 48 * 60 * 60 * 1000;

  const completedTitles = new Set(
    entries.filter(e => e.completed).map(e => e.title.toLowerCase().trim()),
  );

  const enabled: string[] = [];
  for (const e of entries) {
    if (!e.completed || !e.relatedTitles?.length) continue;
    const lastSeen = new Date(e.last_seen_at).getTime();
    if (now - lastSeen > cutoff) continue;
    for (const rt of e.relatedTitles) {
      if (!completedTitles.has(rt.toLowerCase().trim())) {
        enabled.push(rt);
      }
    }
  }

  return [...new Set(enabled)];
}
