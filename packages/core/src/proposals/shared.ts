/**
 * Proposals shared algorithms — pure functions for proposal validation,
 * review, scoring, balancing, and formatting.
 *
 * No filesystem, database, or LLM I/O. MCP and CLI import these and
 * wrap with their own I/O and UX layers.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Raw proposal as received from LLM output (all fields optional). */
export interface RawProposal {
  category?: string;
  title?: string;
  description?: string;
  acceptance_criteria?: string[];
  verification_commands?: string[];
  allowed_paths?: string[];
  files?: string[];
  confidence?: number;
  impact_score?: number;
  rationale?: string;
  estimated_complexity?: string;
  risk?: string;
  touched_files_estimate?: number;
  rollback_note?: string;
}

/** Proposal with all required fields validated and defaults applied. */
export interface ValidatedProposal {
  category: string;
  title: string;
  description: string;
  acceptance_criteria: string[];
  verification_commands: string[];
  allowed_paths: string[];
  files: string[];
  confidence: number;
  impact_score: number;
  rationale: string;
  estimated_complexity: string;
  risk: string;
  touched_files_estimate: number;
  rollback_note: string;
}

/** Result of adversarial review — revised scores for a single proposal. */
export interface ReviewedProposal {
  title: string;
  confidence: number;
  impact_score: number;
  review_note?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const PROPOSALS_DEFAULTS = {
  /** Maximum deferred proposals to keep across cycles */
  MAX_DEFERRED: 20,
  /** Maximum ratio of test-only proposals in a batch */
  MAX_TEST_RATIO: 0.4,
  /** Default impact score when not provided */
  DEFAULT_IMPACT: 5,
  /** Minimum confidence to pass (0 = fundamentally flawed) */
  MIN_CONFIDENCE: 1,
  /** Default minimum impact score filter */
  DEFAULT_MIN_IMPACT: 3,
  /** Dedup similarity threshold */
  DEDUP_THRESHOLD: 0.6,
} as const;

/** Fields required for a proposal to pass schema validation. */
export const REQUIRED_FIELDS: (keyof ValidatedProposal)[] = [
  'category', 'title', 'description', 'allowed_paths',
  'files', 'confidence', 'verification_commands',
  'risk', 'touched_files_estimate', 'rollback_note',
];

// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------

/**
 * Validate that a raw proposal has all required fields.
 * Returns a comma-separated string of missing fields, or null if valid.
 */
export function validateProposalSchema(raw: RawProposal): string | null {
  const missing: string[] = [];

  // Hard-required: no sensible default possible
  if (!raw.category || typeof raw.category !== 'string') missing.push('category');
  if (!raw.title || typeof raw.title !== 'string') missing.push('title');
  if (!raw.description || typeof raw.description !== 'string') missing.push('description');
  if (!Array.isArray(raw.allowed_paths)) missing.push('allowed_paths');
  if (typeof raw.confidence !== 'number') missing.push('confidence');
  if (!raw.risk || typeof raw.risk !== 'string') missing.push('risk');

  // Soft-required: normalizeProposal provides safe defaults for these.
  // We still validate type when present, but missing is not fatal.
  if (raw.files !== null && raw.files !== undefined && !Array.isArray(raw.files)) missing.push('files');
  if (raw.verification_commands !== null && raw.verification_commands !== undefined && !Array.isArray(raw.verification_commands)) missing.push('verification_commands');
  if (raw.touched_files_estimate !== null && raw.touched_files_estimate !== undefined && typeof raw.touched_files_estimate !== 'number') missing.push('touched_files_estimate');
  if (raw.rollback_note !== null && raw.rollback_note !== undefined && typeof raw.rollback_note !== 'string') missing.push('rollback_note');

  return missing.length > 0 ? missing.join(', ') : null;
}

/**
 * Normalize a raw proposal into a validated proposal with defaults applied.
 * Caller must ensure schema validation passed first.
 */
export function normalizeProposal(raw: RawProposal): ValidatedProposal {
  return {
    category: raw.category!,
    title: raw.title!,
    description: raw.description!,
    acceptance_criteria: raw.acceptance_criteria ?? [],
    verification_commands: raw.verification_commands ?? [],
    allowed_paths: raw.allowed_paths ?? [],
    files: raw.files ?? [],
    confidence: raw.confidence!,
    impact_score: raw.impact_score ?? PROPOSALS_DEFAULTS.DEFAULT_IMPACT,
    rationale: raw.rationale ?? '',
    estimated_complexity: raw.estimated_complexity ?? 'moderate',
    risk: raw.risk!,
    touched_files_estimate: raw.touched_files_estimate ?? (raw.allowed_paths?.length ?? 1),
    rollback_note: raw.rollback_note ?? 'git revert',
  };
}

// ---------------------------------------------------------------------------
// Adversarial review prompt
// ---------------------------------------------------------------------------

/** Minimal proposal shape accepted by the review prompt builder. */
export interface ReviewableProposal {
  title: string;
  category: string;
  confidence: number;
  impact_score?: number;
  files: string[];
  description: string;
  verification_commands?: string[];
  risk?: string;
}

/**
 * Build a prompt for adversarial (second-pass) review of proposals.
 *
 * The prompt asks the LLM to critically evaluate each proposal and revise
 * confidence/impact scores. Setting confidence=0 means "fundamentally flawed".
 *
 * Works with both TicketProposal (CLI) and ValidatedProposal (MCP).
 */
export function buildProposalReviewPrompt(proposals: ReviewableProposal[]): string {
  const parts = [
    '# Adversarial Proposal Review',
    '',
    'You previously generated the proposals below. Now review them critically as a skeptical senior engineer.',
    'For each proposal, evaluate:',
    '',
    '1. **Is the confidence inflated?** Would you bet your reputation on this score?',
    '2. **Will the verification commands actually validate the change?** Or are they too generic (e.g. just `npm test`)?',
    '3. **Missing edge cases?** What could break that you didn\'t consider?',
    '4. **Feasibility:** Can this actually be implemented within the file set listed, or does it require changes elsewhere?',
    '',
    '## Proposals to Review',
    '',
  ];

  for (let i = 0; i < proposals.length; i++) {
    const p = proposals[i];
    parts.push(
      `### ${i + 1}. ${p.title}`,
      `- **Category:** ${p.category}`,
      `- **Confidence:** ${p.confidence}`,
      `- **Impact:** ${p.impact_score ?? PROPOSALS_DEFAULTS.DEFAULT_IMPACT}/10`,
      `- **Files:** ${p.files.join(', ') || '(none listed)'}`,
      `- **Risk:** ${p.risk ?? '(not specified)'}`,
      `- **Verification:** ${(p.verification_commands ?? []).join(', ') || '(none)'}`,
      `- **Description:** ${p.description}`,
      '',
    );
  }

  parts.push(
    '## Output',
    '',
    'For each proposal, revise the `confidence` (0-100) and `impact_score` (1-10).',
    'If a proposal is fundamentally flawed, set its confidence to 0.',
    'Optionally add a `review_note` (string) explaining your reasoning.',
    '',
    'Call `blockspool_ingest_event` with type `PROPOSALS_REVIEWED` and payload:',
    '`{ "reviewed_proposals": [{ "title": "...", "confidence": N, "impact_score": N, "review_note": "..." }, ...] }`',
    '',
    'Example payload:',
    '```json',
    '{',
    '  "reviewed_proposals": [',
    '    { "title": "Add missing null check", "confidence": 75, "impact_score": 6, "review_note": "Solid but verify edge case X" },',
    '    { "title": "Refactor auth module", "confidence": 0, "impact_score": 2, "review_note": "Requires changes outside allowed_paths" }',
    '  ]',
    '}',
    '```',
  );

  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Parse reviewed proposals
// ---------------------------------------------------------------------------

/**
 * Parse the <reviewed-proposals> XML block from an LLM response.
 * Returns null if parsing fails.
 */
export function parseReviewedProposals(response: string): ReviewedProposal[] | null {
  const match = response.match(/<reviewed-proposals>\s*([\s\S]*?)\s*<\/reviewed-proposals>/);
  if (!match) return null;

  let jsonStr = match[1].trim();

  // Strip markdown code fences if present
  jsonStr = jsonStr.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');

  try {
    const parsed = JSON.parse(jsonStr);
    if (!Array.isArray(parsed)) return null;

    const results: ReviewedProposal[] = [];
    for (const item of parsed) {
      if (typeof item.title !== 'string') continue;
      results.push({
        title: item.title,
        confidence: typeof item.confidence === 'number' ? item.confidence : 50,
        impact_score: typeof item.impact_score === 'number' ? item.impact_score : PROPOSALS_DEFAULTS.DEFAULT_IMPACT,
        review_note: typeof item.review_note === 'string' ? item.review_note : undefined,
      });
    }
    return results.length > 0 ? results : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Apply review results
// ---------------------------------------------------------------------------

/**
 * Apply reviewed scores to the original proposals.
 * Matches by title (case-insensitive). Unmatched proposals keep original scores.
 * Returns a new array (does not mutate originals).
 */
export function applyReviewToProposals<T extends { title: string; confidence: number; impact_score?: number }>(
  proposals: T[],
  reviewed: ReviewedProposal[],
): T[] {
  const reviewMap = new Map<string, ReviewedProposal>();
  for (const r of reviewed) {
    reviewMap.set(r.title.toLowerCase(), r);
  }

  return proposals.map(p => {
    const review = reviewMap.get(p.title.toLowerCase());
    if (!review) return p;

    return {
      ...p,
      confidence: review.confidence,
      impact_score: review.impact_score,
    };
  });
}

// ---------------------------------------------------------------------------
// Scoring and ranking
// ---------------------------------------------------------------------------

/**
 * Score proposals by impact × confidence and return the top N.
 * Does not mutate the input array.
 */
export function scoreAndRank<T extends { confidence: number; impact_score?: number }>(
  proposals: T[],
  maxCount?: number,
): T[] {
  const scored = [...proposals]
    .map(p => ({
      proposal: p,
      score: (p.impact_score ?? PROPOSALS_DEFAULTS.DEFAULT_IMPACT) * p.confidence,
    }))
    .sort((a, b) => b.score - a.score);

  const capped = maxCount !== undefined ? scored.slice(0, maxCount) : scored;
  return capped.map(s => s.proposal);
}

// ---------------------------------------------------------------------------
// Test balance
// ---------------------------------------------------------------------------

/**
 * Balance test vs non-test proposals by capping the ratio of test-only proposals.
 *
 * If test proposals exceed maxTestRatio, keeps only the highest-impact tests
 * (minimum 1). Does not mutate the input.
 */
export function balanceProposals<T extends { category: string; impact_score?: number | null }>(
  proposals: T[],
  maxTestRatio: number = PROPOSALS_DEFAULTS.MAX_TEST_RATIO,
): T[] {
  const tests = proposals.filter(p => (p.category || '').toLowerCase() === 'test');
  const nonTests = proposals.filter(p => (p.category || '').toLowerCase() !== 'test');

  const total = proposals.length;
  const maxTests = Math.floor(total * maxTestRatio);

  if (tests.length <= maxTests) return [...proposals];

  // Sort tests by impact descending, keep only the top N
  const sortedTests = [...tests].sort(
    (a, b) => (b.impact_score ?? PROPOSALS_DEFAULTS.DEFAULT_IMPACT) - (a.impact_score ?? PROPOSALS_DEFAULTS.DEFAULT_IMPACT),
  );

  // Hard-cap tests — even if ALL proposals are tests, keep at most maxTests (min 1)
  const allowedTests = Math.max(maxTests, 1);
  const keptTests = sortedTests.slice(0, allowedTests);

  return [...nonTests, ...keptTests];
}

// ---------------------------------------------------------------------------
// Description formatting
// ---------------------------------------------------------------------------

/**
 * Format a validated proposal into a structured ticket description.
 */
export function formatProposalDescription(p: ValidatedProposal): string {
  const parts = [
    p.description,
    '',
    '## Acceptance Criteria',
    ...p.acceptance_criteria.map(c => `- ${c}`),
    '',
    '## Details',
    `**Risk:** ${p.risk}`,
    `**Complexity:** ${p.estimated_complexity}`,
    `**Confidence:** ${p.confidence}%`,
    `**Impact:** ${p.impact_score}/10`,
    `**Estimated files:** ${p.touched_files_estimate}`,
    '',
    '## Rollback',
    p.rollback_note,
  ];

  if (p.rationale) {
    parts.push('', '## Rationale', p.rationale);
  }

  if (p.files.length > 0) {
    parts.push('', '## Files', ...p.files.map(f => `- \`${f}\``));
  }

  return parts.join('\n');
}

/**
 * Compute ticket priority from impact score and confidence.
 * Priority = round(impact × confidence / 10)
 */
export function computePriority(impactScore: number, confidence: number): number {
  return Math.round(impactScore * confidence / 10);
}
