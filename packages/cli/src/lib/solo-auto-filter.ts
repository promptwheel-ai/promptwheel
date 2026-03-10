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
import { deferProposal, popDeferredForScope, readRunState } from './run-state.js';
import { addLearning, extractTags } from './learnings.js';
import {
  isDuplicateProposal, getDeduplicationContext,
} from './dedup.js';
import {
  recordDedupEntries, getEnabledProposals,
  loadDedupMemory,
} from './dedup-memory.js';
import { matchAgainstMemory } from '@promptwheel/core/dedup/shared';
// balanceProposals removed — let quality determine proposal mix organically
import { sleep } from './dedup.js';

export interface FilterResult {
  toProcess: TicketProposal[];
  scope: string;
  shouldRetry: boolean;
  shouldBreak: boolean;
  categoryRejected: number;
  /** Titles hard-rejected because they repeatedly failed execution (hit_count >= 3) */
  hardDedupRejectedTitles: string[];
}

export async function filterProposals(
  state: AutoSessionState,
  proposals: TicketProposal[],
  scope: string,
): Promise<FilterResult> {
  const { block: blockCategories } = state.getCycleCategories(null);

  // Adversarial proposal review
  if (state.autoConf.adversarialReview && proposals.length > 0) {
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
          if (state.options.verbose && (adjustedCount > 0 || rejectedCount > 0)) {
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

  // Re-inject deferred proposals (pass cycle count for cycle-based promotion)
  const deferred = popDeferredForScope(state.repoRoot, scope, state.cycleCount);
  if (deferred.length > 0) {
    if (state.options.verbose) state.displayAdapter.log(chalk.cyan(`  ♻ ${deferred.length} deferred proposal(s) now in scope`));
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
  if (state.options.verbose && proposals.length > 0) {
    state.displayAdapter.log(chalk.gray(`  Proposals found:`));
    for (const p of proposals) {
      const conf = p.confidence || 50;
      const impact = p.impact_score ?? '?';
      const cat = p.category || 'refactor';
      state.displayAdapter.log(chalk.gray(`    ${cat} | ${conf}% conf | impact ${impact} | ${p.title}`));
    }
  }

  // Impact floor filter — reject proposals below min_impact_score
  const minImpact = state.autoConf.minImpactScore ?? SCOUT_DEFAULTS.MIN_IMPACT_SCORE;
  let rejectedByImpact = 0;
  const impactFiltered = proposals.filter((p) => {
    const impact = p.impact_score ?? 5;
    if (impact < minImpact) {
      rejectedByImpact++;
      if (state.options.verbose) state.displayAdapter.log(chalk.gray(`  ✗ Low impact (${impact}/${minImpact}): ${p.title}`));
      return false;
    }
    return true;
  });

  // Category filter — only block explicitly blocked categories
  let rejectedByCategory = 0;
  let rejectedByScope = 0;
  const categoryFiltered = impactFiltered.filter((p) => {
    const category = (p.category || 'refactor').toLowerCase();
    if (blockCategories.length > 0 && blockCategories.some(blocked => category === blocked)) {
      rejectedByCategory++;
      if (state.options.verbose) state.displayAdapter.log(chalk.gray(`  ✗ Blocked category (${category}): ${p.title}`));
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
            deferredAtCycle: state.cycleCount,
          });
          const outOfScopeFiles = files.filter((f: string) => !minimatch(f, scope, { dot: true }));
          if (state.options.verbose) state.displayAdapter.log(chalk.yellow(`  ↻ Deferred (outside ${scope}): ${p.title}${outOfScopeFiles.length > 0 ? ` [${outOfScopeFiles.join(', ')}]` : ''}`));
          return false;
        }
        return true;
      });

  // Track pipeline counts for always-on summary
  const pipelineCounts = {
    found: proposals.length,
    impact: impactFiltered.length,
    cat: categoryFiltered.length,
    scope: scopeFiltered.length,
    dedup: 0,  // filled after dedup
  };

  // Dedup filter
  let dedupContext: { existingTitles: string[]; openPrBranches: string[] };
  try {
    dedupContext = await getDeduplicationContext(state.adapter, state.project.id, state.repoRoot);
  } catch (err) {
    if (state.options.verbose) state.displayAdapter.log(chalk.yellow(`  ⚠ Dedup context failed: ${err instanceof Error ? err.message : err}`));
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
      if (state.options.verbose) state.displayAdapter.log(chalk.gray(`  ✗ Duplicate: ${p.title}`));
      if (state.options.verbose) {
        state.displayAdapter.log(chalk.gray(`    Reason: ${dupCheck.reason}`));
      }
    } else {
      approvedProposals.push(p);
    }
  }

  // Hard dedup gate — reject proposals that match repeatedly-failed dedup memory entries.
  // Unlike the soft prompt injection ("Do NOT propose these"), this is an absolute filter.
  // Exception: entries whose blocking dependency modules have since completed are retried.
  const HARD_DEDUP_HIT_THRESHOLD = 3;
  const hardDedupRejected: string[] = [];
  if (state.dedupMemory.length > 0) {
    const failedMemory = state.dedupMemory.filter(
      e => !e.completed && e.failureReason && e.hit_count >= HARD_DEDUP_HIT_THRESHOLD,
    );
    if (failedMemory.length > 0) {
      for (let i = approvedProposals.length - 1; i >= 0; i--) {
        const match = matchAgainstMemory(approvedProposals[i].title, failedMemory);
        if (match) {
          hardDedupRejected.push(approvedProposals[i].title);
          if (state.options.verbose) {
            state.displayAdapter.log(chalk.gray(`  ✗ Hard dedup: ${approvedProposals[i].title} (failed ${match.entry.hit_count}x)`));
          }
          approvedProposals.splice(i, 1);
        }
      }
    }
  }

  // File overlap dedup — catch same issue surfacing under different lenses
  const FILE_OVERLAP_THRESHOLD = 0.5; // >50% file overlap with non-completed entry = likely same issue
  if (state.dedupMemory.length > 0) {
    for (let i = approvedProposals.length - 1; i >= 0; i--) {
      const pFiles = new Set((approvedProposals[i].files ?? approvedProposals[i].allowed_paths ?? []).filter((f: string) => !f.includes('*')));
      if (pFiles.size === 0) continue;
      for (const mem of state.dedupMemory) {
        if (!mem.files?.length || mem.completed) continue;
        const overlap = mem.files.filter(f => pFiles.has(f)).length;
        const overlapRatio = overlap / Math.min(pFiles.size, mem.files.length);
        if (overlapRatio >= FILE_OVERLAP_THRESHOLD) {
          rejectedDupTitles.push(approvedProposals[i].title);
          if (state.options.verbose) {
            state.displayAdapter.log(chalk.gray(`  ✗ File overlap dedup: ${approvedProposals[i].title} (${Math.round(overlapRatio * 100)}% overlap with "${mem.title}")`));
          }
          approvedProposals.splice(i, 1);
          break;
        }
      }
    }
  }

  pipelineCounts.dedup = approvedProposals.length;

  // Per-category confidence adjustment — penalize low-success-rate categories
  const { categoryStats } = readRunState(state.repoRoot);
  if (categoryStats) {
    for (const p of approvedProposals) {
      const cat = (p.category || 'refactor').toLowerCase();
      const catStats = categoryStats[cat];
      if (catStats && catStats.confidenceAdjustment !== 0 && catStats.proposals >= 10) {
        const original = p.confidence || 50;
        p.confidence = Math.max(0, Math.min(100, original + catStats.confidenceAdjustment));
        if (state.options.verbose && catStats.confidenceAdjustment < 0) {
          state.displayAdapter.log(
            chalk.gray(`  ↓ Category penalty (${cat} @ ${Math.round(catStats.successRate * 100)}%): ${p.title} ${original}→${p.confidence}`)
          );
        }
      }
    }
  }

  // Bump dedup memory for rejected duplicates (including hard dedup rejects)
  const allRejected = [...rejectedDupTitles, ...hardDedupRejected];
  if (allRejected.length > 0) {
    await recordDedupEntries(state.repoRoot, allRejected.map(t => ({ title: t, completed: false })));
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

  // Compact pipeline summary (verbose only)
  if (state.options.verbose) {
    const { found, impact: imp, cat, scope: sc, dedup: dd } = pipelineCounts;
    state.displayAdapter.log(chalk.gray(`  Filter: ${found} → impact:${imp} → cat:${cat} → scope:${sc} → dedup:${dd}`));
  }

  if (approvedProposals.length === 0) {
    const parts: string[] = [];
    if (rejectedByImpact > 0) parts.push(`${rejectedByImpact} below impact floor`);
    if (rejectedByCategory > 0) parts.push(`${rejectedByCategory} blocked by category`);
    if (rejectedByScope > 0) parts.push(`${rejectedByScope} out of scope`);
    if (duplicateCount > 0) parts.push(`${duplicateCount} duplicates`);
    if (hardDedupRejected.length > 0) parts.push(`${hardDedupRejected.length} hard-deduped (repeatedly failed)`);
    const reason = parts.length > 0
      ? `No proposals approved (${parts.join(', ')})`
      : 'No proposals passed filters';
    if (state.options.verbose) state.displayAdapter.log(chalk.gray(`  ${reason}`));
    state.scoutedDirs.push(scope);
    // CLI gets more retries than MCP plugin since it's a longer-running standalone process
    const maxRetries = SCOUT_DEFAULTS.MAX_SCOUT_RETRIES + 2;
    if (state.scoutRetries < maxRetries) {
      state.scoutRetries++;
      if (state.options.verbose) state.displayAdapter.log(chalk.gray(`  Retrying with fresh approach (attempt ${state.scoutRetries}/${maxRetries + 1})...`));
      await sleep(1000);
      return { toProcess: [], scope, shouldRetry: true, shouldBreak: false, categoryRejected: rejectedByCategory, hardDedupRejectedTitles: hardDedupRejected };
    }
    state.scoutRetries = 0;
    state.scoutedDirs = [];
    if (state.runMode === 'spin') {
      await sleep(2000);
    }
    // Let shouldContinue() decide whether to loop or stop
    return { toProcess: [], scope, shouldRetry: true, shouldBreak: false, categoryRejected: rejectedByCategory, hardDedupRejectedTitles: hardDedupRejected };
  }

  // Batch selection
  const prsRemaining = state.milestoneMode
    ? (state.batchSize! - state.milestoneTicketCount + (state.maxPrs - state.totalMilestonePrs - 1) * state.batchSize!)
    : (state.maxPrs - state.totalPrsCreated);
  const defaultBatch = state.milestoneMode ? 10 : (state.runMode === 'spin' ? 5 : 3);
  const toProcess = approvedProposals.slice(0, Math.min(prsRemaining, defaultBatch));

  const totalSkipped = duplicateCount + hardDedupRejected.length;
  const statsMsg = totalSkipped > 0
    ? `Auto-approved: ${approvedProposals.length} (${totalSkipped} dedup-skipped${hardDedupRejected.length > 0 ? `, ${hardDedupRejected.length} hard-blocked` : ''}), processing: ${toProcess.length}`
    : `Auto-approved: ${approvedProposals.length}, processing: ${toProcess.length}`;
  state.displayAdapter.log(chalk.gray(`  ${statsMsg}`));
  state.displayAdapter.log('');

  // Reset retry state
  state.scoutRetries = 0;
  state.scoutedDirs = [];

  // Display batch
  if (state.runMode !== 'spin' || state.cycleCount === 1) {
    state.displayAdapter.log(chalk.bold('Will process:'));
    for (const p of toProcess) {
      const confidenceStr = p.confidence ? `${p.confidence}%` : '?';
      const complexity = p.estimated_complexity || 'simple';
      state.displayAdapter.log(chalk.cyan(`  • ${p.title}`));
      state.displayAdapter.log(chalk.gray(`    ${p.category || 'refactor'} | ${complexity} | ${confidenceStr}`));
    }
    state.displayAdapter.log('');
  }

  return { toProcess, scope, shouldRetry: false, shouldBreak: false, categoryRejected: rejectedByCategory, hardDedupRejectedTitles: hardDedupRejected };
}
