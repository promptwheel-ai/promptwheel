/**
 * Proposal filtering pipeline for auto mode.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import chalk from 'chalk';
import { minimatch } from 'minimatch';
import type { TicketProposal } from '@promptwheel/core/scout';
import { SCOUT_DEFAULTS } from '@promptwheel/core';
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
// balanceProposals removed — let quality determine proposal mix organically
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
  const { block: blockCategories } = state.getCycleCategories(cycleFormula);

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
            state.displayAdapter.log(chalk.gray(`  Review: ${adjustedCount} adjusted, ${rejectedCount} rejected`));
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
        state.displayAdapter.log(chalk.yellow(`  ⚠ Adversarial review failed, using original scores`));
      }
    }
  }

  // Baseline-healing confidence boost: nudge proposals that target failing QA commands
  const baselineFailingKeywords: Set<string> = new Set();
  try {
    const blPath = path.join(state.repoRoot, '.promptwheel', 'qa-baseline.json');
    if (fs.existsSync(blPath)) {
      const blData = JSON.parse(fs.readFileSync(blPath, 'utf8'));
      for (const name of (blData.failures ?? [])) {
        // Tokenize: "typecheck (type-check)" → ["typecheck", "type", "check"]
        for (const token of name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/)) {
          if (token.length > 2) baselineFailingKeywords.add(token);
        }
      }
    }
  } catch { /* non-fatal */ }

  if (baselineFailingKeywords.size > 0) {
    for (const p of proposals) {
      const text = `${p.title} ${p.category} ${p.description ?? ''} ${(p.verification_commands ?? []).join(' ')}`.toLowerCase();
      const matches = [...baselineFailingKeywords].some(kw => text.includes(kw));
      if (matches) {
        p.confidence = Math.min(100, (p.confidence || 50) + 10);
      }
    }
  }

  // Re-inject deferred proposals
  const deferred = popDeferredForScope(state.repoRoot, scope);
  if (deferred.length > 0) {
    state.displayAdapter.log(chalk.cyan(`  ♻ ${deferred.length} deferred proposal(s) now in scope`));
    for (const dp of deferred) {
      proposals.push({
        id: `deferred-${Date.now()}`,
        category: dp.category as import('@promptwheel/core/scout').ProposalCategory,
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
    state.displayAdapter.log(chalk.gray(`  Proposals found:`));
    for (const p of proposals) {
      const conf = p.confidence || 50;
      const impact = p.impact_score ?? '?';
      const cat = p.category || 'refactor';
      state.displayAdapter.log(chalk.gray(`    ${cat} | ${conf}% conf | impact ${impact} | ${p.title}`));
    }
  }

  // Category filter — only block explicitly blocked categories
  let rejectedByCategory = 0;
  let rejectedByScope = 0;
  const categoryFiltered = proposals.filter((p) => {
    const category = (p.category || 'refactor').toLowerCase();
    if (blockCategories.length > 0 && blockCategories.some(blocked => category.includes(blocked))) {
      rejectedByCategory++;
      state.displayAdapter.log(chalk.gray(`  ✗ Blocked category (${category}): ${p.title}`));
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
          state.displayAdapter.log(chalk.gray(`  ✗ Out of scope (${scope}): ${p.title}${outOfScopeFiles.length > 0 ? ` [${outOfScopeFiles.join(', ')}]` : ''}`));
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
  };

  // Dedup filter
  let dedupContext: { existingTitles: string[]; openPrBranches: string[] };
  try {
    dedupContext = await getDeduplicationContext(state.adapter, state.project.id, state.repoRoot);
  } catch (err) {
    state.displayAdapter.log(chalk.yellow(`  ⚠ Dedup context failed: ${err instanceof Error ? err.message : err}`));
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
      state.displayAdapter.log(chalk.gray(`  ✗ Duplicate: ${p.title}`));
      if (state.options.verbose) {
        state.displayAdapter.log(chalk.gray(`    Reason: ${dupCheck.reason}`));
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

  // Always-on compact pipeline summary
  const { found, cat, scope: sc, dedup: dd } = pipelineCounts;
  state.displayAdapter.log(chalk.gray(`  Filter: ${found} → cat:${cat} → scope:${sc} → dedup:${dd}`));

  if (approvedProposals.length === 0) {
    const parts: string[] = [];
    if (rejectedByCategory > 0) parts.push(`${rejectedByCategory} blocked by category`);
    if (rejectedByScope > 0) parts.push(`${rejectedByScope} out of scope`);
    if (duplicateCount > 0) parts.push(`${duplicateCount} duplicates`);
    const reason = parts.length > 0
      ? `No proposals approved (${parts.join(', ')})`
      : 'No proposals passed filters';
    state.displayAdapter.log(chalk.gray(`  ${reason}`));
    state.scoutedDirs.push(scope);
    // CLI gets more retries than MCP plugin since it's a longer-running standalone process
    const maxRetries = SCOUT_DEFAULTS.MAX_SCOUT_RETRIES + 2;
    if (state.scoutRetries < maxRetries) {
      state.scoutRetries++;
      state.displayAdapter.log(chalk.gray(`  Retrying with fresh approach (attempt ${state.scoutRetries}/${maxRetries + 1})...`));
      await sleep(1000);
      return { toProcess: [], scope, shouldRetry: true, shouldBreak: false, categoryRejected: rejectedByCategory };
    }
    state.scoutRetries = 0;
    state.scoutedDirs = [];
    if (state.runMode === 'wheel') {
      await sleep(2000);
    }
    // Let shouldContinue() decide whether to loop or stop
    return { toProcess: [], scope, shouldRetry: true, shouldBreak: false, categoryRejected: rejectedByCategory };
  }

  // Batch selection
  const prsRemaining = state.milestoneMode
    ? (state.batchSize! - state.milestoneTicketCount + (state.maxPrs - state.totalMilestonePrs - 1) * state.batchSize!)
    : (state.maxPrs - state.totalPrsCreated);
  const defaultBatch = state.milestoneMode ? 10 : (state.runMode === 'wheel' ? 5 : 3);
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
  state.displayAdapter.log(chalk.gray(`  ${statsMsg}`));
  state.displayAdapter.log('');

  // Reset retry state
  state.scoutRetries = 0;
  state.scoutedDirs = [];

  // Display batch
  if (state.runMode !== 'wheel' || state.cycleCount === 1) {
    state.displayAdapter.log(chalk.bold('Will process:'));
    for (const p of toProcess) {
      const confidenceStr = p.confidence ? `${p.confidence}%` : '?';
      const complexity = p.estimated_complexity || 'simple';
      state.displayAdapter.log(chalk.cyan(`  • ${p.title}`));
      state.displayAdapter.log(chalk.gray(`    ${p.category || 'refactor'} | ${complexity} | ${confidenceStr}`));
    }
    state.displayAdapter.log('');
  }

  return { toProcess, scope, shouldRetry: false, shouldBreak: false, categoryRejected: rejectedByCategory };
}
