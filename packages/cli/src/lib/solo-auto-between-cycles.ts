/**
 * Pre-cycle and post-cycle maintenance for auto mode.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import chalk from 'chalk';
import { spawnSync } from 'node:child_process';
import type { AutoSessionState } from './solo-auto-state.js';
import { readRunState, writeRunState, recordCycle, recordDocsAudit, getQualityRate, snapshotLearningROI } from './run-state.js';
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
import { removePrEntries } from './file-cooldown.js';
import { recordFormulaMergeOutcome } from './run-state.js';
import { updatePrOutcome } from './pr-outcomes.js';
import {
  recordMergeOutcome, saveSectors, refreshSectors,
  suggestScopeAdjustment,
} from './sectors.js';
import { loadDedupMemory } from './dedup-memory.js';
import { calibrateConfidence } from './qa-stats.js';
import { extractMetaLearnings } from './meta-learnings.js';
import {
  refreshCodebaseIndex, hasStructuralChanges,
} from './codebase-index.js';
import {
  pushCycleSummary, computeConvergenceMetrics,
  formatConvergenceOneLiner, type CycleSummary,
} from './cycle-context.js';
import { buildTasteProfile, saveTasteProfile } from './taste-profile.js';
import {
  runMeasurement, measureGoals, pickGoalByGap,
  recordGoalMeasurement,
} from './goals.js';
import { sleep } from './dedup.js';
import { saveTrajectoryState } from './trajectory.js';
import {
  getNextStep as getTrajectoryNextStep,
  trajectoryComplete,
  trajectoryStuck,
} from '@promptwheel/core/trajectory/shared';

// ── Pre-cycle maintenance ───────────────────────────────────────────────────

export interface PreCycleResult {
  shouldSkipCycle: boolean;
}

export async function runPreCycleMaintenance(state: AutoSessionState): Promise<PreCycleResult> {
  state.cycleCount++;
  state.cycleOutcomes = [];
  // scope is computed in scout phase; pre-cycle doesn't need it

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

  // Stats-based confidence calibration
  if (state.cycleCount > 5) {
    try {
      const confDelta = calibrateConfidence(
        state.repoRoot,
        state.effectiveMinConfidence,
        state.autoConf.minConfidence ?? 20,
      );
      if (confDelta !== 0) {
        state.effectiveMinConfidence += confDelta;
        console.log(chalk.gray(`  Confidence calibration: ${confDelta > 0 ? '+' : ''}${confDelta} → ${state.effectiveMinConfidence}`));
      }
    } catch {
      // Non-fatal
    }
  }

  // Backpressure from open PRs (skip in direct mode)
  if (state.runMode === 'spin' && state.pendingPrUrls.length > 0 && state.deliveryMode !== 'direct') {
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

  // Clamp confidence to prevent runaway compounding from stacking adjustments
  const CONFIDENCE_FLOOR = 0;
  const CONFIDENCE_CEILING = 80;
  if (state.effectiveMinConfidence > CONFIDENCE_CEILING) {
    if (state.options.verbose) {
      console.log(chalk.gray(`  Confidence clamped: ${state.effectiveMinConfidence} → ${CONFIDENCE_CEILING} (ceiling)`));
    }
    state.effectiveMinConfidence = CONFIDENCE_CEILING;
  } else if (state.effectiveMinConfidence < CONFIDENCE_FLOOR) {
    state.effectiveMinConfidence = CONFIDENCE_FLOOR;
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
              console.log(`  2. Re-run: promptwheel --spin`);
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
  if (state.runMode === 'spin' && state.cycleCount > 1 && state.cycleCount % 5 === 0 && state.pendingPrUrls.length > 0) {
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
          try { updatePrOutcome(state.repoRoot, pr.url, 'merged', Date.now()); } catch { /* non-fatal */ }
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
          const prMeta = state.prMetaMap.get(pr.url);
          if (prMeta) {
            if (state.sectorState) recordMergeOutcome(state.sectorState, prMeta.sectorId, false);
            recordFormulaMergeOutcome(state.repoRoot, prMeta.formula, false);
          }
          try { updatePrOutcome(state.repoRoot, pr.url, 'closed', Date.now()); } catch { /* non-fatal */ }
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
      const closedOrMergedSet = new Set(closedOrMergedUrls);
      state.pendingPrUrls = state.pendingPrUrls.filter(u => !closedOrMergedSet.has(u));
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
            const recheck = await captureQaBaseline(state.repoRoot, checkConfig, () => {}, state.repoRoot);
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
              console.log(chalk.green(`  Baseline healed: ${healed.join(', ')} now passing`));
              if (state.autoConf.learningsEnabled) {
                addLearning(state.repoRoot, {
                  text: `Baseline healed in ${scope}: ${healed.join(', ')} now pass after cycle ${state.cycleCount}`.slice(0, 200),
                  category: 'pattern',
                  source: { type: 'baseline_healed' as any, detail: healed.join(', ') },
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
      console.warn(chalk.gray(`  Baseline healing skipped: ${err instanceof Error ? err.message : String(err)}`));
    }
  }

  // Meta-learning extraction (aggregate pattern detection)
  let metaInsightsAdded = 0;
  if (state.autoConf.learningsEnabled && state.cycleCount >= 3) {
    try {
      metaInsightsAdded = extractMetaLearnings({
        projectRoot: state.repoRoot,
        cycleOutcomes: state.cycleOutcomes,
        allOutcomes: state.allTicketOutcomes,
        learningsEnabled: state.autoConf.learningsEnabled,
        existingLearnings: state.allLearnings,
      });
      if (metaInsightsAdded > 0 && state.options.verbose) {
        console.log(chalk.gray(`  Meta-learnings: ${metaInsightsAdded} process insight(s) extracted`));
      }
    } catch {
      // Non-fatal
    }
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
    const insightsStr = metaInsightsAdded > 0 ? ` | insights +${metaInsightsAdded}` : '';
    const baselineStr = baselineFailing > 0 ? ` | baseline failing ${baselineFailing}` : '';
    console.log(chalk.gray(`  Spin: quality ${qualityPct}% | confidence ${confValue}${baselineStr}${insightsStr}`));
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

  // Scope adjustment (confidence only — impact uses static config floor)
  if (state.sectorState && state.cycleCount >= 3) {
    const scopeAdj = suggestScopeAdjustment(state.sectorState);
    if (scopeAdj === 'widen') {
      state.effectiveMinConfidence = state.autoConf.minConfidence ?? 20;
      if (state.options.verbose) console.log(chalk.gray(`  Scope adjustment: widening (resetting confidence threshold)`));
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

  // Learning ROI snapshot (every 10 cycles)
  if (state.cycleCount % 10 === 0 && state.autoConf.learningsEnabled) {
    try {
      const { getLearningEffectiveness } = await import('./learnings.js');
      snapshotLearningROI(state.repoRoot, getLearningEffectiveness);
    } catch { /* non-fatal */ }
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
      console.log(chalk.cyan(`  🎯 ${state.activeGoal.name}: ${value} ${arrow} (${deltaSign}${delta.toFixed(1)}) target: ${state.activeGoal.measure.target}`));

      // Check if goal is now met
      const { target, direction } = state.activeGoal.measure;
      const met = direction === 'up' ? value >= target : value <= target;

      // Record measurement
      const measurement = { ...state.activeGoalMeasurement, current: value, measuredAt: Date.now(), met };
      recordGoalMeasurement(state.repoRoot, measurement);

      if (met) {
        console.log(chalk.green(`  ✓ Goal "${state.activeGoal.name}" met!`));

        // Re-evaluate all goals and pivot to next
        const allMeasurements = measureGoals(state.goals, state.repoRoot);
        for (const m of allMeasurements) {
          recordGoalMeasurement(state.repoRoot, m);
        }
        const next = pickGoalByGap(allMeasurements);
        if (next) {
          state.activeGoal = state.goals.find(g => g.name === next.goalName) ?? null;
          state.activeGoalMeasurement = next;
          console.log(chalk.cyan(`  → Pivoting to: ${next.goalName} (gap: ${next.gapPercent}%)`));
        } else {
          const allMet = allMeasurements.every(m => m.met);
          if (allMet) {
            console.log(chalk.green(`  ✓ All goals met!`));
          }
          state.activeGoal = null;
          state.activeGoalMeasurement = null;
        }
      } else {
        // Update current value for next cycle's prompt
        state.activeGoalMeasurement.current = value;
        // Recalculate gap
        if (direction === 'up' && target !== 0) {
          state.activeGoalMeasurement.gapPercent = Math.round(((target - value) / target) * 1000) / 10;
        } else if (direction === 'down') {
          state.activeGoalMeasurement.gapPercent = target === 0
            ? (value > 0 ? 100 : 0)
            : Math.round(((value - target) / value) * 1000) / 10;
        }
      }
    } else {
      console.log(chalk.yellow(`  ⚠ Goal "${state.activeGoal.name}" re-measurement failed${error ? `: ${error}` : ''}`));
    }
  }

  // Trajectory step progression
  if (state.activeTrajectory && state.activeTrajectoryState && state.currentTrajectoryStep) {
    const step = state.currentTrajectoryStep;
    const stepState = state.activeTrajectoryState.stepStates[step.id];

    if (stepState) {
      // Run step verification commands
      let allPassed = true;
      if (step.verification_commands.length > 0) {
        for (const cmd of step.verification_commands) {
          const result = spawnSync('sh', ['-c', cmd], {
            cwd: state.repoRoot,
            timeout: 30000,
            encoding: 'utf-8',
          });
          if (result.status !== 0) {
            allPassed = false;
            const stderr = (result.stderr || '').trim().slice(0, 500);
            const stdout = (result.stdout || '').trim().slice(0, 200);
            console.log(chalk.yellow(`    ✗ ${cmd} (exit ${result.status})`));
            if (stderr) console.log(chalk.gray(`      ${stderr.split('\n')[0]}`));
            else if (stdout) console.log(chalk.gray(`      ${stdout.split('\n')[0]}`));
          }
        }
      }

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
            console.log(chalk.yellow(`    measure: ${value} (target: ${arrow} ${step.measure.target})`));
          }
        } else {
          measureMet = false;
          console.log(chalk.yellow(`    measure failed${error ? `: ${error}` : ''}`));
        }
      }

      if (allPassed && measureMet) {
        // Step completed — advance
        stepState.status = 'completed';
        stepState.completedAt = Date.now();
        console.log(chalk.green(`  Trajectory step "${step.title}" completed`));

        // Pick next step
        const next = getTrajectoryNextStep(state.activeTrajectory, state.activeTrajectoryState.stepStates);
        state.currentTrajectoryStep = next;
        if (next) {
          state.activeTrajectoryState.currentStepId = next.id;
          state.activeTrajectoryState.stepStates[next.id].status = 'active';
          console.log(chalk.cyan(`  -> Next step: ${next.title}`));
        } else if (trajectoryComplete(state.activeTrajectory, state.activeTrajectoryState.stepStates)) {
          console.log(chalk.green(`  Trajectory "${state.activeTrajectory.name}" complete!`));
          // Save final state before clearing (so completed status persists on disk)
          saveTrajectoryState(state.repoRoot, state.activeTrajectoryState);
          state.activeTrajectory = null;
          state.activeTrajectoryState = null;
          state.currentTrajectoryStep = null;
        } else {
          // No next step available but trajectory isn't complete — blocked by failed dependencies
          console.log(chalk.yellow(`  Trajectory "${state.activeTrajectory.name}" stalled (remaining steps blocked by dependencies)`));
          saveTrajectoryState(state.repoRoot, state.activeTrajectoryState);
          state.activeTrajectory = null;
          state.activeTrajectoryState = null;
          state.currentTrajectoryStep = null;
        }
      } else {
        // Step not yet complete — increment attempt counter
        stepState.cyclesAttempted++;
        stepState.lastAttemptedCycle = state.cycleCount;

        // Check for stuck (use per-step max_retries if set)
        const stuckId = trajectoryStuck(state.activeTrajectoryState.stepStates, step.max_retries);
        if (stuckId) {
          console.log(chalk.yellow(`  Trajectory step "${step.title}" stuck after ${stepState.cyclesAttempted} cycles`));
          stepState.status = 'failed';
          stepState.failureReason = 'max retries exceeded';

          // Try to advance to next step
          const next = getTrajectoryNextStep(state.activeTrajectory, state.activeTrajectoryState.stepStates);
          state.currentTrajectoryStep = next;
          if (next) {
            state.activeTrajectoryState.currentStepId = next.id;
            state.activeTrajectoryState.stepStates[next.id].status = 'active';
            console.log(chalk.cyan(`  -> Skipping to next step: ${next.title}`));
          } else {
            // No more steps — trajectory is done (all remaining steps failed or completed)
            console.log(chalk.yellow(`  Trajectory "${state.activeTrajectory.name}" ended (no remaining steps)`));
            saveTrajectoryState(state.repoRoot, state.activeTrajectoryState);
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

  // Pause between cycles
  if (state.runMode === 'spin' && !state.shutdownRequested) {
    console.log(chalk.gray('Pausing before next cycle...'));
    await sleep(5000);
  }
}
