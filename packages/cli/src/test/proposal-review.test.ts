/**
 * Tests for CLI adversarial proposal review module
 */

import { describe, it, expect } from 'vitest';
import {
  buildProposalReviewPrompt,
  parseReviewedProposals,
  applyReviewToProposals,
} from '../lib/proposal-review.js';
import type { TicketProposal } from '@blockspool/core/scout';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProposal(overrides: Partial<TicketProposal> = {}): TicketProposal {
  return {
    id: 'scout-123',
    category: 'refactor',
    title: 'Simplify error handling',
    description: 'Extract common error handling into utility',
    acceptance_criteria: ['Error handling is consistent'],
    verification_commands: ['npm test'],
    allowed_paths: ['src/lib'],
    files: ['src/lib/errors.ts'],
    confidence: 85,
    impact_score: 7,
    rationale: 'Reduces duplication',
    estimated_complexity: 'simple',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// buildProposalReviewPrompt
// ---------------------------------------------------------------------------

describe('buildProposalReviewPrompt', () => {
  it('builds a review prompt with all proposals', () => {
    const proposals = [
      makeProposal({ title: 'Fix A' }),
      makeProposal({ title: 'Fix B' }),
    ];

    const prompt = buildProposalReviewPrompt(proposals);

    expect(prompt).toContain('Adversarial Proposal Review');
    expect(prompt).toContain('Fix A');
    expect(prompt).toContain('Fix B');
    expect(prompt).toContain('skeptical senior engineer');
    expect(prompt).toContain('blockspool_ingest_event');
    expect(prompt).toContain('PROPOSALS_REVIEWED');
  });

  it('includes confidence, impact, files, verification for each proposal', () => {
    const p = makeProposal({
      confidence: 90,
      impact_score: 8,
      files: ['src/a.ts', 'src/b.ts'],
      verification_commands: ['npm test', 'npm run lint'],
    });

    const prompt = buildProposalReviewPrompt([p]);

    expect(prompt).toContain('**Confidence:** 90');
    expect(prompt).toContain('**Impact:** 8/10');
    expect(prompt).toContain('src/a.ts, src/b.ts');
    expect(prompt).toContain('npm test, npm run lint');
  });

  it('handles proposals with no files or verification', () => {
    const p = makeProposal({ files: [], verification_commands: [] });
    const prompt = buildProposalReviewPrompt([p]);
    expect(prompt).toContain('(none listed)');
    expect(prompt).toContain('(none)');
  });
});

// ---------------------------------------------------------------------------
// parseReviewedProposals
// ---------------------------------------------------------------------------

describe('parseReviewedProposals', () => {
  it('parses valid XML block', () => {
    const response = `
Some preamble text.

<reviewed-proposals>
[
  { "title": "Fix A", "confidence": 70, "impact_score": 6, "review_note": "Adjusted down" },
  { "title": "Fix B", "confidence": 0, "impact_score": 2, "review_note": "Infeasible" }
]
</reviewed-proposals>

Some trailing text.
    `;

    const result = parseReviewedProposals(response);
    expect(result).not.toBeNull();
    expect(result).toHaveLength(2);
    expect(result![0].title).toBe('Fix A');
    expect(result![0].confidence).toBe(70);
    expect(result![0].impact_score).toBe(6);
    expect(result![0].review_note).toBe('Adjusted down');
    expect(result![1].confidence).toBe(0);
  });

  it('handles JSON wrapped in code fences', () => {
    const response = `
<reviewed-proposals>
\`\`\`json
[{ "title": "Fix A", "confidence": 80, "impact_score": 7 }]
\`\`\`
</reviewed-proposals>
    `;

    const result = parseReviewedProposals(response);
    expect(result).not.toBeNull();
    expect(result![0].confidence).toBe(80);
  });

  it('returns null when no XML block found', () => {
    expect(parseReviewedProposals('No XML here')).toBeNull();
  });

  it('returns null for invalid JSON', () => {
    const response = '<reviewed-proposals>not json</reviewed-proposals>';
    expect(parseReviewedProposals(response)).toBeNull();
  });

  it('returns null for non-array JSON', () => {
    const response = '<reviewed-proposals>{"title": "x"}</reviewed-proposals>';
    expect(parseReviewedProposals(response)).toBeNull();
  });

  it('returns null for empty array', () => {
    const response = '<reviewed-proposals>[]</reviewed-proposals>';
    expect(parseReviewedProposals(response)).toBeNull();
  });

  it('skips items without title', () => {
    const response = `
<reviewed-proposals>
[
  { "confidence": 70, "impact_score": 6 },
  { "title": "Valid", "confidence": 80, "impact_score": 7 }
]
</reviewed-proposals>
    `;

    const result = parseReviewedProposals(response);
    expect(result).toHaveLength(1);
    expect(result![0].title).toBe('Valid');
  });

  it('defaults confidence and impact for missing values', () => {
    const response = `
<reviewed-proposals>
[{ "title": "Fix A" }]
</reviewed-proposals>
    `;

    const result = parseReviewedProposals(response);
    expect(result).not.toBeNull();
    expect(result![0].confidence).toBe(50);
    expect(result![0].impact_score).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// applyReviewToProposals
// ---------------------------------------------------------------------------

describe('applyReviewToProposals', () => {
  it('applies revised scores to matching proposals', () => {
    const proposals = [
      makeProposal({ title: 'Fix A', confidence: 85, impact_score: 7 }),
      makeProposal({ title: 'Fix B', confidence: 90, impact_score: 8 }),
    ];

    const reviewed = [
      { title: 'Fix A', confidence: 70, impact_score: 6 },
      { title: 'Fix B', confidence: 0, impact_score: 2 },
    ];

    const result = applyReviewToProposals(proposals, reviewed);

    expect(result[0].confidence).toBe(70);
    expect(result[0].impact_score).toBe(6);
    expect(result[1].confidence).toBe(0);
    expect(result[1].impact_score).toBe(2);
  });

  it('preserves original scores for unmatched proposals', () => {
    const proposals = [
      makeProposal({ title: 'Fix A', confidence: 85, impact_score: 7 }),
      makeProposal({ title: 'Fix C', confidence: 90, impact_score: 8 }),
    ];

    const reviewed = [
      { title: 'Fix A', confidence: 70, impact_score: 6 },
      // Fix C not in review
    ];

    const result = applyReviewToProposals(proposals, reviewed);
    expect(result[0].confidence).toBe(70);
    expect(result[1].confidence).toBe(90); // unchanged
    expect(result[1].impact_score).toBe(8); // unchanged
  });

  it('matches titles case-insensitively', () => {
    const proposals = [makeProposal({ title: 'Fix Error Handling', confidence: 85 })];
    const reviewed = [{ title: 'fix error handling', confidence: 60, impact_score: 5 }];

    const result = applyReviewToProposals(proposals, reviewed);
    expect(result[0].confidence).toBe(60);
  });

  it('does not mutate original proposals', () => {
    const original = makeProposal({ title: 'Fix A', confidence: 85 });
    const proposals = [original];
    const reviewed = [{ title: 'Fix A', confidence: 70, impact_score: 5 }];

    applyReviewToProposals(proposals, reviewed);
    expect(original.confidence).toBe(85); // unchanged
  });

  it('returns empty array for empty input', () => {
    expect(applyReviewToProposals([], [])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Config integration
// ---------------------------------------------------------------------------

describe('config integration', () => {
  it('DEFAULT_AUTO_CONFIG has adversarialReview disabled', async () => {
    const { DEFAULT_AUTO_CONFIG } = await import('../lib/solo-config.js');
    expect(DEFAULT_AUTO_CONFIG.adversarialReview).toBe(false);
  });
});
