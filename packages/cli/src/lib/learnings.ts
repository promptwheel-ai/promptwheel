/**
 * Cross-run learning mechanism.
 *
 * Persists learnings to `.blockspool/learnings.json` and provides
 * decay, consolidation, relevance scoring, and prompt formatting.
 *
 * Copied from packages/mcp/src/learnings.ts with titleSimilarity
 * inlined to avoid cross-package dependency.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { metric } from './metrics.js';

// ---------------------------------------------------------------------------
// Inlined bigrams / titleSimilarity (from proposals.ts)
// ---------------------------------------------------------------------------

function bigrams(s: string): Set<string> {
  const result = new Set<string>();
  const cleaned = s.replace(/[^a-z0-9 ]/g, '').trim();
  for (let i = 0; i < cleaned.length - 1; i++) {
    result.add(cleaned.slice(i, i + 2));
  }
  return result;
}

function titleSimilarity(a: string, b: string): number {
  const bigramsA = bigrams(a.toLowerCase());
  const bigramsB = bigrams(b.toLowerCase());

  if (bigramsA.size === 0 && bigramsB.size === 0) return 1;
  if (bigramsA.size === 0 || bigramsB.size === 0) return 0;

  let intersection = 0;
  for (const bg of bigramsA) {
    if (bigramsB.has(bg)) intersection++;
  }

  const union = bigramsA.size + bigramsB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Learning {
  id: string;
  text: string;
  category: 'gotcha' | 'pattern' | 'warning' | 'context';
  source: {
    type:
      | 'qa_failure'
      | 'ticket_failure'
      | 'ticket_success'
      | 'review_downgrade'
      | 'plan_rejection'
      | 'scope_violation'
      | 'reviewer_feedback'
      | 'cross_sector_pattern'
      | 'process_insight'
      | 'manual';
    detail?: string;
  };
  tags: string[];
  weight: number;
  created_at: string;
  last_confirmed_at: string;
  access_count: number;
  /** Effectiveness tracking: times learning was applied */
  applied_count?: number;
  /** Effectiveness tracking: successful outcomes when applied */
  success_count?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LEARNINGS_FILE = 'learnings.json';
const DEFAULT_DECAY_RATE = 3;
const DEFAULT_WEIGHT = 50;
const MAX_WEIGHT = 100;
const CONSOLIDATION_THRESHOLD = 50;
const SIMILARITY_MERGE_THRESHOLD = 0.7;
const CONFIRMATION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const DEFAULT_BUDGET = 2000;

// ---------------------------------------------------------------------------
// File I/O
// ---------------------------------------------------------------------------

function learningsPath(projectRoot: string): string {
  return path.join(projectRoot, '.blockspool', LEARNINGS_FILE);
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
  fs.writeFileSync(fp, JSON.stringify(learnings, null, 2) + '\n', 'utf8');
}

// ---------------------------------------------------------------------------
// Core API
// ---------------------------------------------------------------------------

/**
 * Load learnings, apply decay, prune dead entries, write back.
 * Called once per session start.
 */
export function loadLearnings(projectRoot: string, decayRate: number = DEFAULT_DECAY_RATE): Learning[] {
  const learnings = readLearnings(projectRoot);
  const now = Date.now();

  const surviving: Learning[] = [];
  for (const l of learnings) {
    let decay = decayRate;

    // Access bonus: halve decay if accessed
    if (l.access_count > 0) {
      decay /= 2;
    }

    // Confirmation bonus: halve again if confirmed within 7 days
    const confirmedAt = new Date(l.last_confirmed_at).getTime();
    if (now - confirmedAt < CONFIRMATION_WINDOW_MS) {
      decay /= 2;
    }

    l.weight = Math.min(MAX_WEIGHT, l.weight - decay);

    if (l.weight > 0) {
      surviving.push(l);
    }
  }

  writeLearnings(projectRoot, surviving);

  // Instrument: track how many learnings loaded
  metric('learnings', 'loaded', { count: surviving.length, decayed: learnings.length - surviving.length });

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
    weight: DEFAULT_WEIGHT,
    created_at: now,
    last_confirmed_at: now,
    access_count: 0,
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
  l.weight = Math.min(MAX_WEIGHT, l.weight + 10);
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
 * Record learning application: track when learnings were used in a ticket context.
 */
export function recordApplication(projectRoot: string, ids: string[]): void {
  if (ids.length === 0) return;
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
}

/**
 * Record learning outcome: track success/failure after a ticket completes.
 */
export function recordOutcome(projectRoot: string, ids: string[], success: boolean): void {
  if (ids.length === 0) return;
  const learnings = readLearnings(projectRoot);
  const idSet = new Set(ids);
  for (const l of learnings) {
    if (idSet.has(l.id)) {
      if (success) {
        l.success_count = (l.success_count ?? 0) + 1;
        // Boost weight on success
        l.weight = Math.min(MAX_WEIGHT, l.weight + 2);
      } else {
        // Slight penalty on failure (learning didn't help)
        l.weight = Math.max(1, l.weight - 1);
      }
    }
  }
  writeLearnings(projectRoot, learnings);

  // Instrument: track outcome
  metric('learnings', 'outcome', { count: ids.length, success });
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
  const learnings = readLearnings(projectRoot);
  if (learnings.length <= CONSOLIDATION_THRESHOLD) return;

  const merged = new Set<number>();
  for (let i = 0; i < learnings.length; i++) {
    if (merged.has(i)) continue;
    for (let j = i + 1; j < learnings.length; j++) {
      if (merged.has(j)) continue;
      if (titleSimilarity(learnings[i].text, learnings[j].text) >= SIMILARITY_MERGE_THRESHOLD) {
        // Guard: don't merge across different categories
        if (learnings[i].category !== learnings[j].category) continue;
        // Guard: don't merge across different source types
        if (learnings[i].source.type !== learnings[j].source.type) continue;
        // Guard: don't merge different failure types
        const ftI = learnings[i].tags.find(t => t.startsWith('failureType:'));
        const ftJ = learnings[j].tags.find(t => t.startsWith('failureType:'));
        if (ftI && ftJ && ftI !== ftJ) continue;
        // Guard: don't merge frequently accessed learnings
        if (learnings[i].access_count >= 3 || learnings[j].access_count >= 3) continue;
        // Merge j into i (keep higher weight)
        if (learnings[j].weight > learnings[i].weight) {
          learnings[i].weight = learnings[j].weight;
          learnings[i].text = learnings[j].text;
        }
        learnings[i].access_count += learnings[j].access_count;
        // Merge tags
        const tagSet = new Set([...learnings[i].tags, ...learnings[j].tags]);
        learnings[i].tags = [...tagSet];
        // Preserve most recent confirmation date for decay calculations
        if (new Date(learnings[j].last_confirmed_at).getTime() > new Date(learnings[i].last_confirmed_at).getTime()) {
          learnings[i].last_confirmed_at = learnings[j].last_confirmed_at;
        }
        merged.add(j);
      }
    }
  }

  const result = learnings.filter((_, idx) => !merged.has(idx));
  // Guard: if consolidation was too aggressive, skip the write
  if (result.length < Math.ceil(CONSOLIDATION_THRESHOLD * 0.4)) return;
  writeLearnings(projectRoot, result);
}

/**
 * Format learnings for prompt injection.
 * Sorts by weight descending, respects char budget.
 */
export function formatLearningsForPrompt(learnings: Learning[], budget: number = DEFAULT_BUDGET): string {
  if (learnings.length === 0) return '';

  const sorted = [...learnings].sort((a, b) => b.weight - a.weight);
  const lines: string[] = [];
  let charCount = 0;

  const header = '<project-learnings>\n## Learnings from Previous Runs\n';
  const footer = '\n</project-learnings>';
  charCount += header.length + footer.length;

  for (const l of sorted) {
    const tag = l.category.toUpperCase();
    const line = `- [${tag}] ${l.text} (w:${Math.round(l.weight)})`;
    if (charCount + line.length + 1 > budget) break;
    lines.push(line);
    charCount += line.length + 1;
  }

  if (lines.length === 0) return '';
  return header + lines.join('\n') + footer;
}

const STOPWORDS = new Set([
  'the', 'and', 'for', 'that', 'this', 'with', 'from', 'are', 'was', 'were',
  'been', 'have', 'has', 'had', 'not', 'but', 'all', 'can', 'her', 'his',
  'its', 'may', 'new', 'now', 'old', 'see', 'way', 'who', 'did', 'get',
  'let', 'say', 'she', 'too', 'use', 'add', 'fix', 'run', 'set', 'try',
  'import', 'export', 'function', 'const', 'return', 'type', 'interface',
  'class', 'async', 'await', 'string', 'number', 'boolean', 'null', 'undefined',
  'file', 'files', 'code', 'should', 'would', 'could',
]);

/**
 * Extract top keywords from text for fuzzy matching.
 */
export function extractKeywords(text: string): string[] {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOPWORDS.has(w));
  const unique = [...new Set(words)];
  // Sort by length descending (longer words are more specific)
  unique.sort((a, b) => b.length - a.length);
  return unique.slice(0, 5);
}

/**
 * Select learnings relevant to the current context.
 * Scores by tag overlap × weight.
 */
export function selectRelevant(
  learnings: Learning[],
  context: { paths?: string[]; commands?: string[]; titleHint?: string },
  opts?: { maxResults?: number },
): Learning[] {
  const contextTags = extractTags(context.paths ?? [], context.commands ?? []);
  if (contextTags.length === 0) return learnings;

  const contextPathTags = contextTags.filter(t => t.startsWith('path:'));
  const contextCmdTags = new Set(contextTags.filter(t => t.startsWith('cmd:')));
  const hasCommands = (context.commands?.length ?? 0) > 0;

  const scored = learnings.map(l => {
    let tagScore = 0;
    for (const t of l.tags) {
      if (t.startsWith('path:')) {
        const lPath = t.slice(5);
        if (contextPathTags.some(ct => ct.slice(5) === lPath)) { tagScore += 30; continue; }
        if (contextPathTags.some(ct => ct.slice(5).startsWith(lPath + '/') || lPath.startsWith(ct.slice(5) + '/'))) { tagScore += 15; continue; }
      } else if (t.startsWith('cmd:') && contextCmdTags.has(t)) {
        tagScore += 10;
      } else if (t.startsWith('failureType:') && contextCmdTags.size > 0) {
        tagScore += 5;
      }
    }
    if (context.titleHint) {
      const hintLower = context.titleHint.toLowerCase();
      for (const kw of extractKeywords(l.text)) {
        if (hintLower.includes(kw)) tagScore += 3;
      }
    }
    if (l.category === 'gotcha' && hasCommands) tagScore += 10;
    if (l.last_confirmed_at) {
      const age = Date.now() - new Date(l.last_confirmed_at).getTime();
      if (age < 3 * 24 * 60 * 60 * 1000) tagScore += 5;
    }
    return { learning: l, score: tagScore + l.weight };
  });

  scored.sort((a, b) => b.score - a.score);
  const max = opts?.maxResults ?? 15;
  const selected = scored.slice(0, max).map(s => s.learning);

  // Instrument: track learnings selection
  const relevantCount = scored.filter(s => s.score > 0).length;
  metric('learnings', 'selected', {
    total: learnings.length,
    relevant: relevantCount,
    selected: selected.length,
    topScore: scored[0]?.score ?? 0,
  });

  return selected;
}

/**
 * Extract tags from paths and commands for tag matching.
 */
export function extractTags(paths: string[], commands: string[]): string[] {
  const tags: string[] = [];
  for (const p of paths) {
    // Normalize: strip trailing globs
    const clean = p.replace(/\/?\*\*?$/, '');
    if (clean) tags.push(`path:${clean}`);
  }
  for (const c of commands) {
    tags.push(`cmd:${c}`);
  }
  return tags;
}
