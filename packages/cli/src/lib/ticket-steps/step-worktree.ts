/**
 * Step 1: Create worktree — isolated git checkout for ticket execution.
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { buildExclusionIndex } from '../exclusion-index.js';
import { parseChangedFiles } from '../scope.js';
import { withGitMutex, gitExec } from '../solo-git.js';
import { captureQaBaseline, baselineToPassFail } from '../solo-ticket-qa.js';
import type { TicketContext, StepResult } from './types.js';

const execAsync = promisify(exec);

/**
 * Detect package manager from lockfiles and install deps in worktree.
 * Returns silently if no Node.js project detected or install fails.
 */
async function installWorktreeDeps(
  worktreePath: string,
  verbose: boolean,
  onProgress: (msg: string) => void,
): Promise<void> {
  const { execFile } = await import('node:child_process');
  const execFileAsync = promisify(execFile);

  if (!fs.existsSync(path.join(worktreePath, 'package.json'))) return;
  if (fs.existsSync(path.join(worktreePath, 'node_modules'))) return;

  let pm = 'npm';
  let installArgs = ['install', '--ignore-scripts', '--no-audit', '--no-fund'];
  if (fs.existsSync(path.join(worktreePath, 'pnpm-lock.yaml'))) {
    pm = 'pnpm';
    installArgs = ['install', '--frozen-lockfile', '--ignore-scripts'];
  } else if (fs.existsSync(path.join(worktreePath, 'yarn.lock'))) {
    pm = 'yarn';
    installArgs = ['install', '--frozen-lockfile', '--ignore-scripts'];
  } else if (fs.existsSync(path.join(worktreePath, 'bun.lockb')) || fs.existsSync(path.join(worktreePath, 'bun.lock'))) {
    pm = 'bun';
    installArgs = ['install', '--frozen-lockfile'];
  }

  onProgress(`Installing dependencies (${pm})...`);
  try {
    await execFileAsync(pm, installArgs, {
      cwd: worktreePath,
      timeout: 120_000,
    });
  } catch (err) {
    if (verbose) {
      const msg = err instanceof Error ? err.message : String(err);
      onProgress(`Warning: worktree dep install failed: ${msg}`);
    }
  }
}

export async function run(ctx: TicketContext): Promise<StepResult> {
  const { repoRoot, config, opts, branchName, worktreePath, verbose, onProgress } = ctx;

  await ctx.markStep('worktree', 'started');

  const worktreesDir = path.join(repoRoot, '.promptwheel', 'worktrees');
  if (!fs.existsSync(worktreesDir)) {
    fs.mkdirSync(worktreesDir, { recursive: true });
  }

  let baseBranch = 'master';
  await withGitMutex(async () => {
    try {
      await gitExec('git worktree prune', { cwd: repoRoot });
    } catch { /* best-effort */ }

    if (fs.existsSync(worktreePath)) {
      await gitExec(`git worktree remove --force "${worktreePath}"`, { cwd: repoRoot });
    }

    if (opts.baseBranch) {
      baseBranch = opts.baseBranch;
    } else {
      let detectedBranch = 'master';
      try {
        const remoteHead = (await gitExec('git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null || echo "refs/remotes/origin/master"', { cwd: repoRoot })).trim();
        detectedBranch = remoteHead.replace('refs/remotes/origin/', '');
      } catch {
        // Fall back to master
      }
      baseBranch = detectedBranch;

      try {
        await gitExec(`git fetch origin ${baseBranch}`, { cwd: repoRoot });
      } catch {
        // Fetch failed, continue with what we have
      }
    }

    const branchBase = opts.baseBranch ? opts.baseBranch : `origin/${baseBranch}`;
    try {
      await gitExec(`git worktree remove --force "${worktreePath}"`, { cwd: repoRoot });
    } catch { /* worktree didn't exist */ }
    try {
      await gitExec(`git branch -D "${branchName}"`, { cwd: repoRoot });
    } catch { /* branch didn't exist */ }
    try {
      await gitExec(`git branch "${branchName}" "${branchBase}"`, { cwd: repoRoot });
    } catch (err: any) {
      if (err?.message?.includes('already exists') || err?.stderr?.includes('already exists')) {
        await gitExec(`git branch -D "${branchName}"`, { cwd: repoRoot });
        await gitExec(`git branch "${branchName}" "${branchBase}"`, { cwd: repoRoot });
      } else {
        throw err;
      }
    }
    await gitExec(`git worktree add "${worktreePath}" "${branchName}"`, { cwd: repoRoot });
  });

  await ctx.markStep('worktree', 'success', { metadata: { branchName, worktreePath } });

  // Build exclusion index
  const excludedPatterns = buildExclusionIndex(worktreePath);
  if (excludedPatterns.length > 0 && verbose) {
    onProgress(`Exclusion index: ${excludedPatterns.length} artifact patterns discovered`);
  }

  // Run project setup in worktree
  if (config?.setup) {
    onProgress(`Running setup: ${config.setup}`);
    try {
      await execAsync(config.setup, {
        cwd: worktreePath,
        timeout: 300_000,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      onProgress(`Warning: setup command failed: ${msg}`);
    }
  } else {
    await installWorktreeDeps(worktreePath, verbose, onProgress);
  }

  // Baseline snapshot
  const baselineStatus = (await gitExec('git status --porcelain', {
    cwd: worktreePath,
  })).trim();
  ctx.baselineFiles = new Set(parseChangedFiles(baselineStatus));

  // QA baseline: use cycle-level cache if provided, else capture per-ticket
  ctx.qaBaseline = opts.qaBaseline ?? null;
  if (!ctx.qaBaseline && !opts.skipQa && config?.qa?.commands?.length && !config?.qa?.disableBaseline) {
    onProgress('Capturing QA baseline...');
    const fullBaseline = await captureQaBaseline(worktreePath, config, onProgress);
    ctx.qaBaseline = baselineToPassFail(fullBaseline);
  }

  if (ctx.qaBaseline) {
    const preExisting = [...ctx.qaBaseline.entries()].filter(([, passed]) => !passed);
    if (preExisting.length > 0) {
      onProgress(`QA baseline: ${preExisting.length} pre-existing failure(s) — will be skipped`);
      for (const [name] of preExisting) {
        onProgress(`  ⚠ ${name} already failing before agent`);
      }
    }
  }

  return { continue: true };
}
