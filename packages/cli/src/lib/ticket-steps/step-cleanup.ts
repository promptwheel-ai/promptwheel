/**
 * Step 8: Cleanup — remove the worktree.
 */

import { cleanupWorktree } from '../solo-git.js';
import type { TicketContext, StepResult } from './types.js';

export async function run(ctx: TicketContext): Promise<StepResult> {
  await ctx.markStep('cleanup', 'started');
  await cleanupWorktree(ctx.repoRoot, ctx.worktreePath);
  await ctx.markStep('cleanup', 'success');

  return { continue: true };
}
