/**
 * Step 6: Run QA — execute quality assurance commands and handle retries.
 */

import * as path from 'node:path';
import {
  runQa,
  getQaRunDetails,
} from '@promptwheel/core/services';
import { projects } from '@promptwheel/core/repos';
import { createExecRunner } from '../exec.js';
import { createLogger } from '../logger.js';
import { normalizeQaConfig } from '../solo-utils.js';
import { parseChangedFiles, checkScopeViolations } from '../scope.js';
import { gitExec, gitExecFile } from '../solo-git.js';
import { recordCommandFailure } from '../spindle/index.js';
import { buildTicketPrompt } from '../solo-prompt-builder.js';
import { isTestFailure, extractTestFilesFromQaOutput } from '../solo-qa-retry.js';
import { recordQaCommandResult } from '../qa-stats.js';
import { recordQualitySignal } from '../run-state.js';
import type { FailureReason } from '../solo-ticket-types.js';
import type { TicketContext, StepResult } from './types.js';

export async function run(ctx: TicketContext): Promise<StepResult> {
  const { ticket, repoRoot, worktreePath, config, adapter, opts, startTime, branchName, onProgress, qaBaseline, spindleState, baselineFiles, execBackend } = ctx;
  const { skipQa } = opts;

  if (skipQa || !config?.qa?.commands?.length) {
    await ctx.markStep('qa', 'skipped', { errorMessage: skipQa ? 'Skipped by flag' : 'No QA configured' });
    return { continue: true };
  }

  await ctx.markStep('qa', 'started');

  const qaConfig = normalizeQaConfig(config);

  // Filter out pre-existing failures
  let effectiveQaConfig = qaConfig;
  const skippedCommands: string[] = [];
  if (qaBaseline) {
    const passingCommands = qaConfig.commands.filter(cmd => {
      if (qaBaseline.get(cmd.name) === false) {
        skippedCommands.push(cmd.name);
        return false;
      }
      return true;
    });
    if (skippedCommands.length > 0) {
      onProgress(`QA: skipping ${skippedCommands.length} pre-existing failure(s): ${skippedCommands.join(', ')}`);
      effectiveQaConfig = { ...qaConfig, commands: passingCommands };
    }
  }

  // If all commands were pre-existing failures, skip QA entirely
  if (effectiveQaConfig.commands.length === 0) {
    onProgress('QA: all commands were pre-existing failures — skipping');
    await ctx.markStep('qa', 'success', {
      metadata: { allPreExisting: true, skippedCommands },
    });
    return { continue: true };
  }

  const exec = createExecRunner({
    defaultMaxLogBytes: qaConfig.artifacts.maxLogBytes,
    defaultTailBytes: qaConfig.artifacts.tailBytes,
  });
  const logger = createLogger({ quiet: true });

  const project = await projects.ensureForRepo(adapter, {
    name: path.basename(repoRoot),
    rootPath: repoRoot,
  });

  const qaResult = await runQa(
    { db: adapter, exec, logger },
    {
      projectId: project.id,
      repoRoot: worktreePath,
      config: effectiveQaConfig,
    }
  );

  if (qaResult.status !== 'success') {
    const failedStep = qaResult.failedAt?.stepName ?? 'unknown step';

    await ctx.markStep('qa', 'failed', {
      errorMessage: `QA failed at ${failedStep}`,
      metadata: { qaRunId: qaResult.runId },
    });
    recordQualitySignal(repoRoot, 'qa_fail');
    await ctx.skipRemaining(6, 'QA failed');

    recordCommandFailure(spindleState, failedStep, `QA failed at ${failedStep}`);

    const errorParts = [`QA failed at: ${failedStep}`];

    const qaDetails = await getQaRunDetails(adapter, qaResult.runId);
    if (qaDetails) {
      const failedStepInfo = qaDetails.steps.find(
        s => s.name === failedStep && s.status === 'failed'
      );
      if (failedStepInfo) {
        const errorOutput = failedStepInfo.stderrTail || failedStepInfo.stdoutTail;
        if (errorOutput) {
          const truncated = errorOutput.length > 500
            ? '...' + errorOutput.slice(-497)
            : errorOutput;
          errorParts.push('');
          errorParts.push('Error output:');
          errorParts.push(truncated.split('\n').map(l => `  ${l}`).join('\n'));
        }
        if (failedStepInfo.errorMessage) {
          errorParts.push('');
          errorParts.push(`Error: ${failedStepInfo.errorMessage}`);
        }
      }

      // Record per-command QA stats on failure path
      try {
        for (const step of qaDetails.steps) {
          recordQaCommandResult(repoRoot, step.name, {
            passed: step.status === 'success',
            durationMs: step.durationMs ?? 0,
            timedOut: (step.signal === 'SIGTERM') || false,
            skippedPreExisting: false,
          });
        }
        for (const name of skippedCommands) {
          recordQaCommandResult(repoRoot, name, {
            passed: false,
            durationMs: 0,
            timedOut: false,
            skippedPreExisting: true,
          });
        }
      } catch {
        // Non-fatal
      }
    }

    // QA retry with test-fix scope expansion
    const failedStepName = qaResult.failedAt?.stepName;
    if (opts.qaRetryWithTestFix && isTestFailure(failedStepName)) {
      onProgress('QA test failure — retrying with test files in scope...');

      let qaErrorOutput = '';
      if (qaDetails) {
        const failedStepInfo = qaDetails.steps.find(
          s => s.name === failedStepName && s.status === 'failed'
        );
        if (failedStepInfo) {
          qaErrorOutput = (failedStepInfo.stderrTail || '') + '\n' + (failedStepInfo.stdoutTail || '');
        }
      }

      const testFiles = extractTestFilesFromQaOutput(qaErrorOutput);
      if (testFiles.length > 0) {
        const expandedPaths = [...new Set([...ticket.allowedPaths, ...testFiles])];

        const retryPrompt = [
          `Your changes broke these tests. Fix the tests to match the new behavior. Do NOT revert your changes.`,
          '',
          'Failed test files:',
          ...testFiles.map(f => `- ${f}`),
          '',
          'Error output:',
          qaErrorOutput.slice(-2000),
        ].join('\n');

        const fullRetryPrompt = buildTicketPrompt(
          { ...ticket, allowedPaths: expandedPaths } as typeof ticket,
          opts.guidelinesContext,
          opts.learningsContext,
          opts.metadataContext,
        ) + '\n\n' + retryPrompt;

        try {
          const retryResult = await execBackend.run({
            worktreePath,
            prompt: fullRetryPrompt,
            timeoutMs: opts.timeoutMs,
            verbose: opts.verbose,
            onProgress,
            onRawOutput: opts.onRawOutput,
          });

          if (retryResult.success) {
            // Re-validate scope
            const retryStatusOutput = (await gitExec('git status --porcelain', {
              cwd: worktreePath,
            })).trim();
            const retryAllFiles = parseChangedFiles(retryStatusOutput);
            const retryChangedFiles = baselineFiles.size > 0
              ? retryAllFiles.filter(f => !baselineFiles.has(f))
              : retryAllFiles;
            const retryViolations = checkScopeViolations(
              retryChangedFiles,
              expandedPaths,
              ticket.forbiddenPaths
            );
            if (retryViolations.length > 0) {
              const violatedFiles = retryViolations.map(v => v.file).join(', ');
              errorParts.push('');
              errorParts.push(`(QA retry created scope violations: ${violatedFiles})`);
              errorParts.push(`Worktree preserved for inspection: ${worktreePath}`);
              const result = {
                success: false,
                branchName,
                durationMs: Date.now() - startTime,
                error: errorParts.join('\n'),
                failureReason: 'scope_violation' as FailureReason,
              };
              await ctx.saveRunSummary(result);
              return { continue: false, result };
            }

            // Re-commit
            await gitExec('git add -A', { cwd: worktreePath });
            try {
              await gitExecFile('git', ['commit', '-m', `fix: update tests for ${ticket.title}`], { cwd: worktreePath });
            } catch {
              // No new changes to commit — that's fine
            }

            // Re-run QA
            const retryQaResult = await runQa(
              { db: adapter, exec, logger },
              { projectId: project.id, repoRoot: worktreePath, config: effectiveQaConfig },
            );

            if (retryQaResult.status === 'success') {
              onProgress('QA retry succeeded after fixing tests');
              await ctx.markStep('qa', 'success', { metadata: { qaRunId: retryQaResult.runId, qaRetried: true } });
              recordQualitySignal(repoRoot, 'qa_pass');
              return { continue: true };
            } else {
              errorParts.push('');
              errorParts.push('(QA retry with test-fix also failed)');
              errorParts.push(`To retry: promptwheel solo run ${ticket.id}`);
              errorParts.push(`Worktree preserved for inspection: ${worktreePath}`);
              const result = {
                success: false,
                branchName,
                durationMs: Date.now() - startTime,
                error: errorParts.join('\n'),
                failureReason: 'qa_failed' as FailureReason,
              };
              await ctx.saveRunSummary(result);
              return { continue: false, result };
            }
          } else {
            errorParts.push('');
            errorParts.push('(QA retry agent execution failed)');
            errorParts.push(`To retry: promptwheel solo run ${ticket.id}`);
            errorParts.push(`Worktree preserved for inspection: ${worktreePath}`);
            const result = {
              success: false,
              branchName,
              durationMs: Date.now() - startTime,
              error: errorParts.join('\n'),
              failureReason: 'qa_failed' as FailureReason,
            };
            await ctx.saveRunSummary(result);
            return { continue: false, result };
          }
        } catch {
          errorParts.push('');
          errorParts.push(`To retry: promptwheel solo run ${ticket.id}`);
          errorParts.push(`Worktree preserved for inspection: ${worktreePath}`);
          const result = {
            success: false,
            branchName,
            durationMs: Date.now() - startTime,
            error: errorParts.join('\n'),
            failureReason: 'qa_failed' as FailureReason,
          };
          await ctx.saveRunSummary(result);
          return { continue: false, result };
        }
      } else {
        errorParts.push('');
        errorParts.push(`To retry: promptwheel solo run ${ticket.id}`);
        errorParts.push(`Worktree preserved for inspection: ${worktreePath}`);
        const result = {
          success: false,
          branchName,
          durationMs: Date.now() - startTime,
          error: errorParts.join('\n'),
          failureReason: 'qa_failed' as FailureReason,
        };
        await ctx.saveRunSummary(result);
        return { continue: false, result };
      }
    } else {
      errorParts.push('');
      errorParts.push(`To retry: promptwheel solo run ${ticket.id}`);
      errorParts.push(`Worktree preserved for inspection: ${worktreePath}`);
      const result = {
        success: false,
        branchName,
        durationMs: Date.now() - startTime,
        error: errorParts.join('\n'),
        failureReason: 'qa_failed' as FailureReason,
      };
      await ctx.saveRunSummary(result);
      return { continue: false, result };
    }
  }

  await ctx.markStep('qa', 'success', {
    metadata: {
      qaRunId: qaResult.runId,
      ...(skippedCommands.length > 0 ? { skippedPreExisting: skippedCommands } : {}),
    },
  });
  recordQualitySignal(repoRoot, 'qa_pass');

  // Record per-command QA stats
  try {
    const qaStatsDetails = await getQaRunDetails(adapter, qaResult.runId);
    if (qaStatsDetails) {
      for (const step of qaStatsDetails.steps) {
        recordQaCommandResult(repoRoot, step.name, {
          passed: step.status === 'success',
          durationMs: step.durationMs ?? 0,
          timedOut: (step.signal === 'SIGTERM') || false,
          skippedPreExisting: false,
        });
      }
    }
    for (const name of skippedCommands) {
      recordQaCommandResult(repoRoot, name, {
        passed: false,
        durationMs: 0,
        timedOut: false,
        skippedPreExisting: true,
      });
    }
  } catch {
    // Non-fatal
  }

  return { continue: true };
}
