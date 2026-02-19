/**
 * Session finalization for auto mode.
 */

import chalk from 'chalk';
import type { AutoSessionState } from './solo-auto-state.js';
import { addLearning } from './learnings.js';
import { recordFormulaMergeOutcome } from './run-state.js';
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
import { recordMergeOutcome, saveSectors } from './sectors.js';
import { updatePrOutcome } from './pr-outcomes.js';
import { displayConvergenceSummary, displayWheelHealth, recordSessionHistory, displayFinalSummary, type SessionSummaryContext } from './solo-session-summary.js';
import { generateSessionReport, writeSessionReport } from './session-report.js';
import { writeDaemonWakeMetrics, type DaemonWakeMetrics } from './daemon.js';

export async function finalizeSession(state: AutoSessionState): Promise<number> {
  let exitCode = 0;
  try {
    exitCode = await finalizeSafe(state);
  } finally {
    // Always release resources, even if finalization logic throws
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
    console.log(chalk.cyan(`\nFinalizing direct branch (${state.completedDirectTickets.length} tickets)...`));
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
        console.log(chalk.cyan(`  Summary PR: ${prUrl}`));
      } else if (state.directFinalize === 'merge') {
        const prUrl = await createDirectSummaryPr(state.repoRoot, state.directBranch, state.detectedBaseBranch, title, summaryBody, false);
        state.allPrUrls.push(prUrl);
        await autoMergePr(state.repoRoot, prUrl);
        console.log(chalk.cyan(`  Summary PR (auto-merge): ${prUrl}`));
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
    } catch {
      // Non-fatal
    }
  }

  // Save final sector state
  if (state.sectorState) saveSectors(state.repoRoot, state.sectorState);

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
      sectorState: state.sectorState,
      allLearningsCount: state.allLearnings.length,
      allTicketOutcomes: state.allTicketOutcomes,
      activeFormula: state.activeFormula,
      userScope: state.userScope,
      parallelExplicit: state.parallelExplicit,
      parallelOption: state.options.parallel,
      completedDirectTickets: state.completedDirectTickets,
      traceAnalyses: state.allTraceAnalyses,
    };
    const report = generateSessionReport(reportCtx);
    reportPath = writeSessionReport(state.repoRoot, report);
  } catch {
    // Non-fatal
  }

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
    maxPrs: state.maxPrs,
    endTime: state.endTime,
    totalMinutes: state.totalMinutes,
    sectorState: state.sectorState,
    allLearningsCount: state.allLearnings.length,
    allTicketOutcomes: state.allTicketOutcomes,
    activeFormula: state.activeFormula,
    userScope: state.userScope,
    parallelExplicit: state.parallelExplicit,
    parallelOption: state.options.parallel,
    effectiveMinConfidence: state.effectiveMinConfidence,
    originalMinConfidence: state.autoConf.minConfidence ?? 20,
    completedDirectTicketCount: state.completedDirectTickets.length,
    reportPath,
  };
  displayConvergenceSummary(summaryCtx);
  displayWheelHealth(summaryCtx);
  await recordSessionHistory(summaryCtx);
  displayFinalSummary(summaryCtx);

  if (reportPath) {
    console.log(chalk.gray(`  Report: ${reportPath}`));
  }

  // Persist wake metrics for daemon notification consumption
  if (state.options.daemon) {
    try {
      const metrics: DaemonWakeMetrics = {
        cyclesCompleted: state.cycleCount,
        ticketsCompleted: state.completedDirectTickets.length + state.totalPrsCreated,
        ticketsFailed: state.totalFailed,
        prUrls: [...state.allPrUrls],
        reportPath,
      };
      writeDaemonWakeMetrics(state.repoRoot, metrics);
    } catch { /* non-fatal */ }
  }

  return state.totalFailed > 0 && state.allPrUrls.length === 0 ? 1 : 0;
}
