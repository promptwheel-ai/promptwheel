/**
 * Proposal filtering, dedup, scoring, and ticket creation.
 *
 * Used by the event processor when SCOUT_OUTPUT is ingested,
 * and by the blockspool_submit_proposals tool.
 */

import type { DatabaseAdapter, TicketCategory } from '@blockspool/core';
import { repos } from '@blockspool/core';
import { RunManager } from './run-manager.js';
import { recordDedupEntries } from './dedup-memory.js';

// ---------------------------------------------------------------------------
// Proposal schema
// ---------------------------------------------------------------------------

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

export interface FilterResult {
  accepted: ValidatedProposal[];
  rejected: Array<{ proposal: RawProposal; reason: string }>;
  created_ticket_ids: string[];
}

const REQUIRED_FIELDS: (keyof ValidatedProposal)[] = [
  'category', 'title', 'description', 'allowed_paths',
  'files', 'confidence', 'verification_commands',
  'risk', 'touched_files_estimate', 'rollback_note',
];

// ---------------------------------------------------------------------------
// Main entry: filter + create tickets
// ---------------------------------------------------------------------------

export async function filterAndCreateTickets(
  run: RunManager,
  db: DatabaseAdapter,
  rawProposals: RawProposal[],
): Promise<FilterResult> {
  const s = run.require();
  const rejected: FilterResult['rejected'] = [];

  // Step 0: Re-promote deferred proposals that now match the current scope
  const currentScope = s.scope?.replace(/\*\*$/, '').replace(/\*$/, '').replace(/\/$/, '') || '';
  const stillDeferred: typeof s.deferred_proposals = [];
  for (const dp of s.deferred_proposals) {
    const files = dp.files.length > 0 ? dp.files : dp.allowed_paths;
    const nowInScope = !currentScope || files.length === 0 || files.every(f =>
      f.startsWith(currentScope) || f.startsWith(currentScope + '/')
    );
    if (nowInScope) {
      // Re-inject as a raw proposal
      rawProposals.push({
        category: dp.category,
        title: dp.title,
        description: dp.description,
        files: dp.files,
        allowed_paths: dp.allowed_paths,
        confidence: dp.confidence,
        impact_score: dp.impact_score,
      });
    } else {
      stillDeferred.push(dp);
    }
  }
  s.deferred_proposals = stillDeferred;

  // Step 1: Schema validation
  const valid: ValidatedProposal[] = [];
  for (const raw of rawProposals) {
    const missing = validateSchema(raw);
    if (missing) {
      rejected.push({ proposal: raw, reason: `Missing fields: ${missing}` });
      continue;
    }
    valid.push(normalizeProposal(raw));
  }

  // Step 2: Confidence filter
  const afterConfidence = valid.filter(p => {
    if (p.confidence < s.min_confidence) {
      rejected.push({ proposal: p, reason: `Confidence ${p.confidence} below min ${s.min_confidence}` });
      return false;
    }
    return true;
  });

  // Step 2b: Impact score filter
  const minImpact = s.min_impact_score ?? 3;
  const afterImpact = afterConfidence.filter(p => {
    const impact = p.impact_score ?? 5;
    if (impact < minImpact) {
      rejected.push({ proposal: p, reason: `Impact score ${impact} below min ${minImpact}` });
      return false;
    }
    return true;
  });

  // Step 3: Category trust ladder
  const allowedCategories = new Set(s.categories);
  const afterCategory = afterImpact.filter(p => {
    if (!allowedCategories.has(p.category)) {
      rejected.push({ proposal: p, reason: `Category '${p.category}' not in trust ladder` });
      return false;
    }
    return true;
  });

  // Step 3b: Scope filter — defer proposals whose files fall outside session scope
  const sessionScope = s.scope?.replace(/\*\*$/, '').replace(/\*$/, '').replace(/\/$/, '') || '';
  const afterScope = sessionScope
    ? afterCategory.filter(p => {
        const files = p.files.length > 0 ? p.files : p.allowed_paths;
        const allInScope = files.length === 0 || files.every(f =>
          f.startsWith(sessionScope) || f.startsWith(sessionScope + '/')
        );
        if (!allInScope) {
          // Defer instead of reject — will retry when scope matches
          s.deferred_proposals.push({
            category: p.category,
            title: p.title,
            description: p.description,
            files: p.files,
            allowed_paths: p.allowed_paths,
            confidence: p.confidence,
            impact_score: p.impact_score,
            original_scope: s.scope,
          });
          rejected.push({ proposal: p, reason: `Deferred (files outside scope '${s.scope}'): ${files.filter(f => !f.startsWith(sessionScope)).join(', ')}` });
          return false;
        }
        return true;
      })
    : afterCategory;

  // Step 4: Dedup against existing tickets (title similarity)
  const existingTickets = await repos.tickets.listByProject(db, s.project_id);
  const existingTitles = existingTickets.map(t => t.title);
  const afterDedup = afterScope.filter(p => {
    const isDupe = existingTitles.some(t => titleSimilarity(t, p.title) >= 0.6);
    if (isDupe) {
      rejected.push({ proposal: p, reason: 'Duplicate of existing ticket (title similarity >= 0.6)' });
      return false;
    }
    return true;
  });

  // Also dedup within the batch
  const uniqueByTitle: ValidatedProposal[] = [];
  for (const p of afterDedup) {
    const isDupeInBatch = uniqueByTitle.some(q => titleSimilarity(q.title, p.title) >= 0.6);
    if (isDupeInBatch) {
      rejected.push({ proposal: p, reason: 'Duplicate within batch (title similarity >= 0.6)' });
      continue;
    }
    uniqueByTitle.push(p);
  }

  // Step 5: Score and cap
  const scored = uniqueByTitle
    .map(p => ({
      proposal: p,
      score: (p.impact_score ?? 5) * p.confidence,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, s.max_proposals_per_scout);

  // Step 5b: Balance test vs non-test proposals (maxTestRatio = 0.4)
  const MAX_TEST_RATIO = 0.4;
  const scoredProposals = scored.map(s => s.proposal);
  const testProposals = scoredProposals.filter(p => (p.category || '').toLowerCase() === 'test');
  const nonTestProposals = scoredProposals.filter(p => (p.category || '').toLowerCase() !== 'test');
  const maxTests = Math.floor(scoredProposals.length * MAX_TEST_RATIO);
  const accepted = testProposals.length <= maxTests
    ? scoredProposals
    : [...nonTestProposals, ...testProposals.slice(0, Math.max(maxTests, scoredProposals.length - nonTestProposals.length))];

  // Step 6: Create tickets
  const ticketInputs = accepted.map(p => ({
    projectId: s.project_id,
    title: p.title,
    description: formatDescription(p),
    status: 'ready' as const,
    priority: Math.round((p.impact_score ?? 5) * p.confidence / 10),
    category: p.category as TicketCategory,
    allowedPaths: p.allowed_paths,
    verificationCommands: p.verification_commands,
  }));

  let createdIds: string[] = [];
  if (ticketInputs.length > 0) {
    const created = await repos.tickets.createMany(db, ticketInputs);
    createdIds = created.map(t => t.id);

    run.appendEvent('TICKETS_CREATED', {
      count: created.length,
      ids: createdIds,
      titles: accepted.map(p => p.title),
    });
  }

  run.appendEvent('PROPOSALS_FILTERED', {
    submitted: rawProposals.length,
    valid: valid.length,
    after_confidence: afterConfidence.length,
    after_impact: afterImpact.length,
    after_category: afterCategory.length,
    after_dedup: uniqueByTitle.length,
    accepted: accepted.length,
    rejected_count: rejected.length,
  });

  // Record dedup memory — accepted titles as completed, duplicate rejections as attempted
  const dedupEntries: { title: string; completed: boolean }[] = [];
  for (const p of accepted) {
    dedupEntries.push({ title: p.title, completed: true });
  }
  for (const r of rejected) {
    if (r.reason.includes('Duplicate') && r.proposal.title) {
      dedupEntries.push({ title: r.proposal.title, completed: false });
    }
  }
  if (dedupEntries.length > 0) {
    recordDedupEntries(run.rootPath, dedupEntries);
  }

  return { accepted, rejected, created_ticket_ids: createdIds };
}

// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------

function validateSchema(raw: RawProposal): string | null {
  const missing: string[] = [];

  if (!raw.category || typeof raw.category !== 'string') missing.push('category');
  if (!raw.title || typeof raw.title !== 'string') missing.push('title');
  if (!raw.description || typeof raw.description !== 'string') missing.push('description');
  if (!Array.isArray(raw.allowed_paths)) missing.push('allowed_paths');
  if (!Array.isArray(raw.files)) missing.push('files');
  if (typeof raw.confidence !== 'number') missing.push('confidence');
  if (!Array.isArray(raw.verification_commands)) missing.push('verification_commands');
  if (!raw.risk || typeof raw.risk !== 'string') missing.push('risk');
  if (typeof raw.touched_files_estimate !== 'number') missing.push('touched_files_estimate');
  if (!raw.rollback_note || typeof raw.rollback_note !== 'string') missing.push('rollback_note');

  return missing.length > 0 ? missing.join(', ') : null;
}

function normalizeProposal(raw: RawProposal): ValidatedProposal {
  return {
    category: raw.category!,
    title: raw.title!,
    description: raw.description!,
    acceptance_criteria: raw.acceptance_criteria ?? [],
    verification_commands: raw.verification_commands ?? [],
    allowed_paths: raw.allowed_paths ?? [],
    files: raw.files ?? [],
    confidence: raw.confidence!,
    impact_score: raw.impact_score ?? 5,
    rationale: raw.rationale ?? '',
    estimated_complexity: raw.estimated_complexity ?? 'moderate',
    risk: raw.risk!,
    touched_files_estimate: raw.touched_files_estimate!,
    rollback_note: raw.rollback_note!,
  };
}

// ---------------------------------------------------------------------------
// Title similarity (Jaccard on bigrams, case-insensitive)
// ---------------------------------------------------------------------------

export function titleSimilarity(a: string, b: string): number {
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
// Adversarial proposal review prompt
// ---------------------------------------------------------------------------

export function buildProposalReviewPrompt(proposals: ValidatedProposal[]): string {
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
      `- **Impact:** ${p.impact_score}/10`,
      `- **Files:** ${p.files.join(', ') || '(none listed)'}`,
      `- **Risk:** ${p.risk}`,
      `- **Verification:** ${p.verification_commands.join(', ') || '(none)'}`,
      `- **Description:** ${p.description}`,
      '',
    );
  }

  parts.push(
    '## Output',
    '',
    'Return a `<reviewed-proposals>` XML block containing a JSON array with the same proposals,',
    'but with revised `confidence` and `impact_score` values based on your review.',
    'You may also add a `review_note` string field explaining any adjustments.',
    'If a proposal is fundamentally flawed, set its confidence to 0.',
    '',
    '```',
    '<reviewed-proposals>',
    '[{ "title": "...", "confidence": <revised>, "impact_score": <revised>, "review_note": "..." }, ...]',
    '</reviewed-proposals>',
    '```',
    '',
    'Then call `blockspool_ingest_event` with type `PROPOSALS_REVIEWED` and payload:',
    '`{ "reviewed_proposals": [...] }`',
  );

  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Description formatter
// ---------------------------------------------------------------------------

function formatDescription(p: ValidatedProposal): string {
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
