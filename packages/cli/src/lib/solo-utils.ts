/**
 * Solo mode utility functions
 */

import type { DatabaseAdapter } from '@promptwheel/core/db';
import { tickets } from '@promptwheel/core/repos';
import type { TicketProposal } from '@promptwheel/core/scout';
import type { QaConfig } from '@promptwheel/core/services';
import type { SoloConfig } from './solo-config.js';

/**
 * Format duration in human-readable form
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

/**
 * Format relative time
 */
export function formatRelativeTime(date: Date): string {
  const now = Date.now();
  const diff = now - date.getTime();
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

/**
 * Status output for JSON mode
 */
export interface StatusOutput {
  dbPath: string;
  projects: Array<{
    id: string;
    name: string;
    ticketCounts: Record<string, number>;
    lastScout: {
      id: string;
      status: string;
      completedAt: string | null;
      proposalCount: number;
      ticketCount: number;
      scannedFiles: number;
      durationMs: number;
    } | null;
    lastQa: {
      id: string;
      status: string;
      completedAt: string | null;
      stepsPassed: number;
      stepsFailed: number;
      durationMs: number;
    } | null;
    lastExecute: {
      id: string;
      ticketId: string | null;
      status: string;
      completedAt: string | null;
      branchName: string | null;
      prUrl: string | null;
      durationMs: number;
      completionOutcome: string | null;
    } | null;
    activeRuns: number;
  }>;
}

/**
 * Proposals artifact structure
 */
export interface ProposalsArtifact {
  runId: string;
  projectId: string;
  projectName: string;
  createdAt: string;
  proposals: TicketProposal[];
}

/**
 * Pre-flight check result
 */
export interface PreflightResult {
  ok: boolean;
  error?: string;
  warnings: string[];
  hasRemote: boolean;
  ghAuthenticated: boolean;
}

/**
 * QA output for JSON mode
 */
export interface QaOutput {
  runId: string;
  projectId: string;
  status: 'success' | 'failed' | 'canceled';
  attempts: number;
  durationMs: number;
  failedAt?: {
    attempt: number;
    stepName: string;
  };
  steps: Array<{
    name: string;
    status: string;
    exitCode: number | null;
    durationMs: number | null;
    errorMessage: string | null;
    stdoutPath: string | null;
    stderrPath: string | null;
    stdoutTail: string | null;
    stderrTail: string | null;
  }>;
}

/**
 * Run pre-flight checks before execution
 */
export async function runPreflightChecks(repoRoot: string, opts: {
  needsPr: boolean;
  skipRemoteCheck?: boolean;
}): Promise<PreflightResult> {
  const warnings: string[] = [];
  const { execSync, spawnSync } = await import('child_process');

  // Check Claude CLI installed
  try {
    const result = spawnSync('claude', ['--version'], { encoding: 'utf-8', timeout: 5000 });
    if (result.status !== 0) {
      return {
        ok: false,
        error: 'Claude CLI not found. Install from: https://claude.ai/code',
        warnings,
        hasRemote: false,
        ghAuthenticated: false,
      };
    }
  } catch {
    return {
      ok: false,
      error: 'Claude CLI not found. Install from: https://claude.ai/code',
      warnings,
      hasRemote: false,
      ghAuthenticated: false,
    };
  }

  // Check if repo has a remote
  let hasRemote = false;
  try {
    const remotes = execSync('git remote', { cwd: repoRoot, encoding: 'utf-8' }).trim();
    hasRemote = remotes.length > 0;
  } catch {
    hasRemote = false;
  }

  if (!hasRemote) {
    return {
      ok: false,
      error: 'No git remote configured. Run: git remote add origin <url>',
      warnings,
      hasRemote: false,
      ghAuthenticated: false,
    };
  }

  // Validate origin matches the remote recorded at init time
  if (!opts.skipRemoteCheck) {
    try {
      const { loadConfig } = await import('./solo-config.js');
      const config = loadConfig(repoRoot);
      if (config?.allowedRemote) {
        const { normalizeRemoteUrl } = await import('./solo-remote.js');
        const currentRemote = execSync('git remote get-url origin', { cwd: repoRoot, encoding: 'utf-8' }).trim();
        if (normalizeRemoteUrl(currentRemote) !== normalizeRemoteUrl(config.allowedRemote)) {
          return {
            ok: false,
            error: `Remote mismatch: origin points to "${currentRemote}" but solo init recorded "${config.allowedRemote}". ` +
              'Re-run "promptwheel solo init --force" if this is intentional.',
            warnings,
            hasRemote,
            ghAuthenticated: false,
          };
        }
      }
    } catch {
      // If we can't check, don't block — just warn
      warnings.push('Could not verify origin remote against config');
    }
  }

  // Check gh auth (only if --pr requested)
  let ghAuthenticated = false;
  if (opts.needsPr) {
    // First check if gh is installed
    try {
      const ghResult = spawnSync('gh', ['--version'], { encoding: 'utf-8', timeout: 5000 });
      if (ghResult.status !== 0) {
        return {
          ok: false,
          error: 'GitHub CLI not found. Install from: https://cli.github.com/',
          warnings,
          hasRemote,
          ghAuthenticated: false,
        };
      }
    } catch {
      return {
        ok: false,
        error: 'GitHub CLI not found. Install from: https://cli.github.com/',
        warnings,
        hasRemote,
        ghAuthenticated: false,
      };
    }

    // Then check auth
    try {
      execSync('gh auth status', { stdio: 'ignore' });
      ghAuthenticated = true;
    } catch {
      return {
        ok: false,
        error: 'GitHub CLI not authenticated. Run: gh auth login',
        warnings,
        hasRemote,
        ghAuthenticated: false,
      };
    }
  }

  return {
    ok: true,
    warnings,
    hasRemote,
    ghAuthenticated,
  };
}

// Path overlap and directory overlap algorithms now live in core.
// Re-exported here for backwards compatibility.
export { pathsOverlap, directoriesOverlap } from '@promptwheel/core/waves/shared';
import { pathsOverlap } from '@promptwheel/core/waves/shared';

/**
 * Find in-progress tickets that have overlapping allowed_paths with the given ticket
 */
export async function findConflictingTickets(
  db: DatabaseAdapter,
  ticket: NonNullable<Awaited<ReturnType<typeof tickets.getById>>>
): Promise<Array<{ ticket: NonNullable<Awaited<ReturnType<typeof tickets.getById>>>; overlappingPaths: string[] }>> {
  const inProgressTickets = await tickets.listByProject(db, ticket.projectId, {
    status: ['in_progress', 'leased'],
  });

  const conflicts: Array<{ ticket: typeof inProgressTickets[0]; overlappingPaths: string[] }> = [];

  for (const other of inProgressTickets) {
    if (other.id === ticket.id) {
      continue;
    }

    if (other.allowedPaths.length === 0 || ticket.allowedPaths.length === 0) {
      continue;
    }

    const overlappingPaths: string[] = [];
    for (const pA of ticket.allowedPaths) {
      for (const pB of other.allowedPaths) {
        if (pathsOverlap(pA, pB)) {
          overlappingPaths.push(`${pA} <-> ${pB}`);
        }
      }
    }

    if (overlappingPaths.length > 0) {
      conflicts.push({ ticket: other, overlappingPaths });
    }
  }

  return conflicts;
}

/**
 * Expand allowed paths for test tickets to include test file locations
 */
export function expandPathsForTests(paths: string[]): string[] {
  const expanded = new Set<string>(paths);

  for (const filePath of paths) {
    if (filePath.includes('.test.') || filePath.includes('.spec.') || filePath.includes('__tests__')) {
      continue;
    }

    const lastSlash = filePath.lastIndexOf('/');
    const dir = lastSlash >= 0 ? filePath.slice(0, lastSlash) : '';
    const filename = lastSlash >= 0 ? filePath.slice(lastSlash + 1) : filePath;

    const lastDot = filename.lastIndexOf('.');
    const ext = lastDot >= 0 ? filename.slice(lastDot) : '';
    const baseName = lastDot >= 0 ? filename.slice(0, lastDot) : filename;

    if (dir) {
      expanded.add(`${dir}/${baseName}.test${ext}`);
      expanded.add(`${dir}/${baseName}.spec${ext}`);
    } else {
      expanded.add(`${baseName}.test${ext}`);
      expanded.add(`${baseName}.spec${ext}`);
    }

    if (dir) {
      expanded.add(`${dir}/__tests__/${baseName}.test${ext}`);
      expanded.add(`${dir}/__tests__/${baseName}${ext}`);
    }

    if (dir.startsWith('src/')) {
      const relPath = dir.slice(4);
      expanded.add(`src/test/${relPath ? relPath + '/' : ''}${baseName}.test${ext}`);
      expanded.add(`test/${relPath ? relPath + '/' : ''}${baseName}.test${ext}`);
      expanded.add(`tests/${relPath ? relPath + '/' : ''}${baseName}.test${ext}`);
    }

    expanded.add(`src/test/${baseName}.test${ext}`);
    expanded.add(`test/${baseName}.test${ext}`);
    expanded.add(`tests/${baseName}.test${ext}`);
    expanded.add(`__tests__/${baseName}.test${ext}`);
  }

  return Array.from(expanded);
}

/**
 * Regenerate allowed_paths for a ticket using current scope expansion logic
 */
export function regenerateAllowedPaths(ticket: NonNullable<Awaited<ReturnType<typeof tickets.getById>>>): string[] {
  const currentPaths = ticket.allowedPaths;

  if (currentPaths.length === 0) {
    return [];
  }

  if (ticket.category === 'test') {
    const expandedPaths = expandPathsForTests(currentPaths);
    if (!expandedPaths.includes('package.json')) {
      expandedPaths.push('package.json');
    }
    if (!expandedPaths.includes('package-lock.json')) {
      expandedPaths.push('package-lock.json');
    }
    return expandedPaths;
  }

  return currentPaths;
}

/**
 * Normalize QA config from raw config file
 */
export function normalizeQaConfig(config: SoloConfig, overrides?: { maxAttempts?: number }): QaConfig {
  const qa = config.qa;
  if (!qa?.commands?.length) {
    throw new Error(
      'QA is not configured. Add qa.commands to .promptwheel/config.json\n\n' +
      'Example:\n' +
      '{\n' +
      '  "qa": {\n' +
      '    "commands": [\n' +
      '      { "name": "lint", "cmd": "npm run lint" },\n' +
      '      { "name": "test", "cmd": "npm test" }\n' +
      '    ]\n' +
      '  }\n' +
      '}'
    );
  }

  const commands = qa.commands.map((c) => ({
    name: String(c.name ?? '').trim(),
    cmd: String(c.cmd ?? '').trim(),
    cwd: c.cwd ?? '.',
    timeoutMs: c.timeoutMs ?? (c.timeoutSec ? c.timeoutSec * 1000 : undefined),
  }));

  const artifactsDir = qa.artifacts?.storeDir ?? '.promptwheel/artifacts';
  const maxLogBytes = qa.artifacts?.maxLogBytes ?? 200_000;
  const tailBytes = qa.artifacts?.tailBytes ?? 16_384;

  const retryEnabled = qa.retry?.enabled ?? false;
  const retryMax = qa.retry?.maxAttempts ?? 1;

  return {
    commands,
    artifacts: { dir: artifactsDir, maxLogBytes, tailBytes },
    retry: {
      enabled: overrides?.maxAttempts ? true : retryEnabled,
      maxAttempts: overrides?.maxAttempts ?? retryMax,
    },
  };
}
