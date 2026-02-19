/**
 * Pure learnings algorithms — no filesystem, no database, no crypto.
 *
 * Shared by both @promptwheel/cli and @promptwheel/mcp.
 * Callers handle file I/O (reading/writing learnings.json) and ID generation.
 */

import { bigramSimilarity } from '../dedup/shared.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Structured knowledge attached to a learning.
 * Optional — learnings without this field use text-only matching (backward compat).
 */
export interface StructuredKnowledge {
  /** Files that must co-change together (learned from execution diffs) */
  cochange_files?: string[];
  /** Files with high failure rate when modified */
  fragile_paths?: string[];
  /** Root cause explanation for a failure */
  root_cause?: string;
  /** What type of knowledge this represents */
  pattern_type?: 'dependency' | 'convention' | 'antipattern' | 'environment';
  /** Glob scope this knowledge applies to */
  applies_to?: string;
  /** Failure context from QA/execution */
  failure_context?: {
    /** Which QA command failed */
    command: string;
    /** Normalized error signature (e.g. "TypeError: X is not a function") */
    error_signature: string;
    /** What fix was applied (populated on subsequent success) */
    fix_applied?: string;
  };
}

export interface Learning {
  id: string;
  text: string;
  category: 'gotcha' | 'pattern' | 'warning' | 'context' | 'compaction';
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
  /** Structured knowledge for richer retrieval and prompt injection */
  structured?: StructuredKnowledge;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const LEARNINGS_DEFAULTS = {
  DECAY_RATE: 3,
  DEFAULT_WEIGHT: 50,
  MAX_WEIGHT: 100,
  CONSOLIDATION_THRESHOLD: 50,
  SIMILARITY_MERGE_THRESHOLD: 0.7,
  CONFIRMATION_WINDOW_MS: 7 * 24 * 60 * 60 * 1000, // 7 days
  DEFAULT_BUDGET: 2000,
} as const;

// ---------------------------------------------------------------------------
// Decay (pure — operates on array, returns surviving entries)
// ---------------------------------------------------------------------------

/**
 * Apply temporal decay to learnings, returning only entries with weight > 0.
 * Access bonus halves decay; recent confirmation halves it again.
 */
export function applyLearningsDecay(
  learnings: Learning[],
  decayRate: number = LEARNINGS_DEFAULTS.DECAY_RATE,
  now: number = Date.now(),
): Learning[] {
  const surviving: Learning[] = [];

  for (const l of learnings) {
    let decay = decayRate;

    // Access bonus: halve decay if accessed
    if (l.access_count > 0) {
      decay /= 2;
    }

    // Confirmation bonus: halve again if confirmed within 7 days
    const confirmedAt = new Date(l.last_confirmed_at).getTime();
    if (now - confirmedAt < LEARNINGS_DEFAULTS.CONFIRMATION_WINDOW_MS) {
      decay /= 2;
    }

    l.weight = Math.min(LEARNINGS_DEFAULTS.MAX_WEIGHT, l.weight - decay);

    if (l.weight > 0) {
      surviving.push(l);
    }
  }

  return surviving;
}

// ---------------------------------------------------------------------------
// Consolidation (pure — merges near-duplicate learnings)
// ---------------------------------------------------------------------------

/**
 * Consolidate near-duplicate learnings (>70% text similarity).
 * Keeps the higher weight entry, sums access counts.
 * Returns null if no consolidation needed (below threshold or too aggressive).
 */
export function consolidateLearnings(learnings: Learning[]): Learning[] | null {
  if (learnings.length <= LEARNINGS_DEFAULTS.CONSOLIDATION_THRESHOLD) return null;

  // Deep-clone entries so the original array is never mutated
  const entries = learnings.map(l => ({
    ...l,
    source: { ...l.source },
    tags: [...l.tags],
    structured: l.structured ? { ...l.structured } : undefined,
  }));

  const merged = new Set<number>();
  for (let i = 0; i < entries.length; i++) {
    if (merged.has(i)) continue;
    for (let j = i + 1; j < entries.length; j++) {
      if (merged.has(j)) continue;
      if (bigramSimilarity(entries[i].text, entries[j].text) >= LEARNINGS_DEFAULTS.SIMILARITY_MERGE_THRESHOLD) {
        // Guard: don't merge across different categories
        if (entries[i].category !== entries[j].category) continue;
        // Guard: don't merge across different source types
        if (entries[i].source.type !== entries[j].source.type) continue;
        // Guard: don't merge different failure types
        const ftI = entries[i].tags.find(t => t.startsWith('failureType:'));
        const ftJ = entries[j].tags.find(t => t.startsWith('failureType:'));
        if (ftI && ftJ && ftI !== ftJ) continue;
        // Guard: don't merge frequently accessed learnings
        if (entries[i].access_count >= 3 || entries[j].access_count >= 3) continue;
        // Merge j into i (keep higher weight)
        if (entries[j].weight > entries[i].weight) {
          entries[i].weight = entries[j].weight;
          entries[i].text = entries[j].text;
        }
        entries[i].access_count += entries[j].access_count;
        // Merge effectiveness tracking counters
        if (entries[i].applied_count !== undefined || entries[j].applied_count !== undefined) {
          entries[i].applied_count = (entries[i].applied_count ?? 0) + (entries[j].applied_count ?? 0);
        }
        if (entries[i].success_count !== undefined || entries[j].success_count !== undefined) {
          entries[i].success_count = (entries[i].success_count ?? 0) + (entries[j].success_count ?? 0);
        }
        // Merge tags
        const tagSet = new Set([...entries[i].tags, ...entries[j].tags]);
        entries[i].tags = [...tagSet];
        // Merge structured knowledge (union cochange_files and fragile_paths, keep winner's other fields)
        if (entries[i].structured || entries[j].structured) {
          const si = entries[i].structured ?? {};
          const sj = entries[j].structured ?? {};
          entries[i].structured = {
            ...si,
            cochange_files: si.cochange_files || sj.cochange_files
              ? [...new Set([...(si.cochange_files ?? []), ...(sj.cochange_files ?? [])])]
              : undefined,
            fragile_paths: si.fragile_paths || sj.fragile_paths
              ? [...new Set([...(si.fragile_paths ?? []), ...(sj.fragile_paths ?? [])])]
              : undefined,
            // Keep winner's root_cause (already set by weight comparison above)
            root_cause: si.root_cause ?? sj.root_cause,
            failure_context: si.failure_context ?? sj.failure_context,
          };
        }
        // Preserve most recent confirmation date for decay calculations
        if (new Date(entries[j].last_confirmed_at).getTime() > new Date(entries[i].last_confirmed_at).getTime()) {
          entries[i].last_confirmed_at = entries[j].last_confirmed_at;
        }
        merged.add(j);
      }
    }
  }

  const result = entries.filter((_, idx) => !merged.has(idx));
  // Guard: if consolidation was too aggressive, skip
  if (result.length < Math.ceil(LEARNINGS_DEFAULTS.CONSOLIDATION_THRESHOLD * 0.4)) return null;
  return result;
}

// ---------------------------------------------------------------------------
// Prompt formatting (pure)
// ---------------------------------------------------------------------------

/**
 * Format a single structured knowledge block as an inline annotation.
 * Returns empty string if no actionable structured data.
 */
function formatStructuredAnnotation(sk: StructuredKnowledge): string {
  const parts: string[] = [];
  if (sk.cochange_files && sk.cochange_files.length > 0) {
    parts.push(`Co-change: ${sk.cochange_files.join(', ')}`);
  }
  if (sk.fragile_paths && sk.fragile_paths.length > 0) {
    parts.push(`Fragile: ${sk.fragile_paths.join(', ')}`);
  }
  if (sk.root_cause) {
    parts.push(`Cause: ${sk.root_cause}`);
  }
  if (sk.failure_context?.error_signature) {
    parts.push(`Error: ${sk.failure_context.error_signature}`);
  }
  if (sk.failure_context?.fix_applied) {
    parts.push(`Fix: ${sk.failure_context.fix_applied}`);
  }
  if (parts.length === 0) return '';
  return `  → ${parts.join(' | ')}`;
}

/**
 * Format learnings for prompt injection.
 * Sorts by weight descending, respects char budget.
 * Includes structured knowledge annotations when available.
 */
export function formatLearningsForPrompt(
  learnings: Learning[],
  budget: number = LEARNINGS_DEFAULTS.DEFAULT_BUDGET,
): string {
  if (learnings.length === 0) return '';

  const sorted = [...learnings].sort((a, b) => b.weight - a.weight);
  const lines: string[] = [];
  let charCount = 0;

  const header = '<project-learnings>\n## Learnings from Previous Runs\n';
  const footer = '\n</project-learnings>';
  charCount += header.length + footer.length;

  for (const l of sorted) {
    const tag = l.category.toUpperCase();
    let line = `- [${tag}] ${l.text} (w:${Math.round(l.weight)})`;

    // Append structured annotation if present and budget allows
    if (l.structured) {
      const annotation = formatStructuredAnnotation(l.structured);
      if (annotation) {
        line += '\n' + annotation;
      }
    }

    if (charCount + line.length + 1 > budget) break;
    lines.push(line);
    charCount += line.length + 1;
  }

  if (lines.length === 0) return '';
  return header + lines.join('\n') + footer;
}

// ---------------------------------------------------------------------------
// Keyword extraction and relevance scoring (pure)
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

/**
 * Select learnings relevant to the current context.
 * Scores by tag overlap × weight with enhanced relevance.
 * Structured knowledge fields provide additional scoring signals.
 * Returns scored and sorted learnings (highest relevance first).
 */
export function selectRelevant(
  learnings: Learning[],
  context: { paths?: string[]; commands?: string[]; titleHint?: string },
  opts?: { maxResults?: number },
  now: number = Date.now(),
): Learning[] {
  const contextTags = extractTags(context.paths ?? [], context.commands ?? []);
  if (contextTags.length === 0) return learnings;

  const contextPathTags = contextTags.filter(t => t.startsWith('path:'));
  const contextCmdTags = new Set(contextTags.filter(t => t.startsWith('cmd:')));
  const contextPaths = (context.paths ?? []).map(p => p.replace(/\/?\*\*?$/, ''));
  const hasCommands = (context.commands?.length ?? 0) > 0;

  const scored = learnings.map(l => {
    let tagScore = 0;

    // Standard tag matching
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

    // Structured knowledge scoring
    if (l.structured) {
      const sk = l.structured;

      // Cochange files: if any cochange file overlaps with context paths, strong signal
      if (sk.cochange_files && sk.cochange_files.length > 0) {
        for (const cf of sk.cochange_files) {
          if (contextPaths.some(cp => cf.startsWith(cp + '/') || cf === cp || cp.startsWith(cf + '/'))) {
            tagScore += 20;
            break; // one match is enough
          }
        }
      }

      // Fragile paths: if context touches a known fragile path, boost
      if (sk.fragile_paths && sk.fragile_paths.length > 0) {
        for (const fp of sk.fragile_paths) {
          if (contextPaths.some(cp => fp.startsWith(cp + '/') || fp === cp || cp.startsWith(fp + '/'))) {
            tagScore += 15;
            break;
          }
        }
      }

      // Error signature: if context has the same failing command, boost
      if (sk.failure_context?.command && contextCmdTags.has(`cmd:${sk.failure_context.command}`)) {
        tagScore += 12;
      }

      // Pattern type bonuses: antipatterns and dependencies are high-value
      if (sk.pattern_type === 'antipattern') tagScore += 5;
      if (sk.pattern_type === 'dependency') tagScore += 5;
    }

    if (context.titleHint) {
      const hintLower = context.titleHint.toLowerCase();
      for (const kw of extractKeywords(l.text)) {
        if (hintLower.includes(kw)) tagScore += 3;
      }
    }
    if (l.category === 'gotcha' && hasCommands) tagScore += 10;
    if (l.last_confirmed_at) {
      const age = now - new Date(l.last_confirmed_at).getTime();
      if (age < 3 * 24 * 60 * 60 * 1000) tagScore += 5;
    }
    return { learning: l, score: tagScore + l.weight };
  });

  scored.sort((a, b) => b.score - a.score);
  const max = opts?.maxResults ?? 15;
  return scored.slice(0, max).map(s => s.learning);
}

// ---------------------------------------------------------------------------
// Adaptive Risk Assessment (pure — for adaptive trust scope adjustments)
// ---------------------------------------------------------------------------

export type AdaptiveRiskLevel = 'low' | 'normal' | 'elevated' | 'high';

export interface AdaptiveRiskAssessment {
  level: AdaptiveRiskLevel;
  score: number;
  fragile_paths: string[];
  known_issues: string[];
  failure_count: number;
}

/** Failure-sourced learning types that indicate risk. */
const FAILURE_SOURCES = new Set<string>([
  'qa_failure', 'ticket_failure', 'scope_violation', 'plan_rejection',
]);

/** Compaction-sourced learnings that indicate context pressure. */
const COMPACTION_CATEGORY = 'compaction';

/**
 * Assess adaptive risk for a ticket based on failure history in learnings.
 * Only counts failure-sourced learnings with path overlap.
 */
export function assessAdaptiveRisk(
  learnings: Learning[],
  ticketPaths: string[],
): AdaptiveRiskAssessment {
  const pathSet = new Set(ticketPaths.map(p => p.replace(/\/?\*\*?$/, '')));
  let score = 0;
  let failureCount = 0;
  const fragilePaths = new Set<string>();
  const knownIssues: string[] = [];

  for (const l of learnings) {
    // Check compaction-sourced learnings — these indicate context pressure
    if (l.category === COMPACTION_CATEGORY) {
      // Check path overlap for compaction learnings
      let compactionOverlap = false;
      for (const tag of l.tags) {
        if (tag.startsWith('path:')) {
          const lPath = tag.slice(5);
          if (pathSet.has(lPath) || [...pathSet].some(p => lPath.startsWith(p + '/') || p.startsWith(lPath + '/'))) {
            compactionOverlap = true;
            break;
          }
        }
      }
      if (compactionOverlap) {
        score += 12 * (l.weight / 50);
        if (knownIssues.length < 5) {
          knownIssues.push(l.text.slice(0, 150));
        }
      }
      continue;
    }

    // Only count failure-sourced learnings
    if (!FAILURE_SOURCES.has(l.source.type)) continue;

    // Check path overlap via tags
    let hasOverlap = false;
    for (const tag of l.tags) {
      if (tag.startsWith('path:')) {
        const lPath = tag.slice(5);
        if (pathSet.has(lPath) || [...pathSet].some(p => lPath.startsWith(p + '/') || p.startsWith(lPath + '/'))) {
          hasOverlap = true;
          break;
        }
      }
    }
    if (!hasOverlap) continue;

    failureCount++;
    score += 10 * (l.weight / 50);

    // Collect fragile paths
    if (l.structured?.fragile_paths) {
      for (const fp of l.structured.fragile_paths) {
        fragilePaths.add(fp);
      }
      score += 8 * (l.weight / 50);
    }

    // Collect antipattern bonus
    if (l.structured?.pattern_type === 'antipattern') {
      score += 5 * (l.weight / 50);
    }

    // Collect known issues (up to 5)
    if (knownIssues.length < 5) {
      knownIssues.push(l.text.slice(0, 150));
    }
  }

  score = Math.min(100, score);
  const level: AdaptiveRiskLevel =
    score < 10 ? 'low' :
    score < 30 ? 'normal' :
    score < 60 ? 'elevated' :
    'high';

  return {
    level,
    score,
    fragile_paths: [...fragilePaths],
    known_issues: knownIssues,
    failure_count: failureCount,
  };
}
