/**
 * Git service implementation for CLI
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import type { GitService } from '@blockspool/core/services';

/**
 * Find git repository root from a path
 */
async function findRepoRoot(startPath: string): Promise<string | null> {
  let current = path.resolve(startPath);

  while (current !== path.dirname(current)) {
    if (fs.existsSync(path.join(current, '.git'))) {
      return current;
    }
    current = path.dirname(current);
  }

  return null;
}

/**
 * Get remote URL from git
 */
async function getRemoteUrl(repoRoot: string): Promise<string | null> {
  try {
    const url = execSync('git remote get-url origin', {
      cwd: repoRoot,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return url || null;
  } catch {
    return null;
  }
}

/**
 * Generate deterministic project ID from repo
 */
function getProjectId(repoRoot: string, remoteUrl: string | null): string {
  const source = remoteUrl || repoRoot;

  // Simple hash for deterministic ID
  let hash = 0;
  for (let i = 0; i < source.length; i++) {
    const char = source.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash | 0; // Convert to 32bit integer
  }

  return `proj_${Math.abs(hash).toString(36)}`;
}

/**
 * Create a GitService instance
 */
export function createGitService(): GitService {
  return {
    findRepoRoot,
    getRemoteUrl,
    getProjectId,
  };
}
