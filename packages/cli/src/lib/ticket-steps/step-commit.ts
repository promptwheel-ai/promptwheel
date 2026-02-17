/**
 * Step 4: Commit changes — stage and commit agent's work.
 */

import { writeJsonArtifact } from '../artifacts.js';
import { gitExec, gitExecFile } from '../solo-git.js';
import type { TicketContext, StepResult } from './types.js';

export async function run(ctx: TicketContext): Promise<StepResult> {
  const { ticket, worktreePath, baseDir, opts, statusOutput, changedFiles } = ctx;

  await ctx.markStep('commit', 'started');

  const diffOutput = await gitExec('git diff HEAD', {
    cwd: worktreePath,
    maxBuffer: 10 * 1024 * 1024,
  });

  const diffArtifactPath = writeJsonArtifact({
    baseDir,
    type: 'diffs',
    id: opts.runId,
    data: {
      runId: opts.runId,
      ticketId: ticket.id,
      diff: diffOutput,
      filesChanged: statusOutput.split('\n').length,
      changedFiles,
    },
  });
  ctx.artifactPaths.diff = diffArtifactPath;

  await gitExec('git add -A', { cwd: worktreePath });
  await gitExecFile('git', ['commit', '-m', ticket.title], { cwd: worktreePath });

  await ctx.markStep('commit', 'success', { metadata: { diffArtifactPath } });

  return { continue: true };
}
