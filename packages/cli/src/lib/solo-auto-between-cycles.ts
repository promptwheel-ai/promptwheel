/**
 * Pre-cycle and post-cycle maintenance for auto mode.
 */

import chalk from 'chalk';
import { spawnSync } from 'node:child_process';
import type { AutoSessionState } from './solo-auto-state.js';
import { readRunState, writeRunState, recordCycle, isDocsAuditDue, recordDocsAudit, pushRecentDiff, recordQualitySignal, getQualityRate } from './run-state.js';
import { getSessionPhase, formatElapsed } from './solo-auto-utils.js';
import {
  checkPrStatuses,
  fetchPrReviewComments,
} from './solo-git.js';
import { loadGuidelines } from './guidelines.js';
import { addLearning, loadLearnings, consolidateLearnings } from './learnings.js';
import { removePrEntries } from './file-cooldown.js';
import { recordFormulaMergeOutcome } from './run-state.js';
import {
  recordMergeOutcome, saveSectors, refreshSectors,
  computeCoverage, suggestScopeAdjustment, getSectorCategoryAffinity,
} from './sectors.js';
import { loadDedupMemory } from './dedup-memory.js';
import {
  refreshCodebaseIndex, hasStructuralChanges,
} from './codebase-index.js';
import {
  pushCycleSummary, computeConvergenceMetrics,
  formatConvergenceOneLiner, type CycleSummary,
} from './cycle-context.js';
import { buildTasteProfile, saveTasteProfile } from './taste-profile.js';
import { sleep } from './dedup.js';

// ── Pre-cycle maintenance ───────────────────────────────────────────────────

export interface PreCycleResult {
  shouldSkipCycle: boolean;
}

export async function runPreCycleMaintenance(state: AutoSessionState): Promise<PreCycleResult> {
  state.cycleCount++;
  state.cycleOutcomes = [];
  const scope = ''; // scope is computed in scout phase; pre-cycle doesn't need it

  // Session phase computation
  const totalBudgetMs = state.totalMinutes ? state.totalMinutes * 60 * 1000 : undefined;
  state.sessionPhase = getSessionPhase(Date.now() - state.startTime, totalBudgetMs);

  // Per-sector difficulty calibration
  if (state.sectorState && state.currentSectorId) {
    const { getSectorMinConfidence } = await import('./sectors.js');
    const sec = state.sectorState.sectors.find(s => s.path === state.currentSectorId);
    if (sec) {
      state.effectiveMinConfidence = getSectorMinConfidence(sec, state.autoConf.minConfidence ?? 20);
    }
  }

  // Session phase confidence adjustments
  if (state.sessionPhase === 'warmup') {
    state.effectiveMinConfidence += 10;
  } else if (state.sessionPhase === 'deep') {
    state.effectiveMinConfidence = Math.max(10, state.effectiveMinConfidence - 10);
  }

  // Quality rate confidence boost
  if (state.cycleCount > 2) {
    const qualityRate = getQualityRate(state.repoRoot);
    if (qualityRate < 0.5) {
      state.effectiveMinConfidence += 10;
      if (state.options.verbose) {
        console.log(chalk.gray(`  Quality rate ${(qualityRate * 100).toFixed(0)}% — raising confidence +10`));
      }
    }
  }

  // Backpressure from open PRs (skip in direct mode)
  if (state.isContinuous && state.pendingPrUrls.length > 0 && state.deliveryMode !== 'direct') {
    const openRatio = state.pendingPrUrls.length / state.maxPrs;
    if (openRatio > 0.7) {
      console.log(chalk.yellow(`  Backpressure: ${state.pendingPrUrls.length}/${state.maxPrs} PRs open — waiting for reviews...`));
      await sleep(15000);
      state.cycleCount--; // undo increment so the cycle reruns
      return { shouldSkipCycle: true };
    } else if (openRatio > 0.4) {
      state.effectiveMinConfidence += 15;
      if (state.options.verbose) {
        console.log(chalk.gray(`  Light backpressure (${state.pendingPrUrls.length}/${state.maxPrs} open) — raising confidence +15`));
      }
    }
  }

  // Rebuild taste profile every 10 cycles
  if (state.cycleCount % 10 === 0 && state.sectorState) {
    const rs = readRunState(state.repoRoot);
    state.tasteProfile = buildTasteProfile(state.sectorState, state.allLearnings, rs.formulaStats);
    saveTasteProfile(state.repoRoot, state.tasteProfile);
    if (state.options.verbose) {
      console.log(chalk.gray(`  Taste profile rebuilt: prefer [${state.tasteProfile.preferredCategories.join(', ')}], avoid [${state.tasteProfile.avoidCategories.join(', ')}]`));
    }
  }

  // Periodic pull
  if (state.pullInterval > 0 && state.isContinuous) {
    state.cyclesSinceLastPull++;
    if (state.cyclesSinceLastPull >= state.pullInterval) {
      state.cyclesSinceLastPull = 0;
      try {
        const fetchResult = spawnSync(
          'git', ['fetch', 'origin', state.detectedBaseBranch],
          { cwd: state.repoRoot, encoding: 'utf-8', timeout: 30000 },
        );

        if (fetchResult.status === 0) {
          const mergeResult = spawnSync(
            'git', ['merge', '--ff-only', `origin/${state.detectedBaseBranch}`],
            { cwd: state.repoRoot, encoding: 'utf-8' },
          );

          if (mergeResult.status === 0) {
            const summary = mergeResult.stdout?.trim();
            if (summary && !summary.includes('Already up to date')) {
              console.log(chalk.cyan(`  ⬇ Pulled latest from origin/${state.detectedBaseBranch}`));
            }
          } else {
            const errMsg = mergeResult.stderr?.trim() || 'fast-forward not possible';

            if (state.pullPolicy === 'halt') {
              console.log();
              console.log(chalk.red(`✗ HCF — Base branch has diverged from origin/${state.detectedBaseBranch}`));
              console.log(chalk.gray(`  ${errMsg}`));
              console.log();
              console.log(chalk.bold('Resolution:'));
              console.log(`  1. Resolve the divergence (rebase, merge, or reset)`);
              console.log(`  2. Re-run: blockspool --hours ... --continuous`);
              console.log();
              console.log(chalk.gray(`  To keep going despite divergence, set pullPolicy: "warn" in config.`));

              // Signal orchestrator to break — finalizeSession handles cleanup
              state.shutdownRequested = true;
              return { shouldSkipCycle: true };
            } else {
              console.log(chalk.yellow(`  ⚠ Base branch diverged from origin/${state.detectedBaseBranch} — continuing on stale base`));
              console.log(chalk.gray(`    ${errMsg}`));
              console.log(chalk.gray(`    Subsequent work may produce merge conflicts`));
            }
          }
        } else if (state.options.verbose) {
          console.log(chalk.yellow(`  ⚠ Fetch failed (network?): ${fetchResult.stderr?.trim()}`));
        }
      } catch {
        // Network unavailable — non-fatal
      }
    }
  }

  // Periodic PR status poll (every 5 cycles)
  if (state.isContinuous && state.cycleCount > 1 && state.cycleCount % 5 === 0 && state.pendingPrUrls.length > 0) {
    try {
      const prStatuses = await checkPrStatuses(state.repoRoot, state.pendingPrUrls);
      for (const pr of prStatuses) {
        if (pr.state === 'merged') {
          state.totalMergedPrs++;
          const prMeta = state.prMetaMap.get(pr.url);
          if (prMeta) {
            if (state.sectorState) recordMergeOutcome(state.sectorState, prMeta.sectorId, true);
            recordFormulaMergeOutcome(state.repoRoot, prMeta.formula, true);
          }
          if (state.autoConf.learningsEnabled) {
            addLearning(state.repoRoot, {
              text: `PR merged: ${pr.url}`.slice(0, 200),
              category: 'pattern',
              source: { type: 'ticket_success', detail: 'pr_merged' },
              tags: [],
            });
          }
        } else if (pr.state === 'closed') {
          state.totalClosedPrs++;
          const prMeta = state.prMetaMap.get(pr.url);
          if (prMeta) {
            if (state.sectorState) recordMergeOutcome(state.sectorState, prMeta.sectorId, false);
            recordFormulaMergeOutcome(state.repoRoot, prMeta.formula, false);
          }
          if (state.autoConf.learningsEnabled) {
            addLearning(state.repoRoot, {
              text: `PR closed/rejected: ${pr.url}`.slice(0, 200),
              category: 'warning',
              source: { type: 'ticket_failure', detail: 'pr_closed' },
              tags: [],
            });
            const comments = await fetchPrReviewComments(state.repoRoot, pr.url);
            if (comments.length > 0) {
              const substantive = comments.sort((a, b) => b.body.length - a.body.length)[0];
              addLearning(state.repoRoot, {
                text: `PR rejected: ${substantive.body}`.slice(0, 200),
                category: 'warning',
                source: { type: 'reviewer_feedback', detail: substantive.author },
                tags: [],
              });
            }
          }
        }
      }
      const closedOrMergedUrls = prStatuses
        .filter(p => p.state === 'merged' || p.state === 'closed')
        .map(p => p.url);
      if (closedOrMergedUrls.length > 0) {
        removePrEntries(state.repoRoot, closedOrMergedUrls);
      }
      const polledSet = new Set(prStatuses.map(p => p.url));
      state.pendingPrUrls = state.pendingPrUrls.filter(u => !polledSet.has(u));
    } catch {
      // Non-fatal
    }
  }

  // Periodic guidelines refresh
  if (state.guidelinesRefreshInterval > 0 && state.cycleCount > 1 && state.cycleCount % state.guidelinesRefreshInterval === 0) {
    try {
      state.guidelines = loadGuidelines(state.repoRoot, state.guidelinesOpts);
      if (state.guidelines && state.options.verbose) {
        console.log(chalk.gray(`  Refreshed project guidelines (${state.guidelines.source})`));
      }
    } catch {
      // Non-fatal — keep existing guidelines
    }
  }

  return { shouldSkipCycle: false };
}

// ── Post-cycle maintenance ──────────────────────────────────────────────────

export async function runPostCycleMaintenance(state: AutoSessionState, scope: string, isDocsAuditCycle: boolean): Promise<void> {
  state.currentlyProcessing = false;

  // Save sector outcome stats
  if (state.sectorState) saveSectors(state.repoRoot, state.sectorState);

  // Record cycle completion
  const updatedRunState = recordCycle(state.repoRoot);
  if (isDocsAuditCycle) {
    recordDocsAudit(state.repoRoot);
  }

  // Record cycle summary
  {
    const cycleSummary: CycleSummary = {
      cycle: updatedRunState.totalCycles,
      scope: scope,
      formula: state.currentFormulaName,
      succeeded: state.cycleOutcomes
        .filter(o => o.status === 'completed')
        .map(o => ({ title: o.title, category: o.category || 'unknown' })),
      failed: state.cycleOutcomes
        .filter(o => o.status === 'failed')
        .map(o => ({ title: o.title, reason: 'agent_error' })),
      noChanges: state.cycleOutcomes
        .filter(o => o.status === 'no_changes')
        .map(o => o.title),
    };
    const rs = readRunState(state.repoRoot);
    rs.recentCycles = pushCycleSummary(rs.recentCycles ?? [], cycleSummary);
    writeRunState(state.repoRoot, rs);
  }

  // Convergence metrics
  if (state.cycleCount >= 3 && state.sectorState) {
    const rs = readRunState(state.repoRoot);
    const sessionCtx = {
      elapsedMs: Date.now() - state.startTime,
      prsCreated: state.allPrUrls.length,
      prsMerged: state.totalMergedPrs,
      prsClosed: state.totalClosedPrs,
    };
    const metrics = computeConvergenceMetrics(state.sectorState, state.allLearnings.length, rs.recentCycles ?? [], sessionCtx);
    console.log(chalk.gray(`  ${formatConvergenceOneLiner(metrics)}`));
    if (metrics.suggestedAction === 'stop') {
      console.log(chalk.yellow(`  Convergence suggests stopping — most sectors polished, low yield.`));
      state.shutdownRequested = true;
    }
  }

  // Scope adjustment
  if (state.sectorState && state.cycleCount >= 3) {
    const scopeAdj = suggestScopeAdjustment(state.sectorState);
    if (scopeAdj === 'narrow') {
      state.effectiveMinImpact = Math.min(10, state.effectiveMinImpact + 2);
      if (state.options.verbose) console.log(chalk.gray(`  Scope adjustment: narrowing (raising impact bar to ${state.effectiveMinImpact})`));
    } else if (scopeAdj === 'widen') {
      state.effectiveMinConfidence = state.autoConf.minConfidence ?? 20;
      state.effectiveMinImpact = 3;
      if (state.options.verbose) console.log(chalk.gray(`  Scope adjustment: widening (resetting thresholds)`));
    }
  }

  // Cross-sector pattern learning
  if (state.sectorState && state.currentSectorId && state.autoConf.learningsEnabled) {
    const sec = state.sectorState.sectors.find(s => s.path === state.currentSectorId);
    if (sec?.categoryStats) {
      for (const [cat, stats] of Object.entries(sec.categoryStats)) {
        if (stats.success >= 3) {
          const otherUnscanned = state.sectorState.sectors.filter(
            s => s.path !== state.currentSectorId && s.production && s.scanCount === 0
          );
          if (otherUnscanned.length > 0) {
            addLearning(state.repoRoot, {
              text: `Pattern from ${state.currentSectorId}: ${cat} proposals succeed well. Consider similar work in other sectors.`.slice(0, 200),
              category: 'pattern',
              source: { type: 'cross_sector_pattern' },
              tags: [cat],
            });
          }
        }
      }
    }
  }

  // Periodic learnings consolidation
  try {
    if (state.cycleCount % 5 === 0 && state.autoConf.learningsEnabled) {
      consolidateLearnings(state.repoRoot);
      state.allLearnings = loadLearnings(state.repoRoot, 0);
    }

    if (state.autoConf.learningsEnabled && state.cycleCount % 5 !== 0) {
      state.allLearnings = loadLearnings(state.repoRoot, 0);
      if (state.allLearnings.length > 50) {
        consolidateLearnings(state.repoRoot);
        state.allLearnings = loadLearnings(state.repoRoot, 0);
      }
    }
  } catch {
    // Non-fatal — learnings persist from previous cycle
  }

  // Refresh codebase index
  if (state.codebaseIndex && hasStructuralChanges(state.codebaseIndex, state.repoRoot)) {
    try {
      state.codebaseIndex = refreshCodebaseIndex(state.codebaseIndex, state.repoRoot, state.excludeDirs);
      if (state.options.verbose) {
        console.log(chalk.gray(`  Codebase index refreshed: ${state.codebaseIndex.modules.length} modules`));
      }
      if (state.sectorState) {
        state.sectorState = refreshSectors(
          state.repoRoot,
          state.sectorState,
          state.codebaseIndex.modules,
        );
        if (state.options.verbose) {
          console.log(chalk.gray(`  Sectors refreshed: ${state.sectorState.sectors.length} sector(s)`));
        }
      }
    } catch {
      // Non-fatal
    }
  }

  // Reload dedup memory
  if (state.isContinuous) {
    state.dedupMemory = loadDedupMemory(state.repoRoot);
  }

  // Pause between cycles
  if (state.isContinuous && !state.shutdownRequested) {
    console.log(chalk.gray('Pausing before next cycle...'));
    await sleep(5000);
  }
}
