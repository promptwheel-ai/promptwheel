/**
 * Cross-run learning mechanism.
 *
 * Persists learnings to `.blockspool/learnings.json` and provides
 * decay, consolidation, relevance scoring, and prompt formatting.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { titleSimilarity } from './proposals.js';

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

// ---------------------------------------------------------------------------
// Keyword extraction for titleHint matching
// ---------------------------------------------------------------------------

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
 * Scores by tag overlap × weight with enhanced relevance:
 * - Path prefix matching with hierarchy awareness
 * - titleHint keyword matching
 * - Category-aware scoring (gotcha boost when commands present)
 * - Recency boost (learnings confirmed within 3 days)
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
        // Exact path match
        if (contextPathTags.some(ct => ct.slice(5) === lPath)) { tagScore += 30; continue; }
        // Hierarchy match: parent/child path relationships
        if (contextPathTags.some(ct => ct.slice(5).startsWith(lPath + '/') || lPath.startsWith(ct.slice(5) + '/'))) { tagScore += 15; continue; }
      } else if (t.startsWith('cmd:') && contextCmdTags.has(t)) {
        tagScore += 10;
      } else if (t.startsWith('failureType:') && contextCmdTags.size > 0) {
        tagScore += 5;
      }
    }
    // titleHint keyword matching
    if (context.titleHint) {
      const hintLower = context.titleHint.toLowerCase();
      for (const kw of extractKeywords(l.text)) {
        if (hintLower.includes(kw)) tagScore += 3;
      }
    }
    // Category-aware scoring: gotcha boost when commands present
    if (l.category === 'gotcha' && hasCommands) tagScore += 10;
    // Recency boost: learnings confirmed within 3 days
    if (l.last_confirmed_at) {
      const age = Date.now() - new Date(l.last_confirmed_at).getTime();
      if (age < 3 * 24 * 60 * 60 * 1000) tagScore += 5;
    }
    return { learning: l, score: tagScore + l.weight };
  });

  scored.sort((a, b) => b.score - a.score);
  const max = opts?.maxResults ?? 15;
  return scored.slice(0, max).map(s => s.learning);
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
