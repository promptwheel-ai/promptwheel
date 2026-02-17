/**
 * Step 2: Run the execution agent (Claude, Codex, etc.)
 */

import { writeJsonArtifact } from '../artifacts.js';
import { ClaudeExecutionBackend } from '../execution-backends/index.js';
import { buildTicketPrompt } from '../solo-prompt-builder.js';
import { cleanupWorktree } from '../solo-git.js';
import { loadTriggerRules } from '../trigger-config.js';
import {
  analyzeTrace,
  computeLiveness,
} from '@promptwheel/core/trace/shared';
import type { RunTicketResult } from '../solo-ticket-types.js';
import type { TicketContext, StepResult } from './types.js';

export async function run(ctx: TicketContext): Promise<StepResult> {
  const { ticket, repoRoot, worktreePath, baseDir, opts, startTime, onProgress } = ctx;
  const { runId, verbose, timeoutMs } = opts;

  await ctx.markStep('agent', 'started');

  const prompt = buildTicketPrompt(ticket, opts.guidelinesContext, opts.learningsContext, opts.metadataContext, { confidence: opts.confidence, complexity: opts.complexity });
  ctx.execBackend = opts.executionBackend ?? new ClaudeExecutionBackend();

  const claudeResult = await ctx.execBackend.run({
    worktreePath,
    prompt,
    timeoutMs,
    verbose,
    onProgress,
    onRawOutput: opts.onRawOutput,
  });

  // Save agent artifact
  const agentArtifactPath = writeJsonArtifact({
    baseDir,
    type: 'executions',
    id: runId,
    data: {
      runId,
      ticketId: ticket.id,
      prompt,
      stdout: claudeResult.stdout,
      stderr: claudeResult.stderr,
      exitCode: claudeResult.exitCode,
      timedOut: claudeResult.timedOut,
      durationMs: claudeResult.durationMs,
    },
  });
  ctx.artifactPaths.execution = agentArtifactPath;

  if (!claudeResult.success) {
    await ctx.markStep('agent', 'failed', {
      errorMessage: claudeResult.error ?? 'Agent execution failed',
      metadata: { artifactPath: agentArtifactPath },
    });
    await ctx.skipRemaining(2, 'Agent failed');
    await cleanupWorktree(repoRoot, worktreePath);

    const baseError = claudeResult.error ?? 'Claude execution failed';
    const errorParts = [
      claudeResult.timedOut ? 'Agent timed out' : 'Agent execution failed',
      `  ${baseError}`,
      '',
    ];

    if (claudeResult.timedOut) {
      errorParts.push('The agent exceeded its time limit.');
      errorParts.push('Consider breaking down the ticket into smaller tasks.');
    }

    errorParts.push(`To retry: promptwheel solo run ${ticket.id}`);
    errorParts.push(`Execution logs: ${agentArtifactPath}`);

    const result: RunTicketResult = {
      success: false,
      durationMs: Date.now() - startTime,
      error: errorParts.join('\n'),
      failureReason: claudeResult.timedOut ? 'timeout' : 'agent_error',
      artifacts: { ...ctx.artifactPaths },
    };
    await ctx.saveRunSummary(result);
    return { continue: false, result };
  }

  await ctx.markStep('agent', 'success', {
    metadata: { artifactPath: agentArtifactPath, durationMs: claudeResult.durationMs },
  });

  // Store stdout on context for spindle check
  ctx.agentStdout = claudeResult.stdout;

  // Run trace analysis if stream-json events are available
  if (claudeResult.traceEvents && claudeResult.traceEvents.length > 0) {
    try {
      const triggerRules = loadTriggerRules(ctx.repoRoot);

      // Build full analysis using real timestamps for liveness
      const traceAnalysis = analyzeTrace(claudeResult.stdout, triggerRules);

      // Override liveness with real timestamps when available
      if (claudeResult.traceTimestamps && claudeResult.traceTimestamps.length > 1) {
        traceAnalysis.liveness = computeLiveness(claudeResult.traceEvents, claudeResult.traceTimestamps);
      }

      ctx.traceAnalysis = traceAnalysis;

      // Save trace artifact
      writeJsonArtifact({
        baseDir: ctx.baseDir,
        type: 'traces',
        id: runId,
        data: traceAnalysis,
      });

      // Feed stall signal into spindle state
      if (traceAnalysis.liveness.max_gap_ms > 60_000) {
        ctx.spindleState.iterationsSinceChange = Math.max(
          ctx.spindleState.iterationsSinceChange,
          Math.floor(traceAnalysis.liveness.max_gap_ms / 30_000),
        );
      }

      // Check for abort triggers
      const abortAlert = traceAnalysis.alerts.find(a => a.action === 'abort');
      if (abortAlert) {
        await ctx.markStep('agent', 'failed', {
          errorMessage: `Trigger abort: ${abortAlert.message}`,
        });
        await ctx.skipRemaining(2, 'Trigger abort');
        await cleanupWorktree(repoRoot, worktreePath);

        const result: RunTicketResult = {
          success: false,
          durationMs: Date.now() - startTime,
          error: `Trigger abort: ${abortAlert.message}`,
          failureReason: 'agent_error',
          artifacts: { ...ctx.artifactPaths },
        };
        await ctx.saveRunSummary(result);
        return { continue: false, result };
      }
    } catch {
      // Non-fatal: trace analysis failure should not block execution
    }
  }

  return { continue: true };
}
