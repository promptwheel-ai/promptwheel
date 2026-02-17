/**
 * Thin bridge for recording quality signals from the MCP/plugin path.
 *
 * Reads and writes `.blockspool/run-state.json` directly using the same
 * format as CLI's `packages/cli/src/lib/run-state.ts`. Uses tmp+rename
 * atomic write pattern. No mutex needed — MCP and CLI don't run
 * simultaneously on the same project.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Types (subset of CLI's RunState — only what we need)
// ---------------------------------------------------------------------------

interface QualitySignals {
  totalTickets: number;
  firstPassSuccess: number;
  retriedSuccess: number;
  qaPassed: number;
  qaFailed: number;
}

interface RunState {
  totalCycles: number;
  lastDocsAuditCycle: number;
  lastRunAt: number;
  deferredProposals: unknown[];
  formulaStats: Record<string, unknown>;
  recentCycles?: unknown[];
  recentDiffs?: unknown[];
  qualitySignals?: QualitySignals;
}

// ---------------------------------------------------------------------------
// File I/O
// ---------------------------------------------------------------------------

const RUN_STATE_FILE = 'run-state.json';

function statePath(projectRoot: string): string {
  return path.join(projectRoot, '.blockspool', RUN_STATE_FILE);
}

function readRunState(projectRoot: string): RunState {
  const fp = statePath(projectRoot);
  if (!fs.existsSync(fp)) {
    return {
      totalCycles: 0,
      lastDocsAuditCycle: 0,
      lastRunAt: 0,
      deferredProposals: [],
      formulaStats: {},
      recentCycles: [],
      recentDiffs: [],
    };
  }
  try {
    const raw = fs.readFileSync(fp, 'utf-8');
    const parsed = JSON.parse(raw);
    return {
      totalCycles: parsed.totalCycles ?? 0,
      lastDocsAuditCycle: parsed.lastDocsAuditCycle ?? 0,
      lastRunAt: parsed.lastRunAt ?? 0,
      deferredProposals: Array.isArray(parsed.deferredProposals) ? parsed.deferredProposals : [],
      formulaStats: parsed.formulaStats ?? {},
      recentCycles: parsed.recentCycles,
      recentDiffs: parsed.recentDiffs,
      qualitySignals: parsed.qualitySignals ?? undefined,
    };
  } catch (err) {
    console.warn(`[blockspool] failed to parse run-state.json: ${err instanceof Error ? err.message : String(err)}`);
    return {
      totalCycles: 0,
      lastDocsAuditCycle: 0,
      lastRunAt: 0,
      deferredProposals: [],
      formulaStats: {},
      recentCycles: [],
      recentDiffs: [],
    };
  }
}

function writeRunState(projectRoot: string, state: RunState): void {
  const fp = statePath(projectRoot);
  const dir = path.dirname(fp);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmp = fp + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
  fs.renameSync(tmp, fp);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Record an execution quality signal. Same format as CLI's recordQualitySignal.
 */
export function recordQualitySignal(
  projectRoot: string,
  signal: 'first_pass' | 'retried' | 'qa_pass' | 'qa_fail',
): void {
  const state = readRunState(projectRoot);
  const qs = state.qualitySignals ??= {
    totalTickets: 0,
    firstPassSuccess: 0,
    retriedSuccess: 0,
    qaPassed: 0,
    qaFailed: 0,
  };
  switch (signal) {
    case 'first_pass': qs.totalTickets++; qs.firstPassSuccess++; break;
    case 'retried': qs.totalTickets++; qs.retriedSuccess++; break;
    case 'qa_pass': qs.qaPassed++; break;
    case 'qa_fail': qs.qaFailed++; break;
  }
  writeRunState(projectRoot, state);
}
