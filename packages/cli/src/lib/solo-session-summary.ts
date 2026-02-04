/**
 * Session finalization: summary display, convergence metrics, and run history recording.
 */

import chalk from 'chalk';
import { readRunState, getQualityRate } from './run-state.js';
import { loadQaStats } from './qa-stats.js';
import { loadLearnings } from './learnings.js';
import { computeCoverage, type SectorState } from './sectors.js';
import { computeConvergenceMetrics } from './cycle-context.js';
import { formatElapsed } from './solo-auto-utils.js';
import type { Formula } from './formulas.js';
import type { TicketOutcome } from './run-history.js';

export interface SessionSummaryContext {
  repoRoot: string;
  startTime: number;
  cycleCount: number;
  allPrUrls: string[];
  totalPrsCreated: number;
  totalFailed: number;
  totalMergedPrs: number;
  totalClosedPrs: number;
  totalMilestonePrs: number;
  milestoneMode: boolean;
  isContinuous: boolean;
  shutdownRequested: boolean;
  maxPrs: number;
  endTime: number | null | undefined;
  totalMinutes: number | undefined;
  sectorState: SectorState | null;
  allLearningsCount: number;
  allTicketOutcomes: TicketOutcome[];
  activeFormula: Formula | null;
  userScope: string | undefined;
  parallelExplicit: boolean;
  parallelOption: string | undefined;
  effectiveMinConfidence?: number;
  originalMinConfidence?: number;
}

/**
 * Display convergence summary metrics.
 */
export function displayConvergenceSummary(ctx: SessionSummaryContext): void {
  const { sectorState, cycleCount, repoRoot, startTime, allPrUrls, totalMergedPrs, totalClosedPrs, allLearningsCount } = ctx;
  if (!sectorState || cycleCount < 3) return;

  const rs = readRunState(repoRoot);
  const sessionCtx = { elapsedMs: Date.now() - startTime, prsCreated: allPrUrls.length, prsMerged: totalMergedPrs, prsClosed: totalClosedPrs };
  const metrics = computeConvergenceMetrics(sectorState, allLearningsCount, rs.recentCycles ?? [], sessionCtx);
  console.log();
  console.log(chalk.bold('Convergence Summary'));
  console.log(chalk.gray(`  Polished sectors: ${metrics.polishedSectorPct}%`));
  console.log(chalk.gray(`  Avg proposal yield: ${metrics.avgProposalYield.toFixed(1)}/scan`));
  console.log(chalk.gray(`  Learnings density: ${metrics.learningsDensity.toFixed(2)}/file`));
  console.log(chalk.gray(`  Success trend: ${metrics.successRateTrend}`));
  if (!isNaN(metrics.mergeRate)) console.log(chalk.gray(`  Merge rate: ${Math.round(metrics.mergeRate * 100)}%`));
  if (metrics.velocity.prsPerHour > 0) console.log(chalk.gray(`  Velocity: ${metrics.velocity.prsPerHour.toFixed(1)} PRs/h`));
  console.log(chalk.gray(`  Suggested action: ${metrics.suggestedAction}`));
}

/**
 * Display wheel health summary at end of session.
 */
export function displayWheelHealth(ctx: SessionSummaryContext): void {
  const { repoRoot } = ctx;
  const qualityRate = getQualityRate(repoRoot);
  const rs = readRunState(repoRoot);
  const qs = rs.qualitySignals;
  const qaStats = loadQaStats(repoRoot);
  const allLearnings = loadLearnings(repoRoot, 0);

  const qualityPct = Math.round(qualityRate * 100);
  const qualityColor = qualityRate > 0.8 ? chalk.green
    : qualityRate >= 0.5 ? chalk.yellow
    : chalk.red;

  console.log();
  console.log(chalk.bold('Wheel Health'));

  // Quality rate
  if (qs && qs.totalTickets > 0) {
    const qaStr = (qs.qaPassed + qs.qaFailed) > 0
      ? `${qs.qaPassed}/${qs.qaPassed + qs.qaFailed} QA pass`
      : 'QA: untested';
    console.log(qualityColor(`  Quality rate: ${qualityPct}% (${qs.firstPassSuccess}/${qs.totalTickets} first-pass, ${qaStr})`));
  } else {
    console.log(chalk.gray(`  Quality rate: ${qualityPct}% (no data)`));
  }

  // Confidence
  const effectiveConf = ctx.effectiveMinConfidence ?? ctx.originalMinConfidence ?? 20;
  const originalConf = ctx.originalMinConfidence ?? 20;
  const delta = effectiveConf - originalConf;
  const deltaStr = delta !== 0 ? `, calibrated ${delta > 0 ? '+' : ''}${delta}` : '';
  console.log(chalk.gray(`  Confidence: ${effectiveConf} (started at ${originalConf}${deltaStr})`));

  // Disabled commands
  if (qaStats.disabledCommands.length > 0) {
    const names = qaStats.disabledCommands.map(d => d.name).join(', ');
    console.log(chalk.yellow(`  Disabled commands: ${names}`));
  } else {
    console.log(chalk.gray('  Disabled commands: none'));
  }

  // Meta-learnings (process insights)
  const processInsights = allLearnings.filter(l => l.source.type === 'process_insight');
  console.log(chalk.gray(`  Meta-learnings: ${processInsights.length} process insights`));

  // QA command stats
  const cmdEntries = Object.values(qaStats.commands);
  if (cmdEntries.length > 0) {
    const statLines = cmdEntries.map(s => {
      const rate = s.totalRuns > 0 ? Math.round(s.successes / s.totalRuns * 100) : null;
      const rateStr = rate !== null ? `${rate}% success` : 'no data';
      const avgStr = s.totalRuns > 0
        ? (s.avgDurationMs >= 1000 ? `avg ${(s.avgDurationMs / 1000).toFixed(1)}s` : `avg ${s.avgDurationMs}ms`)
        : '';
      return `    ${s.name}: ${rateStr}${avgStr ? `, ${avgStr}` : ''} (${s.totalRuns} runs)`;
    });
    console.log(chalk.gray('  QA stats:'));
    for (const line of statLines) {
      console.log(chalk.gray(line));
    }
  }
}

/**
 * Record run history for the session.
 */
export async function recordSessionHistory(ctx: SessionSummaryContext): Promise<void> {
  try {
    const { appendRunHistory } = await import('./run-history.js');
    const elapsed = Date.now() - ctx.startTime;
    const stoppedReason = ctx.shutdownRequested ? 'user_shutdown'
      : ctx.totalPrsCreated >= ctx.maxPrs ? 'pr_limit'
      : (ctx.endTime && Date.now() >= ctx.endTime) ? 'time_limit'
      : 'completed';
    appendRunHistory({
      timestamp: new Date().toISOString(),
      mode: 'auto',
      scope: ctx.userScope || 'src',
      formula: ctx.activeFormula?.name,
      ticketsProposed: ctx.allTicketOutcomes.length,
      ticketsApproved: ctx.totalPrsCreated + ctx.totalFailed,
      ticketsCompleted: ctx.totalPrsCreated,
      ticketsFailed: ctx.totalFailed,
      prsCreated: ctx.allPrUrls.length,
      prsMerged: ctx.totalMergedPrs,
      durationMs: elapsed,
      parallel: ctx.parallelExplicit ? parseInt(ctx.parallelOption!, 10) : -1,
      stoppedReason,
      tickets: ctx.allTicketOutcomes,
    }, ctx.repoRoot || undefined);
  } catch {
    // Non-fatal
  }
}

/**
 * Display final summary output.
 */
export function displayFinalSummary(ctx: SessionSummaryContext): void {
  const elapsed = Date.now() - ctx.startTime;

  console.log();
  console.log(chalk.bold('━'.repeat(50)));
  console.log(chalk.bold('Final Summary'));
  console.log();
  console.log(chalk.gray(`  Duration: ${formatElapsed(elapsed)}`));
  console.log(chalk.gray(`  Cycles: ${ctx.cycleCount}`));
  if (ctx.sectorState) {
    const cov = computeCoverage(ctx.sectorState);
    const unclStr = cov.unclassifiedSectors > 0 ? `, ${cov.unclassifiedSectors} unclassified` : '';
    console.log(chalk.gray(`  Coverage: ${cov.scannedSectors}/${cov.totalSectors} sectors (${cov.scannedFiles}/${cov.totalFiles} files, ${cov.percent}%${unclStr})`));
  }

  if (ctx.milestoneMode) {
    console.log(chalk.gray(`  Milestone PRs: ${ctx.totalMilestonePrs}`));
    console.log(chalk.gray(`  Total tickets merged: ${ctx.totalPrsCreated}`));
  }

  if (ctx.allPrUrls.length > 0) {
    console.log(chalk.green(`\n✓ ${ctx.allPrUrls.length} PR(s) created:`));
    for (const url of ctx.allPrUrls) {
      console.log(chalk.cyan(`  ${url}`));
    }
  }

  if (ctx.totalFailed > 0) {
    console.log(chalk.red(`\n✗ ${ctx.totalFailed} failed`));
  }

  if (ctx.allPrUrls.length > 0) {
    console.log();
    console.log(chalk.bold('Next steps:'));
    console.log('  • Review the draft PRs on GitHub');
    console.log('  • Mark as ready for review when satisfied');
    console.log('  • Merge after CI passes');
  }

  if (ctx.isContinuous) {
    console.log();
    if (ctx.shutdownRequested) {
      console.log(chalk.gray('Stopped: User requested shutdown'));
    } else if (ctx.totalPrsCreated >= ctx.maxPrs) {
      console.log(chalk.gray(`Stopped: Reached PR limit (${ctx.maxPrs})`));
    } else if (ctx.endTime && Date.now() >= ctx.endTime) {
      const exhaustedLabel = ctx.totalMinutes! < 60
        ? `${Math.round(ctx.totalMinutes!)}m`
        : ctx.totalMinutes! % 60 === 0
          ? `${ctx.totalMinutes! / 60}h`
          : `${Math.floor(ctx.totalMinutes! / 60)}h ${Math.round(ctx.totalMinutes! % 60)}m`;
      console.log(chalk.gray(`Stopped: Time budget exhausted (${exhaustedLabel})`));
    }
  }
}
