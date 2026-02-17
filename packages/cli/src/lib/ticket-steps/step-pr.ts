/**
 * Step 7: Create PR — push branch and create a pull request.
 */

import { gitExecFile } from '../solo-git.js';
import type { TicketContext, StepResult } from './types.js';

export async function run(ctx: TicketContext): Promise<StepResult> {
  const { ticket, worktreePath, branchName, opts, config, onProgress } = ctx;
  const { createPr, draftPr = false } = opts;

  if (opts.skipPr) {
    await ctx.markStep('pr', 'skipped', { errorMessage: 'Skipped (milestone mode)' });
    return { continue: true };
  }

  if (createPr) {
    await ctx.markStep('pr', 'started');

    try {
      const { assertPushSafe: assertPrSafe } = await import('../solo-remote.js');
      await assertPrSafe(worktreePath, config?.allowedRemote);
      const prBody = `## Summary\n\n${ticket.description ?? ticket.title}\n\n---\n_Created by PromptWheel_`;
      const ghArgs = ['pr', 'create', '--title', ticket.title, '--body', prBody, '--head', branchName];
      if (draftPr) ghArgs.push('--draft');

      const prOutput = (await gitExecFile('gh', ghArgs, { cwd: worktreePath })).trim();

      const urlMatch = prOutput.match(/https:\/\/github\.com\/[^\s]+/);
      ctx.prUrl = urlMatch ? urlMatch[0] : undefined;

      await ctx.markStep('pr', 'success', { metadata: { prUrl: ctx.prUrl } });
    } catch (prError) {
      await ctx.markStep('pr', 'failed', {
        errorMessage: prError instanceof Error ? prError.message : String(prError),
      });
      onProgress(`PR creation failed: ${prError instanceof Error ? prError.message : prError}`);
    }
  } else {
    await ctx.markStep('pr', 'skipped', { errorMessage: 'Not requested' });
  }

  return { continue: true };
}
