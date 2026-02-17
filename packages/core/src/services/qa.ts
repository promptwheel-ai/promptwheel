/**
 * QA Service - Run local QA commands and record results
 *
 * This is pure orchestration: no FS writes, no raw SQL.
 * Uses repos + ExecRunner for all operations.
 */

import * as path from 'node:path';

import type { DatabaseAdapter } from '../db/adapter.js';
import type { ExecRunner, ExecResult } from '../exec/types.js';

import * as runs from '../repos/runs.js';
import * as runSteps from '../repos/run_steps.js';

export interface QaLogger {
  info: (msg: string) => void;
  warn?: (msg: string) => void;
  error: (msg: string) => void;
  debug?: (msg: string) => void;
}

export interface QaCommand {
  name: string;
  cmd: string;
  cwd?: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
}

export interface QaArtifactsConfig {
  dir: string;
  maxLogBytes: number;
  tailBytes: number;
}

export interface QaRetryConfig {
  enabled: boolean;
  maxAttempts: number;
}

export interface QaConfig {
  commands: QaCommand[];
  artifacts: QaArtifactsConfig;
  retry: QaRetryConfig;
}

export interface QaDeps {
  db: DatabaseAdapter;
  exec: ExecRunner;
  logger: QaLogger;
}

export interface QaRunOptions {
  projectId: string;
  repoRoot: string;
  config: QaConfig;
  maxAttemptsOverride?: number;
  signal?: AbortSignal;
}

export interface QaRunResult {
  runId: string;
  projectId: string;
  status: 'success' | 'failed' | 'canceled';
  attempts: number;
  latestAttempt: number;
  failedAt?: {
    attempt: number;
    stepName: string;
  };
  startedAtMs: number;
  endedAtMs: number;
  durationMs: number;
}

function resolveCwd(repoRootAbs: string, cwd?: string): string {
  if (!cwd || cwd === '.') return repoRootAbs;
  return path.isAbsolute(cwd) ? cwd : path.join(repoRootAbs, cwd);
}

function execStatusToStepStatus(exec: ExecResult): 'success' | 'failed' | 'canceled' {
  if (exec.status === 'success') return 'success';
  if (exec.status === 'canceled') return 'canceled';
  return 'failed';
}

/**
 * Run QA commands and record results
 */
export async function runQa(
  deps: QaDeps,
  opts: QaRunOptions
): Promise<QaRunResult> {
  const { db, exec, logger } = deps;
  const { projectId, repoRoot, config, signal } = opts;

  if (!config.commands?.length) {
    throw new Error('QA config has no commands. Add qa.commands to .promptwheel/config.json');
  }

  // Validate unique step names
  const names = new Set<string>();
  for (const c of config.commands) {
    if (!c.name?.trim()) throw new Error('QA command is missing a name');
    if (!c.cmd?.trim()) throw new Error(`QA command "${c.name}" is missing cmd`);
    if (names.has(c.name)) throw new Error(`Duplicate QA command name: "${c.name}"`);
    names.add(c.name);
  }

  const startedAtMs = Date.now();

  // Determine max attempts
  const maxAttempts =
    opts.maxAttemptsOverride ??
    (config.retry.enabled ? config.retry.maxAttempts : 1);

  // Create the run
  const run = await runs.create(db, {
    projectId,
    type: 'qa',
    maxIterations: maxAttempts,
    metadata: {
      maxAttempts,
      commandCount: config.commands.length,
    },
  });

  logger.info(`QA run started: ${run.id}`);

  let latestAttempt = 1;
  let finalStatus: 'success' | 'failed' | 'canceled' = 'failed';
  let failedAt: QaRunResult['failedAt'] | undefined;

  // Check for early cancellation
  if (signal?.aborted) {
    await runs.markFailure(db, run.id, 'Canceled before start', { attempts: 0 });
    return {
      runId: run.id,
      projectId,
      status: 'canceled',
      attempts: 0,
      latestAttempt: 0,
      startedAtMs,
      endedAtMs: Date.now(),
      durationMs: Date.now() - startedAtMs,
    };
  }

  // Attempt loop
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    latestAttempt = attempt;
    logger.info(`Attempt ${attempt}/${maxAttempts}`);

    // Pre-create steps as queued
    const createdSteps = await runSteps.createMany(
      db,
      run.id,
      config.commands.map((c) => ({
        name: c.name,
        cmd: c.cmd,
        cwd: c.cwd ?? '.',
        timeoutMs: c.timeoutMs,
      })),
      attempt
    );

    let attemptFailed = false;

    for (const step of createdSteps) {
      // Check for cancellation before each step
      if (signal?.aborted) {
        await runSteps.markCanceled(db, step.id, 'Canceled by user');
        // Cancel remaining steps
        for (const remaining of createdSteps) {
          if (remaining.ordinal > step.ordinal) {
            await runSteps.markCanceled(db, remaining.id, 'Canceled by user');
          }
        }
        finalStatus = 'canceled';
        failedAt = { attempt, stepName: step.name };
        attemptFailed = true;
        break;
      }

      await runSteps.markStarted(db, step.id);

      const cmdCfg = config.commands[step.ordinal]!;
      const cwdAbs = resolveCwd(repoRoot, cmdCfg.cwd ?? step.cwd ?? '.');

      const execRes = await exec.run({
        cmd: cmdCfg.cmd,
        cwd: cwdAbs,
        env: cmdCfg.env,
        timeoutMs: cmdCfg.timeoutMs ?? step.timeoutMs ?? undefined,
        signal,

        repoRoot,
        artifactsDir: config.artifacts.dir,

        runId: run.id,
        attempt,
        stepName: step.name,
        ordinal: step.ordinal,

        maxLogBytes: config.artifacts.maxLogBytes,
        tailBytes: config.artifacts.tailBytes,
      });

      const stepStatus = execStatusToStepStatus(execRes);

      if (stepStatus === 'success') {
        await runSteps.markSuccess(db, step.id, {
          exitCode: execRes.exitCode ?? 0,
          stdoutPath: execRes.stdout.path,
          stderrPath: execRes.stderr.path,
          stdoutBytes: execRes.stdout.bytes,
          stderrBytes: execRes.stderr.bytes,
          stdoutTruncated: execRes.stdout.truncated,
          stderrTruncated: execRes.stderr.truncated,
          stdoutTail: execRes.stdout.tail,
          stderrTail: execRes.stderr.tail,
          metadata: { execStatus: execRes.status },
        });
        logger.info(`  ✓ ${step.name}`);
        continue;
      }

      // Failed or canceled
      attemptFailed = true;

      const errorMessage =
        execRes.errorMessage ??
        (execRes.status === 'timeout'
          ? `Timed out after ${cmdCfg.timeoutMs ?? step.timeoutMs ?? 'unknown'}ms`
          : execRes.status === 'canceled'
          ? 'Canceled'
          : `Exited with code ${execRes.exitCode ?? 'unknown'}`);

      if (stepStatus === 'canceled') {
        await runSteps.markCanceled(db, step.id, errorMessage);
        finalStatus = 'canceled';
      } else {
        await runSteps.markFailed(db, step.id, {
          exitCode: execRes.exitCode ?? undefined,
          signal: execRes.signal ?? undefined,
          errorMessage,
          stdoutPath: execRes.stdout.path,
          stderrPath: execRes.stderr.path,
          stdoutBytes: execRes.stdout.bytes,
          stderrBytes: execRes.stderr.bytes,
          stdoutTruncated: execRes.stdout.truncated,
          stderrTruncated: execRes.stderr.truncated,
          stdoutTail: execRes.stdout.tail,
          stderrTail: execRes.stderr.tail,
          metadata: { execStatus: execRes.status },
        });
        finalStatus = 'failed';
      }

      logger.error(`  ✗ ${step.name}: ${errorMessage}`);
      failedAt = { attempt, stepName: step.name };

      // Cancel remaining queued steps in this attempt
      for (const remaining of createdSteps) {
        if (remaining.ordinal <= step.ordinal) continue;
        await runSteps.markSkipped(
          db,
          remaining.id,
          `Skipped (previous step "${step.name}" ${stepStatus})`
        );
      }

      break;
    }

    if (!attemptFailed) {
      finalStatus = 'success';
      failedAt = undefined;
      break;
    }

    // If canceled, don't retry
    if (finalStatus === 'canceled') {
      break;
    }
  }

  const endedAtMs = Date.now();

  // Finalize run
  if (finalStatus === 'success') {
    await runs.markSuccess(db, run.id, {
      attempts: latestAttempt,
      durationMs: endedAtMs - startedAtMs,
    });
  } else {
    const errorMsg = failedAt
      ? `Failed at ${failedAt.stepName} (attempt ${failedAt.attempt})`
      : finalStatus === 'canceled'
      ? 'QA canceled'
      : 'QA failed';
    await runs.markFailure(db, run.id, errorMsg, {
      attempts: latestAttempt,
      failedAt,
      durationMs: endedAtMs - startedAtMs,
    });
  }

  return {
    runId: run.id,
    projectId,
    status: finalStatus,
    attempts: latestAttempt,
    latestAttempt,
    failedAt,
    startedAtMs,
    endedAtMs,
    durationMs: endedAtMs - startedAtMs,
  };
}

/**
 * Get QA run details with step information
 */
export async function getQaRunDetails(
  db: DatabaseAdapter,
  runId: string
): Promise<{
  run: runs.Run | null;
  steps: runSteps.RunStep[];
  summary: runSteps.StepSummary;
} | null> {
  const run = await runs.getById(db, runId);
  if (!run) return null;

  const steps = await runSteps.listByRun(db, runId);
  const summary = await runSteps.getSummary(db, runId);

  return { run, steps, summary };
}
