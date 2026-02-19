/**
 * Cross-run learning mechanism.
 *
 * Persists learnings to `.promptwheel/learnings.json` and provides
 * decay, consolidation, relevance scoring, and prompt formatting.
 *
 * Pure algorithms (decay, consolidation, formatting, keyword extraction,
 * relevance scoring) live in @promptwheel/core/learnings/shared.
 * This file wraps them with filesystem I/O and adds CLI-specific
 * extensions (metrics instrumentation, effectiveness tracking).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { metric } from './metrics.js';
import {
  type Learning as CoreLearning,
  type StructuredKnowledge,
  applyLearningsDecay,
  consolidateLearnings as coreConsolidate,
  LEARNINGS_DEFAULTS,
} from '@promptwheel/core/learnings/shared';
import { withLearningsLock } from '@promptwheel/core/learnings/lock';

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
  } catch {
    return [];
  }
}

function writeLearnings(projectRoot: string, learnings: Learning[]): void {
  const fp = learningsPath(projectRoot);
  const dir = path.dirname(fp);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmp = fp + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(learnings, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, fp);
}

// ---------------------------------------------------------------------------
// Core API (wraps core algorithms with I/O + metrics)
// ---------------------------------------------------------------------------

/**
 * Load learnings, apply decay, prune dead entries, write back.
 * Called once per session start.
 */
export function loadLearnings(projectRoot: string, decayRate: number = LEARNINGS_DEFAULTS.DECAY_RATE): Learning[] {
  const fp = learningsPath(projectRoot);
  return withLearningsLock(fp, () => {
    const learnings = readLearnings(projectRoot);
    const surviving = applyLearningsDecay(learnings, decayRate);
    writeLearnings(projectRoot, surviving);

    // Instrument: track how many learnings loaded
    metric('learnings', 'loaded', { count: surviving.length, decayed: learnings.length - surviving.length });

    return surviving;
  });
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
  const fp = learningsPath(projectRoot);
  return withLearningsLock(fp, () => {
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
  });
}

/**
 * Confirm a learning: bump weight +10 and update last_confirmed_at.
 */
export function confirmLearning(projectRoot: string, id: string): void {
  const fp = learningsPath(projectRoot);
  withLearningsLock(fp, () => {
    const learnings = readLearnings(projectRoot);
    const l = learnings.find(x => x.id === id);
    if (!l) return;
    l.weight = Math.min(LEARNINGS_DEFAULTS.MAX_WEIGHT, l.weight + 10);
    l.last_confirmed_at = new Date().toISOString();
    writeLearnings(projectRoot, learnings);
  });
}

/**
 * Record access: increment access_count for each id.
 */
export function recordAccess(projectRoot: string, ids: string[]): void {
  if (ids.length === 0) return;
  const fp = learningsPath(projectRoot);
  withLearningsLock(fp, () => {
    const learnings = readLearnings(projectRoot);
    const idSet = new Set(ids);
    for (const l of learnings) {
      if (idSet.has(l.id)) {
        l.access_count++;
      }
    }
    writeLearnings(projectRoot, learnings);
  });
}

/**
 * Record learning application: track when learnings were used in a ticket context.
 */
export function recordApplication(projectRoot: string, ids: string[]): void {
  if (ids.length === 0) return;
  const fp = learningsPath(projectRoot);
  withLearningsLock(fp, () => {
    const learnings = readLearnings(projectRoot);
    const idSet = new Set(ids);
    for (const l of learnings) {
      if (idSet.has(l.id)) {
        l.applied_count = (l.applied_count ?? 0) + 1;
      }
    }
    writeLearnings(projectRoot, learnings);

    // Instrument: track application
    metric('learnings', 'applied', { count: ids.length });
  });
}

/**
 * Record learning outcome: track success/failure after a ticket completes.
 */
export function recordOutcome(projectRoot: string, ids: string[], success: boolean): void {
  if (ids.length === 0) return;
  const fp = learningsPath(projectRoot);
  withLearningsLock(fp, () => {
    const learnings = readLearnings(projectRoot);
    const idSet = new Set(ids);
    for (const l of learnings) {
      if (idSet.has(l.id)) {
        if (success) {
          l.success_count = (l.success_count ?? 0) + 1;
          // Boost weight on success
          l.weight = Math.min(LEARNINGS_DEFAULTS.MAX_WEIGHT, l.weight + 2);
        } else {
          // Slight penalty on failure (learning didn't help)
          l.weight = Math.max(1, l.weight - 1);
        }
      }
    }
    writeLearnings(projectRoot, learnings);

    // Instrument: track outcome
    metric('learnings', 'outcome', { count: ids.length, success });
  });
}

/**
 * Get learning effectiveness stats.
 */
export function getLearningEffectiveness(projectRoot: string): {
  total: number;
  applied: number;
  successRate: number;
  topPerformers: Array<{ id: string; text: string; effectiveness: number }>;
} {
  const learnings = readLearnings(projectRoot);
  const withApplication = learnings.filter(l => (l.applied_count ?? 0) > 0);

  let totalApplied = 0;
  let totalSuccess = 0;
  const performers: Array<{ id: string; text: string; effectiveness: number }> = [];

  for (const l of withApplication) {
    const applied = l.applied_count ?? 0;
    const success = l.success_count ?? 0;
    totalApplied += applied;
    totalSuccess += success;

    if (applied >= 2) { // Only include learnings with enough data
      performers.push({
        id: l.id,
        text: l.text,
        effectiveness: applied > 0 ? success / applied : 0,
      });
    }
  }

  performers.sort((a, b) => b.effectiveness - a.effectiveness);

  return {
    total: learnings.length,
    applied: totalApplied,
    successRate: totalApplied > 0 ? totalSuccess / totalApplied : 0,
    topPerformers: performers.slice(0, 5),
  };
}

/**
 * Consolidate near-duplicate learnings (>70% text similarity).
 * Keeps the higher weight entry, sums access counts.
 */
export function consolidateLearnings(projectRoot: string): void {
  const fp = learningsPath(projectRoot);
  withLearningsLock(fp, () => {
    const learnings = readLearnings(projectRoot);
    const result = coreConsolidate(learnings);
    if (result !== null) {
      writeLearnings(projectRoot, result);
    }
  });
}
