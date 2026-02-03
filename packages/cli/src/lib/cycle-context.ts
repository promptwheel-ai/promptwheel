/**
 * Cycle context for convergence-aware scout prompting.
 *
 * Tracks recent cycle outcomes so the scout can propose follow-up work
 * instead of random scattershot. Also computes convergence metrics
 * to guide session-level decisions.
 */

import type { SectorState } from './sectors.js';

// ---------------------------------------------------------------------------
// Cycle Summary
// ---------------------------------------------------------------------------

export interface CycleSummary {
  cycle: number;
  scope: string;
  formula: string;
  succeeded: Array<{ title: string; category: string }>;
  failed: Array<{ title: string; reason: string }>;
  noChanges: string[];
}

/**
 * Build an XML block summarizing recent cycle outcomes for the scout prompt.
 * Optionally includes recent diff summaries for follow-up awareness.
 */
export function buildCycleContextBlock(
  recentCycles: CycleSummary[],
  recentDiffs?: Array<{ title: string; summary: string; files: string[]; cycle: number }>,
): string {
  if ((!recentCycles || recentCycles.length === 0) && (!recentDiffs || recentDiffs.length === 0)) return '';

  const lines: string[] = ['<recent-cycles>', '## Recent Cycle Outcomes', ''];

  for (const c of (recentCycles ?? [])) {
    lines.push(`### Cycle ${c.cycle} — scope: ${c.scope}, formula: ${c.formula}`);
    if (c.succeeded.length > 0) {
      lines.push('Succeeded:');
      for (const s of c.succeeded) {
        lines.push(`- [${s.category}] ${s.title}`);
      }
    }
    if (c.failed.length > 0) {
      lines.push('Failed:');
      for (const f of c.failed) {
        lines.push(`- ${f.title} (${f.reason})`);
      }
    }
    if (c.noChanges.length > 0) {
      lines.push('No changes produced:');
      for (const nc of c.noChanges) {
        lines.push(`- ${nc}`);
      }
    }
    lines.push('');
  }

  // Append recent diffs for follow-up awareness
  if (recentDiffs && recentDiffs.length > 0) {
    lines.push('<recent-diffs>');
    for (const d of recentDiffs.slice(-5)) {
      lines.push(`Title: "${d.title}", Files: [${d.files.join(', ')}], Changes: ${d.summary}`);
    }
    lines.push('Consider proposing follow-up work based on these recent changes.');
    lines.push('</recent-diffs>');
    lines.push('');
  }

  lines.push('Use these outcomes to propose FOLLOW-UP work.');
  lines.push('Fix what failed. Build on what succeeded. Avoid repeating no-change proposals.');
  lines.push('</recent-cycles>');

  return lines.join('\n');
}

/**
 * Ring buffer push — keeps at most `max` entries.
 */
export function pushCycleSummary(
  buf: CycleSummary[],
  summary: CycleSummary,
  max: number = 5,
): CycleSummary[] {
  const result = [...buf, summary];
  if (result.length > max) {
    return result.slice(result.length - max);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Convergence Metrics
// ---------------------------------------------------------------------------

export interface ConvergenceMetrics {
  polishedSectorPct: number;
  avgProposalYield: number;
  learningsDensity: number;
  successRateTrend: 'improving' | 'stable' | 'declining';
  suggestedAction: 'continue' | 'widen_scope' | 'deepen' | 'stop';
  mergeRate: number;
  velocity: { prsPerHour: number; mergeRatePercent: number };
}

/**
 * Compute convergence metrics from sectors, learnings count, and recent cycles.
 */
export function computeConvergenceMetrics(
  sectorState: SectorState,
  learningsCount: number,
  recentCycles: CycleSummary[],
  sessionContext?: { elapsedMs: number; prsCreated: number; prsMerged: number; prsClosed: number },
): ConvergenceMetrics {
  const prodSectors = sectorState.sectors.filter(s => s.production && s.fileCount > 0);
  const polishedCount = prodSectors.filter(s => (s as any).polishedAt > 0).length;
  const polishedSectorPct = prodSectors.length > 0
    ? Math.round((polishedCount / prodSectors.length) * 100)
    : 0;

  const scannedSectors = prodSectors.filter(s => s.scanCount > 0);
  const avgProposalYield = scannedSectors.length > 0
    ? scannedSectors.reduce((sum, s) => sum + s.proposalYield, 0) / scannedSectors.length
    : 0;

  const totalFiles = prodSectors.reduce((sum, s) => sum + s.fileCount, 0);
  const learningsDensity = totalFiles > 0 ? learningsCount / totalFiles : 0;

  // Compute success rate trend from last 3 cycles
  let successRateTrend: ConvergenceMetrics['successRateTrend'] = 'stable';
  if (recentCycles.length >= 3) {
    const rates = recentCycles.slice(-3).map(c => {
      const total = c.succeeded.length + c.failed.length + c.noChanges.length;
      return total > 0 ? c.succeeded.length / total : 0;
    });
    const first = rates[0];
    const last = rates[rates.length - 1];
    if (last - first > 0.1) successRateTrend = 'improving';
    else if (first - last > 0.1) successRateTrend = 'declining';
  }

  // Determine suggested action
  let suggestedAction: ConvergenceMetrics['suggestedAction'] = 'continue';
  if (polishedSectorPct > 80 && avgProposalYield < 0.5) {
    suggestedAction = 'stop';
  } else if (polishedSectorPct > 60 && successRateTrend === 'declining') {
    suggestedAction = 'widen_scope';
  } else if (avgProposalYield > 1.5 && successRateTrend === 'improving') {
    suggestedAction = 'deepen';
  }

  // Merge rate from sector-level data
  let totalMerged = 0;
  let totalClosed = 0;
  for (const s of prodSectors) {
    totalMerged += (s as any).mergeCount ?? 0;
    totalClosed += (s as any).closedCount ?? 0;
  }
  const mergeRate = (totalMerged + totalClosed) > 0
    ? totalMerged / (totalMerged + totalClosed)
    : NaN;

  // Velocity from session context
  const elapsedHours = sessionContext ? sessionContext.elapsedMs / 3_600_000 : 0;
  const prsPerHour = elapsedHours > 0 ? (sessionContext?.prsCreated ?? 0) / elapsedHours : 0;
  const mergedTotal = sessionContext?.prsMerged ?? 0;
  const closedTotal = sessionContext?.prsClosed ?? 0;
  const mergeRatePercent = (mergedTotal + closedTotal) > 0
    ? Math.round((mergedTotal / (mergedTotal + closedTotal)) * 100)
    : 0;

  return {
    polishedSectorPct, avgProposalYield, learningsDensity, successRateTrend, suggestedAction,
    mergeRate,
    velocity: { prsPerHour, mergeRatePercent },
  };
}

const TREND_ARROWS: Record<string, string> = {
  improving: '\u2191',
  stable: '\u2192',
  declining: '\u2193',
};

/**
 * Format a one-liner convergence summary for console output.
 */
export function formatConvergenceOneLiner(m: ConvergenceMetrics): string {
  const arrow = TREND_ARROWS[m.successRateTrend] ?? '→';
  const velStr = m.velocity.prsPerHour > 0 ? `, ${m.velocity.prsPerHour.toFixed(1)} PRs/h` : '';
  const mergeStr = !isNaN(m.mergeRate) ? `, merge ${Math.round(m.mergeRate * 100)}%` : '';
  return `Convergence: ${m.polishedSectorPct}% polished, yield ${m.avgProposalYield.toFixed(1)}/scan, success ${arrow}${velStr}${mergeStr} — ${m.suggestedAction}`;
}
