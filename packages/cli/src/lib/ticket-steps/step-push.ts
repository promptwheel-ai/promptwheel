/**
 * Step 5: Push branch to remote.
 */

import { gitExec, cleanupWorktree } from '../solo-git.js';
import type { TicketContext, StepResult } from './types.js';

export async function run(ctx: TicketContext): Promise<StepResult> {
  const { repoRoot, worktreePath, branchName, opts, startTime, config } = ctx;

  if (opts.skipPush) {
    await ctx.markStep('push', 'skipped', { errorMessage: 'Skipped (milestone mode)' });
    return { continue: true };
  }

  await ctx.markStep('push', 'started');

  try {
    const { assertPushSafe } = await import('../solo-remote.js');
    await assertPushSafe(worktreePath, config?.allowedRemote);
    await gitExec(`git push -u origin "${branchName}"`, { cwd: worktreePath });
    await ctx.markStep('push', 'success');
  } catch (pushError) {
    await ctx.markStep('push', 'failed', {
      errorMessage: pushError instanceof Error ? pushError.message : String(pushError),
    });
    await ctx.skipRemaining(5, 'Push failed');
    await cleanupWorktree(repoRoot, worktreePath);
    const result = {
      success: false,
      branchName,
      durationMs: Date.now() - startTime,
      error: `Push failed: ${pushError instanceof Error ? pushError.message : pushError}`,
    };
    await ctx.saveRunSummary(result);
    return { continue: false, result };
  }

  return { continue: true };
}
