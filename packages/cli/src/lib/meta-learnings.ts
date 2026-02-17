/**
 * Meta-learning extraction — detects aggregate patterns across cycles.
 *
 * Runs after 3+ cycles to identify systemic issues like:
 * - Confidence miscalibration (high failure rates)
 * - Category-specific failure patterns
 * - QA command timeout patterns
 * - QA command reliability issues
 *
 * Learnings are automatically picked up by selectRelevant() in future cycles.
 */

import { addLearning, type Learning } from './learnings.js';
import { loadQaStats, type QaStatsStore } from './qa-stats.js';
import { readRunState } from './run-state.js';
import type { TicketOutcome } from './run-history.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MetaLearningContext {
  projectRoot: string;
  cycleOutcomes: TicketOutcome[];
  allOutcomes: TicketOutcome[];
  learningsEnabled: boolean;
  existingLearnings: Learning[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Check if a learning with similar text already exists (dedup guard) */
function hasSimilarLearning(existing: Learning[], needle: string): boolean {
  const needleLower = needle.toLowerCase();
  return existing.some(l => {
    const textLower = l.text.toLowerCase();
    // Exact match
    if (textLower === needleLower) return true;
    // Substring containment (either direction)
    if (textLower.includes(needleLower) || needleLower.includes(textLower)) return true;
    return false;
  });
}

/** Get process_insight learnings only */
function getProcessInsights(learnings: Learning[]): Learning[] {
  return learnings.filter(l => l.source.type === 'process_insight');
}

// ---------------------------------------------------------------------------
// Check functions
// ---------------------------------------------------------------------------

/**
 * Check for confidence miscalibration — high failure rate across recent outcomes.
 */
function checkConfidenceMiscalibration(ctx: MetaLearningContext): number {
  const outcomes = ctx.allOutcomes;
  if (outcomes.length < 5) return 0;

  // Look at the most recent 20 outcomes
  const recent = outcomes.slice(-20);
  const failed = recent.filter(o => o.status === 'failed').length;
  const total = recent.length;

  if (total < 3) return 0;
  if (failed / total <= 0.4) return 0;

  const text = `High failure rate across recent cycles (${failed}/${total} = ${Math.round(failed / total * 100)}%) — scout may be overestimating feasibility`;
  const existing = getProcessInsights(ctx.existingLearnings);
  if (hasSimilarLearning(existing, 'High failure rate across recent cycles')) return 0;

  addLearning(ctx.projectRoot, {
    text: text.slice(0, 200),
    category: 'warning',
    source: { type: 'process_insight', detail: 'confidence_miscalibration' },
    tags: [],
  });
  return 1;
}

/**
 * Check for category-specific failure patterns.
 */
function checkCategoryFailurePatterns(ctx: MetaLearningContext): number {
  const outcomes = ctx.allOutcomes;
  if (outcomes.length < 5) return 0;

  // Group by category
  const byCategory = new Map<string, { total: number; failed: number }>();
  for (const o of outcomes) {
    const cat = o.category ?? 'unknown';
    const entry = byCategory.get(cat) ?? { total: 0, failed: 0 };
    entry.total++;
    if (o.status === 'failed') entry.failed++;
    byCategory.set(cat, entry);
  }

  let added = 0;
  const existing = getProcessInsights(ctx.existingLearnings);

  for (const [category, { total, failed }] of byCategory) {
    if (total < 5) continue;
    const failRate = failed / total;
    if (failRate <= 0.5) continue;

    const text = `Category ${category} has high failure rate (${Math.round(failRate * 100)}% over ${total} tickets) — consider smaller scope`;
    if (hasSimilarLearning(existing, `Category ${category} has high failure rate`)) continue;

    addLearning(ctx.projectRoot, {
      text: text.slice(0, 200),
      category: 'warning',
      source: { type: 'process_insight', detail: `category_failure:${category}` },
      tags: [`category:${category}`],
    });
    added++;
  }

  return added;
}

/**
 * Check for QA command timeout patterns.
 */
function checkTimeoutPatterns(ctx: MetaLearningContext): number {
  let store: QaStatsStore;
  try {
    store = loadQaStats(ctx.projectRoot);
  } catch {
    return 0;
  }

  let added = 0;
  const existing = getProcessInsights(ctx.existingLearnings);

  for (const stats of Object.values(store.commands)) {
    if (stats.totalRuns < 5) continue;
    const timeoutRate = stats.timeouts / stats.totalRuns;
    if (timeoutRate <= 0.2) continue;

    const text = `QA command ${stats.name} times out frequently (${Math.round(timeoutRate * 100)}% of ${stats.totalRuns} runs) — consider increasing timeout`;
    if (hasSimilarLearning(existing, `QA command ${stats.name} times out frequently`)) continue;

    addLearning(ctx.projectRoot, {
      text: text.slice(0, 200),
      category: 'gotcha',
      source: { type: 'process_insight', detail: `timeout_pattern:${stats.name}` },
      tags: [`cmd:${stats.name}`],
    });
    added++;
  }

  return added;
}

/**
 * Check for a single QA command accounting for most failures.
 */
function checkQaCommandReliability(ctx: MetaLearningContext): number {
  let store: QaStatsStore;
  try {
    store = loadQaStats(ctx.projectRoot);
  } catch {
    return 0;
  }

  const commands = Object.values(store.commands);
  if (commands.length < 2) return 0;

  const totalFailures = commands.reduce((sum, s) => sum + s.failures, 0);
  if (totalFailures < 3) return 0;

  const existing = getProcessInsights(ctx.existingLearnings);

  for (const stats of commands) {
    if (stats.failures === 0) continue;
    const failShare = stats.failures / totalFailures;
    if (failShare <= 0.6) continue;

    const text = `${stats.name} is the primary QA failure source (${Math.round(failShare * 100)}% of all failures) — focus on compatibility`;
    if (hasSimilarLearning(existing, `${stats.name} is the primary QA failure source`)) continue;

    addLearning(ctx.projectRoot, {
      text: text.slice(0, 200),
      category: 'gotcha',
      source: { type: 'process_insight', detail: `reliability:${stats.name}` },
      tags: [`cmd:${stats.name}`],
    });
    return 1;
  }

  return 0;
}

/**
 * Check for formulas with low success rate (< 40% over 5+ tickets).
 */
function checkFormulaEffectiveness(ctx: MetaLearningContext): number {
  let rs;
  try {
    rs = readRunState(ctx.projectRoot);
  } catch {
    return 0;
  }

  const formulaStats = rs.formulaStats;
  if (!formulaStats || Object.keys(formulaStats).length === 0) return 0;

  let added = 0;
  const existing = getProcessInsights(ctx.existingLearnings);

  for (const [name, stats] of Object.entries(formulaStats)) {
    if (stats.ticketsTotal < 5) continue;
    const successRate = stats.ticketsTotal > 0
      ? stats.ticketsSucceeded / stats.ticketsTotal
      : 1;
    if (successRate >= 0.4) continue;

    const ratePct = Math.round(successRate * 100);
    const text = `Formula ${name} has low success rate (${ratePct}%) — consider adjusting scope or switching formulas`;
    if (hasSimilarLearning(existing, `Formula ${name} has low success rate`)) continue;

    addLearning(ctx.projectRoot, {
      text: text.slice(0, 200),
      category: 'warning',
      source: { type: 'process_insight', detail: `formula_effectiveness:${name}` },
      tags: [`formula:${name}`],
    });
    added++;
  }

  return added;
}

/**
 * Check for formulas with low merge rate (< 50% over 3+ merge/close events).
 */
function checkFormulaMergeRate(ctx: MetaLearningContext): number {
  let rs;
  try {
    rs = readRunState(ctx.projectRoot);
  } catch {
    return 0;
  }

  const formulaStats = rs.formulaStats;
  if (!formulaStats || Object.keys(formulaStats).length === 0) return 0;

  let added = 0;
  const existing = getProcessInsights(ctx.existingLearnings);

  for (const [name, stats] of Object.entries(formulaStats)) {
    const mergeCount = stats.mergeCount ?? 0;
    const closedCount = stats.closedCount ?? 0;
    const totalPrOutcomes = mergeCount + closedCount;
    if (totalPrOutcomes < 3) continue;

    const mergeRate = mergeCount / totalPrOutcomes;
    if (mergeRate >= 0.5) continue;

    const ratePct = Math.round(mergeRate * 100);
    const text = `Formula ${name} PRs are frequently closed (${ratePct}% merge rate) — output may not match project standards`;
    if (hasSimilarLearning(existing, `Formula ${name} PRs are frequently closed`)) continue;

    addLearning(ctx.projectRoot, {
      text: text.slice(0, 200),
      category: 'warning',
      source: { type: 'process_insight', detail: `formula_merge_rate:${name}` },
      tags: [`formula:${name}`],
    });
    added++;
  }

  return added;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Extract meta-learnings from aggregate patterns across cycles.
 *
 * Returns the number of learnings added.
 */
export function extractMetaLearnings(ctx: MetaLearningContext): number {
  if (!ctx.learningsEnabled) return 0;

  let total = 0;
  total += checkConfidenceMiscalibration(ctx);
  total += checkCategoryFailurePatterns(ctx);
  total += checkTimeoutPatterns(ctx);
  total += checkQaCommandReliability(ctx);
  total += checkFormulaEffectiveness(ctx);
  total += checkFormulaMergeRate(ctx);
  return total;
}
