/**
 * Proposal filtering, dedup, scoring, and ticket creation.
 *
 * Pure algorithms (schema validation, normalization, scoring, balancing,
 * review prompt, description formatting) live in @promptwheel/core/proposals/shared.
 * This file wraps them with database I/O, event logging, and MCP-specific
 * dedup and deferred-proposal management.
 */

import type { DatabaseAdapter, TicketCategory } from '@promptwheel/core';
import { repos } from '@promptwheel/core';
import { bigramSimilarity } from '@promptwheel/core/dedup/shared';
import {
  type RawProposal,
  type ValidatedProposal,
  validateProposalSchema,
  normalizeProposal,
  scoreAndRank,
  balanceProposals,
  formatProposalDescription,
  computePriority,
  PROPOSALS_DEFAULTS,
} from '@promptwheel/core/proposals/shared';
import { minimatch } from 'minimatch';
import { RunManager } from './run-manager.js';
import { recordDedupEntries } from './dedup-memory.js';

// Re-export core types and functions
export type { RawProposal, ValidatedProposal, ReviewedProposal } from '@promptwheel/core/proposals/shared';
export {
  validateProposalSchema,
  normalizeProposal,
  buildProposalReviewPrompt,
  parseReviewedProposals,
  applyReviewToProposals,
  scoreAndRank,
  balanceProposals,
  formatProposalDescription,
  computePriority,
  PROPOSALS_DEFAULTS,
} from '@promptwheel/core/proposals/shared';

// ---------------------------------------------------------------------------
// Filter result
// ---------------------------------------------------------------------------

export interface FilterResult {
  accepted: ValidatedProposal[];
  rejected: Array<{ proposal: RawProposal; reason: string }>;
  created_ticket_ids: string[];
}

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
  const currentScope = s.scope || '';
  const currentIsCatchAll = !currentScope || currentScope === '**' || currentScope === '*';
  const stillDeferred: typeof s.deferred_proposals = [];
  for (const dp of s.deferred_proposals) {
    const files = dp.files.length > 0 ? dp.files : dp.allowed_paths;
    const nowInScope = currentIsCatchAll || files.length === 0 || files.every(f =>
      minimatch(f, currentScope, { dot: true })
    );
    if (nowInScope) {
      rawProposals.push({
        category: dp.category,
        title: dp.title,
        description: dp.description,
        files: dp.files,
        allowed_paths: dp.allowed_paths,
        confidence: dp.confidence,
        impact_score: dp.impact_score,
        verification_commands: dp.verification_commands,
        acceptance_criteria: dp.acceptance_criteria,
        risk: dp.risk,
        touched_files_estimate: dp.touched_files_estimate,
        rollback_note: dp.rollback_note,
        rationale: dp.rationale,
        estimated_complexity: dp.estimated_complexity,
      });
    } else {
      stillDeferred.push(dp);
    }
  }
  s.deferred_proposals = stillDeferred;

  // Step 1: Schema validation
  const valid: ValidatedProposal[] = [];
  for (const raw of rawProposals) {
    const missing = validateProposalSchema(raw);
    if (missing) {
      rejected.push({ proposal: raw, reason: `Missing fields: ${missing}` });
      continue;
    }
    valid.push(normalizeProposal(raw));
  }

  // Step 2a: Reject fundamentally flawed proposals (confidence=0 from adversarial review)
  const afterConfidence = valid.filter(p => {
    if (p.confidence <= 0) {
      rejected.push({ proposal: p, reason: 'Rejected by adversarial review (confidence=0)' });
      return false;
    }
    return true;
  });

  // Step 2b: Impact score filter
  const minImpact = s.min_impact_score ?? PROPOSALS_DEFAULTS.DEFAULT_MIN_IMPACT;
  const afterImpact = afterConfidence.filter(p => {
    const impact = p.impact_score ?? PROPOSALS_DEFAULTS.DEFAULT_IMPACT;
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
  const sessionScope = s.scope || '';
  const isCatchAll = !sessionScope || sessionScope === '**' || sessionScope === '*';
  const afterScope = isCatchAll
    ? afterCategory
    : afterCategory.filter(p => {
        const files = p.files.length > 0 ? p.files : p.allowed_paths;
        const allInScope = files.length === 0 || files.every(f =>
          minimatch(f, sessionScope, { dot: true })
        );
        if (!allInScope) {
          s.deferred_proposals.push({
            category: p.category,
            title: p.title,
            description: p.description,
            files: p.files,
            allowed_paths: p.allowed_paths,
            confidence: p.confidence,
            impact_score: p.impact_score,
            original_scope: s.scope,
            verification_commands: p.verification_commands,
            acceptance_criteria: p.acceptance_criteria,
            risk: p.risk,
            touched_files_estimate: p.touched_files_estimate,
            rollback_note: p.rollback_note,
            rationale: p.rationale,
            estimated_complexity: p.estimated_complexity,
          });
          rejected.push({ proposal: p, reason: `Deferred (files outside scope '${s.scope}'): ${files.filter(f => !minimatch(f, sessionScope, { dot: true })).join(', ')}` });
          return false;
        }
        return true;
      });

  // Cap deferred proposals to prevent unbounded growth
  if (s.deferred_proposals.length > PROPOSALS_DEFAULTS.MAX_DEFERRED) {
    s.deferred_proposals.sort((a, b) => b.confidence - a.confidence);
    s.deferred_proposals = s.deferred_proposals.slice(0, PROPOSALS_DEFAULTS.MAX_DEFERRED);
  }

  // Step 4: Dedup against existing tickets (title similarity via bigrams)
  const existingTickets = await repos.tickets.listByProject(db, s.project_id, {
    status: ['ready', 'in_progress'],
  });
  const existingTitles = existingTickets.map(t => t.title);
  const afterDedup = afterScope.filter(p => {
    const isDupe = existingTitles.some(t => bigramSimilarity(t, p.title) >= PROPOSALS_DEFAULTS.DEDUP_THRESHOLD);
    if (isDupe) {
      rejected.push({ proposal: p, reason: `Duplicate of existing ticket (title similarity >= ${PROPOSALS_DEFAULTS.DEDUP_THRESHOLD})` });
      return false;
    }
    return true;
  });

  // Also dedup within the batch
  const uniqueByTitle: ValidatedProposal[] = [];
  for (const p of afterDedup) {
    const isDupeInBatch = uniqueByTitle.some(q => bigramSimilarity(q.title, p.title) >= PROPOSALS_DEFAULTS.DEDUP_THRESHOLD);
    if (isDupeInBatch) {
      rejected.push({ proposal: p, reason: `Duplicate within batch (title similarity >= ${PROPOSALS_DEFAULTS.DEDUP_THRESHOLD})` });
      continue;
    }
    uniqueByTitle.push(p);
  }

  // Step 5: Score, rank, and cap
  const ranked = scoreAndRank(uniqueByTitle, s.max_proposals_per_scout);

  // Step 5b: Balance test vs non-test proposals
  const accepted = balanceProposals(ranked, PROPOSALS_DEFAULTS.MAX_TEST_RATIO);

  // Step 6: Create tickets
  const ticketInputs = accepted.map(p => ({
    projectId: s.project_id,
    title: p.title,
    description: formatProposalDescription(p),
    status: 'ready' as const,
    priority: computePriority(p.impact_score ?? PROPOSALS_DEFAULTS.DEFAULT_IMPACT, p.confidence),
    category: p.category as TicketCategory,
    allowedPaths: p.allowed_paths,
    verificationCommands: p.verification_commands,
    metadata: {
      scoutConfidence: p.confidence,
      estimatedComplexity: p.estimated_complexity,
    },
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
