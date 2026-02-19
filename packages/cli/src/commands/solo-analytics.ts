/**
 * Analytics command - view metrics from instrumented systems
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { createGitService } from '../lib/git.js';
import { analyzeMetrics, readMetrics, type MetricsSummary } from '../lib/metrics.js';
import { readRunHistory, type RunHistoryEntry } from '../lib/run-history.js';
import { getLearningEffectiveness } from '../lib/learnings.js';
import { analyzeErrorLedger } from '../lib/error-ledger.js';
import { analyzePrOutcomes } from '../lib/pr-outcomes.js';
import { analyzeSpindleIncidents } from '../lib/spindle-incidents.js';
import { readRunState } from '../lib/run-state.js';
import { loadTrajectoryState, loadTrajectories } from '../lib/trajectory.js';

export function registerAnalyticsCommands(solo: Command): void {
  solo
    .command('analytics')
    .description('View system metrics and identify what\'s valuable')
    .option('--raw', 'Show raw metrics data')
    .option('--system <name>', 'Filter by system (learnings, dedup, spindle, sectors, wave)')
    .option('--verbose', 'Show detailed per-system breakdown')
    .action(async (options: { raw?: boolean; system?: string; verbose?: boolean }) => {
      const git = createGitService();
      const repoRoot = await git.findRepoRoot(process.cwd());

      if (!repoRoot) {
        console.error(chalk.red('✗ Not a git repository'));
        process.exit(1);
      }

      const events = readMetrics(repoRoot);

      if (events.length === 0) {
        console.log(chalk.yellow('No metrics data yet.'));
        console.log(chalk.gray('Run promptwheel to generate metrics.'));
        return;
      }

      if (options.raw) {
        const filtered = options.system
          ? events.filter(e => e.system === options.system)
          : events;
        for (const event of filtered.slice(-100)) {
          console.log(JSON.stringify(event));
        }
        return;
      }

      const summary = analyzeMetrics(repoRoot);
      const history = readRunHistory(repoRoot, 50);
      const learningStats = getLearningEffectiveness(repoRoot);

      if (options.verbose) {
        displayVerboseAnalytics(summary, learningStats);
      } else {
        displayCompactAnalytics(summary, history, learningStats, repoRoot);
      }
    });
}

interface LearningStats {
  total: number;
  applied: number;
  successRate: number;
  topPerformers: Array<{ id: string; text: string; effectiveness: number }>;
}

/**
 * Compact analytics display - what's working, what needs attention, recommendations
 */
function displayCompactAnalytics(
  summary: MetricsSummary,
  history: RunHistoryEntry[],
  learningStats: LearningStats,
  repoRoot: string,
): void {
  const duration = summary.timeRange.end - summary.timeRange.start;
  const hours = Math.round(duration / 3600000 * 10) / 10;

  console.log(chalk.cyan('\n📊 PromptWheel Value Report\n'));
  console.log(chalk.gray(`Data: ${new Date(summary.timeRange.start).toLocaleDateString()} to ${new Date(summary.timeRange.end).toLocaleDateString()} (${hours}h)`));
  console.log();

  // Collect working/attention items
  const working: string[] = [];
  const attention: string[] = [];
  const recommendations: string[] = [];

  // Learnings with effectiveness
  const learnings = summary.bySystem['learnings'];
  if (learnings || learningStats.total > 0) {
    const selected = learnings?.events['selected'] || 0;
    const applied = learningStats.applied;
    const effectivenessStr = learningStats.applied > 0
      ? `, ${Math.round(learningStats.successRate * 100)}% effective`
      : '';

    if (applied > 0) {
      working.push(`Learnings: ${applied} applied${effectivenessStr}`);
      if (learningStats.successRate < 0.5 && learningStats.applied >= 5) {
        attention.push('Learnings effectiveness below 50%');
        recommendations.push('Review learnings with `promptwheel analytics --verbose`');
      }
    } else if (selected > 0) {
      working.push(`Learnings: ${selected} selected for context`);
    } else if (learningStats.total > 0) {
      attention.push(`Learnings: ${learningStats.total} stored but none applied`);
      recommendations.push('Learnings may not match current work patterns');
    } else {
      recommendations.push('Build learnings by running more sessions');
    }
  }

  // Dedup
  const dedup = summary.bySystem['dedup'];
  if (dedup) {
    const blocked = dedup.events['duplicate_found'] || 0;
    if (blocked > 0) {
      const estHours = Math.round(blocked * 0.25 * 10) / 10; // ~15min saved per dupe
      working.push(`Dedup: ${blocked} duplicates blocked (~${estHours}h saved)`);
    } else {
      // Not necessarily bad - might just mean no duplicates
    }
  }

  // Spindle
  const spindle = summary.bySystem['spindle'];
  if (spindle) {
    const triggered = spindle.events['triggered'] || 0;
    const checks = spindle.events['check_passed'] || 0;
    if (triggered > 0) {
      working.push(`Spindle: ${triggered} loops prevented`);
    } else if (checks > 0) {
      // Active but not triggering - good
    } else {
      attention.push('Spindle: not active (no checks recorded)');
    }
  }

  // Sectors
  const sectors = summary.bySystem['sectors'];
  if (sectors) {
    const picks = sectors.events['picked'] || 0;
    if (picks > 1) {
      working.push(`Sectors: ${picks} rotations for coverage`);
    } else if (picks === 1) {
      attention.push('Sectors: only 1 pick (limited rotation)');
      recommendations.push('Run multi-cycle sessions (--hours) for better coverage');
    }
  }

  // Wave
  const wave = summary.bySystem['wave'];
  if (wave) {
    const partitions = wave.events['partitioned'] || 0;
    if (partitions > 0) {
      working.push(`Wave: ${partitions} parallel partitions`);
    } else {
      // Only relevant if parallel > 1
    }
  }

  // Session stats from history
  const totalCompleted = history.reduce((sum, h) => sum + h.ticketsCompleted, 0);
  const totalFailed = history.reduce((sum, h) => sum + h.ticketsFailed, 0);
  const successRate = totalCompleted + totalFailed > 0
    ? Math.round(totalCompleted / (totalCompleted + totalFailed) * 100)
    : 0;

  if (totalCompleted > 0) {
    if (successRate >= 80) {
      working.push(`Success rate: ${successRate}% (${totalCompleted}/${totalCompleted + totalFailed} tickets)`);
    } else {
      attention.push(`Success rate: ${successRate}% (below 80% target)`);
      recommendations.push('Review failed tickets for patterns');
    }
  }

  // --- New observability sections ---

  // Performance Breakdown (phase timing)
  const timingHistory = history.filter((h): h is RunHistoryEntry & { phaseTiming: NonNullable<RunHistoryEntry['phaseTiming']> } => h.phaseTiming !== undefined && h.phaseTiming !== null);
  if (timingHistory.length > 0) {
    let tScout = 0, tExec = 0, tQa = 0, tGit = 0;
    for (const h of timingHistory) {
      tScout += h.phaseTiming.totalScoutMs;
      tExec += h.phaseTiming.totalExecuteMs;
      tQa += h.phaseTiming.totalQaMs;
      tGit += h.phaseTiming.totalGitMs;
    }
    const total = tScout + tExec + tQa + tGit;
    if (total > 0) {
      const fmtPhase = (ms: number) => {
        const pct = Math.round(ms / total * 100);
        const mins = (ms / 60000).toFixed(1);
        return `${mins}m (${pct}%)`;
      };
      working.push(`Timing: Scout ${fmtPhase(tScout)} | Exec ${fmtPhase(tExec)} | QA ${fmtPhase(tQa)} | Git ${fmtPhase(tGit)}`);
    }
  }

  // Category Performance
  try {
    const rs = readRunState(repoRoot);
    if (rs.categoryStats && Object.keys(rs.categoryStats).length > 0) {
      const catLines: string[] = [];
      for (const [cat, stats] of Object.entries(rs.categoryStats).sort((a, b) => b[1].successRate - a[1].successRate)) {
        if (stats.proposals === 0) continue;
        const pct = Math.round(stats.successRate * 100);
        const confStr = stats.confidenceAdjustment > 0 ? `+${stats.confidenceAdjustment}` : `${stats.confidenceAdjustment}`;
        catLines.push(`${cat} ${pct}% (${stats.success}/${stats.proposals}) conf:${confStr}`);
      }
      if (catLines.length > 0) {
        working.push(`Categories: ${catLines.slice(0, 4).join(' | ')}`);
      }
    }
  } catch { /* non-fatal */ }

  // PR Outcomes
  try {
    const prSummary = analyzePrOutcomes(repoRoot);
    if (prSummary.total > 0) {
      const mergeRatePct = Math.round(prSummary.mergeRate * 100);
      let prStr = `PRs: ${prSummary.total} total | ${prSummary.merged} merged (${mergeRatePct}%) | ${prSummary.closed} closed | ${prSummary.open} open`;
      if (prSummary.avgTimeToMergeMs !== null) {
        const hours = (prSummary.avgTimeToMergeMs / 3600000).toFixed(1);
        prStr += ` | avg merge: ${hours}h`;
      }
      working.push(prStr);
    }
  } catch { /* non-fatal */ }

  // Error Patterns
  try {
    const errorPatterns = analyzeErrorLedger(repoRoot);
    if (errorPatterns.length > 0) {
      const topPatterns = errorPatterns.slice(0, 3).map(p =>
        `${p.failureType}: ${p.count} (cmd: ${p.failedCommand})`
      ).join(' | ');
      attention.push(`Error patterns: ${topPatterns}`);
    }
  } catch { /* non-fatal */ }

  // Cost (last 7 days)
  const costHistory = history.filter((h): h is RunHistoryEntry & { tokenUsage: NonNullable<RunHistoryEntry['tokenUsage']> } => h.tokenUsage !== undefined && h.tokenUsage !== null);
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const recentCostHistory = costHistory.filter(h => new Date(h.timestamp).getTime() > sevenDaysAgo);
  if (recentCostHistory.length > 0) {
    let totalCost = 0;
    let ticketCount = 0;
    for (const h of recentCostHistory) {
      totalCost += h.tokenUsage.totalCostUsd;
      ticketCount += h.ticketsCompleted + h.ticketsFailed;
    }
    const perTicket = ticketCount > 0 ? (totalCost / ticketCount).toFixed(2) : '?';
    working.push(`Cost (7d): $${totalCost.toFixed(2)} across ${recentCostHistory.length} sessions | $${perTicket}/ticket`);
  }

  // Learning ROI
  try {
    const rs = readRunState(repoRoot);
    const snapshots = rs.learningSnapshots ?? [];
    if (snapshots.length > 0) {
      const latest = snapshots[snapshots.length - 1];
      const effPct = Math.round(latest.successRate * 100);
      const lowStr = latest.lowPerformers.length > 0 ? ` | ${latest.lowPerformers.length} low performers` : '';
      working.push(`Learning ROI: ${effPct}% effective${lowStr}`);
    }
  } catch { /* non-fatal */ }

  // Spindle Incidents
  try {
    const incidents = analyzeSpindleIncidents(repoRoot);
    if (incidents.length > 0) {
      const totalIncidents = incidents.reduce((s, i) => s + i.count, 0);
      const breakdown = incidents.slice(0, 3).map(i => `${i.trigger} (${i.count})`).join(', ');
      if (totalIncidents > 3) {
        attention.push(`Spindle: ${totalIncidents} incidents | ${breakdown}`);
      } else {
        working.push(`Spindle incidents: ${totalIncidents} | ${breakdown}`);
      }
    }
  } catch { /* non-fatal */ }

  // Trajectory Progress
  try {
    const trajState = loadTrajectoryState(repoRoot);
    if (trajState) {
      const trajectories = loadTrajectories(repoRoot);
      const traj = trajectories.find(t => t.name === trajState.trajectoryName);
      const totalSteps = Object.keys(trajState.stepStates).length;
      const completed = Object.values(trajState.stepStates).filter(s => s.status === 'completed').length;
      const failed = Object.values(trajState.stepStates).filter(s => s.status === 'failed').length;
      const active = Object.values(trajState.stepStates).find(s => s.status === 'active');
      const activeTitle = active && traj
        ? traj.steps.find(s => s.id === active.stepId)?.title ?? active.stepId
        : active?.stepId ?? null;
      const paused = trajState.paused ? ' (paused)' : '';

      if (completed === totalSteps) {
        working.push(`Trajectory "${trajState.trajectoryName}": complete (${totalSteps}/${totalSteps} steps)`);
      } else if (activeTitle) {
        working.push(`Trajectory "${trajState.trajectoryName}": ${completed}/${totalSteps} steps${paused} | current: ${activeTitle}`);
      } else {
        const statusParts = [`${completed}/${totalSteps} steps`];
        if (failed > 0) statusParts.push(`${failed} failed`);
        attention.push(`Trajectory "${trajState.trajectoryName}": ${statusParts.join(', ')}${paused} | stalled`);
      }
    }
  } catch { /* non-fatal */ }

  // Display sections
  if (working.length > 0) {
    console.log(chalk.green('┌─────────────────────────────────────────────────────────┐'));
    console.log(chalk.green('│ WORKING WELL                                            │'));
    console.log(chalk.green('├─────────────────────────────────────────────────────────┤'));
    for (const item of working) {
      console.log(chalk.green(`│ ✓ ${item.padEnd(55)}│`));
    }
    console.log(chalk.green('└─────────────────────────────────────────────────────────┘'));
    console.log();
  }

  if (attention.length > 0) {
    console.log(chalk.yellow('┌─────────────────────────────────────────────────────────┐'));
    console.log(chalk.yellow('│ NEEDS ATTENTION                                         │'));
    console.log(chalk.yellow('├─────────────────────────────────────────────────────────┤'));
    for (const item of attention) {
      console.log(chalk.yellow(`│ ⚠ ${item.padEnd(55)}│`));
    }
    console.log(chalk.yellow('└─────────────────────────────────────────────────────────┘'));
    console.log();
  }

  if (recommendations.length > 0) {
    console.log(chalk.cyan('┌─────────────────────────────────────────────────────────┐'));
    console.log(chalk.cyan('│ RECOMMENDATIONS                                         │'));
    console.log(chalk.cyan('├─────────────────────────────────────────────────────────┤'));
    for (const item of recommendations) {
      console.log(chalk.cyan(`│ • ${item.padEnd(55)}│`));
    }
    console.log(chalk.cyan('└─────────────────────────────────────────────────────────┘'));
    console.log();
  }

  if (working.length === 0 && attention.length === 0) {
    console.log(chalk.gray('Not enough data yet. Run more sessions to generate insights.'));
    console.log();
  }

  console.log(chalk.gray('Use --verbose for detailed per-system breakdown.'));
  console.log();
}

/**
 * Verbose analytics display - full per-system breakdown
 */
function displayVerboseAnalytics(summary: MetricsSummary, learningStats: LearningStats): void {
  const duration = summary.timeRange.end - summary.timeRange.start;
  const hours = Math.round(duration / 3600000 * 10) / 10;

  console.log(chalk.cyan('\n📊 System Value Analysis (Verbose)\n'));
  console.log(chalk.gray(`Data from: ${new Date(summary.timeRange.start).toLocaleDateString()} to ${new Date(summary.timeRange.end).toLocaleDateString()}`));
  console.log(chalk.gray(`Total events: ${summary.totalEvents} over ${hours}h\n`));

  // Learnings analysis with effectiveness
  const learnings = summary.bySystem['learnings'];
  console.log(chalk.white('📚 Learnings System'));
  if (learnings) {
    console.log(chalk.gray(`   Loaded: ${learnings.events['loaded'] || 0} times`));
    console.log(chalk.gray(`   Selected: ${learnings.events['selected'] || 0} times`));
  }
  console.log(chalk.gray(`   Total stored: ${learningStats.total}`));
  console.log(chalk.gray(`   Applied: ${learningStats.applied} times`));
  if (learningStats.applied > 0) {
    const effPct = Math.round(learningStats.successRate * 100);
    const effColor = effPct >= 70 ? chalk.green : effPct >= 50 ? chalk.yellow : chalk.red;
    console.log(effColor(`   Effectiveness: ${effPct}%`));
  }
  if (learningStats.topPerformers.length > 0) {
    console.log(chalk.gray('   Top performers:'));
    for (const p of learningStats.topPerformers.slice(0, 3)) {
      const effPct = Math.round(p.effectiveness * 100);
      const truncText = p.text.length > 40 ? p.text.slice(0, 40) + '...' : p.text;
      console.log(chalk.gray(`     ${effPct}%: ${truncText}`));
    }
  }
  console.log();

  // Dedup analysis
  const dedup = summary.bySystem['dedup'];
  if (dedup) {
    console.log(chalk.white('🔄 Dedup Memory'));
    console.log(chalk.gray(`   Loaded: ${dedup.events['loaded'] || 0} times`));
    console.log(chalk.gray(`   Duplicates blocked: ${dedup.events['duplicate_found'] || 0}`));
    const value = (dedup.events['duplicate_found'] || 0) > 0 ? '✓ Saving work' : '○ No duplicates found';
    console.log(chalk.gray(`   Value: ${value}\n`));
  }

  // Spindle analysis
  const spindle = summary.bySystem['spindle'];
  if (spindle) {
    console.log(chalk.white('🔴 Spindle (Loop Detection)'));
    console.log(chalk.gray(`   Checks passed: ${spindle.events['check_passed'] || 0}`));
    console.log(chalk.gray(`   Triggered: ${spindle.events['triggered'] || 0}`));
    const triggered = spindle.events['triggered'] || 0;
    const value = triggered > 0 ? '✓ Preventing loops' : '○ No loops detected';
    console.log(chalk.gray(`   Value: ${value}\n`));
  }

  // Sectors analysis
  const sectors = summary.bySystem['sectors'];
  if (sectors) {
    console.log(chalk.white('🗺️  Sectors (Scope Rotation)'));
    console.log(chalk.gray(`   Picks: ${sectors.events['picked'] || 0}`));
    const value = (sectors.events['picked'] || 0) > 1 ? '✓ Rotating coverage' : '⚠ Minimal rotation';
    console.log(chalk.gray(`   Value: ${value}\n`));
  }

  // Wave scheduling analysis
  const wave = summary.bySystem['wave'];
  if (wave) {
    console.log(chalk.white('🌊 Wave Scheduling'));
    console.log(chalk.gray(`   Partitions: ${wave.events['partitioned'] || 0}`));
    const partitions = wave.events['partitioned'] || 0;
    const value = partitions > 0 ? '✓ Parallelization active' : '○ Not used (parallel=1?)';
    console.log(chalk.gray(`   Value: ${value}\n`));
  }

  // Session tracking
  const session = summary.bySystem['session'];
  if (session) {
    console.log(chalk.white('📍 Sessions'));
    console.log(chalk.gray(`   Started: ${session.events['started'] || 0}`));
    console.log();
  }
}
