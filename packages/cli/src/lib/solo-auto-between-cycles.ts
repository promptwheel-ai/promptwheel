/**
 * Pre-cycle and post-cycle maintenance for auto mode.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import chalk from 'chalk';
import { spawnSync } from 'node:child_process';
import type { AutoSessionState } from './solo-auto-state.js';
import { readRunState, writeRunState, recordCycle, getQualityRate } from './run-state.js';
import { getSessionPhase } from './solo-auto-utils.js';
import {
  checkPrStatuses,
  fetchPrReviewComments,
  deleteTicketBranch,
  deleteRemoteBranch,
} from './solo-git.js';
import { loadGuidelines } from './guidelines.js';
import { addLearning, loadLearnings, consolidateLearnings, extractTags } from './learnings.js';
import { captureQaBaseline } from './solo-ticket.js';
import { normalizeQaConfig } from './solo-utils.js';
import { getPromptwheelDir } from './solo-config.js';
import { loadDedupMemory } from './dedup-memory.js';
import { calibrateConfidence } from './qa-stats.js';
import {
  refreshCodebaseIndex, hasStructuralChanges,
} from './codebase-index.js';
import {
  pushCycleSummary, type CycleSummary,
} from './cycle-context.js';
import {
  runMeasurement, measureGoals, pickGoalByGap,
  recordGoalMeasurement,
} from './goals.js';
import { sleep } from './dedup.js';
import { saveTrajectoryState } from './trajectory.js';
import {
  getNextStep as getTrajectoryNextStep,
  trajectoryComplete,
  trajectoryFullySucceeded,
  trajectoryStuck,
} from '@promptwheel/core/trajectory/shared';
import { recordDrillTrajectoryOutcome, computeAmbitionLevel } from './solo-auto-drill.js';
import { runIntegrations, toProposals } from './integrations.js';
import { pollGitHubIssues, isGhAvailable } from './issue-polling.js';

// ── Pre-cycle maintenance ───────────────────────────────────────────────────

export interface PreCycleResult {
  shouldSkipCycle: boolean;
}

export async function runPreCycleMaintenance(state: AutoSessionState): Promise<PreCycleResult> {
  // Save previous cycle's completed count before resetting outcomes.
  // This lets us detect idle cycles even when retry paths skip post-cycle.
  state._prevCycleCompleted = state.cycleOutcomes.filter(o => o.status === 'completed').length;

  // Idle/failure cycle tracking — distinguish "no proposals found" from "all proposals failed"
  if (state.cycleCount >= 2) {
    const prevHadOutcomes = state.cycleOutcomes.length > 0;
    if (state._prevCycleCompleted > 0) {
      state.consecutiveIdleCycles = 0;
      state.consecutiveFailureCycles = 0;
    } else if (prevHadOutcomes) {
      // Had proposals but none completed — all-failure cycle
      state.consecutiveFailureCycles++;
      state.consecutiveIdleCycles = 0; // Not idle — we found work, it just failed
    } else {
      // No proposals at all — truly idle
      state.consecutiveIdleCycles++;
      state.consecutiveFailureCycles = 0;
    }

    const MAX_IDLE_CYCLES = state.autoConf.maxIdleCycles ?? 15;
    if (state.consecutiveIdleCycles >= MAX_IDLE_CYCLES) {
      state.shutdownRequested = true;
      if (state.shutdownReason === null) state.shutdownReason = 'idle';
      state.displayAdapter.log(chalk.yellow(`  ${state.consecutiveIdleCycles} consecutive idle cycles (no proposals) — stopping`));
      return { shouldSkipCycle: true };
    }

    // Warn on consistent failures but don't auto-stop — let the user decide
    if (state.consecutiveFailureCycles === 10) {
      state.displayAdapter.log(chalk.yellow(`  ⚠ ${state.consecutiveFailureCycles} consecutive all-failure cycles — consider adjusting scope or confidence`));
    }
  }

  // cycleCount is incremented AFTER backpressure checks (below) so that
  // early returns don't need to undo the increment.
  state.cycleOutcomes = [];

  // Multi-repo rotation: cycle to next repo
  if (state.repos.length > 1) {
    state.repoIndex = (state.repoIndex + 1) % state.repos.length;
    state.repoRoot = state.repos[state.repoIndex];
    if (state.options.verbose) state.displayAdapter.log(chalk.gray(`  Multi-repo: switched to ${path.basename(state.repoRoot)}`));
  }

  // scope is computed in scout phase; pre-cycle doesn't need it

  // Session phase computation
  const totalBudgetMs = state.totalMinutes ? state.totalMinutes * 60 * 1000 : undefined;
  state.sessionPhase = getSessionPhase(Date.now() - state.startTime, totalBudgetMs);

  // Session phase confidence adjustments
  if (state.sessionPhase === 'warmup') {
    state.effectiveMinConfidence += 10;
  } else if (state.sessionPhase === 'deep') {
    state.effectiveMinConfidence = Math.max(10, state.effectiveMinConfidence - 10);
  }

  // Quality rate confidence boost (cycleCount not yet incremented, so >= 2 means 3+ cycles done)
  if (state.cycleCount >= 2) {
    const qualityRate = getQualityRate(state.repoRoot);
    if (qualityRate < 0.5) {
      state.effectiveMinConfidence += 10;
      if (state.options.verbose) {
        state.displayAdapter.log(chalk.gray(`  Quality rate ${(qualityRate * 100).toFixed(0)}% — raising confidence +10`));
      }
    }
  }

  // Stats-based confidence calibration
  if (state.cycleCount >= 5) {
    try {
      const confDelta = calibrateConfidence(
        state.repoRoot,
        state.effectiveMinConfidence,
        state.autoConf.minConfidence ?? 20,
      );
      if (confDelta !== 0) {
        state.effectiveMinConfidence += confDelta;
        if (state.options.verbose) state.displayAdapter.log(chalk.gray(`  Confidence calibration: ${confDelta > 0 ? '+' : ''}${confDelta} → ${state.effectiveMinConfidence}`));
      }
    } catch (err) {
      if (state.options.verbose) state.displayAdapter.log(chalk.gray(`  Confidence calibration failed: ${err instanceof Error ? err.message : String(err)}`));
    }
  }

  // Backpressure from open PRs (skip in direct mode)
  if (state.runMode === 'spin' && state.pendingPrUrls.length > 0 && state.deliveryMode !== 'direct') {
    const openRatio = state.pendingPrUrls.length / state.maxPrs;
    const MAX_BACKPRESSURE_RETRIES = 20; // 5 minutes total (20 × 15s)
    if (openRatio > 0.7) {
      state.backpressureRetries++;
      if (state.backpressureRetries > MAX_BACKPRESSURE_RETRIES) {
        state.displayAdapter.log(chalk.yellow(`  Backpressure: ${state.pendingPrUrls.length}/${state.maxPrs} PRs open for ${MAX_BACKPRESSURE_RETRIES} cycles — continuing with raised confidence`));
        state.effectiveMinConfidence += 25;
        state.backpressureRetries = 0;
        // Fall through to continue the session
      } else {
        state.displayAdapter.log(chalk.yellow(`  Backpressure: ${state.pendingPrUrls.length}/${state.maxPrs} PRs open — waiting for reviews... (${state.backpressureRetries}/${MAX_BACKPRESSURE_RETRIES})`));
        await sleep(15000);
        return { shouldSkipCycle: true };
      }
    } else if (openRatio > 0.4) {
      state.backpressureRetries = 0; // Reset when pressure drops
      state.effectiveMinConfidence += 15;
      if (state.options.verbose) {
        state.displayAdapter.log(chalk.gray(`  Light backpressure (${state.pendingPrUrls.length}/${state.maxPrs} open) — raising confidence +15`));
      }
    }
  }

  // All backpressure early-returns have exited — safe to commit the cycle increment
  state.cycleCount++;

  // Clamp confidence to prevent runaway compounding from stacking adjustments
  const CONFIDENCE_FLOOR = 0;
  const CONFIDENCE_CEILING = 80;
  if (state.effectiveMinConfidence > CONFIDENCE_CEILING) {
    if (state.options.verbose) {
      state.displayAdapter.log(chalk.gray(`  Confidence clamped: ${state.effectiveMinConfidence} → ${CONFIDENCE_CEILING} (ceiling)`));
    }
    state.effectiveMinConfidence = CONFIDENCE_CEILING;
  } else if (state.effectiveMinConfidence < CONFIDENCE_FLOOR) {
    state.effectiveMinConfidence = CONFIDENCE_FLOOR;
  }

  // Periodic pull
  if (state.pullInterval > 0 && state.runMode === 'spin') {
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
              state.displayAdapter.log(chalk.cyan(`  ⬇ Pulled latest from origin/${state.detectedBaseBranch}`));
            }
          } else {
            const errMsg = mergeResult.stderr?.trim() || 'fast-forward not possible';

            if (state.pullPolicy === 'halt') {
              state.displayAdapter.log('');
              state.displayAdapter.log(chalk.red(`✗ HCF — Base branch has diverged from origin/${state.detectedBaseBranch}`));
              state.displayAdapter.log(chalk.gray(`  ${errMsg}`));
              state.displayAdapter.log('');
              state.displayAdapter.log(chalk.bold('Resolution:'));
              state.displayAdapter.log(`  1. Resolve the divergence (rebase, merge, or reset)`);
              state.displayAdapter.log(`  2. Re-run: promptwheel`);
              state.displayAdapter.log('');
              state.displayAdapter.log(chalk.gray(`  To keep going despite divergence, set pullPolicy: "warn" in config.`));

              // Signal orchestrator to break — finalizeSession handles cleanup
              state.shutdownRequested = true;
              if (state.shutdownReason === null) state.shutdownReason = 'branch_diverged';
              return { shouldSkipCycle: true };
            } else {
              state.displayAdapter.log(chalk.yellow(`  ⚠ Base branch diverged from origin/${state.detectedBaseBranch} — continuing on stale base`));
              state.displayAdapter.log(chalk.gray(`    ${errMsg}`));
              state.displayAdapter.log(chalk.gray(`    Subsequent work may produce merge conflicts`));
            }
          }
        } else if (state.options.verbose) {  // already verbose-gated
          state.displayAdapter.log(chalk.yellow(`  ⚠ Fetch failed (network?): ${fetchResult.stderr?.trim()}`));
        }
      } catch (err) {
        if (state.options.verbose) state.displayAdapter.log(chalk.gray(`  Fetch failed: ${err instanceof Error ? err.message : String(err)}`));
      }
    }
  }

  // Periodic PR status poll (every 5 cycles)
  if (state.runMode === 'spin' && state.cycleCount > 1 && state.cycleCount % 5 === 0 && state.pendingPrUrls.length > 0) {
    try {
      const prStatuses = await checkPrStatuses(state.repoRoot, state.pendingPrUrls);
      for (const pr of prStatuses) {
        if (pr.state === 'merged') {
          state.totalMergedPrs++;
          if (state.autoConf.learningsEnabled) {
            addLearning(state.repoRoot, {
              text: `PR merged: ${pr.url}`.slice(0, 200),
              category: 'pattern',
              source: { type: 'ticket_success', detail: 'pr_merged' },
              tags: [],
            });
          }
          // Clean up merged branch (local + remote)
          if (pr.branch) {
            await deleteTicketBranch(state.repoRoot, pr.branch).catch(() => {});
            await deleteRemoteBranch(state.repoRoot, pr.branch).catch(() => {});
          }
        } else if (pr.state === 'closed') {
          state.totalClosedPrs++;
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
      const closedOrMergedSet = new Set(closedOrMergedUrls);
      state.pendingPrUrls = state.pendingPrUrls.filter(u => !closedOrMergedSet.has(u));
    } catch (err) {
      if (state.options.verbose) state.displayAdapter.log(chalk.gray(`  PR status poll failed: ${err instanceof Error ? err.message : String(err)}`));
    }
  }

  // Run pre-scout integrations
  if (state.integrations.providers.length > 0) {
    try {
      const preResults = await runIntegrations(state, state.integrations, 'pre-scout');
      const proposalResults = preResults.filter(r => r.feed === 'proposals');
      if (proposalResults.length > 0) {
        state._pendingIntegrationProposals = proposalResults.flatMap(r => toProposals(r));
      }
    } catch (err) {
      if (state.options.verbose) state.displayAdapter.log(chalk.gray(`  Pre-scout integration failed: ${err instanceof Error ? err.message : String(err)}`));
    }
  }

  // Poll GitHub issues for proposals
  if (state.options.issues) {
    try {
      if (isGhAvailable()) {
        const label = typeof state.options.issues === 'string' ? state.options.issues : 'promptwheel';
        const issueProposals = pollGitHubIssues({
          label,
          limit: 10,
          repoRoot: state.repoRoot,
        });
        if (issueProposals.length > 0) {
          state._pendingIntegrationProposals.push(...issueProposals);
          if (state.options.verbose) state.displayAdapter.log(chalk.gray(`  Polled ${issueProposals.length} GitHub issue(s) with label "${label}"`));
        }
      }
    } catch (err) {
      if (state.options.verbose) state.displayAdapter.log(chalk.gray(`  Issue polling failed: ${err instanceof Error ? err.message : String(err)}`));
    }
  }

  // Periodic guidelines refresh
  if (state.guidelinesRefreshInterval > 0 && state.cycleCount > 1 && state.cycleCount % state.guidelinesRefreshInterval === 0) {
    try {
      state.guidelines = loadGuidelines(state.repoRoot, state.guidelinesOpts);
      if (state.guidelines && state.options.verbose) {
        state.displayAdapter.log(chalk.gray(`  Refreshed project guidelines (${state.guidelines.source})`));
      }
    } catch {
      // Non-fatal — keep existing guidelines
    }
  }

  return { shouldSkipCycle: false };
}

// ── Post-cycle maintenance ──────────────────────────────────────────────────

export async function runPostCycleMaintenance(state: AutoSessionState, scope: string): Promise<void> {
  state.currentlyProcessing = false;

  // Record cycle completion
  const updatedRunState = recordCycle(state.repoRoot);

  // Record cycle summary + persist calibration state
  {
    const cycleSummary: CycleSummary = {
      cycle: updatedRunState.totalCycles,
      scope: scope,
      formula: 'default',
      succeeded: state.cycleOutcomes
        .filter(o => o.status === 'completed')
        .map(o => ({ title: o.title, category: o.category || 'unknown' })),
      failed: state.cycleOutcomes
        .filter(o => o.status === 'failed')
        .map(o => ({ title: o.title, reason: o.failureReason ?? 'agent_error' })),
      noChanges: state.cycleOutcomes
        .filter(o => o.status === 'no_changes')
        .map(o => o.title),
    };
    const rs = readRunState(state.repoRoot);
    rs.recentCycles = pushCycleSummary(rs.recentCycles ?? [], cycleSummary);
    // Persist confidence calibration and drill state for cross-session continuity
    rs.lastEffectiveMinConfidence = state.effectiveMinConfidence;
    rs.lastDrillConsecutiveInsufficient = state.drillConsecutiveInsufficient;
    // Session crash-resume checkpoint
    rs.sessionCheckpoint = {
      cycleCount: state.cycleCount,
      totalPrsCreated: state.totalPrsCreated,
      totalFailed: state.totalFailed,
      consecutiveLowYieldCycles: state.consecutiveLowYieldCycles,
      pendingPrUrls: state.pendingPrUrls,
      allPrUrls: state.allPrUrls,
      ticketOutcomeSummary: state.allTicketOutcomes.map(o => ({
        title: o.title, category: o.category ?? '', status: o.status,
      })),
      savedAt: Date.now(),
    };
    writeRunState(state.repoRoot, rs);
  }

  // Baseline healing check: re-run failing commands to detect improvements
  const completedThisCycle = state.cycleOutcomes.filter(o => o.status === 'completed').length;
  if (completedThisCycle > 0 && state.config?.qa?.commands?.length) {
    try {
      const blPath = path.join(getPromptwheelDir(state.repoRoot), 'qa-baseline.json');
      if (fs.existsSync(blPath)) {
        const blData = JSON.parse(fs.readFileSync(blPath, 'utf8'));
        const previouslyFailing: string[] = blData.failures ?? [];
        if (previouslyFailing.length > 0 && previouslyFailing.length <= 5) {
          // Only re-check the previously failing commands (not all)
          const qaConfig = normalizeQaConfig(state.config);
          const failingCmds = qaConfig.commands.filter(c => previouslyFailing.includes(c.name));
          if (failingCmds.length > 0) {
            const checkConfig = { ...state.config, qa: { ...state.config.qa, commands: failingCmds } };
            const recheck = await captureQaBaseline(state.repoRoot, checkConfig, () => {});
            const healed: string[] = [];
            const stillFailing: string[] = [];
            for (const [name, result] of recheck) {
              if (result.passed) {
                healed.push(name);
              } else {
                stillFailing.push(name);
              }
            }
            if (healed.length > 0) {
              state.displayAdapter.log(chalk.green(`  Baseline healed: ${healed.join(', ')} now passing`));
              if (state.autoConf.learningsEnabled) {
                addLearning(state.repoRoot, {
                  text: `Baseline healed in ${scope}: ${healed.join(', ')} now pass after cycle ${state.cycleCount}`.slice(0, 200),
                  category: 'pattern',
                  source: { type: 'baseline_healed', detail: healed.join(', ') },
                  tags: extractTags([scope], []),
                });
              }
              // Update qa-baseline.json with only still-failing commands
              const updatedDetails: Record<string, any> = {};
              for (const name of stillFailing) {
                updatedDetails[name] = (blData.details ?? {})[name] ?? { cmd: name, output: '' };
                // Refresh output from recheck
                const recheckResult = recheck.get(name);
                if (recheckResult?.output) updatedDetails[name].output = recheckResult.output;
              }
              const blTmp = blPath + '.tmp';
              fs.writeFileSync(blTmp, JSON.stringify({
                failures: stillFailing,
                details: updatedDetails,
                timestamp: Date.now(),
              }));
              fs.renameSync(blTmp, blPath);
            }
          }
        }
      }
    } catch (err) {
      if (state.options.verbose) console.warn(chalk.gray(`  Baseline healing skipped: ${err instanceof Error ? err.message : String(err)}`));
    }
  }

  // Low-yield cycle detection — primary Nash equilibrium stop signal
  const completedThisCount = state.cycleOutcomes.filter(o => o.status === 'completed').length;
  if (completedThisCount === 0 && state.cycleCount >= 2) {
    state.consecutiveLowYieldCycles++;
    const MAX_LOW_YIELD_CYCLES = state.drillMode ? 5 : 3;
    if (state.consecutiveLowYieldCycles >= MAX_LOW_YIELD_CYCLES) {
      state.displayAdapter.log(chalk.yellow(`  ${state.consecutiveLowYieldCycles} consecutive low-yield cycles — stopping`));
      state.shutdownRequested = true;
      if (state.shutdownReason === null) state.shutdownReason = 'low_yield';
    } else if (state.options.verbose) {
      state.displayAdapter.log(chalk.gray(`  Low-yield cycle (${state.consecutiveLowYieldCycles}/${MAX_LOW_YIELD_CYCLES})`));
    }
  } else if (completedThisCount > 0) {
    state.consecutiveLowYieldCycles = 0;
  }

  // Wheel diagnostics one-liner (always shown, not verbose-gated)
  if (state.cycleCount >= 2) {
    const qualityRate = getQualityRate(state.repoRoot);
    const qualityPct = Math.round(qualityRate * 100);
    const { loadQaStats: loadQa } = await import('./qa-stats.js');
    loadQa(state.repoRoot);
    const baselineFailing = state.qaBaseline
      ? [...state.qaBaseline.values()].filter(v => !v).length
      : 0;
    const confValue = state.effectiveMinConfidence;
    const baselineStr = baselineFailing > 0 ? ` | baseline failing ${baselineFailing}` : '';
    if (state.options.verbose) state.displayAdapter.log(chalk.gray(`  Spin: quality ${qualityPct}% | confidence ${confValue}${baselineStr}`));
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
  } catch (err) {
    // Non-fatal — learnings persist from previous cycle
    console.warn(chalk.gray(`  Learnings consolidation skipped: ${err instanceof Error ? err.message : String(err)}`));
  }

  // Refresh codebase index
  if (state.codebaseIndex && hasStructuralChanges(state.codebaseIndex, state.repoRoot)) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      state.codebaseIndex = refreshCodebaseIndex(state.codebaseIndex, state.repoRoot, state.excludeDirs, true, (state as any).astGrepModule);
      if (state.options.verbose) {
        state.displayAdapter.log(chalk.gray(`  Codebase index refreshed: ${state.codebaseIndex.modules.length} modules`));
      }
    } catch (err) {
      if (state.options.verbose) state.displayAdapter.log(chalk.gray(`  Codebase index refresh failed: ${err instanceof Error ? err.message : String(err)}`));
    }
  }

  // Reload dedup memory
  if (state.runMode === 'spin') {
    state.dedupMemory = loadDedupMemory(state.repoRoot);
  }

  // Goal re-measurement
  if (state.activeGoal?.measure && state.activeGoalMeasurement) {
    const { value, error } = runMeasurement(state.activeGoal.measure.cmd, state.repoRoot);
    if (value !== null) {
      const prev = state.activeGoalMeasurement.current;
      const delta = prev !== null ? value - prev : 0;
      const deltaSign = delta > 0 ? '+' : '';
      const arrow = state.activeGoal.measure.direction === 'up'
        ? (delta > 0 ? chalk.green('↑') : delta < 0 ? chalk.yellow('↓') : '→')
        : (delta < 0 ? chalk.green('↓') : delta > 0 ? chalk.yellow('↑') : '→');
      state.displayAdapter.log(chalk.cyan(`  🎯 ${state.activeGoal.name}: ${value} ${arrow} (${deltaSign}${delta.toFixed(1)}) target: ${state.activeGoal.measure.target}`));

      // Check if goal is now met
      const { target, direction } = state.activeGoal.measure;
      const met = direction === 'up' ? value >= target : value <= target;

      // Record measurement
      const measurement = { ...state.activeGoalMeasurement, current: value, measuredAt: Date.now(), met };
      recordGoalMeasurement(state.repoRoot, measurement);

      if (met) {
        state.displayAdapter.log(chalk.green(`  ✓ Goal "${state.activeGoal.name}" met!`));

        // Re-evaluate all goals and pivot to next
        const allMeasurements = measureGoals(state.goals, state.repoRoot);
        for (const m of allMeasurements) {
          recordGoalMeasurement(state.repoRoot, m);
        }
        const next = pickGoalByGap(allMeasurements);
        if (next) {
          state.activeGoal = state.goals.find(g => g.name === next.goalName) ?? null;
          state.activeGoalMeasurement = next;
          state.displayAdapter.log(chalk.cyan(`  → Pivoting to: ${next.goalName} (gap: ${next.gapPercent}%)`));
        } else {
          const allMet = allMeasurements.every(m => m.met);
          if (allMet) {
            state.displayAdapter.log(chalk.green(`  ✓ All goals met!`));
          }
          state.activeGoal = null;
          state.activeGoalMeasurement = null;
        }
      } else {
        // Update current value for next cycle's prompt
        state.activeGoalMeasurement.current = value;
        // Recalculate gap (guarded against division by zero)
        if (direction === 'up') {
          if (value >= target) {
            state.activeGoalMeasurement.gapPercent = 0;
          } else if (target !== 0) {
            state.activeGoalMeasurement.gapPercent = Math.round(((target - value) / target) * 1000) / 10;
          } else {
            state.activeGoalMeasurement.gapPercent = 100;
          }
        } else if (direction === 'down') {
          if (value <= target) {
            state.activeGoalMeasurement.gapPercent = 0;
          } else if (target > 0) {
            // Non-zero target: normalize against target so progress is visible
            state.activeGoalMeasurement.gapPercent = Math.round(Math.min(100, ((value - target) / target) * 100) * 10) / 10;
          } else {
            // target=0: use absolute difference capped to 100 so progress is visible
            state.activeGoalMeasurement.gapPercent = Math.round(Math.min(100, value - target) * 10) / 10;
          }
        }
      }
    } else {
      state.displayAdapter.log(chalk.yellow(`  ⚠ Goal "${state.activeGoal.name}" re-measurement failed${error ? `: ${error}` : ''}`));
    }
  }

  // Trajectory cycle budget — abandon if consuming too many cycles.
  // Scales with step count: more steps get more budget (2-step → base, 8-step → ~2x base).
  if (state.drillMode && state.activeTrajectory && state.activeTrajectoryState) {
    const baseMaxCycles = state.autoConf.drill?.maxCyclesPerTrajectory ?? 15;
    const stepsTotal = state.activeTrajectory.steps.length;
    const maxCycles = Math.round(baseMaxCycles * Math.min(2.5, Math.max(0.8, 1 + Math.max(0, stepsTotal - 3) / 5)));
    const totalCyclesUsed = Object.values(state.activeTrajectoryState.stepStates)
      .reduce((sum, s) => sum + (s.cyclesAttempted ?? 0), 0);
    if (totalCyclesUsed >= maxCycles) {
      const completedSteps = state.activeTrajectory.steps.filter(
        s => state.activeTrajectoryState!.stepStates[s.id]?.status === 'completed',
      ).length;
      const pct = Math.round((completedSteps / state.activeTrajectory.steps.length) * 100);
      state.displayAdapter.log(chalk.yellow(`  Drill: trajectory "${state.activeTrajectory.name}" hit cycle budget (${totalCyclesUsed}/${maxCycles} cycles, ${pct}% complete) — abandoning`));
      saveTrajectoryState(state.repoRoot, state.activeTrajectoryState);
      try { finishDrillTrajectory(state, 'stalled'); }
      catch (err) { state.displayAdapter.log(chalk.yellow(`  Drill: failed to record trajectory outcome — ${err instanceof Error ? err.message : String(err)}`)); }
      state.activeTrajectory = null;
      state.activeTrajectoryState = null;
      state.currentTrajectoryStep = null;
    }
  }

  // Trajectory step progression
  if (state.activeTrajectory && state.activeTrajectoryState && state.currentTrajectoryStep) {
    const step = state.currentTrajectoryStep;
    const stepState = state.activeTrajectoryState.stepStates[step.id];

    if (stepState) {
      // Run step verification commands
      let allPassed = true;
      const verificationOutputParts: string[] = [];
      const existingOutcomes = stepState.commandOutcomes ?? [];
      const newCommandOutcomes: NonNullable<typeof stepState.commandOutcomes> = [];
      if (step.verification_commands.length > 0) {
        for (const cmd of step.verification_commands) {
          const result = spawnSync('sh', ['-c', cmd], {
            cwd: state.repoRoot,
            timeout: 30000,
            encoding: 'utf-8',
          });
          const existingCmd = existingOutcomes.find(c => c.command === cmd);
          // Git-context resilience: skip commands that fail due to missing git repo
          // (e.g. tests that shell out to git but run in a non-repo context)
          const combinedOutput = ((result.stderr ?? '') + (result.stdout ?? ''));
          if (result.status !== 0 && !result.error && combinedOutput.includes('not a git repository')) {
            state.displayAdapter.log(chalk.yellow(`    ⚠ ${cmd} (git context unavailable — skipping)`));
            verificationOutputParts.push(`$ ${cmd} (skipped: git context unavailable)`);
            newCommandOutcomes.push({
              command: cmd, passed: true, failCount: existingCmd?.failCount ?? 0,
            });
            continue;
          }
          if (result.error) {
            // Timeout or spawn error
            allPassed = false;
            const reason = result.error.message?.includes('TIMEOUT') ? 'timeout (30s)' : result.error.message;
            state.displayAdapter.log(chalk.yellow(`    ✗ ${cmd} (${reason})`));
            verificationOutputParts.push(`$ ${cmd}\n${reason}`);
            newCommandOutcomes.push({
              command: cmd,
              passed: false,
              failCount: (existingCmd?.failCount ?? 0) + 1,
              lastOutput: reason?.slice(0, 200),
            });
          } else if (result.status !== 0) {
            allPassed = false;
            const stderr = (result.stderr || '').trim().slice(0, 500);
            const stdout = (result.stdout || '').trim().slice(0, 200);
            state.displayAdapter.log(chalk.yellow(`    ✗ ${cmd} (exit ${result.status})`));
            if (stderr) state.displayAdapter.log(chalk.gray(`      ${stderr.split('\n')[0]}`));
            else if (stdout) state.displayAdapter.log(chalk.gray(`      ${stdout.split('\n')[0]}`));
            verificationOutputParts.push(`$ ${cmd} (exit ${result.status})\n${stderr || stdout}`);
            newCommandOutcomes.push({
              command: cmd,
              passed: false,
              failCount: (existingCmd?.failCount ?? 0) + 1,
              lastOutput: (stderr || stdout)?.slice(0, 200),
            });
          } else {
            newCommandOutcomes.push({
              command: cmd,
              passed: true,
              failCount: existingCmd?.failCount ?? 0,
            });
          }
        }
      }
      stepState.commandOutcomes = newCommandOutcomes;

      // Optional measurement check
      let measureMet = true;
      if (step.measure) {
        const { value, error } = runMeasurement(step.measure.cmd, state.repoRoot);
        if (value !== null) {
          const arrow = step.measure.direction === 'up' ? '>=' : '<=';
          measureMet = step.measure.direction === 'up'
            ? value >= step.measure.target
            : value <= step.measure.target;
          stepState.measurement = { value, timestamp: Date.now() };
          if (!measureMet) {
            state.displayAdapter.log(chalk.yellow(`    measure: ${value} (target: ${arrow} ${step.measure.target})`));
          }
        } else {
          measureMet = false;
          state.displayAdapter.log(chalk.yellow(`    measure failed${error ? `: ${error}` : ''}`));
        }
      }

      if (allPassed && measureMet) {
        // Step completed — advance
        stepState.status = 'completed';
        stepState.completedAt = Date.now();
        stepState.consecutiveFailures = 0;
        stepState.lastVerificationOutput = undefined;
        const completedCount = state.activeTrajectory.steps.filter(s => state.activeTrajectoryState!.stepStates[s.id]?.status === 'completed').length;
        const totalCount = state.activeTrajectory.steps.length;
        state.displayAdapter.log(chalk.green(`  Trajectory step ${completedCount}/${totalCount} "${step.title}" completed`));

        // Pick next step
        const next = getTrajectoryNextStep(state.activeTrajectory, state.activeTrajectoryState.stepStates);
        state.currentTrajectoryStep = next;
        if (next) {
          state.activeTrajectoryState.currentStepId = next.id;
          if (state.activeTrajectoryState.stepStates[next.id]) {
            state.activeTrajectoryState.stepStates[next.id].status = 'active';
          }
          state.displayAdapter.log(chalk.cyan(`  -> Next step: ${next.title}`));
        } else if (trajectoryComplete(state.activeTrajectory, state.activeTrajectoryState.stepStates)) {
          const fullySucceeded = trajectoryFullySucceeded(state.activeTrajectory, state.activeTrajectoryState.stepStates);
          const outcome = fullySucceeded ? 'completed' : 'stalled';
          if (fullySucceeded) {
            state.displayAdapter.log(chalk.green(`  Trajectory "${state.activeTrajectory.name}" complete!`));
          } else {
            state.displayAdapter.log(chalk.yellow(`  Trajectory "${state.activeTrajectory.name}" finished with some failed steps`));
          }
          // Save final state with completed status (persists on disk for history)
          state.activeTrajectoryState.status = 'completed';
          state.activeTrajectoryState.currentStepId = null;
          saveTrajectoryState(state.repoRoot, state.activeTrajectoryState);
          if (state.drillMode) {
            try { finishDrillTrajectory(state, outcome); }
            catch (err) { state.displayAdapter.log(chalk.yellow(`  Drill: failed to record trajectory outcome — ${err instanceof Error ? err.message : String(err)}`)); }
          }
          state.activeTrajectory = null;
          state.activeTrajectoryState = null;
          state.currentTrajectoryStep = null;
        } else {
          // No next step available but trajectory isn't complete — shouldn't happen now
          // (failed deps unblock dependents), but handle as fallback
          state.displayAdapter.log(chalk.yellow(`  Trajectory "${state.activeTrajectory.name}" stalled (remaining steps blocked)`));
          state.activeTrajectoryState.status = 'abandoned';
          state.activeTrajectoryState.currentStepId = null;
          saveTrajectoryState(state.repoRoot, state.activeTrajectoryState);
          if (state.drillMode) {
            try { finishDrillTrajectory(state, 'stalled'); }
            catch (err) { state.displayAdapter.log(chalk.yellow(`  Drill: failed to record trajectory outcome — ${err instanceof Error ? err.message : String(err)}`)); }
          }
          state.activeTrajectory = null;
          state.activeTrajectoryState = null;
          state.currentTrajectoryStep = null;
        }
      } else {
        // Step not yet complete — increment attempt counter
        stepState.cyclesAttempted++;
        stepState.lastAttemptedCycle = state.cycleCount;
        // Track consecutive and total failures for transient/flakiness detection
        stepState.consecutiveFailures = (stepState.consecutiveFailures ?? 0) + 1;
        stepState.totalFailures = (stepState.totalFailures ?? 0) + 1;
        // Capture verification output for prompt injection on next attempt
        if (verificationOutputParts.length > 0) {
          stepState.lastVerificationOutput = verificationOutputParts.join('\n').slice(0, 1000);
        }

        // Check for stuck — pass full step list so each step uses its own max_retries
        const stuckId = trajectoryStuck(state.activeTrajectoryState.stepStates, undefined, state.activeTrajectory.steps);
        if (stuckId) {
          // Fail the actual stuck step (may differ from current step if state was corrupted)
          const stuckStepState = state.activeTrajectoryState.stepStates[stuckId];
          const stuckStep = state.activeTrajectory.steps.find(s => s.id === stuckId);
          const stuckTitle = stuckStep?.title ?? stuckId;
          const stuckAttempts = stuckStepState?.cyclesAttempted ?? stepState.cyclesAttempted;
          state.displayAdapter.log(chalk.yellow(`  Trajectory step "${stuckTitle}" stuck after ${stuckAttempts} cycles`));
          if (stuckStepState) {
            stuckStepState.status = 'failed';
            stuckStepState.failureReason = 'max retries exceeded';
          }

          // Try to advance to next step
          const next = getTrajectoryNextStep(state.activeTrajectory, state.activeTrajectoryState.stepStates);
          state.currentTrajectoryStep = next;
          if (next) {
            state.activeTrajectoryState.currentStepId = next.id;
            if (state.activeTrajectoryState.stepStates[next.id]) {
              state.activeTrajectoryState.stepStates[next.id].status = 'active';
            }
            state.displayAdapter.log(chalk.cyan(`  -> Skipping to next step: ${next.title}`));
          } else {
            // No more steps — trajectory is done (all remaining steps failed or completed)
            state.displayAdapter.log(chalk.yellow(`  Trajectory "${state.activeTrajectory.name}" ended (no remaining steps)`));
            saveTrajectoryState(state.repoRoot, state.activeTrajectoryState);
            if (state.drillMode) {
              try { finishDrillTrajectory(state, 'stalled'); }
              catch (err) { state.displayAdapter.log(chalk.yellow(`  Drill: failed to record trajectory outcome — ${err instanceof Error ? err.message : String(err)}`)); }
            }
            state.activeTrajectory = null;
            state.activeTrajectoryState = null;
            state.currentTrajectoryStep = null;
          }
        }
      }

      if (state.activeTrajectoryState) {
        saveTrajectoryState(state.repoRoot, state.activeTrajectoryState);
      }
    }
  }

  // Run post-cycle integrations
  if (state.integrations.providers.length > 0) {
    try {
      await runIntegrations(state, state.integrations, 'post-cycle');
    } catch (err) {
      if (state.options.verbose) state.displayAdapter.log(chalk.gray(`  Post-cycle integration failed: ${err instanceof Error ? err.message : String(err)}`));
    }
  }

  // Pause between cycles — shorter when trajectory-guided (work is pre-planned)
  if (state.runMode === 'spin' && !state.shutdownRequested) {
    const pauseMs = state.currentTrajectoryStep ? 1000 : 5000;
    state.displayAdapter.log(chalk.gray('Pausing before next cycle...'));
    await sleep(pauseMs);
  }
}

// ── Drill trajectory lifecycle ───────────────────────────────────────────────

/**
 * Record a drill trajectory's completion/stall into history, record learnings,
 * and log the next-survey message.
 *
 * Must be called BEFORE clearing state.activeTrajectory (needs the trajectory data).
 */
function finishDrillTrajectory(state: AutoSessionState, outcome: 'completed' | 'stalled'): void {
  if (!state.activeTrajectory || !state.activeTrajectoryState) return;
  const traj = state.activeTrajectory;
  const trajState = state.activeTrajectoryState;

  const stepsTotal = traj.steps.length;
  const stepsCompleted = traj.steps.filter(s => trajState.stepStates[s.id]?.status === 'completed').length;
  const stepsFailed = traj.steps.filter(s => trajState.stepStates[s.id]?.status === 'failed').length;

  // Collect failed step details for history
  const failedStepDetails = traj.steps
    .filter(s => trajState.stepStates[s.id]?.status === 'failed')
    .map(s => ({
      id: s.id,
      title: s.title,
      reason: trajState.stepStates[s.id]?.lastVerificationOutput?.slice(0, 200)
        ?? trajState.stepStates[s.id]?.failureReason,
    }));

  // Collect completed step summaries for causal chaining
  const completedStepSummaries = traj.steps
    .filter(s => trajState.stepStates[s.id]?.status === 'completed')
    .map(s => s.title);

  // Collect modified files from git (since trajectory started)
  let modifiedFiles: string[] | undefined;
  try {
    const trajStartTime = trajState.startedAt ?? (state.startTime || 0);
    if (trajStartTime > 0) {
      // Use git log --diff-filter with --since instead of HEAD~N (which fails with shallow repos or few commits)
      const sinceDate = new Date(trajStartTime).toISOString();
      const gitResult = spawnSync('git', [
        'log', '--diff-filter=ACMR', '--name-only', '--pretty=format:',
        `--since=${sinceDate}`,
      ], { cwd: state.repoRoot, encoding: 'utf-8', timeout: 5000 });
      if (!gitResult.error && gitResult.status === 0 && gitResult.stdout.trim()) {
        // Deduplicate file names (same file may appear in multiple commits)
        modifiedFiles = [...new Set(gitResult.stdout.trim().split('\n').filter(Boolean))].slice(0, 20);
      }
    }
  } catch (err) {
    if (state.options.verbose) state.displayAdapter.log(chalk.gray(`  Drill: git log for modified files failed: ${err instanceof Error ? err.message : String(err)}`));
  }

  // Collect per-step outcomes for telemetry (enables step-level learning)
  const stepOutcomes = traj.steps.map(s => ({
    id: s.id,
    status: (trajState.stepStates[s.id]?.status ?? 'pending') as 'completed' | 'failed' | 'skipped' | 'pending',
  }));

  // Record into drill history (for avoidance + diversity + stats)
  recordDrillTrajectoryOutcome(
    state,
    traj.name,
    traj.description,
    stepsTotal,
    stepsCompleted,
    stepsFailed,
    outcome,
    traj.steps,
    failedStepDetails.length > 0 ? failedStepDetails : undefined,
    completedStepSummaries.length > 0 ? completedStepSummaries : undefined,
    modifiedFiles,
    computeAmbitionLevel(state),
    {
      stepOutcomes,
      ...state.drillGenerationTelemetry,
    },
  );
  state.drillGenerationTelemetry = null;

  // Record learnings — trajectory-level
  if (state.autoConf.learningsEnabled) {
    const categories = [...new Set(traj.steps.flatMap(s => s.categories ?? []))];
    const catLabel = categories.join(', ') || 'mixed';

    if (outcome === 'completed') {
      addLearning(state.repoRoot, {
        text: `Drill trajectory "${traj.name}" completed (${stepsCompleted}/${stepsTotal} steps). Theme: ${traj.description}. Categories: ${catLabel}`.slice(0, 200),
        category: 'pattern',
        source: { type: 'drill_completed', detail: traj.name },
        tags: categories,
      });
    } else {
      const failedSteps = traj.steps
        .filter(s => trajState.stepStates[s.id]?.status === 'failed')
        .map(s => s.title);
      addLearning(state.repoRoot, {
        text: `Drill trajectory "${traj.name}" stalled (${stepsCompleted}/${stepsTotal} completed, ${stepsFailed} failed). Failed: ${failedSteps.join(', ')}`.slice(0, 200),
        category: 'warning',
        source: { type: 'drill_stalled', detail: traj.name },
        tags: categories,
      });
    }

    // Record step-level learnings — enables scope-tagged learning for future proposals
    for (const step of traj.steps) {
      const stepState = trajState.stepStates[step.id];
      if (!stepState) continue;

      const stepTags = extractTags(step.scope ? [step.scope] : [], step.verification_commands ?? []);

      if (stepState.status === 'completed') {
        addLearning(state.repoRoot, {
          text: `Trajectory step succeeded: ${step.title} (scope: ${step.scope ?? 'any'})`.slice(0, 200),
          category: 'pattern',
          source: { type: 'drill_completed', detail: traj.name },
          tags: stepTags,
        });
      } else if (stepState.status === 'failed') {
        addLearning(state.repoRoot, {
          text: `Trajectory step failed: ${step.title} (scope: ${step.scope ?? 'any'})`.slice(0, 200),
          category: 'warning',
          source: { type: 'drill_stalled', detail: `${traj.name}/${step.id}` },
          tags: stepTags,
          structured: {
            pattern_type: 'antipattern',
            applies_to: step.scope,
          },
        });
      }
    }

    // Blueprint insight — correlate enabler placement with outcome
    const lastEntry = state.drillHistory[state.drillHistory.length - 1];
    if (lastEntry?.blueprintEnablerCount && lastEntry.blueprintEnablerCount > 0) {
      const label = outcome === 'completed' ? 'succeeded' : `stalled at ${Math.round(lastEntry.completionPct * 100)}%`;
      addLearning(state.repoRoot, {
        text: `Blueprint: ${lastEntry.blueprintEnablerCount} enabler(s), ${lastEntry.blueprintGroupCount ?? 0} group(s), ${lastEntry.blueprintConflictCount ?? 0} conflict(s) → ${label}`.slice(0, 200),
        category: outcome === 'completed' ? 'pattern' : 'warning',
        source: { type: 'drill_blueprint', detail: traj.name },
        tags: [...categories, 'blueprint'],
      });
    }
  }

  const rate = stepsTotal > 0 ? Math.round((stepsCompleted / stepsTotal) * 100) : 0;
  state.displayAdapter.log(chalk.cyan(`  Drill: trajectory ${outcome} (${stepsCompleted}/${stepsTotal} steps, ${rate}% completion)`));
  if (state.options.verbose) state.displayAdapter.log(chalk.cyan('  Drill: will survey for next trajectory on next cycle'));

  // Notify display adapter that trajectory finished (back to idle)
  state.displayAdapter.drillStateChanged({ active: true });

  // Reload learnings immediately so next trajectory generation has fresh context
  if (state.autoConf.learningsEnabled) {
    try {
      state.allLearnings = loadLearnings(state.repoRoot, 0);
    } catch (err) {
      if (state.options.verbose) state.displayAdapter.log(chalk.gray(`  Learnings reload failed: ${err instanceof Error ? err.message : String(err)}`));
    }
  }
}
