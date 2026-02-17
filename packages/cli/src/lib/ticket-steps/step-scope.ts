/**
 * Step 3: Scope check — validates agent changes stay within allowed paths.
 */

import {
  checkScopeViolations,
  parseChangedFiles,
  analyzeViolationsForExpansion,
} from '../scope.js';
import {
  writeJsonArtifact,
  type ViolationsArtifact,
} from '../artifacts.js';
import { gitExec, cleanupWorktree } from '../solo-git.js';
import type { RunTicketResult } from '../solo-ticket-types.js';
import type { TicketContext, StepResult } from './types.js';

export async function run(ctx: TicketContext): Promise<StepResult> {
  const { ticket, repoRoot, worktreePath, baseDir, opts, startTime, baselineFiles, adapter } = ctx;

  await ctx.markStep('scope', 'started');

  ctx.statusOutput = (await gitExec('git status --porcelain', {
    cwd: worktreePath,
  })).trim();

  if (!ctx.statusOutput) {
    await ctx.markStep('scope', 'success', { errorMessage: 'No changes needed' });
    await ctx.skipRemaining(3, 'No changes needed');
    await cleanupWorktree(repoRoot, worktreePath);
    const result: RunTicketResult = {
      success: true,
      durationMs: Date.now() - startTime,
      completionOutcome: 'no_changes_needed',
      artifacts: { ...ctx.artifactPaths },
    };
    await ctx.saveRunSummary(result);
    return { continue: false, result };
  }

  const allChangedFiles = parseChangedFiles(ctx.statusOutput);
  ctx.changedFiles = baselineFiles.size > 0
    ? allChangedFiles.filter(f => !baselineFiles.has(f))
    : allChangedFiles;

  const violations = checkScopeViolations(
    ctx.changedFiles,
    ticket.allowedPaths,
    ticket.forbiddenPaths
  );

  if (violations.length > 0) {
    const violationsData: ViolationsArtifact = {
      runId: opts.runId,
      ticketId: ticket.id,
      changedFiles: ctx.changedFiles,
      allowedPaths: ticket.allowedPaths,
      forbiddenPaths: ticket.forbiddenPaths,
      violations,
    };
    const violationsArtifactPath = writeJsonArtifact({
      baseDir,
      type: 'violations',
      id: opts.runId,
      data: violationsData,
    });
    ctx.artifactPaths.violations = violationsArtifactPath;

    const canAutoRetry = ticket.retryCount < ticket.maxRetries;
    const expansionResult = canAutoRetry
      ? analyzeViolationsForExpansion(violations, ticket.allowedPaths)
      : { canExpand: false, expandedPaths: ticket.allowedPaths, addedPaths: [], reason: 'Max retries exceeded' };

    if (expansionResult.canExpand && expansionResult.addedPaths.length > 0) {
      const newRetryCount = ticket.retryCount + 1;

      await adapter.query(
        `UPDATE tickets SET
          allowed_paths = $1,
          retry_count = $2,
          status = 'ready',
          updated_at = datetime('now')
        WHERE id = $3`,
        [JSON.stringify(expansionResult.expandedPaths), newRetryCount, ticket.id]
      );

      await ctx.markStep('scope', 'failed', {
        errorMessage: `Scope expanded: +${expansionResult.addedPaths.length} paths, retry ${newRetryCount}/${ticket.maxRetries}`,
        metadata: { violations, expansionResult, artifactPath: violationsArtifactPath },
      });
      await ctx.skipRemaining(4, 'Scope expansion - retry scheduled');
      await cleanupWorktree(repoRoot, worktreePath);

      const result: RunTicketResult = {
        success: false,
        durationMs: Date.now() - startTime,
        error: `Scope auto-expanded: ${expansionResult.addedPaths.join(', ')}`,
        failureReason: 'scope_violation',
        artifacts: { ...ctx.artifactPaths },
        scopeExpanded: {
          addedPaths: expansionResult.addedPaths,
          newRetryCount,
        },
      };
      await ctx.saveRunSummary(result);
      return { continue: false, result };
    }

    const violationSummary = violations
      .map(v => v.violation === 'in_forbidden'
        ? `${v.file} (forbidden by ${v.pattern})`
        : `${v.file} (not in allowed paths)`)
      .join(', ');

    await ctx.markStep('scope', 'failed', {
      errorMessage: `Scope violations: ${violationSummary}`,
      metadata: { violations, expansionResult, artifactPath: violationsArtifactPath },
    });
    await ctx.skipRemaining(4, 'Scope violations');
    await cleanupWorktree(repoRoot, worktreePath);

    const violationDetails = violations
      .map(v => v.violation === 'in_forbidden'
        ? `  ${v.file} (forbidden by ${v.pattern})`
        : `  ${v.file} (not in allowed_paths)`)
      .join('\n');
    const blockReason = expansionResult.reason
      ? `\nNote: ${expansionResult.reason}`
      : '';
    const errorMessage = [
      `Scope violation: Changes outside allowed paths`,
      violationDetails,
      blockReason,
      ``,
      `To fix: promptwheel solo retry ${ticket.id}`,
      `  This regenerates allowed_paths and resets the ticket to 'ready'`,
    ].join('\n');

    const result: RunTicketResult = {
      success: false,
      durationMs: Date.now() - startTime,
      error: errorMessage,
      failureReason: 'scope_violation',
      artifacts: { ...ctx.artifactPaths },
    };
    await ctx.saveRunSummary(result);
    return { continue: false, result };
  }

  await ctx.markStep('scope', 'success', {
    metadata: { filesChecked: ctx.changedFiles.length },
  });

  return { continue: true };
}
