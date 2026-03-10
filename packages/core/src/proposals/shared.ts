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

export type ProposalSeverity = 'blocking' | 'degrading' | 'polish' | 'speculative';

export const SEVERITY_WEIGHT: Record<ProposalSeverity, number> = {
  blocking: 3,
  degrading: 2,
  polish: 1,
  speculative: 0.5,
};

// ---------------------------------------------------------------------------
// Structured risk assessment
// ---------------------------------------------------------------------------

/** Structured risk factors produced by the LLM for rubric-based severity. */
export interface RiskAssessment {
  /** How does this affect end users? */
  user_impact: 'none' | 'minor' | 'degraded' | 'broken';
  /** How easily can the issue be triggered externally? */
  exploitability: 'none' | 'requires_auth' | 'public';
  /** How much of the system is affected? */
  blast_radius: 'single_file' | 'module' | 'system_wide';
  /** Risk of data corruption or loss. */
  data_risk: 'none' | 'stale' | 'corrupted' | 'lost';
  /** What evidence supports this finding? */
  confidence_basis: 'pattern_match' | 'code_trace' | 'runtime_evidence';
}

/**
 * Derive severity from structured risk factors using a deterministic rubric.
 * This is more reliable than regex heuristics or raw LLM labels.
 */
export function deriveSeverity(assessment: RiskAssessment): ProposalSeverity {
  // Blocking: any critical dimension
  if (assessment.user_impact === 'broken') return 'blocking';
  if (assessment.data_risk === 'lost') return 'blocking';
  if (assessment.exploitability === 'public') return 'blocking';

  // Degrading: significant but not critical
  if (assessment.user_impact === 'degraded') return 'degrading';
  if (assessment.data_risk === 'corrupted') return 'degrading';
  if (assessment.blast_radius === 'system_wide') return 'degrading';

  // Speculative: low-evidence pattern matches with no user impact
  if (assessment.confidence_basis === 'pattern_match' && assessment.user_impact === 'none') {
    return 'speculative';
  }

  return 'polish';
}

/** Validate that a risk_assessment object has all required fields with valid values. */
export function isValidRiskAssessment(ra: unknown): ra is RiskAssessment {
  if (!ra || typeof ra !== 'object') return false;
  const r = ra as Record<string, unknown>;
  return (
    ['none', 'minor', 'degraded', 'broken'].includes(r.user_impact as string) &&
    ['none', 'requires_auth', 'public'].includes(r.exploitability as string) &&
    ['single_file', 'module', 'system_wide'].includes(r.blast_radius as string) &&
    ['none', 'stale', 'corrupted', 'lost'].includes(r.data_risk as string) &&
    ['pattern_match', 'code_trace', 'runtime_evidence'].includes(r.confidence_basis as string)
  );
}

// ---------------------------------------------------------------------------
// Regex-based severity inference (fallback)
// ---------------------------------------------------------------------------

const BLOCKING_SIGNALS = /(?:\b(?:crash|race condition|security|vulnerability|injection|xss|csrf|auth bypass|data loss|corrupt|undefined is not|typeerror|referenceerror|unhandled|deadlock|infinite loop|memory leak|denial.of.service|force.delete|rm -rf)\b|\.catch\(null\))/i;
const DEGRADING_SIGNALS = /\b(silent(ly)?.(fail|swallow|ignore|drop)|wrong (result|output|value|status|code)|incorrect|broken|missing (guard|check|validation|error)|unreachable|dead code|resource leak|hang(s|ing)?|timeout|orphan)\b/i;
const SPECULATIVE_SIGNALS = /\b(consider|might|could|potentially|arguably|style|cosmetic|nitpick|optional|subjective)\b/i;

/**
 * Infer severity from category + description when LLM doesn't provide
 * structured risk_assessment. Deterministic regex fallback.
 */
export function inferSeverity(category: string, description: string): ProposalSeverity {
  if (category === 'security') return 'blocking';
  if (BLOCKING_SIGNALS.test(description)) return 'blocking';
  if (category === 'fix' && DEGRADING_SIGNALS.test(description)) return 'degrading';
  if (category === 'fix') return 'degrading'; // fixes are at least degrading
  if (category === 'docs' || category === 'types' || category === 'cleanup') return 'polish';
  if (DEGRADING_SIGNALS.test(description)) return 'degrading';
  if (SPECULATIVE_SIGNALS.test(description)) return 'speculative';
  return 'polish';
}

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
  /** Function/class names this proposal modifies (for symbol-aware conflict detection). */
  target_symbols?: string[];
  /** Severity tier: how critical is this change? */
  severity?: ProposalSeverity;
  /** Structured risk factors for rubric-based severity derivation. */
  risk_assessment?: RiskAssessment;
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
  /** Function/class names this proposal modifies (for symbol-aware conflict detection). */
  target_symbols?: string[];
  /** Severity tier: how critical is this change? */
  severity: ProposalSeverity;
  /** Structured risk factors (present when LLM produced them). */
  risk_assessment?: RiskAssessment;
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
  DEFAULT_MIN_IMPACT: 5,
  /** Dedup similarity threshold */
  DEDUP_THRESHOLD: 0.6,
} as const;

// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------

/** Coerce a value to number if it's a numeric string, otherwise return as-is. */
function coerceToNumber(value: unknown): unknown {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return value;
}

/**
 * Validate that a raw proposal has all required fields.
 * Returns a comma-separated string of missing fields, or null if valid.
 *
 * Applies forgiveness coercions in-place:
 * - `confidence`: coerced from string (e.g. `"75"` → `75`), defaults to 50 if missing
 * - `touched_files_estimate`: coerced from string
 * - `impact_score`: coerced from string
 */
export function validateProposalSchema(raw: RawProposal): string | null {
  const missing: string[] = [];

  // Coerce numeric fields from string before validation
  raw.confidence = coerceToNumber(raw.confidence) as number | undefined;
  raw.touched_files_estimate = coerceToNumber(raw.touched_files_estimate) as number | undefined;
  raw.impact_score = coerceToNumber(raw.impact_score) as number | undefined;

  // Default confidence to 50 if missing entirely (matches CLI behavior)
  if (raw.confidence === undefined || raw.confidence === null) {
    raw.confidence = 50;
  }

  // Hard-required: no sensible default possible
  if (!raw.category || typeof raw.category !== 'string') missing.push('category');
  if (!raw.title || typeof raw.title !== 'string') missing.push('title');
  if (!raw.description || typeof raw.description !== 'string') missing.push('description');
  // allowed_paths can be derived from files — only fail if neither is usable
  if (!Array.isArray(raw.allowed_paths) && !(Array.isArray(raw.files) && raw.files.length > 0)) {
    missing.push('allowed_paths');
  }
  if (typeof raw.confidence !== 'number') missing.push('confidence');

  // Soft-required: normalizeProposal provides safe defaults for these.
  // We still validate type when present, but missing is not fatal.
  if (raw.files !== null && raw.files !== undefined && !Array.isArray(raw.files)) missing.push('files');
  if (raw.verification_commands !== null && raw.verification_commands !== undefined && !Array.isArray(raw.verification_commands)) missing.push('verification_commands');
  if (raw.risk !== null && raw.risk !== undefined && typeof raw.risk !== 'string') missing.push('risk');
  if (raw.touched_files_estimate !== null && raw.touched_files_estimate !== undefined && typeof raw.touched_files_estimate !== 'number') missing.push('touched_files_estimate');
  if (raw.rollback_note !== null && raw.rollback_note !== undefined && typeof raw.rollback_note !== 'string') missing.push('rollback_note');

  return missing.length > 0 ? missing.join(', ') : null;
}

/**
 * Normalize a raw proposal into a validated proposal with defaults applied.
 * Caller must ensure schema validation passed first.
 */
export function normalizeProposal(raw: RawProposal): ValidatedProposal | null {
  // Lowercase category — LLMs produce "Fix", "Refactor" etc. Trust ladder
  // uses lowercase set (e.g. allowedCategories.has("fix")), so normalize here.
  const category = raw.category!.toLowerCase();

  // Noise filter — reject low-value cosmetic proposals
  const NOISE_PATTERNS = /\b(jsdoc|comment|typo|spelling|whitespace|import order|sort import|lint|format|prettier|eslint|tslint)\b/i;
  if (
    NOISE_PATTERNS.test(raw.title ?? '') &&
    (category === 'docs' || category === 'cleanup') &&
    (raw.confidence ?? 50) < 80
  ) {
    return null;
  }

  // Clamp impact_score to 1-10 range (CLI already does this, MCP didn't)
  const rawImpact = raw.impact_score ?? PROPOSALS_DEFAULTS.DEFAULT_IMPACT;
  const impact_score = Math.max(1, Math.min(10, rawImpact));

  const result: ValidatedProposal = {
    category,
    title: raw.title!,
    description: raw.description!,
    acceptance_criteria: raw.acceptance_criteria ?? [],
    verification_commands: raw.verification_commands ?? [],
    allowed_paths: Array.isArray(raw.allowed_paths) && raw.allowed_paths.length > 0
      ? raw.allowed_paths
      : [...(raw.files ?? [])],
    files: raw.files ?? [],
    confidence: raw.confidence!,
    impact_score,
    rationale: raw.rationale ?? '',
    estimated_complexity: raw.estimated_complexity ?? 'moderate',
    risk: raw.risk ?? 'medium',
    touched_files_estimate: raw.touched_files_estimate ?? (raw.allowed_paths?.length ?? 1),
    rollback_note: raw.rollback_note ?? 'git revert',
    severity: raw.risk_assessment && isValidRiskAssessment(raw.risk_assessment)
      ? deriveSeverity(raw.risk_assessment)
      : (['blocking', 'degrading', 'polish', 'speculative'] as const).includes(raw.severity as ProposalSeverity)
        ? raw.severity as ProposalSeverity
        : inferSeverity(category, raw.description ?? ''),
  };
  if (raw.risk_assessment && isValidRiskAssessment(raw.risk_assessment)) {
    result.risk_assessment = raw.risk_assessment;
  }
  if (raw.target_symbols?.length) result.target_symbols = raw.target_symbols;
  return result;
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
    'Call `promptwheel_ingest_event` with type `PROPOSALS_REVIEWED` and payload:',
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
// Graph-boosted scoring
// ---------------------------------------------------------------------------

/**
 * Optional dependency graph context for structural impact scoring.
 * When provided, proposals touching hub modules (high fan-in) get a score
 * boost, making structurally impactful changes float to the top.
 */
export interface GraphContext {
  /** Forward edges: module → modules it imports. */
  edges: Record<string, string[]>;
  /** Reverse edges: module → modules that import it. */
  reverseEdges: Record<string, string[]>;
  /** Modules with fan_in >= 3 (high dependents). */
  hubModules: string[];
}

/** Hub boost: 20% increase for proposals touching hub modules. */
const HUB_BOOST = 0.2;
/** Fan-in scaling: each additional dependent adds 2% up to 20% max. */
const FAN_IN_SCALE = 0.02;
const FAN_IN_CAP = 0.2;

/**
 * Compute a structural boost multiplier for a proposal based on its
 * position in the dependency graph.
 *
 * Returns a multiplier >= 1.0. Hub modules (high fan-in) get boosted
 * because changes to them have cascading impact. Returns 1.0 when
 * no graph context or no matching modules.
 */
export function computeGraphBoost(
  files: string[],
  graph: GraphContext | undefined,
): number {
  if (!graph || files.length === 0) return 1.0;

  // Map files to their containing modules (parent directory paths)
  const modules = new Set<string>();
  for (const f of files) {
    const parts = f.split('/');
    // Try increasingly specific paths: a/b/c → a/b, a/b/c
    for (let i = 1; i <= parts.length - 1; i++) {
      const candidate = parts.slice(0, i).join('/');
      if (candidate in graph.reverseEdges || candidate in graph.edges) {
        modules.add(candidate);
      }
    }
  }

  if (modules.size === 0) return 1.0;

  let maxBoost = 0;
  for (const mod of modules) {
    const fanIn = (graph.reverseEdges[mod] ?? []).length;
    const isHub = graph.hubModules.includes(mod);

    let boost = 0;
    if (isHub) boost += HUB_BOOST;
    boost += Math.min(fanIn * FAN_IN_SCALE, FAN_IN_CAP);
    if (boost > maxBoost) maxBoost = boost;
  }

  return 1.0 + maxBoost;
}

// ---------------------------------------------------------------------------
// Scoring and ranking
// ---------------------------------------------------------------------------

/**
 * Score proposals by impact × confidence and return the top N.
 * When graphContext is provided, proposals touching hub modules get
 * a structural boost. Does not mutate the input array.
 */
export function scoreAndRank<T extends { confidence: number; impact_score?: number; files?: string[]; severity?: ProposalSeverity }>(
  proposals: T[],
  maxCount?: number,
  graphContext?: GraphContext,
): T[] {
  const scored = [...proposals]
    .map(p => {
      const base = (p.impact_score ?? PROPOSALS_DEFAULTS.DEFAULT_IMPACT) * p.confidence;
      const boost = computeGraphBoost(p.files ?? [], graphContext);
      const severityMult = SEVERITY_WEIGHT[p.severity ?? 'polish'];
      return { proposal: p, score: base * boost * severityMult };
    })
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
