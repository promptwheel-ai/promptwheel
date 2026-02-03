/**
 * Persistent run state for cross-session cycle tracking.
 *
 * Stored in `.blockspool/run-state.json`. Tracks how many scout cycles
 * have run so periodic tasks (like docs-audit) can trigger automatically.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CycleSummary } from './cycle-context.js';

export interface DeferredProposal {
  category: string;
  title: string;
  description: string;
  files: string[];
  allowed_paths: string[];
  confidence: number;
  impact_score: number;
  original_scope: string;
  deferredAt: number;
}

export interface FormulaStats {
  cycles: number;
  proposalsGenerated: number;
  ticketsSucceeded: number;
  ticketsTotal: number;
  recentCycles: number;
  recentProposalsGenerated: number;
  recentTicketsSucceeded: number;
  recentTicketsTotal: number;
  lastResetCycle: number;
  mergeCount?: number;
  closedCount?: number;
}

export interface RunState {
  /** Total scout cycles completed (persists across sessions) */
  totalCycles: number;
  /** Cycle number of the last docs-audit run */
  lastDocsAuditCycle: number;
  /** Timestamp of last run */
  lastRunAt: number;
  /** Proposals deferred because they were outside the session scope */
  deferredProposals: DeferredProposal[];
  /** Per-formula performance stats for adaptive rotation */
  formulaStats: Record<string, FormulaStats>;
  /** Recent cycle summaries for convergence-aware prompting */
  recentCycles?: CycleSummary[];
  /** Recent diff summaries for follow-up proposal generation */
  recentDiffs?: Array<{ title: string; summary: string; files: string[]; cycle: number }>;
  /** Execution quality signals for confidence calibration */
  qualitySignals?: {
    totalTickets: number;
    firstPassSuccess: number;
    retriedSuccess: number;
    qaPassed: number;
    qaFailed: number;
  };
}

const RUN_STATE_FILE = 'run-state.json';

function statePath(repoRoot: string): string {
  return path.join(repoRoot, '.blockspool', RUN_STATE_FILE);
}

const DEFAULT_STATE: RunState = {
  totalCycles: 0,
  lastDocsAuditCycle: 0,
  lastRunAt: 0,
  deferredProposals: [],
  formulaStats: {},
  recentCycles: [],
  recentDiffs: [],
};

/**
 * Read the current run state from disk.
 */
export function readRunState(repoRoot: string): RunState {
  const fp = statePath(repoRoot);
  if (!fs.existsSync(fp)) return { ...DEFAULT_STATE };

  try {
    const raw = fs.readFileSync(fp, 'utf-8');
    const parsed = JSON.parse(raw);
    return {
      totalCycles: parsed.totalCycles ?? 0,
      lastDocsAuditCycle: parsed.lastDocsAuditCycle ?? 0,
      lastRunAt: parsed.lastRunAt ?? 0,
      deferredProposals: Array.isArray(parsed.deferredProposals) ? parsed.deferredProposals : [],
      recentCycles: Array.isArray(parsed.recentCycles) ? parsed.recentCycles : [],
      recentDiffs: Array.isArray(parsed.recentDiffs) ? parsed.recentDiffs : [],
      qualitySignals: parsed.qualitySignals ?? undefined,
      formulaStats: (() => {
        const raw = parsed.formulaStats ?? {};
        for (const key of Object.keys(raw)) {
          const e = raw[key];
          e.recentCycles ??= 0;
          e.recentProposalsGenerated ??= 0;
          e.recentTicketsSucceeded ??= 0;
          e.recentTicketsTotal ??= 0;
          e.lastResetCycle ??= 0;
          e.mergeCount ??= 0;
          e.closedCount ??= 0;
        }
        return raw;
      })(),
    };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

/**
 * Write the run state to disk.
 */
export function writeRunState(repoRoot: string, state: RunState): void {
  const fp = statePath(repoRoot);
  const dir = path.dirname(fp);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(fp, JSON.stringify(state, null, 2) + '\n');
}

/**
 * Increment the cycle counter and return the new state.
 */
export function recordCycle(repoRoot: string): RunState {
  const state = readRunState(repoRoot);
  state.totalCycles += 1;
  state.lastRunAt = Date.now();
  writeRunState(repoRoot, state);
  return state;
}

/**
 * Check if a docs-audit cycle is due.
 * Returns true every N cycles since the last docs-audit.
 */
export function isDocsAuditDue(repoRoot: string, interval: number = 3): boolean {
  const state = readRunState(repoRoot);
  return (state.totalCycles - state.lastDocsAuditCycle) >= interval;
}

/**
 * Record that a docs-audit was run.
 */
export function recordDocsAudit(repoRoot: string): void {
  const state = readRunState(repoRoot);
  state.lastDocsAuditCycle = state.totalCycles;
  writeRunState(repoRoot, state);
}

/**
 * Record that a formula was used and produced N proposals.
 */
export function recordFormulaResult(repoRoot: string, formulaName: string, proposalCount: number): void {
  const state = readRunState(repoRoot);
  const entry = state.formulaStats[formulaName] ??= { cycles: 0, proposalsGenerated: 0, ticketsSucceeded: 0, ticketsTotal: 0, recentCycles: 0, recentProposalsGenerated: 0, recentTicketsSucceeded: 0, recentTicketsTotal: 0, lastResetCycle: 0 };
  entry.cycles++;
  entry.proposalsGenerated += proposalCount;
  entry.recentCycles++;
  entry.recentProposalsGenerated += proposalCount;
  if (state.totalCycles - entry.lastResetCycle >= 20) {
    entry.recentCycles = 1;
    entry.recentProposalsGenerated = proposalCount;
    entry.recentTicketsSucceeded = 0;
    entry.recentTicketsTotal = 0;
    entry.lastResetCycle = state.totalCycles;
  }
  writeRunState(repoRoot, state);
}

/**
 * Record a ticket success/failure for the formula that produced it.
 */
export function recordFormulaTicketOutcome(repoRoot: string, formulaName: string, success: boolean): void {
  const state = readRunState(repoRoot);
  const entry = state.formulaStats[formulaName] ??= { cycles: 0, proposalsGenerated: 0, ticketsSucceeded: 0, ticketsTotal: 0, recentCycles: 0, recentProposalsGenerated: 0, recentTicketsSucceeded: 0, recentTicketsTotal: 0, lastResetCycle: 0 };
  entry.ticketsTotal++;
  entry.recentTicketsTotal++;
  if (success) {
    entry.ticketsSucceeded++;
    entry.recentTicketsSucceeded++;
  }
  writeRunState(repoRoot, state);
}

/** Max age for deferred proposals (7 days) */
const MAX_DEFERRED_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Defer a proposal for later when the scope matches.
 */
export function deferProposal(repoRoot: string, proposal: DeferredProposal): void {
  const state = readRunState(repoRoot);
  // Avoid duplicates by title
  if (state.deferredProposals.some(d => d.title === proposal.title)) return;
  state.deferredProposals.push(proposal);
  writeRunState(repoRoot, state);
}

/**
 * Retrieve and remove deferred proposals that now match the given scope.
 * Also prunes proposals older than 7 days.
 */
export function popDeferredForScope(repoRoot: string, scope: string): DeferredProposal[] {
  const state = readRunState(repoRoot);
  const now = Date.now();
  const normalizedScope = scope.replace(/\*\*$/, '').replace(/\*$/, '').replace(/\/$/, '');

  const matched: DeferredProposal[] = [];
  const remaining: DeferredProposal[] = [];

  for (const dp of state.deferredProposals) {
    // Prune stale
    if (now - dp.deferredAt > MAX_DEFERRED_AGE_MS) continue;

    const files = dp.files.length > 0 ? dp.files : dp.allowed_paths;
    const inScope = !normalizedScope || files.length === 0 || files.every(f =>
      f.startsWith(normalizedScope) || f.startsWith(normalizedScope + '/')
    );

    if (inScope) {
      matched.push(dp);
    } else {
      remaining.push(dp);
    }
  }

  if (matched.length > 0 || remaining.length !== state.deferredProposals.length) {
    state.deferredProposals = remaining;
    writeRunState(repoRoot, state);
  }

  return matched;
}

/**
 * Record a formula merge/close outcome for PR merge signal tracking.
 */
export function recordFormulaMergeOutcome(projectRoot: string, formula: string, merged: boolean): void {
  const state = readRunState(projectRoot);
  const entry = state.formulaStats[formula] ??= { cycles: 0, proposalsGenerated: 0, ticketsSucceeded: 0, ticketsTotal: 0, recentCycles: 0, recentProposalsGenerated: 0, recentTicketsSucceeded: 0, recentTicketsTotal: 0, lastResetCycle: 0, mergeCount: 0, closedCount: 0 };
  if (merged) {
    entry.mergeCount = (entry.mergeCount ?? 0) + 1;
  } else {
    entry.closedCount = (entry.closedCount ?? 0) + 1;
  }
  writeRunState(projectRoot, state);
}

/** Max recent diffs to keep (ring buffer) */
const MAX_RECENT_DIFFS = 10;

/**
 * Push a diff summary to recentDiffs ring buffer.
 */
export function pushRecentDiff(
  projectRoot: string,
  diff: { title: string; summary: string; files: string[]; cycle: number },
): void {
  const state = readRunState(projectRoot);
  const diffs = state.recentDiffs ?? [];
  diffs.push(diff);
  if (diffs.length > MAX_RECENT_DIFFS) {
    diffs.splice(0, diffs.length - MAX_RECENT_DIFFS);
  }
  state.recentDiffs = diffs;
  writeRunState(projectRoot, state);
}

/**
 * Record an execution quality signal.
 */
export function recordQualitySignal(projectRoot: string, signal: 'first_pass' | 'retried' | 'qa_pass' | 'qa_fail'): void {
  const state = readRunState(projectRoot);
  const qs = state.qualitySignals ??= { totalTickets: 0, firstPassSuccess: 0, retriedSuccess: 0, qaPassed: 0, qaFailed: 0 };
  qs.totalTickets++;
  switch (signal) {
    case 'first_pass': qs.firstPassSuccess++; break;
    case 'retried': qs.retriedSuccess++; break;
    case 'qa_pass': qs.qaPassed++; break;
    case 'qa_fail': qs.qaFailed++; break;
  }
  writeRunState(projectRoot, state);
}

/**
 * Get the first-pass success rate (0-1). Returns 1 if no data.
 */
export function getQualityRate(projectRoot: string): number {
  const state = readRunState(projectRoot);
  const qs = state.qualitySignals;
  if (!qs || qs.totalTickets === 0) return 1;
  return qs.firstPassSuccess / qs.totalTickets;
}
