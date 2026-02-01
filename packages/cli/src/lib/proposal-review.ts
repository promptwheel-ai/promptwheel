/**
 * Adversarial proposal review — second-pass critical evaluation of scout proposals.
 *
 * Builds a review prompt, sends it through the execution backend (Claude CLI / Codex),
 * parses revised confidence/impact scores, and applies them to proposals.
 */

import type { TicketProposal } from '@blockspool/core/scout';

// ---------------------------------------------------------------------------
// Review prompt builder
// ---------------------------------------------------------------------------

export function buildProposalReviewPrompt(proposals: TicketProposal[]): string {
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
      `- **Impact:** ${p.impact_score ?? 5}/10`,
      `- **Files:** ${p.files.join(', ') || '(none listed)'}`,
      `- **Verification:** ${p.verification_commands.join(', ') || '(none)'}`,
      `- **Description:** ${p.description}`,
      '',
    );
  }

  parts.push(
    '## Output',
    '',
    'Return ONLY a `<reviewed-proposals>` XML block containing a JSON array.',
    'Each element must have: `title` (string, matching original), `confidence` (number 0-100),',
    '`impact_score` (number 1-10), and optionally `review_note` (string).',
    'If a proposal is fundamentally flawed, set its confidence to 0.',
    '',
    'Example:',
    '```',
    '<reviewed-proposals>',
    '[',
    '  { "title": "Add missing null check", "confidence": 75, "impact_score": 6, "review_note": "Solid but verify edge case X" },',
    '  { "title": "Refactor auth module", "confidence": 0, "impact_score": 2, "review_note": "Requires changes outside allowed_paths" }',
    ']',
    '</reviewed-proposals>',
    '```',
    '',
    'Output the <reviewed-proposals> block now. Nothing else.',
  );

  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Parse reviewed proposals from LLM response
// ---------------------------------------------------------------------------

export interface ReviewedProposal {
  title: string;
  confidence: number;
  impact_score: number;
  review_note?: string;
}

/**
 * Parse the <reviewed-proposals> XML block from the LLM response.
 * Returns null if parsing fails.
 */
export function parseReviewedProposals(response: string): ReviewedProposal[] | null {
  // Extract content between <reviewed-proposals> tags
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
        impact_score: typeof item.impact_score === 'number' ? item.impact_score : 5,
        review_note: typeof item.review_note === 'string' ? item.review_note : undefined,
      });
    }
    return results.length > 0 ? results : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Apply review results to proposals
// ---------------------------------------------------------------------------

/**
 * Apply reviewed scores to the original proposals.
 * Matches by title (case-insensitive). Unmatched proposals keep original scores.
 * Returns a new array (does not mutate originals).
 */
export function applyReviewToProposals(
  proposals: TicketProposal[],
  reviewed: ReviewedProposal[],
): TicketProposal[] {
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
