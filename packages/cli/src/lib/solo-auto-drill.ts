/**
 * Drill mode — auto-generate trajectories from scout output in spin mode.
 *
 * When drill mode is active and no trajectory is loaded, runs a broad survey
 * scout, generates a trajectory from the proposals, and activates it. The spin
 * loop then executes trajectory-guided cycles until the trajectory completes
 * or stalls, at which point drill generates a fresh one.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import chalk from 'chalk';
import type { TicketProposal } from '@promptwheel/core/scout';
import type { AutoSessionState } from './solo-auto-state.js';
import { getPromptwheelDir } from './solo-config.js';
import { scoutAllSectors } from './solo-auto-planning.js';
import { generateTrajectoryFromProposals } from './trajectory-generate.js';
import { activateTrajectory, loadTrajectory, saveTrajectoryState } from './trajectory.js';
import {
  getNextStep as getTrajectoryNextStep,
  trajectoryComplete,
  preVerifyAndAdvanceSteps as preVerifyAndAdvanceStepsFn,
} from '@promptwheel/core/trajectory/shared';
import { runMeasurement } from './goals.js';
import { formatLearningsForPrompt, selectRelevant } from './learnings.js';
import { formatDedupForPrompt, type DedupEntry } from './dedup-memory.js';
import { matchAgainstMemory } from '@promptwheel/core/dedup/shared';
import { readHints as readHintsForDrill, writeHints as writeHintsForDrill } from './solo-hints.js';

/**
 * Result of a drill trajectory generation attempt.
 * - `generated`: New trajectory created and activated
 * - `cooldown`: Skipped due to cooldown period
 * - `failed`: Generation attempted but failed (LLM error, validation error, etc.)
 * - `insufficient`: Not enough proposals found (codebase may be polished)
 * - `low_quality`: Proposals found but below quality gate (try lowering thresholds)
 * - `stale`: Proposals found but dropped by freshness filter (wait for external changes)
 */
export type DrillResult = 'generated' | 'cooldown' | 'failed' | 'insufficient' | 'low_quality' | 'stale';

// ── Adaptive cooldown ────────────────────────────────────────────────────────

const COOLDOWN_MIN_HISTORY = 3;            // entries needed before adaptation kicks in

/**
 * Compute cooldown cycles based on last trajectory outcome and historical success rate.
 * First generation always returns 0. After that, applies adaptive tuning via a smooth
 * sigmoid curve mapping recency-weighted completion rate to cooldown adjustment.
 *
 * Base cooldown uses granular completionPct from the last trajectory:
 * - completionPct >= 0.8 → treated as completed (base = cooldownCompleted, default 0)
 * - completionPct < 0.2 → treated as fully stalled (base = cooldownStalled, default 5)
 * - Between → interpolated (e.g., 50% completion → ~2.5 base cooldown)
 *
 * Sigmoid adjustment (recency-weighted rate → adjustment):
 *   rate=0.0 → +4, rate=0.25 → +3, rate=0.5 → 0, rate=0.75 → -3, rate=1.0 → -4
 */
/** @internal Exported for testing. */
export function getDrillCooldown(state: AutoSessionState): number {
  if (state.drillTrajectoriesGenerated === 0) return 0;
  const drillConf = state.autoConf.drill;
  const cooldownCompleted = drillConf?.cooldownCompleted ?? 0;
  const cooldownStalled = drillConf?.cooldownStalled ?? 5;

  // Step-1 failure override: immediate retry when failure rate is critical.
  // Forces conservative ambition + zero cooldown to break the failure pattern.
  const step1Critical = drillConf?.ambitionThresholds?.step1Critical ?? 0.4;
  if (state.drillHistory.length >= COOLDOWN_MIN_HISTORY) {
    const metrics = computeDrillMetrics(state.drillHistory);
    if (metrics.step1FailureRate > step1Critical) {
      return 0;
    }
  }

  // Use granular completionPct from last trajectory for interpolated base cooldown
  const lastEntry = state.drillHistory.length > 0
    ? state.drillHistory[state.drillHistory.length - 1]
    : undefined;

  let baseCooldown: number;
  if (!lastEntry && state.drillLastOutcome === null) {
    // No history and unknown outcome → moderate default
    baseCooldown = Math.round((cooldownCompleted + cooldownStalled) / 2);
  } else {
    const lastPct = lastEntry?.completionPct ?? (state.drillLastOutcome === 'completed' ? 1 : 0);
    // Interpolate: pct=1.0 → cooldownCompleted, pct=0.0 → cooldownStalled
    baseCooldown = Math.round(cooldownStalled + (cooldownCompleted - cooldownStalled) * lastPct);
  }

  // Smooth sigmoid adaptation based on recency-weighted success rate
  if (state.drillHistory.length >= COOLDOWN_MIN_HISTORY) {
    const rate = computeDrillMetrics(state.drillHistory).weightedCompletionRate;
    // Sigmoid: smooth mapping from rate to adjustment
    // rate=0 → +4 (more cooldown), rate=0.5 → 0, rate=1.0 → -4 (less cooldown)
    const sigmoid = 1 / (1 + Math.exp(-6 * (rate - 0.5)));
    const adjustment = Math.round(4 - 8 * sigmoid);

    // Freshness filter → cooldown bridge: adjust based on last generation's stale ratio.
    // Many proposals stale → survey sooner. Very few stale → can wait longer.
    let freshnessAdj = 0;
    if (state.drillLastFreshnessDropRatio !== null) {
      if (state.drillLastFreshnessDropRatio > 0.5) {
        freshnessAdj = -2; // many proposals stale → survey sooner
      } else if (state.drillLastFreshnessDropRatio < 0.1) {
        freshnessAdj = 1;  // very few stale → can wait longer
      }
    }

    // ±N jitter prevents lockstep patterns in long sessions (configurable, default ±1)
    const jitterRange = drillConf?.cooldownJitter ?? 1;
    const jitter = jitterRange > 0
      ? Math.round(Math.random() * jitterRange * 2) - jitterRange
      : 0;
    return Math.max(0, baseCooldown + adjustment + freshnessAdj + jitter);
  }

  return baseCooldown;
}

/**
 * Compute adaptive proposal thresholds based on historical success rate.
 * Returns adjusted min/max proposals — scales with drill effectiveness.
 */
/** @internal Exported for testing. */
export function getAdaptiveProposalThresholds(state: AutoSessionState): { min: number; max: number } {
  const drillConf = state.autoConf.drill;
  let min = drillConf?.minProposals ?? 3;
  let max = drillConf?.maxProposals ?? 10;

  if (state.drillHistory.length >= 3) {
    const metrics = computeDrillMetrics(state.drillHistory);
    if (metrics.weightedCompletionRate > 0.7) {
      // High recent success — lower the bar (we generate good trajectories)
      min = Math.max(2, min - 1);
      max = max + 2;
    } else if (metrics.weightedCompletionRate < 0.3) {
      // Low recent success — raise the bar (need better proposals)
      min = min + 1;
      max = Math.max(min + 1, max - 2);
    }
  }

  return { min, max };
}

// ── Staleness detection ─────────────────────────────────────────────────────

/**
 * Measure code staleness since a given timestamp — gradient from 0.0 (completely fresh)
 * to 1.0 (very stale, lots of changes). Returns the number of commits as a
 * normalized staleness score. Binary check: staleness > 0 means some changes exist.
 *
 * When `excludeOwnCommits` is true (default), excludes PromptWheel's own commits
 * so only external changes are measured. Set to false for drill survey gating —
 * PromptWheel's own commits change the codebase and create new patterns worth scanning.
 * Falls back to 1.0 (assume fully stale) if git is unavailable.
 */
function measureCodeStaleness(repoRoot: string, sinceTimestamp: number, logBase: number = 11, excludeOwnCommits: boolean = true): number {
  try {
    // Validate timestamp — reject NaN, negative, or unreasonably old/future values
    if (!Number.isFinite(sinceTimestamp) || sinceTimestamp <= 0) return 1.0;
    const sinceDate = new Date(sinceTimestamp).toISOString();
    const args = ['log', '--oneline', `--since=${sinceDate}`];
    if (excludeOwnCommits) {
      // Use --invert-grep to exclude commits authored by PromptWheel
      args.push('--invert-grep', '--grep=\\[promptwheel\\]', '--grep=Co-Authored-By: Claude');
    }
    args.push('--', '.');
    const result = spawnSync('git', args, {
      cwd: repoRoot,
      timeout: 5000,
      encoding: 'utf-8',
    });
    if (result.error || result.status !== 0) return 1.0; // assume stale on git error/timeout
    const lines = result.stdout.trim();
    if (!lines) return 0.0;
    const commitCount = lines.split('\n').length;
    // Log scaling: diminishing returns after first few commits
    // 1 commit ≈ 0.37, 3 commits ≈ 0.69, 5 commits ≈ 0.83, 10+ commits → ~1.0
    return Math.min(1.0, Math.log(commitCount + 1) / Math.log(logBase));
  } catch {
    return 1.0; // assume stale — better to survey unnecessarily than miss changes
  }
}

// ── Trajectory history ───────────────────────────────────────────────────────

/** Build a summary of previous drill trajectories for the generation prompt. Capped to last 10 entries. */
export function formatDrillHistoryForPrompt(state: AutoSessionState): string {
  if (state.drillHistory.length === 0) return '';

  // Cap to recent entries to avoid bloating the LLM prompt
  const MAX_HISTORY_IN_PROMPT = 10;
  const recent = state.drillHistory.slice(-MAX_HISTORY_IN_PROMPT);
  const skipped = state.drillHistory.length - recent.length;

  const lines = recent.map((h, i) => {
    const pct = h.completionPct !== undefined && h.completionPct !== null ? `${Math.round(h.completionPct * 100)}%` : `${h.stepsCompleted}/${h.stepsTotal}`;
    const status = h.outcome === 'completed'
      ? `completed (${pct})`
      : `stalled (${pct} done, ${h.stepsFailed} failed)`;
    // Strip timestamp suffix from drill names for cleaner display
    const displayName = h.name.replace(/-\d{13}$/, '');
    let entry = `${skipped + i + 1}. "${displayName}" — ${h.description} [${status}]
   Categories: ${h.categories.join(', ') || 'mixed'}
   Scopes: ${h.scopes.join(', ') || 'broad'}`;
    // Include specific failure details so LLM can learn from them
    if (h.failedSteps && h.failedSteps.length > 0) {
      const failDetails = h.failedSteps.map(f => `"${f.title}"${f.reason ? `: ${f.reason.slice(0, 100)}` : ''}`);
      entry += `\n   Failed steps: ${failDetails.join('; ')}`;
    }
    // Include completed step summaries for causal chaining
    if (h.completedStepSummaries && h.completedStepSummaries.length > 0) {
      entry += `\n   Completed work: ${h.completedStepSummaries.slice(0, 3).join('; ')}`;
    }
    // Include modified files so next trajectory can build on them
    if (h.modifiedFiles && h.modifiedFiles.length > 0) {
      const files = h.modifiedFiles.slice(0, 8);
      entry += `\n   Modified files: ${files.join(', ')}${h.modifiedFiles.length > 8 ? ` (+${h.modifiedFiles.length - 8} more)` : ''}`;
    }
    return entry;
  });

  if (skipped > 0) {
    lines.unshift(`(${skipped} older trajectories omitted)`);
  }

  return lines.join('\n');
}

// ── Theme diversity ──────────────────────────────────────────────────────────

/**
 * Compute recency-weighted coverage counts from drill history.
 * Recent trajectories contribute more to coverage than old ones, so categories
 * explored 20+ trajectories ago get fresh exploration scores again.
 * Uses exponential decay with half-life of 10 entries.
 *
 * @internal Exported for testing.
 */
export function computeDecayedCoverage(history: DrillHistoryEntry[]): {
  categories: Map<string, number>;
  scopes: Map<string, number>;
} {
  const DECAY_LAMBDA = Math.LN2 / 10; // half-life of 10 entries
  const categories = new Map<string, number>();
  const scopes = new Map<string, number>();

  for (let i = 0; i < history.length; i++) {
    const h = history[i];
    const age = history.length - 1 - i; // 0 = newest
    const weight = Math.exp(-DECAY_LAMBDA * age);

    for (const cat of h.categories) {
      categories.set(cat, (categories.get(cat) ?? 0) + weight);
    }
    for (const scope of h.scopes) {
      scopes.set(scope, (scopes.get(scope) ?? 0) + weight);
    }
  }

  return { categories, scopes };
}

/**
 * Build a diversity hint with numeric exploration scores for the generation prompt.
 * Score = 1/(decayedCount + 1) — higher score means less explored (preferred).
 * Uses recency-weighted counts so old coverage fades over time.
 *
 * All standard categories are listed so the LLM knows the full palette.
 */
function formatDiversityHint(state: AutoSessionState): string {
  if (state.drillHistory.length === 0 && state.drillCoveredCategories.size === 0 && state.drillCoveredScopes.size === 0) return '';

  const parts: string[] = [];
  const allCategories = ['security', 'fix', 'perf', 'refactor', 'test', 'types', 'cleanup', 'docs'];

  // Use decayed counts from history when available, fall back to raw cumulative counts
  const decayed = state.drillHistory.length > 0
    ? computeDecayedCoverage(state.drillHistory)
    : { categories: state.drillCoveredCategories, scopes: state.drillCoveredScopes };

  // Category diversity scores (decayed)
  const catScores = allCategories.map(cat => {
    const count = decayed.categories.get(cat) ?? 0;
    const score = (1 / (count + 1)).toFixed(2);
    const label = count > 0 ? ` (${count.toFixed(1)} effective coverage)` : ' (unexplored)';
    return `${cat}: ${score}${label}`;
  });
  parts.push(`Category exploration scores (higher = less explored, PREFER higher scores):\n${catScores.join('\n')}`);

  // Scope diversity scores (decayed, capped to top 20)
  if (decayed.scopes.size > 0) {
    const MAX_SCOPES_IN_PROMPT = 20;
    const sorted = [...decayed.scopes.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_SCOPES_IN_PROMPT);
    const scopeScores = sorted.map(([s, n]) => `${s}: ${(1 / (n + 1)).toFixed(2)} (${n.toFixed(1)} effective)`);
    if (decayed.scopes.size > MAX_SCOPES_IN_PROMPT) {
      scopeScores.push(`(${decayed.scopes.size - MAX_SCOPES_IN_PROMPT} more omitted)`);
    }
    parts.push(`Scope exploration scores:\n${scopeScores.join('\n')}`);
  }

  return parts.join('\n\n');
}

// ── Drill history persistence ────────────────────────────────────────────────

/** A single drill trajectory outcome — persisted to disk for cross-session diversity and metrics. */
export interface DrillHistoryEntry {
  name: string;
  description: string;
  stepsTotal: number;
  stepsCompleted: number;
  stepsFailed: number;
  outcome: 'completed' | 'stalled';
  /** Step completion percentage (0-1). More granular than binary outcome — 0.88 is nearly done, 0.11 is a failure. */
  completionPct: number;
  categories: string[];
  scopes: string[];
  timestamp?: number;
  /** Which steps failed and why (for step-level feedback) */
  failedSteps?: Array<{ id: string; title: string; reason?: string }>;
  /** What the completed steps actually changed — drives causal chaining to next trajectory */
  completedStepSummaries?: string[];
  /** Files modified by this trajectory — helps next trajectory know what's freshly changed */
  modifiedFiles?: string[];
  /** Ambition level used when generating this trajectory — enables empirical analysis */
  ambitionLevel?: AmbitionLevel;

  // ── Telemetry (for empirical tuning decisions) ──────────────────────────
  /** Per-step outcomes — enables step-level learning (which step positions stall most). */
  stepOutcomes?: Array<{ id: string; status: 'completed' | 'failed' | 'skipped' | 'pending' }>;
  /** Avg confidence of proposals at generation time — tracks proposal quality trends. */
  proposalAvgConfidence?: number;
  /** Avg impact of proposals at generation time — tracks proposal quality trends. */
  proposalAvgImpact?: number;
  /** Number of proposals dropped by freshness filter — measures filter aggressiveness. */
  freshnessDropCount?: number;
  /** Number of distinct categories in proposals at generation time — measures diversity at input. */
  proposalCategoryCount?: number;
  /** Number of proposal groups identified by blueprint file-overlap analysis. */
  blueprintGroupCount?: number;
  /** Number of cross-category conflicts detected by blueprint. */
  blueprintConflictCount?: number;
  /** Number of enabler proposals (depended upon by others). */
  blueprintEnablerCount?: number;
  /** Number of mergeable near-duplicate proposal pairs. */
  blueprintMergeableCount?: number;
  /** Whether the quality gate triggered a retry on this trajectory. */
  qualityRetried?: boolean;
  /** Number of quality issues found (0 = clean pass). */
  qualityIssueCount?: number;
  /** Model used for execution (from model routing) */
  modelUsed?: string;
}

// ── Drill metrics ────────────────────────────────────────────────────────────

/** Aggregated drill health metrics — used for session reporting, adaptive tuning, and convergence analysis. */
export interface DrillMetrics {
  totalTrajectories: number;
  completionRate: number;        // 0-1 fraction of trajectories fully completed
  /** Recency-weighted completion rate — recent outcomes count more than old ones (exponential decay, half-life ~5 entries). */
  weightedCompletionRate: number;
  avgStepCompletionRate: number; // 0-1 fraction of steps completed across all trajectories
  /** Recency-weighted average step completion percentage — uses granular completionPct per trajectory. */
  weightedStepCompletionRate: number;
  avgStepsPerTrajectory: number;
  categorySuccessRates: Record<string, { completed: number; total: number; rate: number }>;
  topCategories: string[];       // categories sorted by success rate
  stalledCategories: string[];   // categories that stall most often
  /** Fraction of trajectories that stalled on the very first step (generation quality signal) */
  step1FailureRate: number;
  /** Step-position failure rates — which positions (1st, 2nd, 3rd+) fail most often */
  stepPositionFailureRates: Array<{ position: number; failureRate: number; total: number }>;
  /** Fraction of trajectories where the quality gate fired (triggered a retry). */
  qualityGateFireRate: number;
  /** Fraction of quality-gate retries that resulted in a completed trajectory. */
  qualityGateRetrySuccessRate: number;
  /** Distribution of models used for execution (model name → count) */
  modelDistribution?: Record<string, number>;
  /** Fraction of recovery attempts that succeeded (0-1). Undefined when no recoveries attempted. */
  recoverySuccessRate?: number;
}

/**
 * Compute drill health metrics from history.
 * Uses recency-weighted exponential decay (half-life ~5 entries) so recent
 * outcomes outweigh old ones in completion rates and category success.
 */
export function computeDrillMetrics(history: DrillHistoryEntry[]): DrillMetrics {
  if (history.length === 0) {
    return {
      totalTrajectories: 0, completionRate: 0, weightedCompletionRate: 0,
      avgStepCompletionRate: 0, weightedStepCompletionRate: 0,
      avgStepsPerTrajectory: 0, categorySuccessRates: {}, topCategories: [], stalledCategories: [],
      step1FailureRate: 0, stepPositionFailureRates: [],
      qualityGateFireRate: 0, qualityGateRetrySuccessRate: 0,
    };
  }

  // Recency decay: λ = ln(2)/5 ≈ 0.1386 → half-life of 5 entries
  const DECAY_LAMBDA = Math.LN2 / 5;

  const completed = history.filter(h => h.outcome === 'completed').length;
  const completionRate = completed / history.length;

  // Recency-weighted completion rate (binary: completed=1, stalled=0)
  let weightedSum = 0;
  let weightTotal = 0;
  // Recency-weighted step completion rate (granular: completionPct 0-1)
  let weightedStepSum = 0;
  let weightedStepTotal = 0;

  let totalSteps = 0;
  let totalStepsCompleted = 0;
  for (let i = 0; i < history.length; i++) {
    const h = history[i];
    const age = history.length - 1 - i; // 0 = newest, N-1 = oldest
    const weight = Math.exp(-DECAY_LAMBDA * age);

    totalSteps += h.stepsTotal;
    totalStepsCompleted += h.stepsCompleted;

    weightedSum += (h.outcome === 'completed' ? 1 : 0) * weight;
    weightTotal += weight;

    // Use granular completionPct if available, fall back to stepsCompleted/stepsTotal
    const pct = h.completionPct ?? (h.stepsTotal > 0 ? h.stepsCompleted / h.stepsTotal : 0);
    weightedStepSum += pct * weight;
    weightedStepTotal += weight;
  }
  const weightedCompletionRate = weightTotal > 0 ? weightedSum / weightTotal : 0;
  const weightedStepCompletionRate = weightedStepTotal > 0 ? weightedStepSum / weightedStepTotal : 0;

  const avgStepCompletionRate = totalSteps > 0 ? totalStepsCompleted / totalSteps : 0;
  const avgStepsPerTrajectory = history.length > 0 ? totalSteps / history.length : 0;

  // Category success rates with recency weighting
  const catStats: Record<string, { completed: number; total: number; weightedCompleted: number; weightedTotal: number }> = {};
  for (let i = 0; i < history.length; i++) {
    const h = history[i];
    const age = history.length - 1 - i;
    const weight = Math.exp(-DECAY_LAMBDA * age);
    for (const cat of h.categories) {
      const s = catStats[cat] ??= { completed: 0, total: 0, weightedCompleted: 0, weightedTotal: 0 };
      s.total++;
      s.weightedTotal += weight;
      if (h.outcome === 'completed') {
        s.completed++;
        s.weightedCompleted += weight;
      }
    }
  }

  const categorySuccessRates: DrillMetrics['categorySuccessRates'] = {};
  for (const [cat, s] of Object.entries(catStats)) {
    // Use weighted rate for ranking, store raw counts for reporting
    const rate = s.weightedTotal > 0 ? s.weightedCompleted / s.weightedTotal : 0;
    categorySuccessRates[cat] = { completed: s.completed, total: s.total, rate };
  }

  const sorted = Object.entries(categorySuccessRates).sort((a, b) => b[1].rate - a[1].rate);
  const topCategories = sorted.filter(([, s]) => s.rate >= 0.5).map(([c]) => c);
  const stalledCategories = sorted.filter(([, s]) => s.rate < 0.3 && s.total >= 2).map(([c]) => c);

  // Step-1 failure rate: trajectories that stalled with 0 steps completed
  const step1Failures = history.filter(h => h.outcome === 'stalled' && h.stepsCompleted === 0).length;
  const step1FailureRate = step1Failures / history.length;

  // Step-position failure analysis: aggregate stepOutcomes by position
  const positionStats: Array<{ failed: number; total: number }> = [];
  for (const h of history) {
    if (!h.stepOutcomes) continue;
    for (let pos = 0; pos < h.stepOutcomes.length; pos++) {
      if (!positionStats[pos]) positionStats[pos] = { failed: 0, total: 0 };
      positionStats[pos].total++;
      if (h.stepOutcomes[pos].status === 'failed') positionStats[pos].failed++;
    }
  }
  const stepPositionFailureRates = positionStats
    .map((s, i) => ({ position: i + 1, failureRate: s.total > 0 ? s.failed / s.total : 0, total: s.total }))
    .filter(s => s.total >= 2); // need at least 2 data points

  // Quality gate metrics — how often it fires and whether retries help
  const qualityRetriedEntries = history.filter(h => h.qualityRetried === true);
  const qualityGateFireRate = qualityRetriedEntries.length / history.length;
  const qualityGateRetrySuccessRate = qualityRetriedEntries.length > 0
    ? qualityRetriedEntries.filter(h => h.outcome === 'completed').length / qualityRetriedEntries.length
    : 0;

  // Model distribution from history entries that have modelUsed
  let modelDistribution: Record<string, number> | undefined;
  const entriesWithModel = history.filter(h => h.modelUsed);
  if (entriesWithModel.length > 0) {
    modelDistribution = {};
    for (const h of entriesWithModel) {
      modelDistribution[h.modelUsed!] = (modelDistribution[h.modelUsed!] ?? 0) + 1;
    }
  }

  return {
    totalTrajectories: history.length,
    completionRate,
    weightedCompletionRate,
    avgStepCompletionRate,
    weightedStepCompletionRate,
    avgStepsPerTrajectory,
    categorySuccessRates,
    topCategories,
    stalledCategories,
    step1FailureRate,
    stepPositionFailureRates,
    qualityGateFireRate,
    qualityGateRetrySuccessRate,
    modelDistribution,
  };
}

// ── Adaptive ambition ─────────────────────────────────────────────────────────

export type AmbitionLevel = 'conservative' | 'moderate' | 'ambitious';

/**
 * Compute an ambition level from session metrics. Scales first-step complexity
 * dynamically based on weighted completion rate and step-1 failure rate.
 *
 * Includes fast-recovery: if the last 2 trajectories both completed, bump up
 * one level regardless of overall weighted rate. This prevents the system from
 * being stuck at conservative after a string of old failures.
 */
export function computeAmbitionLevel(state: AutoSessionState): AmbitionLevel {
  if (state.drillHistory.length < 3) return 'conservative';
  if (state.sessionPhase === 'cooldown') return 'conservative';
  const drillConf = state.autoConf.drill;
  const metrics = computeDrillMetrics(state.drillHistory);

  // Configurable thresholds (via config.json auto.drill.ambitionThresholds)
  const step1Critical = drillConf?.ambitionThresholds?.step1Critical ?? 0.4;
  const step1Threshold = drillConf?.ambitionThresholds?.step1Fail ?? 0.25;
  const lowCompletion = drillConf?.ambitionThresholds?.conservative ?? 0.3;
  const highCompletion = drillConf?.ambitionThresholds?.ambitious ?? 0.7;
  const step1AmbitiousMax = drillConf?.ambitionThresholds?.step1AmbitiousMax ?? 0.15;

  // Critical step-1 failure: ALWAYS conservative, no fast-recovery override.
  // This breaks the "generate bad trajectory → stall on step 1 → repeat" cycle.
  if (metrics.step1FailureRate > step1Critical) return 'conservative';

  // Fast-recovery: 2 consecutive completions → bump up one level
  const last2 = state.drillHistory.slice(-2);
  const consecutiveWins = last2.length === 2 && last2.every(h => h.outcome === 'completed');

  // Per-ambition success tracking: if ambitious has been tried and fails too often, stay moderate
  const ambitionRates = computePerAmbitionSuccessRates(state.drillHistory);

  if (metrics.step1FailureRate > step1Threshold || metrics.weightedCompletionRate < lowCompletion) {
    return consecutiveWins ? 'moderate' : 'conservative';
  }
  if (metrics.weightedCompletionRate > highCompletion && metrics.step1FailureRate < step1AmbitiousMax && state.drillHistory.length >= 5) {
    // Per-ambition guard: if ambitious trajectories have < 40% success, stay moderate
    if (ambitionRates.ambitious !== null && ambitionRates.ambitious < 0.4) return 'moderate';
    return 'ambitious';
  }
  // Fast-recovery from moderate → ambitious on streak
  if (consecutiveWins && metrics.step1FailureRate < step1AmbitiousMax && state.drillHistory.length >= 4) {
    if (ambitionRates.ambitious !== null && ambitionRates.ambitious < 0.4) return 'moderate';
    return 'ambitious';
  }
  return 'moderate';
}

/** Compute success rate per ambition level from history. Returns null if fewer than 2 entries for a level. */
export function computePerAmbitionSuccessRates(history: DrillHistoryEntry[]): {
  conservative: number | null;
  moderate: number | null;
  ambitious: number | null;
} {
  const counts = {
    conservative: { ok: 0, total: 0 },
    moderate: { ok: 0, total: 0 },
    ambitious: { ok: 0, total: 0 },
  };
  for (const h of history) {
    const level = h.ambitionLevel;
    if (level && counts[level]) {
      counts[level].total++;
      if (h.outcome === 'completed') counts[level].ok++;
    }
  }
  return {
    conservative: counts.conservative.total >= 2 ? counts.conservative.ok / counts.conservative.total : null,
    moderate: counts.moderate.total >= 2 ? counts.moderate.ok / counts.moderate.total : null,
    ambitious: counts.ambitious.total >= 2 ? counts.ambitious.ok / counts.ambitious.total : null,
  };
}

// ── Multi-trajectory arc guidance ─────────────────────────────────────────────

/**
 * Analyze the category distribution and outcomes of recent trajectories to
 * provide directional guidance for the next one — shifting focus from
 * foundation to core to polish, pivoting away from stalled areas, and
 * building on successful momentum.
 *
 * Uses primary category (first in list) for phase detection to avoid
 * double-counting trajectories that span foundation and polish categories.
 *
 * When a goalCategory is provided, biases guidance toward categories that
 * advance the active goal rather than purely phase-rotating.
 *
 * ## Equilibrium properties
 *
 * Signals are prioritized and capped at 2 to prevent contradictory advice.
 * Priority order: stall pivot > phase rotation > momentum > chain > goal.
 * Stall pivot and momentum are mutually exclusive — when both would fire,
 * a blended "selective momentum" signal is emitted instead. Chain guidance
 * is suppressed when momentum already fires (avoids double "continue" signal).
 * Goal alignment is reweighted (not suppressed) when the phase rotation already
 * directs toward the goal category — a softer nudge ensures the goal gets
 * priority within the shift rather than being silenced entirely.
 */
export function computeArcGuidance(
  state: AutoSessionState,
  goalCategory?: string,
): string | undefined {
  if (state.drillHistory.length < 2) return undefined;

  const MAX_SIGNALS = 2;
  const recentWindow = state.drillHistory.slice(-5);
  const parts: string[] = [];

  // Use primary category (first in list) per trajectory — avoids double-counting
  // trajectories like ['refactor', 'test'] as both foundation and polish
  const primaryCats = recentWindow.map(h => h.categories[0] ?? 'other');

  // Count primary category distribution
  const catCounts = new Map<string, number>();
  for (const cat of primaryCats) {
    catCounts.set(cat, (catCounts.get(cat) ?? 0) + 1);
  }
  const dominant = [...catCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([c]) => c);

  // Phase detection: foundation → core → polish (using primary category only)
  const foundationCats = new Set(['types', 'refactor', 'fix']);
  const polishCats = new Set(['test', 'docs', 'cleanup']);

  const foundationCount = primaryCats.filter(c => foundationCats.has(c)).length;
  const polishCount = primaryCats.filter(c => polishCats.has(c)).length;

  // Track which direction phase rotation suggests (used for goal dedup)
  let phaseDirection: 'polish' | 'core' | null = null;

  // Stall and momentum signals — compute both, then resolve conflicts
  const stalledInWindow = recentWindow.filter(h => h.outcome === 'stalled');
  const completedInWindow = recentWindow.filter(h => h.outcome === 'completed');
  const hasStalls = stalledInWindow.length >= 2;
  const hasMomentum = completedInWindow.length >= 3;

  // Priority 1: Stall pivot (highest priority — avoiding repeated failure is critical)
  // When both stalls and momentum fire, emit a blended signal instead of both
  const allStdCategories = ['security', 'fix', 'perf', 'refactor', 'test', 'types', 'cleanup', 'docs'];
  if (hasStalls && hasMomentum) {
    const stalledCats = [...new Set(stalledInWindow.flatMap(h => h.categories))];
    const completedCats = [...new Set(completedInWindow.flatMap(h => h.categories))];
    const touchedCats = new Set([...stalledCats, ...completedCats]);
    const unexplored = allStdCategories.filter(c => !touchedCats.has(c));
    const diversityNudge = unexplored.length > 0
      ? ` Also consider unexplored categories (${unexplored.slice(0, 3).join(', ')}) to diversify.`
      : '';
    parts.push(`Selective momentum: strong completions in ${completedCats.join(', ')} but repeated stalls in ${stalledCats.join(', ')}. Double down on successful categories and avoid stalled areas.${diversityNudge}`);
  } else if (hasStalls) {
    const stalledCats = [...new Set(stalledInWindow.flatMap(h => h.categories))];
    parts.push(`Multiple recent stalls in: ${stalledCats.join(', ')}. Pivot to a completely different area or category.`);
  }

  // Priority 2: Phase rotation (only if budget remains)
  if (parts.length < MAX_SIGNALS) {
    if (foundationCount >= 3 && polishCount < 2) {
      phaseDirection = 'polish';
      parts.push(`Recent trajectories focused on foundation work (${dominant.join(', ')}). Shift toward testing and documentation — write tests for recently refactored code, validate new interfaces, add missing docs.`);
    } else if (polishCount >= 3) {
      phaseDirection = 'core';
      parts.push(`Recent trajectories focused on polish (${dominant.join(', ')}). Shift to core improvements — security hardening, performance optimization, or deeper refactors.`);
    }
  }

  // Priority 3: Momentum (only when stall pivot didn't fire — they're mutually exclusive)
  if (parts.length < MAX_SIGNALS && hasMomentum && !hasStalls) {
    parts.push(`Strong completion momentum (${completedInWindow.length}/${recentWindow.length} completed). Build on this — tackle slightly more ambitious work in the same areas, or expand to adjacent modules.`);
  }

  // Priority 4: Chain guidance (only when momentum didn't fire — avoids double "continue" signal)
  if (parts.length < MAX_SIGNALS && !hasMomentum) {
    const last = recentWindow[recentWindow.length - 1];
    if (last?.outcome === 'completed' && last.modifiedFiles && last.modifiedFiles.length > 0) {
      const areas = [...new Set(last.modifiedFiles.map(f => f.split('/').slice(0, -1).join('/')))].slice(0, 3);
      parts.push(`Last trajectory modified ${areas.join(', ')}. Consider a follow-up trajectory that adds tests, improves docs, or extends functionality in those same areas.`);
    }
  }

  // Priority 5: Goal alignment — always emits when goal exists and budget remains,
  // but reweights the message when phase rotation already covers the goal category
  // (softer nudge instead of full suppression to prevent goal drift)
  if (parts.length < MAX_SIGNALS && goalCategory) {
    const phaseCoversGoal =
      (phaseDirection === 'polish' && polishCats.has(goalCategory)) ||
      (phaseDirection === 'core' && !foundationCats.has(goalCategory) && !polishCats.has(goalCategory));

    const goalCatCount = primaryCats.filter(c => c === goalCategory).length;
    if (phaseCoversGoal) {
      // Phase rotation already points toward goal — softer nudge to ensure priority
      parts.push(`Phase shift aligns with active goal ("${goalCategory}") — ensure "${goalCategory}" gets priority within the shift rather than other ${phaseDirection === 'polish' ? 'polish' : 'core'} categories.`);
    } else if (goalCatCount < 2) {
      parts.push(`Active goal targets "${goalCategory}" work — prioritize proposals in this category to advance the goal.`);
    } else {
      parts.push(`Good goal alignment — recent trajectories include "${goalCategory}" work. Continue advancing the goal while maintaining category diversity.`);
    }
  }

  return parts.length > 0 ? parts.join('\n') : undefined;
}

interface DrillHistoryFile {
  entries: DrillHistoryEntry[];
  coveredCategories: Record<string, number>;
  coveredScopes: Record<string, number>;
}

function getDrillHistoryPath(repoRoot: string): string {
  return path.join(getPromptwheelDir(repoRoot), 'drill-history.json');
}

/** Load persisted drill history from disk. Returns empty state if missing or corrupted. */
export function loadDrillHistory(repoRoot: string, verbose?: boolean): DrillHistoryFile {
  const empty: DrillHistoryFile = { entries: [], coveredCategories: {}, coveredScopes: {} };
  try {
    const filePath = getDrillHistoryPath(repoRoot);
    const tmpPath = filePath + '.tmp';

    // Recover orphaned .tmp file from crash — read .tmp first, validate, then promote
    if (!fs.existsSync(filePath) && fs.existsSync(tmpPath)) {
      try {
        const tmpRaw = fs.readFileSync(tmpPath, 'utf-8');
        const tmpData = JSON.parse(tmpRaw);
        if (tmpData && typeof tmpData === 'object' && Array.isArray(tmpData.entries)) {
          fs.renameSync(tmpPath, filePath);
        } else {
          // Invalid .tmp — remove it
          fs.unlinkSync(tmpPath);
        }
      } catch {
        // .tmp is corrupted — remove it
        try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
      }
    }

    if (!fs.existsSync(filePath)) return empty;
    const raw = fs.readFileSync(filePath, 'utf-8');
    if (!raw.trim()) return empty;
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object') return empty;
    return {
      entries: Array.isArray(data.entries) ? data.entries : [],
      coveredCategories: (data.coveredCategories && typeof data.coveredCategories === 'object' && !Array.isArray(data.coveredCategories))
        ? data.coveredCategories : {},
      coveredScopes: (data.coveredScopes && typeof data.coveredScopes === 'object' && !Array.isArray(data.coveredScopes))
        ? data.coveredScopes : {},
    };
  } catch (err) {
    if (verbose) console.log(chalk.yellow(`  Drill: history corrupted — starting fresh (${err instanceof Error ? err.message : String(err)})`));
    return empty;
  }
}

/** Persist drill history to disk. Caps entries to prevent unbounded growth. */
function saveDrillHistory(repoRoot: string, history: DrillHistoryFile, cap: number = 100, verbose?: boolean): void {
  const filePath = getDrillHistoryPath(repoRoot);
  const tmp = filePath + '.tmp';
  try {
    const validCap = Math.max(10, Math.min(1000, cap));
    const capped = { ...history, entries: history.entries.slice(-validCap) };
    fs.writeFileSync(tmp, JSON.stringify(capped, null, 2));
    fs.renameSync(tmp, filePath);
  } catch (err) {
    if (verbose) console.log(chalk.yellow(`  Drill: failed to save history (${err instanceof Error ? err.message : String(err)})`));
  } finally {
    // Always clean up .tmp to prevent orphaned files on error
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}

/** Hydrate session state from persisted drill history. */
export function hydrateDrillState(state: AutoSessionState): void {
  const persisted = loadDrillHistory(state.repoRoot, state.options?.verbose);
  if (persisted.entries.length === 0) return;

  state.drillHistory = persisted.entries;
  state.drillCoveredCategories = new Map(Object.entries(persisted.coveredCategories));
  state.drillCoveredScopes = new Map(Object.entries(persisted.coveredScopes));

  // Restore generation count from history so cooldown works correctly on resume
  state.drillTrajectoriesGenerated = persisted.entries.length;

  // Set last outcome from most recent entry
  const last = persisted.entries[persisted.entries.length - 1];
  if (last) state.drillLastOutcome = last.outcome;
}

// ── Track trajectory outcome ─────────────────────────────────────────────────

/**
 * Record a completed or stalled drill trajectory into history.
 * Called from between-cycles when a trajectory finishes.
 * Persists to disk for cross-session diversity.
 */
export function recordDrillTrajectoryOutcome(
  state: AutoSessionState,
  trajectoryName: string,
  trajectoryDescription: string,
  stepsTotal: number,
  stepsCompleted: number,
  stepsFailed: number,
  outcome: 'completed' | 'stalled',
  steps: Array<{ id?: string; title?: string; categories?: string[]; scope?: string }>,
  failedSteps?: Array<{ id: string; title: string; reason?: string }>,
  completedStepSummaries?: string[],
  modifiedFiles?: string[],
  ambitionLevel?: AmbitionLevel,
  telemetry?: {
    stepOutcomes?: DrillHistoryEntry['stepOutcomes'];
    proposalAvgConfidence?: number;
    proposalAvgImpact?: number;
    freshnessDropCount?: number;
    proposalCategoryCount?: number;
    blueprintGroupCount?: number;
    blueprintConflictCount?: number;
    blueprintEnablerCount?: number;
    blueprintMergeableCount?: number;
    qualityRetried?: boolean;
    qualityIssueCount?: number;
  },
): void {
  // Collect categories and scopes from all steps
  const categories = [...new Set(steps.flatMap(s => s.categories ?? []))];
  const scopes = [...new Set(steps.map(s => s.scope).filter((s): s is string => !!s))];

  // Cap in-memory history before push to prevent unbounded growth
  const historyCap = state.autoConf.drill?.historyCap ?? 100;
  const validCap = Math.max(10, Math.min(1000, historyCap));
  if (state.drillHistory.length >= validCap) {
    state.drillHistory = state.drillHistory.slice(-(validCap - 1));
  }

  state.drillHistory.push({
    name: trajectoryName,
    description: trajectoryDescription,
    stepsTotal,
    stepsCompleted,
    stepsFailed,
    outcome,
    completionPct: stepsTotal > 0 ? stepsCompleted / stepsTotal : 0,
    categories,
    scopes,
    timestamp: Date.now(),
    failedSteps: failedSteps?.slice(0, 5), // cap to prevent unbounded growth
    completedStepSummaries: completedStepSummaries?.slice(0, 5),
    modifiedFiles: modifiedFiles?.slice(0, 20), // cap to prevent unbounded growth
    ambitionLevel,
    // Telemetry — enables empirical analysis of edge cases
    stepOutcomes: telemetry?.stepOutcomes?.slice(0, 10),
    proposalAvgConfidence: telemetry?.proposalAvgConfidence,
    proposalAvgImpact: telemetry?.proposalAvgImpact,
    freshnessDropCount: telemetry?.freshnessDropCount,
    proposalCategoryCount: telemetry?.proposalCategoryCount,
    blueprintGroupCount: telemetry?.blueprintGroupCount,
    blueprintConflictCount: telemetry?.blueprintConflictCount,
    blueprintEnablerCount: telemetry?.blueprintEnablerCount,
    blueprintMergeableCount: telemetry?.blueprintMergeableCount,
    qualityRetried: telemetry?.qualityRetried,
    qualityIssueCount: telemetry?.qualityIssueCount,
  });

  state.drillLastOutcome = outcome;

  // Update diversity tracking
  for (const cat of categories) {
    state.drillCoveredCategories.set(cat, (state.drillCoveredCategories.get(cat) ?? 0) + 1);
  }
  for (const scope of scopes) {
    state.drillCoveredScopes.set(scope, (state.drillCoveredScopes.get(scope) ?? 0) + 1);
  }
  // Cap scopes map to prevent unbounded growth in monorepos
  const MAX_TRACKED_SCOPES = 200;
  if (state.drillCoveredScopes.size > MAX_TRACKED_SCOPES) {
    // Keep top entries by frequency, prune the rest
    const sorted = [...state.drillCoveredScopes.entries()].sort((a, b) => b[1] - a[1]);
    state.drillCoveredScopes = new Map(sorted.slice(0, MAX_TRACKED_SCOPES));
  }

  // Persist to disk for cross-session awareness
  const drillConf = state.autoConf.drill;
  saveDrillHistory(state.repoRoot, {
    entries: state.drillHistory,
    coveredCategories: Object.fromEntries(state.drillCoveredCategories),
    coveredScopes: Object.fromEntries(state.drillCoveredScopes),
  }, drillConf?.historyCap ?? 100, state.options?.verbose);
}

// ── Pre-verification ────────────────────────────────────────────────────────

/**
 * Check if the current trajectory step's verification commands already pass.
 * If so, mark the step complete and advance — avoids wasting an LLM cycle.
 * Returns true if the step was advanced (caller should re-enter loop).
 */
export function tryPreVerifyTrajectoryStep(state: AutoSessionState): boolean {
  if (!state.activeTrajectory || !state.activeTrajectoryState || !state.currentTrajectoryStep) return false;

  const step = state.currentTrajectoryStep;
  if (step.verification_commands.length === 0) return false;

  // Optional measure gate — checked before delegating to shared logic
  // (shared function handles verification commands only; measure is CLI-specific)
  const exec = (cmd: string, cwd: string) => {
    const r = spawnSync('sh', ['-c', cmd], { cwd, timeout: 30000, encoding: 'utf-8' });
    return {
      exitCode: r.status ?? 1,
      timedOut: !!r.error?.message?.includes('TIMEOUT'),
      output: (r.stderr ?? '') + (r.stdout ?? ''),
    };
  };

  // Run verification commands via shared logic (cap at 1 step)
  const prevStepId = state.activeTrajectoryState.currentStepId;
  const result = preVerifyAndAdvanceStepsFn(
    state.activeTrajectory, state.activeTrajectoryState, state.repoRoot, exec,
  );
  // We only want one step per call — if shared advanced more, that's fine, we'll just report it
  if (result.advanced === 0) return false;

  // Measure gate for the step we just advanced (if it had one)
  if (step.measure) {
    const { value } = runMeasurement(step.measure.cmd, state.repoRoot);
    if (value === null) {
      // Revert — measure failed, step shouldn't be considered complete
      const ss = state.activeTrajectoryState.stepStates[step.id];
      if (ss) { ss.status = 'active'; ss.completedAt = undefined; }
      state.activeTrajectoryState.currentStepId = prevStepId;
      state.currentTrajectoryStep = step;
      saveTrajectoryState(state.repoRoot, state.activeTrajectoryState);
      return false;
    }
    const met = step.measure.direction === 'up' ? value >= step.measure.target : value <= step.measure.target;
    if (!met) {
      const ss = state.activeTrajectoryState.stepStates[step.id];
      if (ss) { ss.status = 'active'; ss.completedAt = undefined; }
      state.activeTrajectoryState.currentStepId = prevStepId;
      state.currentTrajectoryStep = step;
      saveTrajectoryState(state.repoRoot, state.activeTrajectoryState);
      return false;
    }
  }

  state.displayAdapter.log(chalk.green(`  Trajectory step "${step.title}" already passing — advancing`));

  const next = getTrajectoryNextStep(state.activeTrajectory, state.activeTrajectoryState.stepStates);
  state.currentTrajectoryStep = next;
  if (next) {
    state.displayAdapter.log(chalk.cyan(`  -> Next step: ${next.title}`));
  } else if (trajectoryComplete(state.activeTrajectory, state.activeTrajectoryState.stepStates)) {
    state.displayAdapter.log(chalk.green(`  Trajectory "${state.activeTrajectory.name}" complete!`));
    // Don't clear here — let the post-cycle handler finish the drill trajectory properly
  }

  saveTrajectoryState(state.repoRoot, state.activeTrajectoryState);
  return true;
}

// ── Stratified sampling ──────────────────────────────────────────────────

/**
 * Stratified proposal sampling — ensures category diversity while keeping quality high.
 * Takes the best proposal from each category in round-robin, then fills remaining
 * slots with the highest-scoring proposals from any category.
 */
function stratifiedSample(proposals: TicketProposal[], maxCount: number): TicketProposal[] {
  if (proposals.length <= maxCount) return proposals;

  // Group by category
  const byCategory = new Map<string, TicketProposal[]>();
  for (const p of proposals) {
    const cat = p.category || 'other';
    const list = byCategory.get(cat) ?? [];
    list.push(p);
    byCategory.set(cat, list);
  }

  const selected = new Set<number>();
  const result: TicketProposal[] = [];

  // Round 1: take best from each category (ensures diversity)
  for (const [, catProposals] of byCategory) {
    if (result.length >= maxCount) break;
    if (catProposals.length === 0) continue;
    const idx = proposals.indexOf(catProposals[0]);
    if (idx >= 0 && !selected.has(idx)) {
      selected.add(idx);
      result.push(catProposals[0]);
    }
  }

  // Round 2: fill remaining slots with highest-scoring unselected proposals
  for (let i = 0; i < proposals.length && result.length < maxCount; i++) {
    if (!selected.has(i)) {
      selected.add(i);
      result.push(proposals[i]);
    }
  }

  return result;
}

// ── Directive handling ────────────────────────────────────────────────────────

/**
 * Apply pending drill directives from the hints system.
 * Reads unconsumed directive hints, applies them to session state,
 * and marks them as consumed.
 */
export function applyDrillDirectives(state: AutoSessionState): void {
  const hints = readHintsForDrill(state.repoRoot);
  const directives = hints.filter(h => !h.consumed && h.directive);

  if (directives.length === 0) return;

  for (const h of directives) {
    switch (h.directive) {
      case 'drill:pause':
        state.drillMode = false;
        state.displayAdapter.log(chalk.cyan('  Drill: paused via nudge'));
        state.displayAdapter.drillStateChanged(null);
        break;
      case 'drill:resume':
        state.drillMode = true;
        state.displayAdapter.log(chalk.cyan('  Drill: resumed via nudge'));
        state.displayAdapter.drillStateChanged({ active: true });
        break;
      case 'drill:disable':
        state.drillMode = false;
        state.displayAdapter.log(chalk.cyan('  Drill: disabled via nudge'));
        state.displayAdapter.drillStateChanged(null);
        break;
    }
    h.consumed = true;
  }

  // Write back consumed state
  writeHintsForDrill(state.repoRoot, hints);
}

// ── Core drill logic ─────────────────────────────────────────────────────────

// ---------------------------------------------------------------------------
// Escalation — promote repeatedly-failed proposals to drill for decomposition
// ---------------------------------------------------------------------------

/**
 * Build escalation proposals from dedup memory and inject them into the
 * survey proposals array. Returns the number of escalation candidates injected.
 *
 * Escalation candidates are proposals that were hard-dedup-rejected (hit_count >= 3,
 * failureReason set). They represent valid issues the codebase has that are too
 * complex for a single ticket. Drill decomposes them into achievable steps.
 */
export function buildEscalationProposals(
  state: AutoSessionState,
  allProposals: TicketProposal[],
): number {
  if (state.escalationCandidates.size === 0) return 0;

  const ESCALATION_HIT_THRESHOLD = 3;
  const failedMemory = state.dedupMemory.filter(
    (e: DedupEntry) => !e.completed && e.failureReason && e.hit_count >= ESCALATION_HIT_THRESHOLD,
  );
  if (failedMemory.length === 0) return 0;

  // Match escalation candidate titles against dedup memory
  let injected = 0;
  for (const title of state.escalationCandidates) {
    const match = matchAgainstMemory(title, failedMemory);
    if (!match) continue;
    const entry = match.entry as DedupEntry;

    // Check if this proposal is already in the survey results
    const alreadyPresent = allProposals.some(p =>
      p.title.toLowerCase().trim() === title.toLowerCase().trim(),
    );
    if (alreadyPresent) continue;

    // Build a synthetic proposal with failure-type-driven attributes
    const confidence = entry.failureReason === 'scope_violation' ? 80
      : entry.failureReason === 'qa_failed' ? 65
      : entry.failureReason === 'spindle_abort' ? 50
      : 60;
    const category = 'refactor';
    const complexity = entry.failureReason === 'spindle_abort' ? 'complex'
      : entry.failureReason === 'scope_violation' ? 'moderate'
      : 'complex';

    allProposals.push({
      id: `escalation-${Date.now()}-${injected}`,
      title: entry.title,
      description: `[ESCALATION — failed ${entry.hit_count}x as single ticket, reason: ${entry.failureReason}] This is a valid improvement that needs trajectory decomposition into smaller steps.`,
      category: category as import('@promptwheel/core/scout').ProposalCategory,
      files: [],
      allowed_paths: [],
      confidence,
      impact_score: 8, // high impact — these are persistent issues worth solving
      acceptance_criteria: [],
      verification_commands: state.config?.qa?.commands?.map(c => typeof c === 'string' ? c : c.cmd) ?? ['npm test'],
      rationale: `Repeatedly failed as single ticket (${entry.hit_count}x, reason: ${entry.failureReason}). Needs decomposition.`,
      estimated_complexity: complexity as 'trivial' | 'simple' | 'moderate' | 'complex',
    });
    injected++;
  }

  return injected;
}

/**
 * Format escalation context for the trajectory generation prompt.
 * Lists the repeatedly-failed proposals with their failure reasons.
 */
export function formatEscalationContext(state: AutoSessionState): string {
  if (state.escalationCandidates.size === 0) return '';

  const ESCALATION_HIT_THRESHOLD = 3;
  const failedMemory = state.dedupMemory.filter(
    (e: DedupEntry) => !e.completed && e.failureReason && e.hit_count >= ESCALATION_HIT_THRESHOLD,
  );

  const lines: string[] = [];
  for (const title of state.escalationCandidates) {
    const match = matchAgainstMemory(title, failedMemory);
    if (!match) continue;
    const e = match.entry as DedupEntry;
    lines.push(`- "${e.title}" — failed ${e.hit_count}x (reason: ${e.failureReason})`);
  }

  return lines.length > 0 ? lines.join('\n') : '';
}

/**
 * Build compact analysis context string from codebase index for trajectory generation.
 * Includes dead exports, structural issues, and coupling extremes.
 */
function buildAnalysisContext(state: AutoSessionState): string | undefined {
  const idx = state.codebaseIndex;
  if (!idx) return undefined;

  const parts: string[] = [];

  if (idx.dead_exports && idx.dead_exports.length > 0) {
    const byModule = new Map<string, string[]>();
    for (const d of idx.dead_exports) {
      const names = byModule.get(d.module) ?? [];
      names.push(d.name);
      byModule.set(d.module, names);
    }
    const lines = Array.from(byModule.entries()).map(([m, names]) => `${m}: ${names.join(', ')}`);
    parts.push(`Dead exports (${idx.dead_exports.length}): ${lines.join('; ')}`);
  }

  if (idx.structural_issues && idx.structural_issues.length > 0) {
    const lines = idx.structural_issues.map(i => `${i.kind}: ${i.module} (${i.detail})`);
    parts.push(`Structural issues: ${lines.join('; ')}`);
  }

  if (idx.ast_findings && idx.ast_findings.length > 0) {
    const byPattern = new Map<string, number>();
    for (const f of idx.ast_findings) {
      byPattern.set(f.patternId, (byPattern.get(f.patternId) ?? 0) + 1);
    }
    const summary = Array.from(byPattern.entries())
      .sort(([, a], [, b]) => b - a)
      .map(([id, count]) => `${id}: ${count}`)
      .join(', ');
    parts.push(`AST findings (${idx.ast_findings.length}): ${summary}`);
  }

  return parts.length > 0 ? parts.join('\n') : undefined;
}

/**
 * Check whether drill should generate a new trajectory, and if so, do it.
 *
 * Returns a result code so the caller knows whether to restart the loop
 * (on 'generated') or fall through to a normal cycle.
 */
export async function maybeDrillGenerateTrajectory(state: AutoSessionState): Promise<DrillResult> {
  // Adaptive cooldown — scales based on last trajectory outcome
  const cooldownCycles = getDrillCooldown(state);
  const cyclesSinceLastGen = state.cycleCount - state.drillLastGeneratedAtCycle;
  if (state.drillTrajectoriesGenerated > 0 && cyclesSinceLastGen < cooldownCycles) {
    if (state.options.verbose) state.displayAdapter.log(chalk.gray(`  Drill: cooldown (${cyclesSinceLastGen}/${cooldownCycles} cycles)`));
    return 'cooldown';
  }

  // Gradient staleness check — skip survey when no changes at all (including own commits).
  // Own commits are included because PromptWheel's changes create new code worth scanning —
  // excluding them starves drill in autonomous sessions where PW is the only committer.
  if (state.drillTrajectoriesGenerated > 0 && state.drillLastSurveyTimestamp) {
    const stalenessLogBase = state.autoConf.drill?.stalenessLogBase ?? 11;
    const staleness = measureCodeStaleness(state.repoRoot, state.drillLastSurveyTimestamp, stalenessLogBase, /* excludeOwnCommits */ false);
    if (staleness === 0) {
      if (state.options.verbose) {
        state.displayAdapter.log(chalk.gray('  Drill: no code changes since last survey — skipping'));
      }
      return 'cooldown';
    }
    // Low staleness (few changes) — still survey but with less confidence discount
    // This prevents full re-survey on trivial changes while allowing exploration on significant ones
    if (staleness < 0.4 && state.options.verbose) {
      state.displayAdapter.log(chalk.gray(`  Drill: minor changes since last survey (staleness: ${(staleness * 100).toFixed(0)}%)`));
    }
  }

  // Run broad survey — temporarily lower confidence threshold for wider discovery
  state.displayAdapter.log(chalk.cyan(`Drill: surveying codebase for trajectory generation...`));
  state.drillLastSurveyTimestamp = Date.now();
  const savedConfidence = state.effectiveMinConfidence;
  const confidenceDiscount = state.autoConf.drill?.confidenceDiscount ?? 15;
  state.effectiveMinConfidence = Math.max(0, state.effectiveMinConfidence - confidenceDiscount);
  const allProposals = await runDrillSurvey(state);
  state.effectiveMinConfidence = savedConfidence;

  // Escalation injection — promote repeatedly-failed proposals from dedup memory
  // into the drill pipeline. These are valid issues the scout correctly identifies
  // but that fail as single tickets (scope too narrow, multi-file coordination needed).
  // Drill decomposes them into smaller, achievable steps.
  let escalationContext: string | undefined;
  const escalationCount = buildEscalationProposals(state, allProposals);
  if (escalationCount > 0) {
    state.displayAdapter.log(chalk.cyan(`  Drill: ${escalationCount} escalation candidate(s) injected from repeatedly-failed proposals`));
    escalationContext = formatEscalationContext(state);
  }

  // Adaptive thresholds — scale with historical success rate
  const { min: minProposals, max: maxProposals } = getAdaptiveProposalThresholds(state);

  // When we have escalation candidates, lower the minimum to allow trajectory generation
  // even if the survey alone didn't find enough new proposals
  const effectiveMin = escalationCount > 0 ? Math.min(minProposals, 2) : minProposals;

  if (allProposals.length < effectiveMin) {
    if (state.options.verbose) state.displayAdapter.log(chalk.gray(`  Drill: ${allProposals.length} proposal(s) found — below threshold (${effectiveMin}), running normal cycle`));
    return 'insufficient'; // genuinely no proposals — codebase may be polished
  }

  // Freshness filter — drop proposals whose primary files have been modified since survey
  // (they may no longer apply). Batches all files into a single git diff call.
  let changedFiles: Set<string>;
  try {
    const allFiles = [...new Set(allProposals.flatMap(p => p.files.slice(0, 3)))];
    if (allFiles.length > 0) {
      const result = spawnSync('git', ['diff', '--name-only', '--', ...allFiles], {
        cwd: state.repoRoot,
        encoding: 'utf-8',
        timeout: 5000,
      });
      changedFiles = (!result.error && result.status === 0 && result.stdout.trim())
        ? new Set(result.stdout.trim().split('\n').filter(Boolean))
        : new Set();
    } else {
      changedFiles = new Set();
    }
  } catch {
    changedFiles = new Set(); // on error, keep all proposals
  }
  const freshProposals = allProposals.filter(p => {
    if (p.files.length === 0) return true;
    return !p.files.slice(0, 3).some(f => changedFiles.has(f));
  });

  if (freshProposals.length < allProposals.length) {
    if (state.options.verbose) state.displayAdapter.log(chalk.gray(`  Drill: filtered ${allProposals.length - freshProposals.length} stale proposal(s) (modified since survey)`));
  }

  // Staleness check — if freshness filter dropped enough proposals to fall below threshold, return 'stale'
  const { min: freshMin } = getAdaptiveProposalThresholds(state);
  if (freshProposals.length < freshMin && freshProposals.length < allProposals.length) {
    // Had proposals but freshness filter killed them — wait for external changes
    if (state.options.verbose) state.displayAdapter.log(chalk.gray(`  Drill: ${allProposals.length - freshProposals.length} proposal(s) filtered as stale — waiting for external changes`));
    return 'stale';
  }

  // Use fresh proposals for remaining checks (fall back to all if all filtered)
  const proposalsForQuality = freshProposals.length >= freshMin
    ? freshProposals : allProposals;

  // Quality gate — graduated: hard floor skips entirely, soft threshold adds guidance
  const avgConfidence = proposalsForQuality.reduce((sum, p) => sum + (p.confidence ?? 50), 0) / proposalsForQuality.length;
  const avgImpact = proposalsForQuality.reduce((sum, p) => sum + (p.impact_score ?? 5), 0) / proposalsForQuality.length;
  const MIN_AVG_CONFIDENCE = state.autoConf.drill?.minAvgConfidence ?? 30;
  const MIN_AVG_IMPACT = state.autoConf.drill?.minAvgImpact ?? 3;
  // Hard floor: proposals are truly unusable — skip generation entirely
  const HARD_FLOOR_CONFIDENCE = Math.max(10, Math.round(MIN_AVG_CONFIDENCE / 2));
  const HARD_FLOOR_IMPACT = Math.max(1, Math.round(MIN_AVG_IMPACT / 2));
  let qualityWarning: string | undefined;
  if (avgConfidence < HARD_FLOOR_CONFIDENCE || avgImpact < HARD_FLOOR_IMPACT) {
    if (state.options.verbose) state.displayAdapter.log(chalk.gray(`  Drill: proposals too weak (avg confidence: ${avgConfidence.toFixed(0)}, avg impact: ${avgImpact.toFixed(1)}) — skipping generation`));
    return 'low_quality'; // proposals exist but quality is truly unusable
  } else if (avgConfidence < MIN_AVG_CONFIDENCE || avgImpact < MIN_AVG_IMPACT) {
    // Soft threshold: proposals are weak but usable — proceed with conservative guidance
    qualityWarning = `Proposal quality is below ideal (avg confidence: ${avgConfidence.toFixed(0)}/${MIN_AVG_CONFIDENCE}, avg impact: ${avgImpact.toFixed(1)}/${MIN_AVG_IMPACT}). Generate a SHORT, conservative trajectory (2-3 steps max) focused on the 1-2 highest-confidence proposals. Drop weaker proposals rather than spreading thin.`;
    if (state.options.verbose) state.displayAdapter.log(chalk.gray(`  Drill: weak proposals (confidence: ${avgConfidence.toFixed(0)}, impact: ${avgImpact.toFixed(1)}) — generating conservative trajectory`));
  }

  // Freshness filter → cooldown bridge: store drop ratio for next cooldown calculation
  const freshnessDropCount = allProposals.length - freshProposals.length;
  state.drillLastFreshnessDropRatio = allProposals.length > 0
    ? freshnessDropCount / allProposals.length
    : null;

  // Capture generation telemetry — carried to outcome recording for empirical analysis
  const proposalCategoryCount = new Set(proposalsForQuality.map(p => p.category || 'other')).size;
  state.drillGenerationTelemetry = {
    proposalAvgConfidence: avgConfidence,
    proposalAvgImpact: avgImpact,
    freshnessDropCount: freshnessDropCount > 0 ? freshnessDropCount : undefined,
    proposalCategoryCount,
  };

  // Stratified sampling — ensure diversity across categories while prioritizing quality
  const proposals = stratifiedSample(proposalsForQuality, maxProposals);
  if (state.options.verbose && proposalsForQuality.length > maxProposals) {
    state.displayAdapter.log(chalk.gray(`  Drill: stratified ${proposalsForQuality.length} proposals to ${proposals.length}`));
  }

  // Build context for trajectory generation
  const historyBlock = formatDrillHistoryForPrompt(state);
  const diversityHint = formatDiversityHint(state);
  // Integrate project learnings and dedup memory
  const learningsContext = state.autoConf.learningsEnabled
    ? formatLearningsForPrompt(selectRelevant(state.allLearnings, {}), state.autoConf.learningsBudget ?? 500) || undefined
    : undefined;
  const dedupContext = state.dedupMemory.length > 0
    ? formatDedupForPrompt(state.dedupMemory, 500) || undefined
    : undefined;

  // Build metrics hint from drill history
  let metricsHint: string | undefined;
  if (state.drillHistory.length >= 3) {
    const metrics = computeDrillMetrics(state.drillHistory);
    const parts: string[] = [];
    parts.push(`Completion rate: ${(metrics.weightedCompletionRate * 100).toFixed(0)}% recent, ${(metrics.completionRate * 100).toFixed(0)}% overall (${metrics.totalTrajectories} trajectories)`);
    parts.push(`Avg step completion: ${(metrics.weightedStepCompletionRate * 100).toFixed(0)}% recent, ${(metrics.avgStepCompletionRate * 100).toFixed(0)}% overall`);
    if (metrics.topCategories.length > 0) {
      parts.push(`High-success categories (prefer, can be ambitious): ${metrics.topCategories.join(', ')}`);
    }
    if (metrics.stalledCategories.length > 0) {
      parts.push(`Frequently stalled categories (use conservative steps or avoid): ${metrics.stalledCategories.join(', ')}`);
    }
    // Per-category ambition hints — give the LLM granular guidance on which categories to push vs simplify
    const catHints: string[] = [];
    for (const [cat, stats] of Object.entries(metrics.categorySuccessRates)) {
      if (stats.total < 2) continue; // not enough data
      if (stats.rate >= 0.7) catHints.push(`${cat}: ambitious (${Math.round(stats.rate * 100)}% success)`);
      else if (stats.rate < 0.3) catHints.push(`${cat}: conservative (${Math.round(stats.rate * 100)}% success)`);
    }
    if (catHints.length > 0) {
      parts.push(`Per-category ambition: ${catHints.join(', ')}`);
    }
    if (metrics.step1FailureRate > 0.3) {
      parts.push(`WARNING: ${(metrics.step1FailureRate * 100).toFixed(0)}% of trajectories stall on step 1 — this is the #1 cause of wasted cycles. Step 1 MUST be a trivial "gimme" (1 file, zero dependencies, guaranteed success like adding a type annotation or fixing a lint error). Complex work belongs in step 2+.`);
    } else if (metrics.step1FailureRate > 0.15) {
      parts.push(`Step-1 failure rate: ${(metrics.step1FailureRate * 100).toFixed(0)}%. Keep first steps simple — 1-3 files, zero deps, one-cycle completable.`);
    } else if (metrics.step1FailureRate > 0) {
      parts.push(`Step-1 failure rate: ${(metrics.step1FailureRate * 100).toFixed(0)}% (healthy). First steps are landing well.`);
    }
    // Step-position failure analysis from telemetry — derive concrete step-count cap
    if (metrics.stepPositionFailureRates.length > 0) {
      const problematicPositions = metrics.stepPositionFailureRates.filter(p => p.failureRate > 0.5);
      if (problematicPositions.length > 0) {
        const posLabels = problematicPositions.map(p => `step ${p.position} (${Math.round(p.failureRate * 100)}% failure, n=${p.total})`);
        // Derive step-count cap: if position N fails >60%, cap at N-1 steps
        const highFailPositions = metrics.stepPositionFailureRates.filter(p => p.failureRate > 0.6 && p.total >= 3);
        if (highFailPositions.length > 0) {
          const firstHighFail = Math.min(...highFailPositions.map(p => p.position));
          const suggestedMax = Math.max(2, firstHighFail - 1);
          parts.push(`Step position risk: ${posLabels.join(', ')}. CONSTRAINT: limit trajectory to ${suggestedMax} steps maximum — positions ${firstHighFail}+ fail too often.`);
        } else {
          parts.push(`Step position risk: ${posLabels.join(', ')}. Keep these positions simpler or reduce trajectory length.`);
        }
      }
    }
    // Scope-size → outcome correlation
    const entriesWithFiles = state.drillHistory.filter(h => h.modifiedFiles && h.modifiedFiles.length > 0);
    if (entriesWithFiles.length >= 3) {
      const largeScopeEntries = entriesWithFiles.filter(h => h.modifiedFiles!.length > 10);
      const smallScopeEntries = entriesWithFiles.filter(h => h.modifiedFiles!.length <= 10);
      if (largeScopeEntries.length >= 2 && smallScopeEntries.length >= 2) {
        const largeRate = largeScopeEntries.filter(h => h.outcome === 'completed').length / largeScopeEntries.length;
        const smallRate = smallScopeEntries.filter(h => h.outcome === 'completed').length / smallScopeEntries.length;
        if (largeRate < smallRate - 0.2) {
          parts.push(`Scope-size insight: trajectories touching >10 files succeed ${Math.round(largeRate * 100)}% vs ${Math.round(smallRate * 100)}% for ≤10 files. Prefer smaller, focused scopes.`);
        }
      }
    }
    // Quality gate effectiveness — helps LLM understand trajectory validation
    if (metrics.qualityGateFireRate > 0) {
      parts.push(`Quality gate: fires on ${Math.round(metrics.qualityGateFireRate * 100)}% of trajectories, retry success: ${Math.round(metrics.qualityGateRetrySuccessRate * 100)}%.`);
    }
    // Model distribution — shows which models have been used
    if (metrics.modelDistribution && Object.keys(metrics.modelDistribution).length > 0) {
      const dist = Object.entries(metrics.modelDistribution).map(([m, n]) => `${m}: ${n}`).join(', ');
      parts.push(`Model distribution: ${dist}`);
    }
    metricsHint = parts.join('\n');
  }

  // Append quality warning to metrics hint (soft threshold guidance)
  if (qualityWarning) {
    metricsHint = metricsHint
      ? `${metricsHint}\n\n${qualityWarning}`
      : qualityWarning;
  }

  // Build goal context for trajectory alignment
  let goalContext: string | undefined;
  if (state.activeGoal?.measure && state.activeGoalMeasurement) {
    const m = state.activeGoalMeasurement;
    const arrow = state.activeGoal.measure.direction === 'up' ? '>=' : '<=';
    goalContext = `Goal: "${state.activeGoal.name}" — current: ${m.current ?? 'unmeasured'}, target: ${arrow} ${state.activeGoal.measure.target} (gap: ${m.gapPercent}%)`;
  }

  // Extract dependency subgraph for proposal files (includes reverse edges + hub labels)
  let dependencyEdges: string | undefined;
  if (state.codebaseIndex?.dependency_edges) {
    const proposalModules = new Set<string>();
    for (const p of proposals) {
      for (const f of p.files) {
        // Find the module that contains this file
        const dir = f.split('/').slice(0, -1).join('/');
        proposalModules.add(dir);
      }
    }
    // Extract forward edges where either source or target is in proposal modules
    const edgeLines: string[] = [];
    for (const [mod, deps] of Object.entries(state.codebaseIndex.dependency_edges)) {
      const relevantDeps = deps.filter(d => proposalModules.has(d) || proposalModules.has(mod));
      if (relevantDeps.length > 0 && (proposalModules.has(mod) || relevantDeps.some(d => proposalModules.has(d)))) {
        edgeLines.push(`${mod} → imports: ${relevantDeps.join(', ')}`);
      }
    }
    // Include reverse edges (who depends on proposal modules)
    const reverseEdges = state.codebaseIndex.reverse_edges ?? {};
    for (const mod of proposalModules) {
      const dependents = reverseEdges[mod];
      if (dependents && dependents.length > 0) {
        edgeLines.push(`${mod} ← imported by: ${dependents.join(', ')}`);
      }
    }
    // Annotate hub modules for ordering guidance
    const hubs = state.codebaseIndex.graph_metrics?.hub_modules ?? [];
    const relevantHubs = hubs.filter(h => proposalModules.has(h));
    if (relevantHubs.length > 0) {
      edgeLines.push(`Hub modules (fix leaves before hubs): ${relevantHubs.join(', ')}`);
    }
    if (edgeLines.length > 0 && edgeLines.length <= 40) {
      dependencyEdges = edgeLines.join('\n');
    }
  }

  // Build causal context from recent trajectories — gives LLM a narrative arc
  let causalContext: string | undefined;
  if (state.drillHistory.length > 0) {
    const causalWindow = Math.max(1, Math.min(10, state.autoConf.drill?.causalWindow ?? 3));
    const windowEntries = state.drillHistory.slice(-causalWindow);
    const parts: string[] = [];

    for (let i = 0; i < windowEntries.length; i++) {
      const entry = windowEntries[i];
      const isNewest = i === windowEntries.length - 1;
      const ago = windowEntries.length - i;

      if (isNewest) {
        // Most recent: full detail with granular completion
        const pct = entry.completionPct !== undefined && entry.completionPct !== null
          ? Math.round(entry.completionPct * 100)
          : Math.round((entry.stepsCompleted / Math.max(1, entry.stepsTotal)) * 100);
        parts.push(`Last trajectory: "${entry.description}" (${entry.outcome}, ${pct}% complete)`);
        if (entry.completedStepSummaries && entry.completedStepSummaries.length > 0) {
          parts.push(`What was done: ${entry.completedStepSummaries.join('; ')}`);
        }
        if (entry.modifiedFiles && entry.modifiedFiles.length > 0) {
          parts.push(`Files changed: ${entry.modifiedFiles.slice(0, 10).join(', ')}`);
        }
        if (entry.failedSteps && entry.failedSteps.length > 0) {
          const reasons = entry.failedSteps.map(f => `"${f.title}"${f.reason ? `: ${f.reason.slice(0, 80)}` : ''}`);
          parts.push(`What failed (may now be unblocked by survey proposals): ${reasons.join('; ')}`);
        }
        if (entry.outcome === 'completed') {
          parts.push('The previous trajectory SUCCEEDED — build on this momentum. Propose follow-up work like tests, documentation, or deeper refactors in the same area.');
        } else if (pct >= 70) {
          parts.push(`The previous trajectory was ${pct}% complete before stalling — nearly done. Consider a targeted follow-up trajectory to finish the remaining work.`);
        } else if (pct >= 30) {
          parts.push('The previous trajectory PARTIALLY completed — some work was done. Try a different angle for the remaining work, or simplify the approach.');
        } else {
          parts.push('The previous trajectory STALLED early — avoid the same approach entirely. Try a different angle or much simpler steps.');
        }
      } else {
        // Older entries: summary only
        parts.push(`[${ago} ago] "${entry.description}" — ${entry.outcome}, categories: ${entry.categories.join(', ') || 'mixed'}`);
      }
    }

    causalContext = parts.join('\n');
  }

  // Adaptive ambition — scale first-step complexity based on track record
  const baseAmbition = computeAmbitionLevel(state);

  // Proposal quality → ambition override: if current proposals are weak, downgrade;
  // if strong, upgrade. This closes the loop between proposal quality and generation complexity.
  let effectiveAmbition = baseAmbition;
  // Freshness → ambition bridge: high stale ratio means the codebase is changing rapidly
  // or PromptWheel is outrunning new issues — generate conservative trajectories to avoid waste
  if (state.drillLastFreshnessDropRatio !== null && state.drillLastFreshnessDropRatio > 0.5 && effectiveAmbition !== 'conservative') {
    effectiveAmbition = 'conservative';
    if (state.options.verbose) state.displayAdapter.log(chalk.gray(`    Ambition downgraded to conservative (${Math.round(state.drillLastFreshnessDropRatio * 100)}% proposals stale)`));
  }
  if (avgConfidence < 40 && effectiveAmbition !== 'conservative') {
    effectiveAmbition = effectiveAmbition === 'ambitious' ? 'moderate' : 'conservative';
    if (state.options.verbose) state.displayAdapter.log(chalk.gray(`    Ambition downgraded to ${effectiveAmbition} (low proposal confidence: ${avgConfidence.toFixed(0)})`));
  } else if (avgConfidence > 70 && effectiveAmbition !== 'ambitious' && state.drillHistory.length >= 5) {
    effectiveAmbition = effectiveAmbition === 'conservative' ? 'moderate' : 'ambitious';
    if (state.options.verbose) state.displayAdapter.log(chalk.gray(`    Ambition upgraded to ${effectiveAmbition} (high proposal confidence: ${avgConfidence.toFixed(0)})`));
  }

  // Multi-trajectory arc guidance — directional hints across consecutive trajectories
  // Derive goal category from active goal's formula categories for goal-aligned guidance
  const goalCategory = state.activeGoal?.categories?.[0];
  const arcGuidance = computeArcGuidance(state, goalCategory);

  // Merge arc guidance into causal context as a meta-narrative preamble
  // to avoid conflicting prompt sections and reduce token spend
  if (arcGuidance) {
    causalContext = causalContext
      ? `[Campaign direction]\n${arcGuidance}\n\n[Recent trajectory detail]\n${causalContext}`
      : arcGuidance;
  }

  // Build convergence hint for trajectory generation
  let convergenceHint: string | undefined;
  if (state.lastConvergenceAction && state.lastConvergenceAction !== 'continue') {
    const hints: Record<string, string> = {
      widen_scope: 'Convergence analysis suggests WIDENING SCOPE — current areas are well-covered. Explore new sectors, less-touched categories, or broader architectural improvements.',
      deepen: 'Convergence analysis suggests DEEPENING — surface-level issues are addressed. Focus on deeper refactors, multi-file architectural improvements, or comprehensive test coverage.',
      stop: 'Convergence analysis suggests the codebase is well-polished. If generating a trajectory, keep it SHORT (2-3 steps) and focus only on high-impact remaining work.',
    };
    convergenceHint = hints[state.lastConvergenceAction];
  }

  const preFiltered = proposals;

  // Filter test-only files from proposals before trajectory generation.
  // The scout excludes test files by default, so trajectory steps scoped to
  // test files will always fail with "no files found matching scope".
  const { isNonProductionFile } = await import('@promptwheel/core/codebase-index/shared');
  const testsEnabled = state.options.tests === true;
  const filteredProposals = testsEnabled ? preFiltered : preFiltered
    .map(p => ({ ...p, files: p.files.filter(f => !isNonProductionFile(f)) }))
    .filter(p => p.files.length > 0 || (p.allowed_paths && p.allowed_paths.length > 0));
  if (!testsEnabled && filteredProposals.length < preFiltered.length) {
    state.displayAdapter.log(chalk.gray(`  Drill: dropped ${preFiltered.length - filteredProposals.length} test-only proposal(s)`));
  }

  // Compute proposal blueprint for strategic analysis
  let blueprintContext: string | undefined;
  let blueprintGroupCount: number | undefined;
  let blueprintConflictCount: number | undefined;
  let blueprintEnablerCount: number | undefined;
  let blueprintMergeableCount: number | undefined;
  try {
    const { computeBlueprint, formatBlueprintForPrompt } = await import('@promptwheel/core/proposals/blueprint');
    const blueprintProposals = filteredProposals.map(p => ({
      title: p.title,
      category: p.category,
      files: p.files,
      impact_score: p.impact_score,
      confidence: p.confidence,
    }));
    const depEdgesMap = state.codebaseIndex?.dependency_edges ?? {};
    const bpConf = state.autoConf.drill?.blueprint;
    const blueprint = computeBlueprint(blueprintProposals, depEdgesMap, bpConf);
    blueprintContext = formatBlueprintForPrompt(blueprint, blueprintProposals);
    blueprintGroupCount = blueprint.groups.length;
    blueprintConflictCount = blueprint.conflicts.length;
    blueprintEnablerCount = blueprint.enablers.length;
    blueprintMergeableCount = blueprint.mergeablePairs.length;
    if (state.options.verbose) {
      state.displayAdapter.log(chalk.gray(`    Blueprint: ${blueprint.executionArc}`));
    }
  } catch {
    // Blueprint computation is optional — proceed without it
  }

  state.displayAdapter.log(chalk.cyan(`  Drill: generating trajectory from ${filteredProposals.length} proposal(s)...`));
  if (state.options.verbose && effectiveAmbition !== 'moderate') {
    state.displayAdapter.log(chalk.gray(`    Ambition: ${effectiveAmbition}${effectiveAmbition !== baseAmbition ? ` (adjusted from ${baseAmbition})` : ''}`));
  }

  try {
    const result = await generateTrajectoryFromProposals({
      proposals: filteredProposals.map(p => ({
        title: p.title,
        description: p.description,
        category: p.category,
        files: p.files,
        allowed_paths: p.allowed_paths,
        acceptance_criteria: p.acceptance_criteria,
        verification_commands: p.verification_commands,
        confidence: p.confidence,
        impact_score: p.impact_score,
        rationale: p.rationale,
        estimated_complexity: p.estimated_complexity,
      })),
      repoRoot: state.repoRoot,
      previousTrajectories: historyBlock || undefined,
      diversityHint: diversityHint || undefined,
      sectorContext: undefined,
      learningsContext,
      dedupContext,
      goalContext,
      metricsHint,
      dependencyEdges,
      causalContext,
      ambitionLevel: effectiveAmbition,
      escalationContext,
      convergenceHint,
      sessionPhase: state.sessionPhase,
      analysisContext: buildAnalysisContext(state),
      blueprintContext,
      blueprintConfig: state.autoConf.drill?.blueprint,
    });

    // Activate the generated trajectory
    const trajState = activateTrajectory(state.repoRoot, result.trajectory.name);
    if (!trajState) {
      state.displayAdapter.log(chalk.yellow('  Drill: trajectory generated but activation failed'));
      return 'failed';
    }

    // Load into session state
    const traj = loadTrajectory(state.repoRoot, result.trajectory.name);
    if (!traj) {
      state.displayAdapter.log(chalk.yellow('  Drill: trajectory generated but could not be loaded'));
      return 'failed';
    }

    state.activeTrajectory = traj;
    state.activeTrajectoryState = trajState;
    state.currentTrajectoryStep = getTrajectoryNextStep(traj, trajState.stepStates);

    // Update drill tracking
    state.drillLastGeneratedAtCycle = state.cycleCount;
    state.drillTrajectoriesGenerated++;

    // Augment generation telemetry with blueprint + quality gate data
    if (state.drillGenerationTelemetry) {
      state.drillGenerationTelemetry.blueprintGroupCount = blueprintGroupCount;
      state.drillGenerationTelemetry.blueprintConflictCount = blueprintConflictCount;
      state.drillGenerationTelemetry.blueprintEnablerCount = blueprintEnablerCount;
      state.drillGenerationTelemetry.blueprintMergeableCount = blueprintMergeableCount;
      state.drillGenerationTelemetry.qualityRetried = result.qualityRetried;
      state.drillGenerationTelemetry.qualityIssueCount = result.qualityIssues?.length ?? 0;
    }

    const stepCount = traj.steps.length;
    state.displayAdapter.log(chalk.green(`  Drill: trajectory "${traj.name}" activated (${stepCount} steps)`));
    if (state.options.verbose) state.displayAdapter.log(chalk.gray(`    ${result.filePath}`));
    if (result.qualityRetried) {
      state.displayAdapter.log(chalk.yellow(`    Quality gate: retried (${result.qualityIssues?.length ?? 0} issue(s) remaining)`));
    }
    if (state.options.verbose && result.planningAnalysis) {
      state.displayAdapter.log(chalk.gray(`    Planning analysis captured (${result.planningAnalysis.length} chars)`));
    }
    if (state.currentTrajectoryStep) {
      state.displayAdapter.log(chalk.cyan(`    First step: ${state.currentTrajectoryStep.title}`));
    }
    if (state.options.verbose && state.drillHistory.length > 0) {
      state.displayAdapter.log(chalk.gray(`    Session trajectories: ${state.drillHistory.length} previous`));
    }

    // Clear escalation candidates that were consumed by this trajectory
    if (escalationCount > 0) {
      state.escalationCandidates.clear();
    }

    return 'generated';
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    state.displayAdapter.log(chalk.yellow(`  Drill: trajectory generation failed — ${msg}`));
    // Don't update drillLastGeneratedAtCycle on failure — allow retry on next cycle
    // instead of forcing a full cooldown after a transient error
    return 'failed';
  }
}

/**
 * Run a broad survey scout to gather proposals for trajectory generation.
 * Wraps scoutAllSectors() — reuses existing multi-sector scout logic.
 * Proposals are returned pre-ranked by score (highest first).
 */
export async function runDrillSurvey(state: AutoSessionState): Promise<TicketProposal[]> {
  const { proposals } = await scoutAllSectors(state);
  return proposals;
}
