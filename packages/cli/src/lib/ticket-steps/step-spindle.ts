/**
 * Step 2b: Spindle loop detection — checks if the agent is spinning.
 *
 * Runs after the agent step, before scope check. Not a tracked step
 * in EXECUTE_STEPS — it's a guard that aborts the pipeline if detected.
 */

import { writeJsonArtifact } from '../artifacts.js';
import {
  checkSpindleLoop,
  formatSpindleResult,
  getFileEditWarnings,
} from '../spindle/index.js';
import { parseChangedFiles, checkScopeViolations } from '../scope.js';
import { gitExec, cleanupWorktree } from '../solo-git.js';
import { generateSpindleRecommendations } from '../solo-ci.js';
import type { RunTicketResult, SpindleAbortDetails } from '../solo-ticket-types.js';
import type { TicketContext, StepResult } from './types.js';

export async function run(ctx: TicketContext): Promise<StepResult> {
  const { ticket, repoRoot, worktreePath, baseDir, opts, startTime, onProgress } = ctx;
  const { spindleConfig, spindleState, baselineFiles } = ctx;

  if (!spindleConfig.enabled) {
    return { continue: true };
  }

  const agentStdout: string = ctx.agentStdout ?? '';

  let prelimDiff: string | null = null;
  try {
    prelimDiff = (await gitExec('git diff', {
      cwd: worktreePath,
      maxBuffer: 10 * 1024 * 1024,
    })).trim();
  } catch {
    // Ignore diff errors for Spindle check
  }

  const spindleCheck = checkSpindleLoop(
    spindleState,
    agentStdout,
    prelimDiff,
    spindleConfig
  );

  for (const warning of spindleState.warnings) {
    onProgress(`⚠ ${warning}`);
  }
  spindleState.warnings = [];

  if (spindleCheck.shouldAbort) {
    const trigger = spindleCheck.reason as SpindleAbortDetails['trigger'];
    const recommendations = generateSpindleRecommendations(trigger, ticket, spindleConfig);

    const spindleArtifactData = {
      runId: opts.runId,
      ticketId: ticket.id,
      triggeredAtMs: Date.now(),
      iteration: spindleState.outputs.length,
      reason: trigger,
      metrics: {
        similarity: spindleCheck.diagnostics.similarityScore,
        similarOutputs: spindleState.outputs.length,
        stallIterations: spindleCheck.diagnostics.iterationsWithoutChange,
        estimatedTokens: spindleState.estimatedTokens,
        repeatedPatterns: spindleCheck.diagnostics.repeatedPatterns,
        oscillationPattern: spindleCheck.diagnostics.oscillationPattern,
      },
      thresholds: {
        similarityThreshold: spindleConfig.similarityThreshold,
        maxSimilarOutputs: spindleConfig.maxSimilarOutputs,
        maxStallIterations: spindleConfig.maxStallIterations,
        tokenBudgetWarning: spindleConfig.tokenBudgetWarning,
        tokenBudgetAbort: spindleConfig.tokenBudgetAbort,
      },
      pointers: {
        agentExecution: ctx.artifactPaths.execution,
      },
      recommendations,
      recentOutputs: spindleState.outputs.slice(-3),
      recentDiffs: spindleState.diffs.slice(-3),
      formatted: formatSpindleResult(spindleCheck),
    };

    const spindleArtifactPath = writeJsonArtifact({
      baseDir,
      type: 'spindle',
      id: opts.runId,
      data: spindleArtifactData,
    });
    ctx.artifactPaths.spindle = spindleArtifactPath;

    const spindleDetails: SpindleAbortDetails = {
      trigger,
      confidence: spindleCheck.confidence,
      estimatedTokens: spindleState.estimatedTokens,
      iteration: spindleState.outputs.length,
      thresholds: {
        similarityThreshold: spindleConfig.similarityThreshold,
        maxSimilarOutputs: spindleConfig.maxSimilarOutputs,
        maxStallIterations: spindleConfig.maxStallIterations,
        tokenBudgetWarning: spindleConfig.tokenBudgetWarning,
        tokenBudgetAbort: spindleConfig.tokenBudgetAbort,
      },
      metrics: {
        similarityScore: spindleCheck.diagnostics.similarityScore,
        iterationsWithoutChange: spindleCheck.diagnostics.iterationsWithoutChange,
        repeatedPatterns: spindleCheck.diagnostics.repeatedPatterns,
        oscillationPattern: spindleCheck.diagnostics.oscillationPattern,
      },
      recommendations,
      artifactPath: spindleArtifactPath,
    };

    onProgress(`Spindle loop detected: ${trigger}`);
    onProgress(`  Confidence: ${(spindleCheck.confidence * 100).toFixed(0)}%`);
    onProgress(`  Tokens: ~${spindleState.estimatedTokens.toLocaleString()}`);

    // Log scope diagnostics before discarding
    try {
      const abortStatus = (await gitExec('git status --porcelain', { cwd: worktreePath })).trim();
      if (abortStatus) {
        const abortAllFiles = parseChangedFiles(abortStatus);
        const abortChanged = baselineFiles.size > 0
          ? abortAllFiles.filter(f => !baselineFiles.has(f))
          : abortAllFiles;
        const abortViolations = checkScopeViolations(abortChanged, ticket.allowedPaths, ticket.forbiddenPaths);
        if (abortViolations.length > 0) {
          (spindleArtifactData as Record<string, unknown>).scopeViolations = abortViolations.map(v => v.file);
          onProgress(`  Scope violations (discarded): ${abortViolations.map(v => v.file).join(', ')}`);
        }
      }
    } catch { /* diagnostic only */ }

    await ctx.skipRemaining(2, `Spindle loop: ${trigger}`);
    await cleanupWorktree(repoRoot, worktreePath);

    const result: RunTicketResult = {
      success: false,
      durationMs: Date.now() - startTime,
      error: `Spindle loop detected: ${trigger} (confidence: ${(spindleCheck.confidence * 100).toFixed(0)}%)`,
      failureReason: 'spindle_abort',
      spindle: spindleDetails,
      artifacts: { ...ctx.artifactPaths },
    };
    await ctx.saveRunSummary(result);
    return { continue: false, result };
  }

  // Handle shouldBlock (command_failure → needs human intervention)
  if (spindleCheck.shouldBlock) {
    onProgress(`Spindle blocked: ${spindleCheck.reason} — needs human intervention`);
    for (const w of getFileEditWarnings(spindleState, spindleConfig.maxFileEdits)) {
      onProgress(`  ⚠ ${w}`);
    }

    try {
      const blockStatus = (await gitExec('git status --porcelain', { cwd: worktreePath })).trim();
      if (blockStatus) {
        const blockAllFiles = parseChangedFiles(blockStatus);
        const blockChanged = baselineFiles.size > 0
          ? blockAllFiles.filter(f => !baselineFiles.has(f))
          : blockAllFiles;
        const blockViolations = checkScopeViolations(blockChanged, ticket.allowedPaths, ticket.forbiddenPaths);
        if (blockViolations.length > 0) {
          onProgress(`  Scope violations (discarded): ${blockViolations.map(v => v.file).join(', ')}`);
        }
      }
    } catch { /* diagnostic only */ }

    await ctx.skipRemaining(2, `Spindle blocked: ${spindleCheck.reason}`);
    await cleanupWorktree(repoRoot, worktreePath);

    const result: RunTicketResult = {
      success: false,
      durationMs: Date.now() - startTime,
      error: `Spindle blocked: ${spindleCheck.reason} (needs human intervention)`,
      failureReason: 'spindle_abort',
      artifacts: { ...ctx.artifactPaths },
    };
    await ctx.saveRunSummary(result);
    return { continue: false, result };
  }

  return { continue: true };
}
