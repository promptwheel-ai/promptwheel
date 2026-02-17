/**
 * Pure dedup algorithms — no filesystem, no database.
 *
 * Shared by both @promptwheel/cli and @promptwheel/mcp.
 * CLI keeps its proposal-level wrapper (isDuplicateProposal).
 * MCP keeps its file I/O (dedup-memory.json persistence).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DedupEntry {
  title: string;
  /** 0-100, decays per session load */
  weight: number;
  /** ISO timestamp of first encounter */
  created_at: string;
  /** ISO timestamp of most recent bump (re-proposal or completion) */
  last_seen_at: string;
  /** How many times this title was encountered (proposed or completed) */
  hit_count: number;
  /** Whether this was actually executed successfully (stronger signal) */
  completed: boolean;
}

export interface DedupMatch {
  entry: DedupEntry;
  similarity: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEDUP_DEFAULTS = {
  DECAY_RATE: 5,
  DEFAULT_WEIGHT: 60,
  COMPLETED_WEIGHT: 80,
  MAX_WEIGHT: 100,
  BUMP_AMOUNT: 15,
  RECENT_WINDOW_MS: 3 * 24 * 60 * 60 * 1000, // 3 days
  DEFAULT_BUDGET: 1500,
  SIMILARITY_THRESHOLD: 0.6,
} as const;

// ---------------------------------------------------------------------------
// Title normalization and similarity
// ---------------------------------------------------------------------------

/**
 * Normalize a title for comparison (lowercase, remove punctuation, collapse whitespace).
 */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Calculate word overlap similarity between two titles (Jaccard on words, 0-1).
 * Filters out short words (≤2 chars) to focus on meaningful terms.
 */
export function titleSimilarity(a: string, b: string): number {
  const wordsA = new Set(normalizeTitle(a).split(' ').filter(w => w.length > 2));
  const wordsB = new Set(normalizeTitle(b).split(' ').filter(w => w.length > 2));

  if (wordsA.size === 0 || wordsB.size === 0) return 0;

  let overlap = 0;
  for (const word of wordsA) {
    if (wordsB.has(word)) overlap++;
  }

  const union = new Set([...wordsA, ...wordsB]).size;
  return overlap / union;
}

/**
 * Bigram-based title similarity (Jaccard on character bigrams, 0-1).
 * More resilient to word reordering and minor phrasing differences.
 */
export function bigramSimilarity(a: string, b: string): number {
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

function bigrams(s: string): Set<string> {
  const result = new Set<string>();
  const cleaned = s.replace(/[^a-z0-9 ]/g, '').trim();
  for (let i = 0; i < cleaned.length - 1; i++) {
    result.add(cleaned.slice(i, i + 2));
  }
  return result;
}

// ---------------------------------------------------------------------------
// Duplicate detection (pure — no I/O)
// ---------------------------------------------------------------------------

/**
 * Check if a title is a duplicate of any existing title.
 */
export function isDuplicate(
  title: string,
  existing: string[],
  threshold: number = DEDUP_DEFAULTS.SIMILARITY_THRESHOLD,
): { isDuplicate: boolean; reason?: string } {
  const normalizedProposal = normalizeTitle(title);

  // Exact match
  for (const ex of existing) {
    if (normalizeTitle(ex) === normalizedProposal) {
      return { isDuplicate: true, reason: `Exact match: "${ex}"` };
    }
  }

  // Similarity match
  for (const ex of existing) {
    const sim = titleSimilarity(title, ex);
    if (sim >= threshold) {
      return { isDuplicate: true, reason: `Similar (${Math.round(sim * 100)}%): "${ex}"` };
    }
  }

  return { isDuplicate: false };
}

// ---------------------------------------------------------------------------
// Decay (pure — operates on in-memory arrays)
// ---------------------------------------------------------------------------

/**
 * Apply temporal decay to dedup entries. Returns surviving entries (weight > 0).
 */
export function applyDecay(
  entries: DedupEntry[],
  decayRate: number = DEDUP_DEFAULTS.DECAY_RATE,
  now: number = Date.now(),
): DedupEntry[] {
  const surviving: DedupEntry[] = [];

  for (const e of entries) {
    let decay = decayRate;

    // Re-confirmation bonus: halve decay if seen recently
    const lastSeen = new Date(e.last_seen_at).getTime();
    if (now - lastSeen < DEDUP_DEFAULTS.RECENT_WINDOW_MS) {
      decay /= 2;
    }

    // Completed work decays slower (stronger signal)
    if (e.completed) {
      decay /= 2;
    }

    e.weight = Math.min(DEDUP_DEFAULTS.MAX_WEIGHT, e.weight - decay);

    if (e.weight > 0) {
      surviving.push(e);
    }
  }

  return surviving;
}

// ---------------------------------------------------------------------------
// Memory matching (pure)
// ---------------------------------------------------------------------------

/**
 * Match a title against dedup memory entries.
 * Returns the best match above threshold, or null.
 */
export function matchAgainstMemory(
  title: string,
  memory: DedupEntry[],
  threshold: number = DEDUP_DEFAULTS.SIMILARITY_THRESHOLD,
): DedupMatch | null {
  const normalized = normalizeTitle(title);
  let bestMatch: DedupMatch | null = null;

  for (const entry of memory) {
    // Exact match
    if (normalizeTitle(entry.title) === normalized) {
      return { entry, similarity: 1.0 };
    }

    const sim = Math.max(
      titleSimilarity(title, entry.title),
      bigramSimilarity(title, entry.title),
    );
    if (sim >= threshold && (!bestMatch || sim > bestMatch.similarity)) {
      bestMatch = { entry, similarity: sim };
    }
  }

  return bestMatch;
}

// ---------------------------------------------------------------------------
// Entry management (pure — returns new state, caller persists)
// ---------------------------------------------------------------------------

/**
 * Record a title as "seen" in a dedup entry list.
 * Returns the updated entries array (mutates in place for efficiency).
 */
export function recordEntry(
  entries: DedupEntry[],
  title: string,
  completed: boolean,
  now: string = new Date().toISOString(),
): DedupEntry[] {
  const normalized = title.toLowerCase().trim();

  const existing = entries.find(e => e.title.toLowerCase().trim() === normalized);
  if (existing) {
    existing.weight = Math.min(DEDUP_DEFAULTS.MAX_WEIGHT, existing.weight + DEDUP_DEFAULTS.BUMP_AMOUNT);
    existing.last_seen_at = now;
    existing.hit_count++;
    if (completed) existing.completed = true;
  } else {
    entries.push({
      title,
      weight: completed ? DEDUP_DEFAULTS.COMPLETED_WEIGHT : DEDUP_DEFAULTS.DEFAULT_WEIGHT,
      created_at: now,
      last_seen_at: now,
      hit_count: 1,
      completed,
    });
  }

  return entries;
}

/**
 * Batch-record multiple titles.
 */
export function recordEntries(
  entries: DedupEntry[],
  titles: { title: string; completed: boolean }[],
  now: string = new Date().toISOString(),
): DedupEntry[] {
  for (const { title, completed } of titles) {
    recordEntry(entries, title, completed, now);
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Prompt formatting (pure)
// ---------------------------------------------------------------------------

/**
 * Format dedup memory for prompt injection.
 * Highest-weight entries first, respects char budget.
 */
export function formatDedupForPrompt(
  entries: DedupEntry[],
  budget: number = DEDUP_DEFAULTS.DEFAULT_BUDGET,
): string {
  if (entries.length === 0) return '';

  const sorted = [...entries].sort((a, b) => b.weight - a.weight);
  const lines: string[] = [];
  let charCount = 0;

  const header = '<already-completed>\n## Already Completed — Do NOT Propose These\n\nThe following improvements have already been done or attempted. Do NOT propose similar changes:\n';
  const footer = '\n</already-completed>';
  charCount += header.length + footer.length;

  for (const e of sorted) {
    const status = e.completed ? '✓ done' : 'attempted';
    const line = `- ${e.title} (${status}, seen ${e.hit_count}x)`;
    if (charCount + line.length + 1 > budget) break;
    lines.push(line);
    charCount += line.length + 1;
  }

  if (lines.length === 0) return '';
  return header + lines.join('\n') + footer;
}
