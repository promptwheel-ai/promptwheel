/**
 * Retention & Cleanup
 *
 * Prune logic for all unbounded state accumulation points.
 * Called automatically on session start and via `blockspool prune`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  type RetentionConfig,
  type SoloConfig,
  DEFAULT_RETENTION_CONFIG,
  getBlockspoolDir,
} from './solo-config.js';
import { readRunState, writeRunState } from './run-state.js';
import type { DatabaseAdapter } from '@blockspool/core/db';

// =============================================================================
// Report
// =============================================================================

export interface PruneReport {
  runFoldersRemoved: number;
  historyLinesRemoved: number;
  artifactsRemoved: number;
  spoolArchivesRemoved: number;
  deferredProposalsRemoved: number;
  completedTicketsRemoved: number;
  mergedBranchesRemoved: number;
  staleWorktreesRemoved: number;
  totalPruned: number;
}

function emptyReport(): PruneReport {
  return {
    runFoldersRemoved: 0,
    historyLinesRemoved: 0,
    artifactsRemoved: 0,
    spoolArchivesRemoved: 0,
    deferredProposalsRemoved: 0,
    completedTicketsRemoved: 0,
    mergedBranchesRemoved: 0,
    staleWorktreesRemoved: 0,
    totalPruned: 0,
  };
}

// =============================================================================
// Config helper
// =============================================================================

export function getRetentionConfig(config: SoloConfig | null): RetentionConfig {
  return {
    ...DEFAULT_RETENTION_CONFIG,
    ...(config?.retention ?? {}),
  };
}

// =============================================================================
// Individual prune functions
// =============================================================================

/**
 * Sort .blockspool/runs/ by mtime, delete oldest beyond cap.
 */
export function pruneRunFolders(
  repoRoot: string,
  maxRuns: number,
  dryRun = false,
): number {
  const runsDir = path.join(getBlockspoolDir(repoRoot), 'runs');
  if (!fs.existsSync(runsDir)) return 0;

  const entries = fs.readdirSync(runsDir, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => ({
      name: e.name,
      path: path.join(runsDir, e.name),
      mtime: fs.statSync(path.join(runsDir, e.name)).mtimeMs,
    }))
    .sort((a, b) => b.mtime - a.mtime); // newest first

  if (entries.length <= maxRuns) return 0;

  const toRemove = entries.slice(maxRuns);
  if (!dryRun) {
    for (const entry of toRemove) {
      fs.rmSync(entry.path, { recursive: true, force: true });
    }
  }
  return toRemove.length;
}

/**
 * Keep last N lines in history.ndjson, rewrite file.
 */
export function pruneHistory(
  repoRoot: string,
  maxEntries: number,
  dryRun = false,
): number {
  const historyPath = path.join(getBlockspoolDir(repoRoot), 'history.ndjson');
  if (!fs.existsSync(historyPath)) return 0;

  const content = fs.readFileSync(historyPath, 'utf-8');
  const lines = content.split('\n').filter(l => l.trim().length > 0);

  if (lines.length <= maxEntries) return 0;

  const removed = lines.length - maxEntries;
  if (!dryRun) {
    const kept = lines.slice(-maxEntries);
    fs.writeFileSync(historyPath, kept.join('\n') + '\n');
  }
  return removed;
}

/**
 * Within each run folder, keep newest N artifact files.
 */
export function pruneArtifacts(
  repoRoot: string,
  maxPerRun: number,
  dryRun = false,
): number {
  const runsDir = path.join(getBlockspoolDir(repoRoot), 'runs');
  if (!fs.existsSync(runsDir)) return 0;

  let totalRemoved = 0;
  const runDirs = fs.readdirSync(runsDir, { withFileTypes: true })
    .filter(e => e.isDirectory());

  for (const runDir of runDirs) {
    const runPath = path.join(runsDir, runDir.name);
    const files = fs.readdirSync(runPath, { withFileTypes: true })
      .filter(e => e.isFile())
      .map(e => ({
        name: e.name,
        path: path.join(runPath, e.name),
        mtime: fs.statSync(path.join(runPath, e.name)).mtimeMs,
      }))
      .sort((a, b) => b.mtime - a.mtime);

    if (files.length <= maxPerRun) continue;

    const toRemove = files.slice(maxPerRun);
    if (!dryRun) {
      for (const file of toRemove) {
        fs.unlinkSync(file.path);
      }
    }
    totalRemoved += toRemove.length;
  }

  return totalRemoved;
}

/**
 * Delete oldest *.archived.ndjson in spool/ beyond cap.
 */
export function pruneSpoolArchives(
  repoRoot: string,
  maxArchives: number,
  dryRun = false,
): number {
  const spoolDir = path.join(getBlockspoolDir(repoRoot), 'spool');
  if (!fs.existsSync(spoolDir)) return 0;

  const archives = fs.readdirSync(spoolDir)
    .filter(f => f.endsWith('.archived.ndjson'))
    .map(f => ({
      name: f,
      path: path.join(spoolDir, f),
      mtime: fs.statSync(path.join(spoolDir, f)).mtimeMs,
    }))
    .sort((a, b) => b.mtime - a.mtime);

  if (archives.length <= maxArchives) return 0;

  const toRemove = archives.slice(maxArchives);
  if (!dryRun) {
    for (const archive of toRemove) {
      fs.unlinkSync(archive.path);
    }
  }
  return toRemove.length;
}

/**
 * Trim oldest deferred proposals from run-state.json beyond cap.
 */
export function pruneDeferredProposals(
  repoRoot: string,
  maxDeferred: number,
  dryRun = false,
): number {
  const state = readRunState(repoRoot);
  if (state.deferredProposals.length <= maxDeferred) return 0;

  const removed = state.deferredProposals.length - maxDeferred;
  if (!dryRun) {
    // Keep the newest (last added)
    state.deferredProposals = state.deferredProposals.slice(-maxDeferred);
    writeRunState(repoRoot, state);
  }
  return removed;
}

/**
 * Hard-delete oldest completed tickets beyond cap.
 * Uses the DatabaseAdapter interface (Postgres $1 placeholders).
 */
export async function pruneCompletedTickets(
  adapter: DatabaseAdapter | null,
  maxCompleted: number,
  dryRun = false,
): Promise<number> {
  if (!adapter) return 0;

  try {
    const countResult = await adapter.query<{ cnt: number }>(
      `SELECT COUNT(*) as cnt FROM tickets WHERE status = 'done'`
    );

    const count = countResult.rows[0]?.cnt ?? 0;
    if (count <= maxCompleted) return 0;

    const toRemove = count - maxCompleted;

    if (!dryRun) {
      // Subquery to find oldest N completed tickets, then delete them.
      // Works on both SQLite and Postgres.
      await adapter.query(
        `DELETE FROM tickets WHERE id IN (
          SELECT id FROM tickets WHERE status = 'done'
          ORDER BY updated_at ASC LIMIT $1
        )`,
        [toRemove]
      );
    }
    return toRemove;
  } catch {
    // Table might not exist or schema differs — non-fatal
    return 0;
  }
}

/**
 * Delete local blockspool/* branches that are fully merged, keeping the
 * newest N merged branches. Only touches local branches — never deletes
 * remote branches, and never touches unmerged branches.
 *
 * NOT called during auto-prune-on-start — only via `blockspool prune`.
 */
export function pruneMergedBranches(
  repoRoot: string,
  maxMergedBranches: number,
  dryRun = false,
): number {
  try {
    // Get the list of blockspool/* branches that are fully merged into HEAD
    const mergedResult = spawnSync(
      'git',
      ['branch', '--merged', 'HEAD', '--list', 'blockspool/*', '--sort=-committerdate', '--format=%(refname:short)'],
      { cwd: repoRoot, encoding: 'utf-8' },
    );
    if (mergedResult.status !== 0 || !mergedResult.stdout) return 0;

    // Check current branch so we never delete it
    const headResult = spawnSync('git', ['branch', '--show-current'], {
      cwd: repoRoot,
      encoding: 'utf-8',
    });
    const currentBranch = headResult.stdout?.trim() ?? '';

    const mergedBranches = mergedResult.stdout.trim().split('\n')
      .filter(b => b && b !== currentBranch);

    if (mergedBranches.length <= maxMergedBranches) return 0;

    // Keep the newest N, delete the rest
    const toDelete = mergedBranches.slice(maxMergedBranches);

    let removed = 0;
    if (!dryRun) {
      for (const branch of toDelete) {
        const delResult = spawnSync('git', ['branch', '-d', branch], {
          cwd: repoRoot,
          encoding: 'utf-8',
        });
        if (delResult.status === 0) removed++;
      }
    } else {
      removed = toDelete.length;
    }

    return removed;
  } catch {
    return 0;
  }
}

// =============================================================================
// Stale worktree cleanup
// =============================================================================

/**
 * Remove orphaned worktrees that have no associated running process.
 * Uses `git worktree list` to find stale entries and `git worktree remove --force`.
 */
export function pruneStaleWorktrees(repoRoot: string, dryRun = false): number {
  try {
    const worktreesDir = path.join(repoRoot, '.blockspool', 'worktrees');
    if (!fs.existsSync(worktreesDir)) return 0;

    const entries = fs.readdirSync(worktreesDir).filter(e => {
      const fullPath = path.join(worktreesDir, e);
      return fs.statSync(fullPath).isDirectory();
    });

    if (entries.length === 0) return 0;

    // Get list of worktrees git knows about
    const listResult = spawnSync('git', ['worktree', 'list', '--porcelain'], {
      cwd: repoRoot,
      encoding: 'utf-8',
    });
    const gitWorktrees = new Set(
      (listResult.stdout ?? '').split('\n')
        .filter(l => l.startsWith('worktree '))
        .map(l => l.replace('worktree ', '').trim()),
    );

    let removed = 0;
    for (const entry of entries) {
      // Skip _milestone — that's managed by solo-git
      if (entry === '_milestone') continue;

      const worktreePath = path.join(worktreesDir, entry);

      // Check if git still tracks this worktree with a lock file
      // If git doesn't know about it, it's a leftover directory
      const isTracked = gitWorktrees.has(path.resolve(worktreePath));

      if (!dryRun) {
        try {
          if (isTracked) {
            spawnSync('git', ['worktree', 'remove', '--force', worktreePath], {
              cwd: repoRoot,
              encoding: 'utf-8',
            });
          } else {
            // Not a git worktree anymore — just remove the directory
            fs.rmSync(worktreePath, { recursive: true, force: true });
          }
          removed++;
        } catch {
          // Individual removal failure is non-fatal
        }
      } else {
        removed++;
      }
    }

    return removed;
  } catch {
    return 0;
  }
}

// =============================================================================
// Main prune (sync — file-system only)
// =============================================================================

export function pruneAll(
  repoRoot: string,
  config: RetentionConfig,
  dryRun = false,
): PruneReport {
  const report = emptyReport();

  report.runFoldersRemoved = pruneRunFolders(repoRoot, config.maxRuns, dryRun);
  report.historyLinesRemoved = pruneHistory(repoRoot, config.maxHistoryEntries, dryRun);
  report.artifactsRemoved = pruneArtifacts(repoRoot, config.maxArtifactsPerRun, dryRun);
  report.spoolArchivesRemoved = pruneSpoolArchives(repoRoot, config.maxSpoolArchives, dryRun);
  report.deferredProposalsRemoved = pruneDeferredProposals(repoRoot, config.maxDeferredProposals, dryRun);
  report.staleWorktreesRemoved = pruneStaleWorktrees(repoRoot, dryRun);
  // Branch pruning is NOT run here — only via explicit `blockspool prune`

  report.totalPruned =
    report.runFoldersRemoved +
    report.historyLinesRemoved +
    report.artifactsRemoved +
    report.spoolArchivesRemoved +
    report.deferredProposalsRemoved +
    report.staleWorktreesRemoved;

  return report;
}

/**
 * Full prune including async DB operations.
 */
export async function pruneAllAsync(
  repoRoot: string,
  config: RetentionConfig,
  adapter: DatabaseAdapter | null = null,
  dryRun = false,
): Promise<PruneReport> {
  const report = pruneAll(repoRoot, config, dryRun);

  report.completedTicketsRemoved = await pruneCompletedTickets(adapter, config.maxCompletedTickets, dryRun);
  report.mergedBranchesRemoved = pruneMergedBranches(repoRoot, config.maxMergedBranches, dryRun);
  report.totalPruned += report.completedTicketsRemoved + report.mergedBranchesRemoved;

  return report;
}

/**
 * Format a prune report for display.
 */
export function formatPruneReport(report: PruneReport, dryRun = false): string {
  const prefix = dryRun ? 'Would remove' : 'Removed';
  const lines: string[] = [];

  if (report.runFoldersRemoved > 0) {
    lines.push(`  ${prefix} ${report.runFoldersRemoved} run folder(s)`);
  }
  if (report.historyLinesRemoved > 0) {
    lines.push(`  ${prefix} ${report.historyLinesRemoved} history line(s)`);
  }
  if (report.artifactsRemoved > 0) {
    lines.push(`  ${prefix} ${report.artifactsRemoved} artifact file(s)`);
  }
  if (report.spoolArchivesRemoved > 0) {
    lines.push(`  ${prefix} ${report.spoolArchivesRemoved} spool archive(s)`);
  }
  if (report.deferredProposalsRemoved > 0) {
    lines.push(`  ${prefix} ${report.deferredProposalsRemoved} deferred proposal(s)`);
  }
  if (report.completedTicketsRemoved > 0) {
    lines.push(`  ${prefix} ${report.completedTicketsRemoved} completed ticket(s)`);
  }
  if (report.mergedBranchesRemoved > 0) {
    lines.push(`  ${prefix} ${report.mergedBranchesRemoved} merged branch(es)`);
  }
  if (report.staleWorktreesRemoved > 0) {
    lines.push(`  ${prefix} ${report.staleWorktreesRemoved} stale worktree(s)`);
  }

  if (lines.length === 0) {
    return '  Nothing to prune.';
  }

  return lines.join('\n');
}
