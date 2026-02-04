/**
 * Proposal filtering pipeline for auto mode.
 */

import chalk from 'chalk';
import { minimatch } from 'minimatch';
import type { TicketProposal } from '@blockspool/core/scout';
import type { AutoSessionState } from './solo-auto-state.js';
import { runClaude, type ExecutionBackend } from './execution-backends/index.js';
import {
  buildProposalReviewPrompt, parseReviewedProposals, applyReviewToProposals,
} from './proposal-review.js';
import { deferProposal, popDeferredForScope, recordFormulaResult } from './run-state.js';
import { addLearning, extractTags } from './learnings.js';
import {
  isDuplicateProposal, getDeduplicationContext,
} from './dedup.js';
import {
  recordDedupEntries, getEnabledProposals,
  loadDedupMemory,
} from './dedup-memory.js';
import { balanceProposals } from './solo-proposal-pipeline.js';
import {
  getSectorCategoryAffinity, updateProposalYield,
} from './sectors.js';
import { getCooledFiles, computeCooldownOverlap } from './file-cooldown.js';
import { sleep } from './dedup.js';

export interface FilterResult {
  toProcess: TicketProposal[];
  scope: string;
  shouldRetry: boolean;
  shouldBreak: boolean;
  categoryRejected: number;
}

export async function filterProposals(
  state: AutoSessionState,
  proposals: TicketProposal[],
  scope: string,
  cycleFormula: import('./formulas.js').Formula | null,
): Promise<FilterResult> {
  const { allow: allowCategories, block: blockCategories } = state.getCycleCategories(cycleFormula);

  // Adversarial proposal review
  if (state.autoConf.adversarialReview && !state.options.eco && proposals.length > 0) {
    try {
      const reviewPrompt = buildProposalReviewPrompt(proposals);
      const reviewBackend = state.executionBackend ?? {
        name: 'claude-review',
        run: (opts: Parameters<ExecutionBackend['run']>[0]) => runClaude(opts),
      };
      const reviewResult = await reviewBackend.run({
        worktreePath: (state.milestoneMode && state.milestoneWorktreePath) ? state.milestoneWorktreePath : state.repoRoot,
        prompt: reviewPrompt,
        timeoutMs: 120000,
        verbose: false,
        onProgress: () => {},
      });

      if (reviewResult.success) {
        const reviewed = parseReviewedProposals(reviewResult.stdout);
        if (reviewed) {
          const before = proposals.map(p => p.confidence);
          const revised = applyReviewToProposals(proposals, reviewed);
          proposals.length = 0;
          proposals.push(...revised);

          const adjustedCount = reviewed.filter((r, i) => {
            const orig = before[i];
            return orig !== undefined && r.confidence !== orig;
          }).length;
          const rejectedCount = reviewed.filter(r => r.confidence === 0).length;
          if (adjustedCount > 0 || rejectedCount > 0) {
            console.log(chalk.gray(`  Review: ${adjustedCount} adjusted, ${rejectedCount} rejected`));
          }

          if (state.autoConf.learningsEnabled && reviewed) {
            for (let ri = 0; ri < reviewed.length; ri++) {
              const origConf = before[ri];
              if (origConf !== undefined && typeof reviewed[ri].confidence === 'number') {
                const drop = origConf - reviewed[ri].confidence;
                if (drop > 20) {
                  addLearning(state.repoRoot, {
                    text: `Proposal "${reviewed[ri].title}" had inflated confidence (${origConf}→${reviewed[ri].confidence})`.slice(0, 200),
                    category: 'warning',
                    source: { type: 'review_downgrade' as any, detail: reviewed[ri].review_note },
                    tags: extractTags(proposals[ri]?.files ?? proposals[ri]?.allowed_paths ?? [], []),
                  });
                }
              }
            }
          }
        }
      }
    } catch {
      if (state.options.verbose) {
        console.log(chalk.yellow(`  ⚠ Adversarial review failed, using original scores`));
      }
    }
  }

  // Re-inject deferred proposals
  const deferred = popDeferredForScope(state.repoRoot, scope);
  if (deferred.length > 0) {
    console.log(chalk.cyan(`  ♻ ${deferred.length} deferred proposal(s) now in scope`));
    for (const dp of deferred) {
      proposals.push({
        id: `deferred-${Date.now()}`,
        category: dp.category as import('@blockspool/core/scout').ProposalCategory,
        title: dp.title,
        description: dp.description,
        files: dp.files,
        allowed_paths: dp.allowed_paths,
        confidence: dp.confidence,
        impact_score: dp.impact_score,
        acceptance_criteria: [],
        verification_commands: ['npm run build'],
        rationale: `(deferred from scope ${dp.original_scope})`,
        estimated_complexity: 'simple' as const,
      });
    }
  }

  // Show all proposals before filtering
  if (proposals.length > 0) {
    console.log(chalk.gray(`  Proposals found:`));
    for (const p of proposals) {
      const conf = p.confidence || 50;
      const impact = p.impact_score ?? '?';
      const cat = p.category || 'refactor';
      console.log(chalk.gray(`    ${cat} | ${conf}% conf | impact ${impact} | ${p.title}`));
    }
  }

  // Category filter
  // Test proposals are soft-allowed: not in the focus list but not hard-blocked.
  // balanceProposals() organically caps test ratio (default 40%).
  // --tests flag adds test to the focus list for active test seeking.
  let rejectedByCategory = 0;
  let rejectedByScope = 0;
  const categoryFiltered = proposals.filter((p) => {
    const category = (p.category || 'refactor').toLowerCase();
    if (blockCategories.some(blocked => category.includes(blocked))) {
      rejectedByCategory++;
      console.log(chalk.gray(`  ✗ Blocked category (${category}): ${p.title}`));
      return false;
    }
    if (!allowCategories.some(allowed => category.includes(allowed))) {
      // Soft-allow test: not in focus list but not hard-blocked
      if (category === 'test') return true;
      rejectedByCategory++;
      console.log(chalk.gray(`  ✗ Category not allowed (${category}): ${p.title}`));
      return false;
    }
    return true;
  });

  // Scope filter — use minimatch for proper glob matching (handles patterns like 'packages/*/src/**')
  const isCatchAll = !scope || scope === '**' || scope === '*';
  const scopeFiltered = isCatchAll
    ? categoryFiltered
    : categoryFiltered.filter(p => {
        const files = (p.files?.length ? p.files : p.allowed_paths) || [];
        const allInScope = files.length === 0 || files.every((f: string) =>
          minimatch(f, scope, { dot: true })
        );
        if (!allInScope) {
          rejectedByScope++;
          deferProposal(state.repoRoot, {
            category: p.category,
            title: p.title,
            description: p.description,
            files: p.files || [],
            allowed_paths: p.allowed_paths || [],
            confidence: p.confidence || 50,
            impact_score: p.impact_score ?? 5,
            original_scope: scope,
            deferredAt: Date.now(),
          });
          const outOfScopeFiles = files.filter((f: string) => !minimatch(f, scope, { dot: true }));
          console.log(chalk.gray(`  ✗ Out of scope (${scope}): ${p.title}${outOfScopeFiles.length > 0 ? ` [${outOfScopeFiles.join(', ')}]` : ''}`));
          return false;
        }
        return true;
      });

  // Track pipeline counts for always-on summary
  const pipelineCounts = {
    found: proposals.length,
    cat: categoryFiltered.length,
    scope: scopeFiltered.length,
    dedup: 0,  // filled after dedup
    impact: 0, // filled after impact
    balance: 0, // filled after balance
  };

  // Dedup filter
  let dedupContext: { existingTitles: string[]; openPrBranches: string[] };
  try {
    dedupContext = await getDeduplicationContext(state.adapter, state.project.id, state.repoRoot);
  } catch (err) {
    console.log(chalk.yellow(`  ⚠ Dedup context failed: ${err instanceof Error ? err.message : err}`));
    dedupContext = { existingTitles: [], openPrBranches: [] };
  }
  const approvedProposals: typeof scopeFiltered = [];
  let duplicateCount = 0;
  const rejectedDupTitles: string[] = [];
  for (const p of scopeFiltered) {
    const dupCheck = await isDuplicateProposal(
      p,
      dedupContext.existingTitles,
      dedupContext.openPrBranches
    );
    if (dupCheck.isDuplicate) {
      duplicateCount++;
      rejectedDupTitles.push(p.title);
      console.log(chalk.gray(`  ✗ Duplicate: ${p.title}`));
      if (state.options.verbose) {
        console.log(chalk.gray(`    Reason: ${dupCheck.reason}`));
      }
    } else {
      approvedProposals.push(p);
    }
  }

  pipelineCounts.dedup = approvedProposals.length;

  // Bump dedup memory for rejected duplicates
  if (rejectedDupTitles.length > 0) {
    recordDedupEntries(state.repoRoot, rejectedDupTitles.map(t => ({ title: t, completed: false })));
    state.dedupMemory = loadDedupMemory(state.repoRoot);
  }

  // Impact floor filter (static — no dynamic escalation)
  const impactFloor = state.autoConf.minImpactScore ?? 3;
  let rejectedByImpact = 0;
  const impactFiltered = approvedProposals.filter(p => {
    const impact = p.impact_score ?? 5;
    if (impact < impactFloor) {
      rejectedByImpact++;
      console.log(chalk.gray(`  ✗ Below impact floor (${impact} < ${impactFloor}): ${p.title}`));
      return false;
    }
    return true;
  });
  approvedProposals.length = 0;
  approvedProposals.push(...impactFiltered);

  pipelineCounts.impact = approvedProposals.length;

  // Dependency enablement boost
  const enabledTitles = getEnabledProposals(state.repoRoot);
  if (enabledTitles.length > 0) {
    const enabledSet = new Set(enabledTitles.map(t => t.toLowerCase().trim()));
    approvedProposals.sort((a, b) => {
      const aEnabled = enabledSet.has(a.title.toLowerCase().trim()) ? 0 : 1;
      const bEnabled = enabledSet.has(b.title.toLowerCase().trim()) ? 0 : 1;
      return aEnabled - bEnabled;
    });
  }

  // Category×Sector affinity
  if (state.sectorState && state.currentSectorId) {
    const sec = state.sectorState.sectors.find(s => s.path === state.currentSectorId);
    if (sec) {
      const { boost, suppress } = getSectorCategoryAffinity(sec);
      if (boost.length > 0 || suppress.length > 0) {
        const boostSet = new Set(boost);
        const suppressSet = new Set(suppress);
        approvedProposals.sort((a, b) => {
          const aBoost = boostSet.has(a.category) ? 0 : suppressSet.has(a.category) ? 2 : 1;
          const bBoost = boostSet.has(b.category) ? 0 : suppressSet.has(b.category) ? 2 : 1;
          return aBoost - bBoost;
        });
        for (const p of approvedProposals) {
          if (suppressSet.has(p.category)) {
            (p as any)._affinityConfidenceBoost = 15;
          }
        }
      }
    }
  }

  // Test balance
  const maxTestRatio = state.autoConf.maxTestRatio ?? 0.4;
  const preBalanceCount = approvedProposals.length;
  const balanced = balanceProposals(approvedProposals, maxTestRatio);
  approvedProposals.length = 0;
  approvedProposals.push(...balanced);

  if (balanced.length === 0 && preBalanceCount > 0) {
    console.log(chalk.yellow(`  ⚠ Balance returned 0 from ${preBalanceCount} proposals (maxTestRatio: ${maxTestRatio}) — this is unexpected`));
  }

  pipelineCounts.balance = approvedProposals.length;

  // Always-on compact pipeline summary
  const { found, cat, scope: sc, dedup: dd, impact: imp, balance: bal } = pipelineCounts;
  console.log(chalk.gray(`  Filter: ${found} → cat:${cat} → scope:${sc} → dedup:${dd} → impact:${imp} → balance:${bal}`));

  if (approvedProposals.length === 0) {
    const parts: string[] = [];
    if (rejectedByCategory > 0) parts.push(`${rejectedByCategory} blocked by category`);
    if (rejectedByScope > 0) parts.push(`${rejectedByScope} out of scope`);
    if (duplicateCount > 0) parts.push(`${duplicateCount} duplicates`);
    if (rejectedByImpact > 0) parts.push(`${rejectedByImpact} below impact floor`);
    const balanceDropped = preBalanceCount - balanced.length;
    if (balanceDropped > 0) parts.push(`${balanceDropped} dropped by balance`);
    const reason = parts.length > 0
      ? `No proposals approved (${parts.join(', ')})`
      : 'No proposals passed filters';
    console.log(chalk.gray(`  ${reason}`));
    state.scoutedDirs.push(scope);
    const MAX_SCOUT_RETRIES = 2;
    if (state.scoutRetries < MAX_SCOUT_RETRIES) {
      state.scoutRetries++;
      console.log(chalk.gray(`  Retrying with fresh approach (attempt ${state.scoutRetries}/${MAX_SCOUT_RETRIES + 1})...`));
      await sleep(1000);
      return { toProcess: [], scope, shouldRetry: true, shouldBreak: false, categoryRejected: rejectedByCategory };
    }
    state.scoutRetries = 0;
    state.scoutedDirs = [];
    if (state.isContinuous) {
      await sleep(2000);
    }
    // Let shouldContinue() decide whether to loop or stop
    return { toProcess: [], scope, shouldRetry: true, shouldBreak: false, categoryRejected: rejectedByCategory };
  }

  // Batch selection
  const prsRemaining = state.milestoneMode
    ? (state.batchSize! - state.milestoneTicketCount + (state.maxPrs - state.totalMilestonePrs - 1) * state.batchSize!)
    : (state.maxPrs - state.totalPrsCreated);
  const defaultBatch = state.milestoneMode ? 10 : (state.isContinuous ? 5 : 3);
  const cooledFiles = getCooledFiles(state.repoRoot);
  if (cooledFiles.size > 0) {
    approvedProposals.sort((a, b) => {
      const overlapA = computeCooldownOverlap(a.files ?? a.allowed_paths ?? [], cooledFiles);
      const overlapB = computeCooldownOverlap(b.files ?? b.allowed_paths ?? [], cooledFiles);
      return overlapA - overlapB;
    });
  }
  const toProcess = approvedProposals.slice(0, Math.min(prsRemaining, defaultBatch));

  // Update yield tracking
  recordFormulaResult(state.repoRoot, state.currentFormulaName, approvedProposals.length);
  if (state.sectorState && state.currentSectorId) updateProposalYield(state.sectorState, state.currentSectorId, approvedProposals.length);

  const statsMsg = duplicateCount > 0
    ? `Auto-approved: ${approvedProposals.length} (${duplicateCount} duplicates skipped), processing: ${toProcess.length}`
    : `Auto-approved: ${approvedProposals.length}, processing: ${toProcess.length}`;
  console.log(chalk.gray(`  ${statsMsg}`));
  console.log();

  // Reset retry state
  state.scoutRetries = 0;
  state.scoutedDirs = [];

  // Display batch
  if (!state.isContinuous || state.cycleCount === 1) {
    console.log(chalk.bold('Will process:'));
    for (const p of toProcess) {
      const confidenceStr = p.confidence ? `${p.confidence}%` : '?';
      const complexity = p.estimated_complexity || 'simple';
      console.log(chalk.cyan(`  • ${p.title}`));
      console.log(chalk.gray(`    ${p.category || 'refactor'} | ${complexity} | ${confidenceStr}`));
    }
    console.log();
  }

  return { toProcess, scope, shouldRetry: false, shouldBreak: false, categoryRejected: rejectedByCategory };
}
