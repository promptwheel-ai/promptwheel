/**
 * Cross-run learning mechanism.
 *
 * Persists learnings to `.promptwheel/learnings.json` and provides
 * decay, consolidation, relevance scoring, and prompt formatting.
 *
 * Pure algorithms live in @promptwheel/core/learnings/shared.
 * This file wraps them with filesystem I/O.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import {
  type Learning as CoreLearning,
  type StructuredKnowledge,
  applyLearningsDecay,
  consolidateLearnings as coreConsolidate,
  LEARNINGS_DEFAULTS,
} from '@promptwheel/core/learnings/shared';

// Re-export pure functions and types from core
export type { Learning, StructuredKnowledge } from '@promptwheel/core/learnings/shared';
export {
  formatLearningsForPrompt,
  extractKeywords,
  selectRelevant,
  extractTags,
  LEARNINGS_DEFAULTS,
} from '@promptwheel/core/learnings/shared';

// Use core's Learning type locally
type Learning = CoreLearning;

// ---------------------------------------------------------------------------
// File I/O
// ---------------------------------------------------------------------------

const LEARNINGS_FILE = 'learnings.json';

function learningsPath(projectRoot: string): string {
  return path.join(projectRoot, '.promptwheel', LEARNINGS_FILE);
}

function readLearnings(projectRoot: string): Learning[] {
  const fp = learningsPath(projectRoot);
  if (!fs.existsSync(fp)) return [];
  try {
    const raw = fs.readFileSync(fp, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.warn(`[promptwheel] failed to parse learnings.json: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

function writeLearnings(projectRoot: string, learnings: Learning[]): void {
  const fp = learningsPath(projectRoot);
  const dir = path.dirname(fp);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(fp, JSON.stringify(learnings, null, 2) + '\n', 'utf8');
}

// ---------------------------------------------------------------------------
// Core API (wraps core algorithms with I/O)
// ---------------------------------------------------------------------------

/**
 * Load learnings, apply decay, prune dead entries, write back.
 * Called once per session start.
 */
export function loadLearnings(projectRoot: string, decayRate: number = LEARNINGS_DEFAULTS.DECAY_RATE): Learning[] {
  const learnings = readLearnings(projectRoot);
  const surviving = applyLearningsDecay(learnings, decayRate);
  writeLearnings(projectRoot, surviving);
  return surviving;
}

/**
 * Add a new learning with sensible defaults.
 */
export function addLearning(
  projectRoot: string,
  input: {
    text: string;
    category: Learning['category'];
    source: Learning['source'];
    tags?: string[];
    structured?: StructuredKnowledge;
  },
): Learning {
  const learnings = readLearnings(projectRoot);
  const now = new Date().toISOString();
  const learning: Learning = {
    id: crypto.randomBytes(4).toString('hex'),
    text: input.text.slice(0, 200),
    category: input.category,
    source: input.source,
    tags: input.tags ?? [],
    weight: LEARNINGS_DEFAULTS.DEFAULT_WEIGHT,
    created_at: now,
    last_confirmed_at: now,
    access_count: 0,
    structured: input.structured,
  };
  learnings.push(learning);
  writeLearnings(projectRoot, learnings);
  return learning;
}

/**
 * Confirm a learning: bump weight +10 and update last_confirmed_at.
 */
export function confirmLearning(projectRoot: string, id: string): void {
  const learnings = readLearnings(projectRoot);
  const l = learnings.find(x => x.id === id);
  if (!l) return;
  l.weight = Math.min(LEARNINGS_DEFAULTS.MAX_WEIGHT, l.weight + 10);
  l.last_confirmed_at = new Date().toISOString();
  writeLearnings(projectRoot, learnings);
}

/**
 * Record access: increment access_count for each id.
 */
export function recordAccess(projectRoot: string, ids: string[]): void {
  if (ids.length === 0) return;
  const learnings = readLearnings(projectRoot);
  const idSet = new Set(ids);
  for (const l of learnings) {
    if (idSet.has(l.id)) {
      l.access_count++;
    }
  }
  writeLearnings(projectRoot, learnings);
}

/**
 * Consolidate near-duplicate learnings (>70% text similarity).
 * Keeps the higher weight entry, sums access counts.
 */
export function consolidateLearnings(projectRoot: string): void {
  const learnings = readLearnings(projectRoot);
  const result = coreConsolidate(learnings);
  if (result !== null) {
    writeLearnings(projectRoot, result);
  }
}
