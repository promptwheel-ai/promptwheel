/**
 * Deduplication utilities for proposal filtering.
 *
 * Pure algorithms (normalizeTitle, titleSimilarity, isDuplicate) live in
 * @promptwheel/core/dedup/shared. This file re-exports them and adds
 * I/O-dependent helpers (database lookups, git branch listing).
 */

import type { DatabaseAdapter } from '@promptwheel/core/db';
import { tickets } from '@promptwheel/core/repos';
import type { TicketProposal } from '@promptwheel/core/scout';
import { gitExecFile } from './solo-git.js';

// Re-export pure algorithms from core
export { normalizeTitle, titleSimilarity } from '@promptwheel/core/dedup/shared';
import { normalizeTitle, titleSimilarity } from '@promptwheel/core/dedup/shared';

/**
 * Sleep helper
 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Check if a proposal is a duplicate of existing tickets or open PRs
 */
export async function isDuplicateProposal(
  proposal: { title: string; files?: string[] },
  existingTitles: string[],
  openPrBranches: string[],
  similarityThreshold = 0.6
): Promise<{ isDuplicate: boolean; reason?: string }> {
  const normalizedProposal = normalizeTitle(proposal.title);

  for (const existing of existingTitles) {
    if (normalizeTitle(existing) === normalizedProposal) {
      return { isDuplicate: true, reason: `Exact match: "${existing}"` };
    }
  }

  for (const existing of existingTitles) {
    const sim = titleSimilarity(proposal.title, existing);
    if (sim >= similarityThreshold) {
      return { isDuplicate: true, reason: `Similar (${Math.round(sim * 100)}%): "${existing}"` };
    }
  }

  for (const branch of openPrBranches) {
    // Extract slug from branch name (e.g., 'promptwheel/tkt_abc123/fix-login-bug' -> 'fix login bug')
    const branchTitle = branch.replace(/^promptwheel\/tkt_[a-z0-9]+\//, '').replace(/-/g, ' ');
    if (branchTitle && titleSimilarity(proposal.title, branchTitle) >= similarityThreshold) {
      return { isDuplicate: true, reason: `Open PR branch: ${branch}` };
    }
  }

  return { isDuplicate: false };
}

/**
 * Get existing ticket titles and open PR branches for deduplication
 */
export async function getDeduplicationContext(
  adapter: DatabaseAdapter,
  projectId: string,
  repoRoot: string
): Promise<{ existingTitles: string[]; openPrBranches: string[] }> {
  const allTickets = await tickets.listByProject(adapter, projectId, {
    limit: 200,
  });

  const existingTitles = allTickets
    .filter(t => t.status !== 'ready')
    .map(t => t.title);

  let openPrBranches: string[] = [];
  try {
    const stdout = await gitExecFile('git', ['branch', '-r', '--list', 'origin/promptwheel/*'], {
      cwd: repoRoot,
    });
    if (stdout) {
      openPrBranches = stdout
        .split('\n')
        .map(b => b.trim().replace('origin/', ''))
        .filter(Boolean);
    }
  } catch {
    // Ignore git errors
  }

  return { existingTitles, openPrBranches };
}

/**
 * Determine adaptive parallel count based on ticket complexity.
 * When --parallel is NOT explicitly set, scale based on proposal mix.
 */
export function getAdaptiveParallelCount(proposals: TicketProposal[]): number {
  const heavy = proposals.filter(p => p.estimated_complexity === 'moderate' || p.estimated_complexity === 'complex').length;
  const light = proposals.filter(p => p.estimated_complexity === 'trivial' || p.estimated_complexity === 'simple').length;
  if (heavy === 0) return 5;       // all light → go wide
  if (light === 0) return 2;       // all heavy → conservative
  const ratio = light / (light + heavy);
  return Math.max(2, Math.min(5, Math.round(2 + ratio * 3)));  // 2-5
}
