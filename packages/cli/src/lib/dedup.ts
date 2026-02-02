/**
 * Deduplication utilities for proposal filtering.
 */

import { spawnSync } from 'node:child_process';
import type { DatabaseAdapter } from '@blockspool/core/db';
import { tickets } from '@blockspool/core/repos';
import type { TicketProposal } from '@blockspool/core/scout';

/**
 * Sleep helper
 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Normalize a title for comparison (lowercase, remove punctuation, collapse whitespace)
 */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Calculate simple word overlap similarity between two titles (0-1)
 */
export function titleSimilarity(a: string, b: string): number {
  const wordsA = new Set(normalizeTitle(a).split(' ').filter(w => w.length > 2));
  const wordsB = new Set(normalizeTitle(b).split(' ').filter(w => w.length > 2));

  if (wordsA.size === 0 || wordsB.size === 0) return 0;

  let overlap = 0;
  for (const word of wordsA) {
    if (wordsB.has(word)) overlap++;
  }

  const union = new Set([...wordsA, ...wordsB]).size;
  return overlap / union;
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
    const branchTitle = branch.replace(/^blockspool\/tkt_[a-z0-9]+$/, '').replace(/-/g, ' ');
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
    const result = spawnSync('git', ['branch', '-r', '--list', 'origin/blockspool/*'], {
      cwd: repoRoot,
      encoding: 'utf-8',
    });
    if (result.stdout) {
      openPrBranches = result.stdout
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
