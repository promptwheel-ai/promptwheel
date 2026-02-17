/**
 * Hints system for live steering of auto mode.
 *
 * Multiple frontends (stdin listener, `solo nudge` CLI) write to
 * `.promptwheel/hints.json`. The scout loop consumes pending hints
 * and injects them into the scout prompt via `customPrompt`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

export interface Hint {
  id: string;
  text: string;
  createdAt: number;
  consumed: boolean;
}

const HINTS_FILE = 'hints.json';
const HINTS_TMP = 'hints.json.tmp';
const MAX_HINT_LENGTH = 500;
const PRUNE_AGE_MS = 60 * 60 * 1000; // 1 hour

function hintsPath(repoRoot: string): string {
  return path.join(repoRoot, '.promptwheel', HINTS_FILE);
}

function hintsTmpPath(repoRoot: string): string {
  return path.join(repoRoot, '.promptwheel', HINTS_TMP);
}

function generateId(): string {
  return crypto.randomBytes(8).toString('hex');
}

/**
 * Read all hints from disk, pruning stale consumed ones.
 */
export function readHints(repoRoot: string): Hint[] {
  const fp = hintsPath(repoRoot);
  if (!fs.existsSync(fp)) return [];

  try {
    const raw = fs.readFileSync(fp, 'utf-8');
    const hints: Hint[] = JSON.parse(raw);
    const now = Date.now();

    // Prune consumed hints older than 1 hour
    const kept = hints.filter(
      (h) => !(h.consumed && now - h.createdAt > PRUNE_AGE_MS),
    );

    if (kept.length !== hints.length) {
      atomicWrite(repoRoot, kept);
    }

    return kept;
  } catch {
    return [];
  }
}

/**
 * Atomically write hints array to disk.
 */
function atomicWrite(repoRoot: string, hints: Hint[]): void {
  const dir = path.join(repoRoot, '.promptwheel');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmp = hintsTmpPath(repoRoot);
  const target = hintsPath(repoRoot);
  fs.writeFileSync(tmp, JSON.stringify(hints, null, 2), 'utf-8');
  fs.renameSync(tmp, target);
}

/**
 * Add a new hint. Returns the created hint.
 */
export function addHint(repoRoot: string, text: string): Hint {
  const truncated = text.slice(0, MAX_HINT_LENGTH);
  const hints = readHints(repoRoot);
  const hint: Hint = {
    id: generateId(),
    text: truncated,
    createdAt: Date.now(),
    consumed: false,
  };
  hints.push(hint);
  atomicWrite(repoRoot, hints);
  return hint;
}

/**
 * Consume all pending (unconsumed) hints.
 * Marks them as consumed and returns a formatted prompt block,
 * or null if there are no pending hints.
 */
export function consumePendingHints(repoRoot: string): string | null {
  const hints = readHints(repoRoot);
  const pending = hints.filter((h) => !h.consumed);

  if (pending.length === 0) return null;

  for (const h of pending) {
    h.consumed = true;
  }
  atomicWrite(repoRoot, hints);

  const lines = pending.map((h) => `- "${h.text}"`).join('\n');
  return `\n## User Steering Hints\n${lines}`;
}

/**
 * Clear all hints.
 */
export function clearHints(repoRoot: string): void {
  atomicWrite(repoRoot, []);
}
