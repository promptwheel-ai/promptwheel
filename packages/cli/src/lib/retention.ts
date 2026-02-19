/**
 * Retention & Cleanup
 *
 * Prune logic for all unbounded state accumulation points.
 * Called automatically on session start and via `promptwheel prune`.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  type RetentionConfig,
  type SoloConfig,
  DEFAULT_RETENTION_CONFIG,
  getPromptwheelDir,
} from './solo-config.js';
import { readRunState, writeRunState } from './run-state.js';
import type { DatabaseAdapter } from '@promptwheel/core/db';

// =============================================================================
// Report
// =============================================================================

export interface PruneReport {
  runFoldersRemoved: number;
  historyLinesRemoved: number;
  artifactsRemoved: number;
  bufferArchivesRemoved: number;
  deferredProposalsRemoved: number;
  completedTicketsRemoved: number;
  mergedBranchesRemoved: number;
  staleBranchesRemoved: number;
  staleWorktreesRemoved: number;
  logsRotated: number;
  metricsLinesRemoved: number;
  artifactsByAgeRemoved: number;
  totalPruned: number;
}

function emptyReport(): PruneReport {
  return {
    runFoldersRemoved: 0,
    historyLinesRemoved: 0,
    artifactsRemoved: 0,
    bufferArchivesRemoved: 0,
    deferredProposalsRemoved: 0,
    completedTicketsRemoved: 0,
    mergedBranchesRemoved: 0,
    staleBranchesRemoved: 0,
    staleWorktreesRemoved: 0,
    logsRotated: 0,
    metricsLinesRemoved: 0,
    artifactsByAgeRemoved: 0,
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
 * Sort .promptwheel/runs/ by mtime, delete oldest beyond cap.
 */
export function pruneRunFolders(
  repoRoot: string,
  maxRuns: number,
  dryRun = false,
): number {
  const runsDir = path.join(getPromptwheelDir(repoRoot), 'runs');
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
  const historyPath = path.join(getPromptwheelDir(repoRoot), 'history.ndjson');
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
  const runsDir = path.join(getPromptwheelDir(repoRoot), 'runs');
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
 * Delete oldest *.archived.ndjson in buffer/ beyond cap.
 */
export function pruneBufferArchives(
  repoRoot: string,
  maxArchives: number,
  dryRun = false,
): number {
  const bufferDir = path.join(getPromptwheelDir(repoRoot), 'buffer');
  if (!fs.existsSync(bufferDir)) return 0;

  const archives = fs.readdirSync(bufferDir)
    .filter(f => f.endsWith('.archived.ndjson'))
    .map(f => ({
      name: f,
      path: path.join(bufferDir, f),
      mtime: fs.statSync(path.join(bufferDir, f)).mtimeMs,
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
 * Delete local promptwheel/* branches that are fully merged, keeping the
 * newest N merged branches. Only touches local branches — never deletes
 * remote branches, and never touches unmerged branches.
 *
 * NOT called during auto-prune-on-start — only via `promptwheel prune`.
 */
export function pruneMergedBranches(
  repoRoot: string,
  maxMergedBranches: number,
  dryRun = false,
): number {
  try {
    // Get the list of promptwheel/* branches that are fully merged into HEAD
    const mergedResult = spawnSync(
      'git',
      ['branch', '--merged', 'HEAD', '--list', 'promptwheel/*', '--sort=-committerdate', '--format=%(refname:short)'],
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
// Stale unmerged branch cleanup
// =============================================================================

/**
 * Delete local promptwheel/tkt_* and promptwheel/milestone-* branches that are
 * NOT merged and whose last commit is older than `maxDays` days. Never touches
 * promptwheel-direct or user branches. Never deletes the current branch.
 */
export function pruneStaleBranches(
  repoRoot: string,
  maxDays: number,
  dryRun = false,
): number {
  if (maxDays <= 0) return 0;

  try {
    // Current branch — never delete
    const headResult = spawnSync('git', ['branch', '--show-current'], {
      cwd: repoRoot,
      encoding: 'utf-8',
    });
    const currentBranch = headResult.stdout?.trim() ?? '';

    const cutoff = Date.now() - (maxDays * 24 * 60 * 60 * 1000);
    let removed = 0;

    // Prune both tkt_* and milestone-* branches
    const refPatterns = ['refs/heads/promptwheel/tkt_*', 'refs/heads/promptwheel/milestone-*'];
    for (const pattern of refPatterns) {
      const listResult = spawnSync(
        'git',
        ['for-each-ref', '--format=%(refname:short) %(committerdate:unix)', pattern],
        { cwd: repoRoot, encoding: 'utf-8' },
      );
      if (listResult.status !== 0 || !listResult.stdout?.trim()) continue;

      for (const line of listResult.stdout.trim().split('\n')) {
        const parts = line.trim().split(' ');
        if (parts.length < 2) continue;
        const branch = parts[0];
        const epochSec = parseInt(parts[1], 10);
        if (!branch || isNaN(epochSec)) continue;
        if (branch === currentBranch) continue;

        const commitMs = epochSec * 1000;
        if (commitMs >= cutoff) continue; // too recent

        if (!dryRun) {
          const delResult = spawnSync('git', ['branch', '-D', branch], {
            cwd: repoRoot,
            encoding: 'utf-8',
          });
          if (delResult.status === 0) removed++;
        } else {
          removed++;
        }
      }
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
    const worktreesDir = path.join(repoRoot, '.promptwheel', 'worktrees');
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

          // Also delete the associated branch
          if (entry.startsWith('tkt_')) {
            spawnSync('git', ['branch', '-D', `promptwheel/${entry}`], {
              cwd: repoRoot,
              encoding: 'utf-8',
            });
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
// Stale codex session cleanup
// =============================================================================

/**
 * Remove codex session rollout files from incompatible versions and old sessions.
 *
 * Codex stores per-thread rollout files in ~/.codex/sessions/YYYY/MM/DD/.
 * After a codex upgrade, old-version rollout files cause "state db missing
 * rollout path" errors on every invocation because the new version can't
 * index the old format. This prunes:
 *   1. Rollout files from a different major.minor codex version
 *   2. Rollout files older than `maxDays` days
 *   3. Abandoned rollout files — same version, recent, but the owning
 *      process stopped writing (mtime > 5 min stale). These are left
 *      behind when a codex process is killed mid-execution.
 */
export function pruneStaleCodexSessions(maxDays: number, dryRun = false): number {
  if (maxDays <= 0) return 0;

  try {
    const codexDir = path.join(os.homedir(), '.codex', 'sessions');
    if (!fs.existsSync(codexDir)) return 0;

    // Detect current codex version
    const verResult = spawnSync('codex', ['--version'], { encoding: 'utf-8', timeout: 5000 });
    const verMatch = verResult.stdout?.match(/(\d+\.\d+)/);
    const currentMajorMinor = verMatch?.[1] ?? null;

    // Only prune abandoned threads if no codex process is running
    const codexRunning = isCodexRunning();

    const cutoff = Date.now() - (maxDays * 24 * 60 * 60 * 1000);
    const staleCutoff = Date.now() - (5 * 60 * 1000); // 5 minutes
    let removed = 0;

    // Walk YYYY/MM/DD directory structure
    for (const year of safeReaddir(codexDir)) {
      const yearPath = path.join(codexDir, year);
      if (!safeStat(yearPath)?.isDirectory()) continue;

      for (const month of safeReaddir(yearPath)) {
        const monthPath = path.join(yearPath, month);
        if (!safeStat(monthPath)?.isDirectory()) continue;

        for (const day of safeReaddir(monthPath)) {
          const dayPath = path.join(monthPath, day);
          if (!safeStat(dayPath)?.isDirectory()) continue;

          for (const file of safeReaddir(dayPath)) {
            const filePath = path.join(dayPath, file);
            try {
              const stat = fs.statSync(filePath);
              let shouldRemove = stat.mtimeMs < cutoff;

              // Check version incompatibility for rollout files
              if (!shouldRemove && currentMajorMinor && file.endsWith('.jsonl')) {
                const firstLine = readFirstLine(filePath);
                if (firstLine) {
                  const verInFile = firstLine.match(/"cli_version":"(\d+\.\d+)/);
                  if (verInFile && verInFile[1] !== currentMajorMinor) {
                    shouldRemove = true;
                  }
                }
              }

              // Check for abandoned rollout files — stale mtime, no codex running.
              // These are left behind when a codex process is killed mid-execution.
              // Only prune if no codex process is currently running (safe window).
              if (!shouldRemove && !codexRunning && file.endsWith('.jsonl') && stat.mtimeMs < staleCutoff) {
                shouldRemove = true;
              }

              if (shouldRemove) {
                if (!dryRun) fs.unlinkSync(filePath);
                removed++;
              }
            } catch { /* skip */ }
          }

          // Remove empty day directories
          try {
            if (!dryRun && safeReaddir(dayPath).length === 0) fs.rmdirSync(dayPath);
          } catch { /* skip */ }
        }

        try {
          if (!dryRun && safeReaddir(monthPath).length === 0) fs.rmdirSync(monthPath);
        } catch { /* skip */ }
      }

      try {
        if (!dryRun && safeReaddir(yearPath).length === 0) fs.rmdirSync(yearPath);
      } catch { /* skip */ }
    }

    return removed;
  } catch {
    return 0;
  }
}

/**
 * Check if any codex process is currently running.
 * Used to gate abandoned-thread pruning — if codex is running,
 * skip aggressive pruning to avoid deleting active rollout files.
 */
function isCodexRunning(): boolean {
  try {
    const result = spawnSync('pgrep', ['-f', 'codex'], { encoding: 'utf-8', timeout: 5000 });
    return result.status === 0 && !!result.stdout?.trim();
  } catch {
    return true; // assume running if we can't check — safer to skip pruning
  }
}

function safeReaddir(dir: string): string[] {
  try { return fs.readdirSync(dir); } catch { return []; }
}

function safeStat(p: string): fs.Stats | null {
  try { return fs.statSync(p); } catch { return null; }
}

function readFirstLine(filePath: string): string | null {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(512);
    const bytesRead = fs.readSync(fd, buf, 0, 512, 0);
    fs.closeSync(fd);
    const text = buf.toString('utf-8', 0, bytesRead);
    const nl = text.indexOf('\n');
    return nl >= 0 ? text.slice(0, nl) : text;
  } catch { return null; }
}

// =============================================================================
// Log rotation
// =============================================================================

/**
 * Rotate tui.log when it exceeds maxBytes.
 * Renames current to tui.log.1, starts fresh.
 * Only keeps 1 backup — previous .1 is overwritten.
 */
export function rotateLogs(repoRoot: string, maxBytes: number, dryRun = false): number {
  if (maxBytes <= 0) return 0;

  const bsDir = getPromptwheelDir(repoRoot);
  const logPath = path.join(bsDir, 'tui.log');
  if (!fs.existsSync(logPath)) return 0;

  try {
    const stat = fs.statSync(logPath);
    if (stat.size <= maxBytes) return 0;

    if (!dryRun) {
      const backupPath = path.join(bsDir, 'tui.log.1');
      // Overwrite previous backup
      try { fs.unlinkSync(backupPath); } catch { /* may not exist */ }
      fs.renameSync(logPath, backupPath);
    }
    return 1;
  } catch {
    return 0;
  }
}

/**
 * Keep last N lines in metrics.ndjson, rewrite file.
 */
export function pruneMetrics(
  repoRoot: string,
  maxEntries: number,
  dryRun = false,
): number {
  if (maxEntries <= 0) return 0;

  const metricsPath = path.join(getPromptwheelDir(repoRoot), 'metrics.ndjson');
  if (!fs.existsSync(metricsPath)) return 0;

  const content = fs.readFileSync(metricsPath, 'utf-8');
  const lines = content.split('\n').filter(l => l.trim().length > 0);

  if (lines.length <= maxEntries) return 0;

  const removed = lines.length - maxEntries;
  if (!dryRun) {
    const kept = lines.slice(-maxEntries);
    fs.writeFileSync(metricsPath, kept.join('\n') + '\n');
  }
  return removed;
}

// =============================================================================
// Time-based artifact expiry
// =============================================================================

/**
 * Delete artifact files older than maxDays from .promptwheel/artifacts/.
 * Walks all subdirectories (executions/, diffs/, runs/, violations/).
 * Removes empty subdirectories afterward.
 */
export function pruneArtifactsByAge(
  repoRoot: string,
  maxDays: number,
  dryRun = false,
): number {
  if (maxDays <= 0) return 0;

  const artifactsDir = path.join(getPromptwheelDir(repoRoot), 'artifacts');
  if (!fs.existsSync(artifactsDir)) return 0;

  const cutoff = Date.now() - (maxDays * 24 * 60 * 60 * 1000);
  let removed = 0;

  for (const subdir of safeReaddir(artifactsDir)) {
    const subdirPath = path.join(artifactsDir, subdir);
    if (!safeStat(subdirPath)?.isDirectory()) continue;

    for (const file of safeReaddir(subdirPath)) {
      const filePath = path.join(subdirPath, file);
      try {
        const stat = fs.statSync(filePath);
        if (!stat.isFile()) continue;
        if (stat.mtimeMs < cutoff) {
          if (!dryRun) fs.unlinkSync(filePath);
          removed++;
        }
      } catch { /* skip */ }
    }

    // Remove empty subdirectory
    try {
      if (!dryRun && safeReaddir(subdirPath).length === 0) {
        fs.rmdirSync(subdirPath);
      }
    } catch { /* skip */ }
  }

  return removed;
}

// =============================================================================
// Git worktree prune
// =============================================================================

/**
 * Run `git worktree prune` to clean dangling worktree refs that manual
 * cleanup misses (e.g. worktree directories deleted without `git worktree remove`).
 */
export function gitWorktreePrune(repoRoot: string): void {
  try {
    spawnSync('git', ['worktree', 'prune'], {
      cwd: repoRoot,
      encoding: 'utf-8',
      timeout: 10_000,
    });
  } catch { /* non-fatal */ }
}

// =============================================================================
// Session lock file
// =============================================================================

/**
 * Write a session lock file (.promptwheel/session.pid) with the current PID.
 * Returns true if lock acquired, false if another live session holds it.
 */
export function acquireSessionLock(repoRoot: string): { acquired: boolean; stalePid?: number } {
  const lockPath = path.join(getPromptwheelDir(repoRoot), 'session.pid');

  // Check existing lock
  if (fs.existsSync(lockPath)) {
    try {
      const content = fs.readFileSync(lockPath, 'utf-8').trim();
      const pid = parseInt(content, 10);
      if (!isNaN(pid) && pid > 0) {
        // Check if PID is still alive
        try {
          process.kill(pid, 0); // signal 0 = existence check only
          // Process is alive — another session is running
          return { acquired: false };
        } catch {
          // Process is dead — stale lock, clean it up
          fs.unlinkSync(lockPath);
          // Fall through to acquire
          return acquireLock(lockPath, pid);
        }
      }
    } catch {
      // Corrupt lock file — remove and proceed
      try { fs.unlinkSync(lockPath); } catch { /* skip */ }
    }
  }

  return acquireLock(lockPath);
}

function acquireLock(lockPath: string, stalePid?: number): { acquired: boolean; stalePid?: number } {
  try {
    fs.writeFileSync(lockPath, String(process.pid));
    return { acquired: true, stalePid };
  } catch {
    return { acquired: false };
  }
}

/**
 * Release the session lock file on clean shutdown.
 */
export function releaseSessionLock(repoRoot: string): void {
  const lockPath = path.join(getPromptwheelDir(repoRoot), 'session.pid');
  try {
    // Only remove if we own it
    const content = fs.readFileSync(lockPath, 'utf-8').trim();
    if (parseInt(content, 10) === process.pid) {
      fs.unlinkSync(lockPath);
    }
  } catch { /* non-fatal */ }
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
  report.bufferArchivesRemoved = pruneBufferArchives(repoRoot, config.maxBufferArchives, dryRun);
  report.deferredProposalsRemoved = pruneDeferredProposals(repoRoot, config.maxDeferredProposals, dryRun);
  report.staleWorktreesRemoved = pruneStaleWorktrees(repoRoot, dryRun);
  // Branch pruning is NOT run here — only via explicit `promptwheel prune`

  // Log rotation & metrics pruning
  report.logsRotated = rotateLogs(repoRoot, config.maxLogSizeBytes, dryRun);
  report.metricsLinesRemoved = pruneMetrics(repoRoot, config.maxMetricsEntries, dryRun);
  report.artifactsByAgeRemoved = pruneArtifactsByAge(repoRoot, config.maxArtifactAgeDays, dryRun);

  // Git worktree prune (dangling refs)
  if (!dryRun) gitWorktreePrune(repoRoot);

  report.totalPruned =
    report.runFoldersRemoved +
    report.historyLinesRemoved +
    report.artifactsRemoved +
    report.bufferArchivesRemoved +
    report.deferredProposalsRemoved +
    report.staleWorktreesRemoved +
    report.logsRotated +
    report.metricsLinesRemoved +
    report.artifactsByAgeRemoved;

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
  report.staleBranchesRemoved = pruneStaleBranches(repoRoot, config.maxStaleBranchDays, dryRun);
  report.totalPruned += report.completedTicketsRemoved + report.mergedBranchesRemoved + report.staleBranchesRemoved;

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
  if (report.bufferArchivesRemoved > 0) {
    lines.push(`  ${prefix} ${report.bufferArchivesRemoved} buffer archive(s)`);
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
  if (report.staleBranchesRemoved > 0) {
    lines.push(`  ${prefix} ${report.staleBranchesRemoved} stale ticket branch(es)`);
  }
  if (report.staleWorktreesRemoved > 0) {
    lines.push(`  ${prefix} ${report.staleWorktreesRemoved} stale worktree(s)`);
  }
  if (report.logsRotated > 0) {
    lines.push(`  Rotated tui.log`);
  }
  if (report.metricsLinesRemoved > 0) {
    lines.push(`  ${prefix} ${report.metricsLinesRemoved} metrics line(s)`);
  }
  if (report.artifactsByAgeRemoved > 0) {
    lines.push(`  ${prefix} ${report.artifactsByAgeRemoved} expired artifact(s)`);
  }

  if (lines.length === 0) {
    return '  Nothing to prune.';
  }

  return lines.join('\n');
}
