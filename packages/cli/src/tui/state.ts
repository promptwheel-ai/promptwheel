/**
 * TUI state builder - Builds TuiSnapshot from repos
 *
 * This is the ONLY place the TUI touches the database.
 * All reads go through repos, never raw SQL.
 */

import * as crypto from 'node:crypto';
import type { DatabaseAdapter } from '@promptwheel/core/db';
import { projects, tickets, runs, runSteps } from '@promptwheel/core/repos';
import type { TicketStatus, RunStatus } from '@promptwheel/core/repos';

export type TuiSnapshot = {
  generatedAtMs: number;

  project: {
    id: string;
    name: string;
    repoRoot: string;
  } | null;

  tickets: Record<TicketStatus, number>;

  runs: {
    activeCount: number;
    lastScout: {
      id: string;
      status: RunStatus;
      completedAt: Date | null;
      proposalCount: number;
      ticketCount: number;
      scannedFiles: number;
      durationMs: number;
    } | null;
    lastQa: {
      id: string;
      status: RunStatus;
      completedAt: Date | null;
      stepsPassed: number;
      stepsFailed: number;
      durationMs: number;
    } | null;
    lastExecute: {
      id: string;
      ticketId: string | null;
      status: RunStatus;
      completedAt: Date | null;
      branchName: string | null;
      prUrl: string | null;
      durationMs: number;
    } | null;
    lastQaStepsSummary: {
      latestAttempt: number;
      counts: {
        passed: number;
        failed: number;
        active: number;
        skipped: number;
        total: number;
      };
      firstFailedStep: string | null;
      runningStep: string | null;
      totalDurationMs: number;
    } | null;
    lastExecuteStepsSummary: {
      latestAttempt: number;
      counts: {
        passed: number;
        failed: number;
        active: number;
        skipped: number;
        total: number;
      };
      firstFailedStep: string | null;
      runningStep: string | null;
      totalDurationMs: number;
    } | null;
    runningStep: {
      runId: string;
      runType: 'qa' | 'execute';
      name: string;
      startedAtMs: number;
    } | null;
  };

  /**
   * A stable hash that changes when snapshot meaningfully changes.
   * Used by poller to dedupe UI renders.
   */
  etag: string;

  /**
   * One-line hint the footer can show.
   */
  hintLine: string;
};

export type BuildSnapshotDeps = {
  db: DatabaseAdapter;
  repoRoot: string;
};

function sha1(input: string): string {
  return crypto.createHash('sha1').update(input).digest('hex');
}

function emptyTicketCounts(): Record<TicketStatus, number> {
  return {
    backlog: 0,
    ready: 0,
    leased: 0,
    in_progress: 0,
    in_review: 0,
    done: 0,
    blocked: 0,
    aborted: 0,
  };
}

export async function buildSnapshot(deps: BuildSnapshotDeps): Promise<TuiSnapshot> {
  const { db, repoRoot } = deps;
  const generatedAtMs = Date.now();

  // Get project by repo root
  const project = await projects.getByRepoRoot(db, repoRoot);
  if (!project) {
    return {
      generatedAtMs,
      project: null,
      tickets: emptyTicketCounts(),
      runs: {
        activeCount: 0,
        lastScout: null,
        lastQa: null,
        lastExecute: null,
        lastQaStepsSummary: null,
        lastExecuteStepsSummary: null,
        runningStep: null,
      },
      etag: sha1('no-project'),
      hintLine: 's scout • q qa • r refresh • ctrl+c quit',
    };
  }

  // Get all data in parallel
  const [ticketCounts, runSummary] = await Promise.all([
    tickets.countByStatus(db, project.id),
    runs.getSummary(db, project.id),
  ]);

  // Get step summaries for QA and Execute runs
  let lastQaStepsSummary: TuiSnapshot['runs']['lastQaStepsSummary'] = null;
  let lastExecuteStepsSummary: TuiSnapshot['runs']['lastExecuteStepsSummary'] = null;
  let runningStep: TuiSnapshot['runs']['runningStep'] = null;

  // QA steps
  if (runSummary.lastQa) {
    const stepsSummary = await runSteps.getSummary(db, runSummary.lastQa.id);
    lastQaStepsSummary = {
      latestAttempt: stepsSummary.latestAttempt,
      counts: stepsSummary.counts,
      firstFailedStep: stepsSummary.firstFailedStep,
      runningStep: stepsSummary.runningStep,
      totalDurationMs: stepsSummary.totalDurationMs,
    };

    // Get running step if QA is active
    if (runSummary.lastQa.status === 'running') {
      const step = await runSteps.getRunningStep(db, runSummary.lastQa.id);
      if (step) {
        runningStep = {
          runId: runSummary.lastQa.id,
          runType: 'qa',
          name: step.name,
          startedAtMs: step.startedAtMs ?? Date.now(),
        };
      }
    }
  }

  // Execute steps (higher priority for running step display)
  if (runSummary.lastExecute) {
    const stepsSummary = await runSteps.getSummary(db, runSummary.lastExecute.id);
    lastExecuteStepsSummary = {
      latestAttempt: stepsSummary.latestAttempt,
      counts: stepsSummary.counts,
      firstFailedStep: stepsSummary.firstFailedStep,
      runningStep: stepsSummary.runningStep,
      totalDurationMs: stepsSummary.totalDurationMs,
    };

    // Execute running step takes priority over QA
    if (runSummary.lastExecute.status === 'running') {
      const step = await runSteps.getRunningStep(db, runSummary.lastExecute.id);
      if (step) {
        runningStep = {
          runId: runSummary.lastExecute.id,
          runType: 'execute',
          name: step.name,
          startedAtMs: step.startedAtMs ?? Date.now(),
        };
      }
    }
  }

  // Build etag from meaningful state
  const etag = sha1(
    JSON.stringify({
      projectId: project.id,
      ticketCounts,
      lastScout: runSummary.lastScout
        ? {
            id: runSummary.lastScout.id,
            status: runSummary.lastScout.status,
            completedAt: runSummary.lastScout.completedAt?.toISOString(),
          }
        : null,
      lastQa: runSummary.lastQa
        ? {
            id: runSummary.lastQa.id,
            status: runSummary.lastQa.status,
            completedAt: runSummary.lastQa.completedAt?.toISOString(),
          }
        : null,
      lastExecute: runSummary.lastExecute
        ? {
            id: runSummary.lastExecute.id,
            status: runSummary.lastExecute.status,
            completedAt: runSummary.lastExecute.completedAt?.toISOString(),
          }
        : null,
      activeCount: runSummary.activeRuns,
      runningStep: runningStep?.name,
      qaStepsDigest: lastQaStepsSummary
        ? {
            latestAttempt: lastQaStepsSummary.latestAttempt,
            counts: lastQaStepsSummary.counts,
          }
        : null,
      executeStepsDigest: lastExecuteStepsSummary
        ? {
            latestAttempt: lastExecuteStepsSummary.latestAttempt,
            counts: lastExecuteStepsSummary.counts,
          }
        : null,
    })
  );

  // Build hint line
  let hintLine = 's scout • q qa • r refresh • ctrl+c quit';
  if (runningStep) {
    const prefix = runningStep.runType === 'execute' ? 'Executing' : 'Running';
    hintLine = `${prefix}: ${runningStep.name}  |  r refresh • ctrl+c quit`;
  }

  return {
    generatedAtMs,
    project: {
      id: project.id,
      name: project.name,
      repoRoot: project.rootPath,
    },
    tickets: ticketCounts,
    runs: {
      activeCount: runSummary.activeRuns,
      lastScout: runSummary.lastScout,
      lastQa: runSummary.lastQa,
      lastExecute: runSummary.lastExecute,
      lastQaStepsSummary,
      lastExecuteStepsSummary,
      runningStep,
    },
    etag,
    hintLine,
  };
}
