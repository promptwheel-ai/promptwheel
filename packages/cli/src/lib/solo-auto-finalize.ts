/**
 * Session finalization for auto mode.
 */

import chalk from 'chalk';
import type { AutoSessionState } from './solo-auto-state.js';
import { addLearning, getLearningEffectiveness } from './learnings.js';
import {
  checkPrStatuses,
  fetchPrReviewComments,
  cleanupMilestone,
  pushDirectBranch,
  createDirectSummaryPr,
  autoMergePr,
  deleteTicketBranch,
  deleteRemoteBranch,
  gitExecFile,
} from './solo-git.js';
import { displayWheelHealth, recordSessionHistory, displayFinalSummary, type SessionSummaryContext } from './solo-session-summary.js';
import { generateSessionReport, generateSessionJson, writeSessionReport, writeSessionJsonReport } from './session-report.js';
import { computeDrillMetrics } from './solo-auto-drill.js';

export async function finalizeSession(state: AutoSessionState): Promise<number> {
  let exitCode: number;
  try {
    exitCode = await finalizeSafe(state);
  } finally {
    // Always release resources — destroy calls are idempotent
    state.interactiveConsole?.stop();
    try { state.displayAdapter.destroy(); } catch { /* best-effort */ }
    try { await state.adapter.close(); } catch { /* best-effort */ }
  }
  return exitCode;
}

async function finalizeSafe(state: AutoSessionState): Promise<number> {
  // Finalize any partial milestone
  if (state.milestoneMode && state.milestoneTicketCount > 0) {
    try {
      await state.finalizeMilestone();
    } catch (err) {
      console.error(chalk.red(`  Milestone finalization failed: ${err instanceof Error ? err.message : err}`));
    }
  }
  if (state.milestoneMode) {
    try {
      await cleanupMilestone(state.repoRoot);
    } catch (err) {
      console.error(chalk.red(`  Milestone cleanup failed: ${err instanceof Error ? err.message : err}`));
    }
  }

  // Finalize direct mode
  if (state.deliveryMode === 'direct' && state.completedDirectTickets.length > 0 && state.directFinalize !== 'none') {
    state.displayAdapter.log(chalk.cyan(`\nFinalizing direct branch (${state.completedDirectTickets.length} tickets)...`));
    try {
      await pushDirectBranch(state.repoRoot, state.directBranch);
      const elapsed = Date.now() - state.startTime;
      const hours = Math.floor(elapsed / 3600000);
      const mins = Math.floor((elapsed % 3600000) / 60000);
      const durationStr = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
      const ticketList = state.completedDirectTickets
        .map(t => `- [${t.category}] ${t.title} — ${t.files.length} file(s)`)
        .join('\n');
      const summaryBody = [
        '## PromptWheel Session Summary',
        '',
        `### Tickets Completed (${state.completedDirectTickets.length})`,
        ticketList,
        '',
        '### Stats',
        `- Cycles: ${state.cycleCount} | Duration: ${durationStr} | Files modified: ${new Set(state.completedDirectTickets.flatMap(t => t.files)).size}`,
      ].join('\n');
      const title = `PromptWheel: ${state.completedDirectTickets.length} improvements`;

      if (state.directFinalize === 'pr') {
        const prUrl = await createDirectSummaryPr(state.repoRoot, state.directBranch, state.detectedBaseBranch, title, summaryBody, true);
        state.allPrUrls.push(prUrl);
        state.displayAdapter.log(chalk.cyan(`  Summary PR: ${prUrl}`));
      } else if (state.directFinalize === 'merge') {
        const prUrl = await createDirectSummaryPr(state.repoRoot, state.directBranch, state.detectedBaseBranch, title, summaryBody, false);
        state.allPrUrls.push(prUrl);
        await autoMergePr(state.repoRoot, prUrl);
        state.displayAdapter.log(chalk.cyan(`  Summary PR (auto-merge): ${prUrl}`));
      }
    } catch (err) {
      console.error(chalk.red(`  Direct finalize failed: ${err instanceof Error ? err.message : err}`));
    }

  }

  // Return to base branch so user isn't left on a promptwheel working branch
  try {
    await gitExecFile('git', ['checkout', state.detectedBaseBranch], { cwd: state.repoRoot });
  } catch { /* non-fatal — user can checkout manually */ }

  // Final PR status poll
  if (state.allPrUrls.length > 0) {
    try {
      const finalStatuses = await checkPrStatuses(state.repoRoot, state.allPrUrls);
      for (const pr of finalStatuses) {
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
    } catch (err) {
      console.error(chalk.gray(`  PR status poll failed: ${err instanceof Error ? err.message : String(err)}`));
    }
  }

  // Build drill stats from history (needed by both report and summary)
  let drillStats: SessionSummaryContext['drillStats'];
  if (state.drillMode && state.drillHistory.length > 0) {
    const stepsTotal = state.drillHistory.reduce((sum, h) => sum + h.stepsTotal, 0);
    const stepsCompleted = state.drillHistory.reduce((sum, h) => sum + h.stepsCompleted, 0);
    const stepsFailed = state.drillHistory.reduce((sum, h) => sum + h.stepsFailed, 0);
    const metrics = computeDrillMetrics(state.drillHistory);
    drillStats = {
      trajectoriesGenerated: state.drillHistory.length,
      stepsTotal,
      stepsCompleted,
      stepsFailed,
      completionRate: stepsTotal > 0 ? Math.round((stepsCompleted / stepsTotal) * 100) : 0,
      topCategories: metrics.topCategories.join(', ') || undefined,
      stalledCategories: metrics.stalledCategories.join(', ') || undefined,
    };
  }

  // Learning effectiveness stats
  let learningStats: SessionSummaryContext['learningStats'];
  if (state.autoConf.learningsEnabled) {
    try {
      const eff = getLearningEffectiveness(state.repoRoot);
      if (eff.applied > 0) {
        learningStats = {
          total: eff.total,
          applied: eff.applied,
          successRate: eff.successRate,
          topPerformers: eff.topPerformers.map(p => ({ text: p.text, effectiveness: p.effectiveness })),
        };
      }
    } catch (err) {
      console.debug(`Learning effectiveness stats failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Generate session report (before summary so we can show path in overnight output)
  let reportPath: string | undefined;
  try {
    const reportCtx = {
      repoRoot: state.repoRoot,
      startTime: state.startTime,
      cycleCount: state.cycleCount,
      allPrUrls: state.allPrUrls,
      totalPrsCreated: state.totalPrsCreated,
      totalFailed: state.totalFailed,
      totalMergedPrs: state.totalMergedPrs,
      totalClosedPrs: state.totalClosedPrs,
      totalMilestonePrs: state.totalMilestonePrs,
      milestoneMode: state.milestoneMode,
      isContinuous: state.runMode === 'spin',
      shutdownRequested: state.shutdownRequested,
      maxPrs: state.maxPrs,
      endTime: state.endTime,
      totalMinutes: state.totalMinutes,
      allLearningsCount: state.allLearnings.length,
      allTicketOutcomes: state.allTicketOutcomes,
      activeFormula: null,
      userScope: state.userScope,
      parallelExplicit: state.parallelExplicit,
      parallelOption: state.options.parallel,
      completedDirectTickets: state.completedDirectTickets,
      traceAnalyses: state.allTraceAnalyses,
      drillStats,
    };
    const report = generateSessionReport(reportCtx);
    reportPath = writeSessionReport(state.repoRoot, report);

    // Write JSON report when --output json is requested
    if (state.options.output === 'json') {
      const jsonData = generateSessionJson(reportCtx);
      const jsonPath = writeSessionJsonReport(state.repoRoot, jsonData);
      console.log(chalk.gray(`  JSON report: ${jsonPath}`));
    }
  } catch (err) {
    console.debug(`Session report generation failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Destroy TUI before printing summary so output goes to the normal terminal
  state.interactiveConsole?.stop();
  try { state.displayAdapter.destroy(); } catch { /* best-effort */ }

  // Summary
  const summaryCtx: SessionSummaryContext = {
    repoRoot: state.repoRoot,
    startTime: state.startTime,
    cycleCount: state.cycleCount,
    allPrUrls: state.allPrUrls,
    totalPrsCreated: state.totalPrsCreated,
    totalFailed: state.totalFailed,
    totalMergedPrs: state.totalMergedPrs,
    totalClosedPrs: state.totalClosedPrs,
    totalMilestonePrs: state.totalMilestonePrs,
    milestoneMode: state.milestoneMode,
    isContinuous: state.runMode === 'spin',
    shutdownRequested: state.shutdownRequested,
    shutdownReason: state.shutdownReason,
    maxPrs: state.maxPrs,
    endTime: state.endTime,
    totalMinutes: state.totalMinutes,
    allLearningsCount: state.allLearnings.length,
    allTicketOutcomes: state.allTicketOutcomes,
    activeFormula: null,
    userScope: state.userScope,
    parallelExplicit: state.parallelExplicit,
    parallelOption: state.options.parallel,
    effectiveMinConfidence: state.effectiveMinConfidence,
    originalMinConfidence: state.autoConf.minConfidence ?? 20,
    completedDirectTicketCount: state.completedDirectTickets.length,
    reportPath,
    learningStats,
    drillStats,
  };
  displayWheelHealth(summaryCtx);
  await recordSessionHistory(summaryCtx);

  // Update project portfolio with cross-session context
  try {
    const { buildOrUpdatePortfolio, savePortfolio } = await import('./portfolio.js');
    const updatedPortfolio = buildOrUpdatePortfolio(
      state.repoRoot,
      state.codebaseIndex,
      state.drillHistory,
      state.allLearnings,
    );
    savePortfolio(state.repoRoot, updatedPortfolio);
  } catch { /* non-fatal */ }

  displayFinalSummary(summaryCtx);

  if (reportPath) {
    console.log(chalk.gray(`  Report: ${reportPath}`));
  }


  return state.totalFailed > 0 && state.allPrUrls.length === 0 ? 1 : 0;
}
