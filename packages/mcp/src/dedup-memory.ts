/**
 * Cross-run dedup memory with temporal decay.
 *
 * Persists completed/rejected proposal titles to `.blockspool/dedup-memory.json`
 * so the scout prompt knows what NOT to propose.
 *
 * Pure algorithms (decay, entry management, formatting) live in
 * @blockspool/core/dedup/shared. This file wraps them with file I/O.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  type DedupEntry,
  applyDecay,
  recordEntry as coreRecordEntry,
  recordEntries as coreRecordEntries,
  DEDUP_DEFAULTS,
} from '@blockspool/core/dedup/shared';

// Re-export types and pure functions for existing consumers
export type { DedupEntry } from '@blockspool/core/dedup/shared';
export { formatDedupForPrompt } from '@blockspool/core/dedup/shared';

const DEDUP_FILE = 'dedup-memory.json';

// ---------------------------------------------------------------------------
// File I/O
// ---------------------------------------------------------------------------

function dedupPath(projectRoot: string): string {
  return path.join(projectRoot, '.blockspool', DEDUP_FILE);
}

function readEntries(projectRoot: string): DedupEntry[] {
  const fp = dedupPath(projectRoot);
  if (!fs.existsSync(fp)) return [];
  try {
    const raw = fs.readFileSync(fp, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.warn(`[blockspool] failed to parse dedup-memory.json: ${err instanceof Error ? err.message : String(err)}`);
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
  const surviving = applyDecay(entries, DEDUP_DEFAULTS.DECAY_RATE);
  writeEntries(projectRoot, surviving);
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
  _failureReason?: string,
): void {
  const entries = readEntries(projectRoot);
  coreRecordEntry(entries, title, completed);
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
  coreRecordEntries(entries, titles);
  writeEntries(projectRoot, entries);
}

// formatDedupForPrompt is re-exported from core above
