/**
 * Solo mode ticket execution
 */

import * as path from 'node:path';
import { runSteps } from '@promptwheel/core/repos';
import {
  writeJsonArtifact,
  type RunSummaryArtifact,
} from '../lib/artifacts.js';
import {
  createSpindleState,
  DEFAULT_SPINDLE_CONFIG,
  type SpindleConfig,
} from '../lib/spindle/index.js';
import { getPromptwheelDir } from './solo-config.js';
import { ClaudeExecutionBackend } from './execution-backends/index.js';
import { cleanupWorktree } from './solo-git.js';
import type {
  RunTicketResult,
  RunTicketOptions,
  StepName,
} from './solo-ticket-types.js';
import { EXECUTE_STEPS } from './solo-ticket-types.js';
import {
  stepWorktree,
  stepAgent,
  stepSpindle,
  stepScope,
  stepCommit,
  stepPush,
  stepQa,
  stepPr,
  stepCleanup,
  type TicketContext,
} from './ticket-steps/index.js';

// Re-export QA baseline functions from extracted module
export { type BaselineResult, baselineToPassFail, captureQaBaseline } from './solo-ticket-qa.js';

/**
 * Build the TicketContext from RunTicketOptions.
 * Sets up step records, spindle state, artifact tracking, and helper closures.
 */
async function buildTicketContext(opts: RunTicketOptions): Promise<TicketContext> {
  const {
    ticket,
    repoRoot,
    config,
    adapter,
    runId,
    verbose,
    onProgress,
  } = opts;

  const startTime = Date.now();
  const branchName = `promptwheel/${ticket.id}`;
  const worktreePath = path.join(repoRoot, '.promptwheel', 'worktrees', ticket.id);
  const baseDir = getPromptwheelDir(repoRoot);

  // Create all steps upfront
  const stepRecords = new Map<StepName, Awaited<ReturnType<typeof runSteps.create>>>();
  for (let i = 0; i < EXECUTE_STEPS.length; i++) {
    const stepDef = EXECUTE_STEPS[i];
    const step = await runSteps.create(adapter, {
      runId,
      ordinal: i,
      name: stepDef.name,
      kind: stepDef.kind,
    });
    stepRecords.set(stepDef.name, step);
  }

  const artifactPaths: TicketContext['artifactPaths'] = {};

  const spindleConfig: SpindleConfig = {
    ...DEFAULT_SPINDLE_CONFIG,
    ...config?.spindle,
  };
  const spindleState = createSpindleState();

  const stepResults: TicketContext['stepResults'] = [];

  // Helper to save run summary artifact
  async function saveRunSummary(result: RunTicketResult): Promise<string> {
    const summary: RunSummaryArtifact = {
      runId,
      ticketId: ticket.id,
      ticketTitle: ticket.title,
      projectId: ticket.projectId,
      success: result.success,
      startedAt: new Date(startTime).toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: result.durationMs,
      branchName: result.branchName,
      prUrl: result.prUrl,
      error: result.error,
      steps: stepResults.map(s => ({
        name: s.name,
        status: s.status,
        durationMs: s.startedAt && s.completedAt ? s.completedAt - s.startedAt : undefined,
        errorMessage: s.errorMessage,
      })),
      artifacts: artifactPaths,
    };

    return writeJsonArtifact({
      baseDir,
      type: 'runs',
      id: runId,
      data: summary,
    });
  }

  // Helper to mark step progress
  async function markStep(name: StepName, status: 'started' | 'success' | 'failed' | 'skipped', markOpts?: {
    errorMessage?: string;
    metadata?: Record<string, unknown>;
  }) {
    const step = stepRecords.get(name);
    if (!step) return;

    onProgress(`${name}...`);

    let stepResult = stepResults.find(s => s.name === name);
    if (!stepResult) {
      stepResult = { name, status: 'skipped' };
      stepResults.push(stepResult);
    }

    switch (status) {
      case 'started':
        stepResult.startedAt = Date.now();
        await runSteps.markStarted(adapter, step.id);
        break;
      case 'success':
        stepResult.status = 'success';
        stepResult.completedAt = Date.now();
        await runSteps.markSuccess(adapter, step.id, markOpts);
        break;
      case 'failed':
        stepResult.status = 'failed';
        stepResult.completedAt = Date.now();
        stepResult.errorMessage = markOpts?.errorMessage;
        await runSteps.markFailed(adapter, step.id, {
          errorMessage: markOpts?.errorMessage,
          metadata: markOpts?.metadata,
        });
        break;
      case 'skipped':
        stepResult.status = 'skipped';
        stepResult.errorMessage = markOpts?.errorMessage;
        await runSteps.markSkipped(adapter, step.id, markOpts?.errorMessage);
        break;
    }
  }

  // Helper to mark remaining steps as skipped
  async function skipRemaining(fromIndex: number, reason: string) {
    for (let i = fromIndex; i < EXECUTE_STEPS.length; i++) {
      await markStep(EXECUTE_STEPS[i].name, 'skipped', { errorMessage: reason });
    }
  }

  return {
    ticket,
    repoRoot,
    config,
    adapter,
    runId,
    verbose,
    opts,
    branchName,
    worktreePath,
    baseDir,
    startTime,
    baselineFiles: new Set(),
    qaBaseline: null,
    artifactPaths,
    spindleState,
    spindleConfig,
    changedFiles: [],
    statusOutput: '',
    prUrl: undefined,
    execBackend: new ClaudeExecutionBackend(), // default, overridden by step-agent
    stepRecords,
    stepResults,
    markStep,
    skipRemaining,
    saveRunSummary,
    onProgress,
  };
}

/**
 * Execute a ticket in isolation with step tracking.
 *
 * Pipeline: worktree → agent → spindle → scope → commit → push → qa → pr → cleanup
 */
export async function soloRunTicket(opts: RunTicketOptions): Promise<RunTicketResult> {
  const ctx = await buildTicketContext(opts);

  const steps = [
    stepWorktree,
    stepAgent,
    stepSpindle,
    stepScope,
    stepCommit,
    stepPush,
    stepQa,
    stepPr,
    stepCleanup,
  ];

  try {
    for (const step of steps) {
      const result = await step(ctx);
      if (!result.continue) {
        return result.result!;
      }
    }

    // All steps completed successfully
    const result: RunTicketResult = {
      success: true,
      branchName: ctx.branchName,
      prUrl: ctx.prUrl,
      durationMs: Date.now() - ctx.startTime,
      traceAnalysis: ctx.traceAnalysis,
    };
    await ctx.saveRunSummary(result);
    return result;
  } catch (error) {
    await cleanupWorktree(ctx.repoRoot, ctx.worktreePath);

    const result: RunTicketResult = {
      success: false,
      durationMs: Date.now() - ctx.startTime,
      error: error instanceof Error ? error.message : String(error),
    };
    await ctx.saveRunSummary(result);
    return result;
  }
}
