/**
 * Wave scheduling utilities for conflict-free parallel execution.
 */

import { pathsOverlap, directoriesOverlap } from './solo-utils.js';
import type { CodebaseIndex } from './codebase-index.js';
import type { SectorState } from './sectors.js';

/**
 * Partition proposals into conflict-free waves.
 * Proposals with overlapping file paths go into separate waves
 * so they run sequentially, avoiding merge conflicts.
 */
export function partitionIntoWaves<T extends { files: string[]; category?: string }>(proposals: T[]): T[][] {
  const waves: T[][] = [];

  for (const proposal of proposals) {
    let placed = false;
    for (const wave of waves) {
      const conflicts = wave.some(existing => {
        // Direct file path overlap
        if (existing.files.some(fA =>
          proposal.files.some(fB => pathsOverlap(fA, fB))
        )) return true;
        // Semantic: same category + overlapping directories
        if (existing.category && proposal.category
            && existing.category === proposal.category
            && directoriesOverlap(existing.files, proposal.files)) return true;
        return false;
      });
      if (!conflicts) {
        wave.push(proposal);
        placed = true;
        break;
      }
    }
    if (!placed) {
      waves.push([proposal]);
    }
  }

  return waves;
}

/**
 * Build escalation prompt text for scout retries.
 * Suggests unexplored modules and fresh angles when previous attempts found nothing.
 */
export function buildScoutEscalation(
  retryCount: number,
  scoutedDirs: string[],
  codebaseIndex: CodebaseIndex | null,
  sectorState?: SectorState,
): string {
  const parts = [
    '## Previous Attempts Found Nothing — Fresh Approach Required',
    '',
  ];

  if (scoutedDirs.length > 0) {
    parts.push('### What Was Already Tried');
    for (const dir of scoutedDirs) {
      parts.push(`- Scouted \`${dir}\``);
    }
    parts.push('');
  }

  // Suggest unexplored modules from codebase index
  const exploredSet = new Set(scoutedDirs.map(d => d.replace(/\/$/, '')));
  const unexplored: string[] = [];
  if (codebaseIndex) {
    for (const mod of codebaseIndex.modules) {
      if (!exploredSet.has(mod.path) && !exploredSet.has(mod.path + '/')) {
        unexplored.push(mod.path);
      }
    }
  }

  // Sort unexplored by sector history when available
  if (sectorState && unexplored.length > 0) {
    const sectorByPath = new Map(sectorState.sectors.map(s => [s.path, s]));
    unexplored.sort((a, b) => {
      const sa = sectorByPath.get(a);
      const sb = sectorByPath.get(b);
      // Fewer scans first
      const scanA = sa?.scanCount ?? 0;
      const scanB = sb?.scanCount ?? 0;
      if (scanA !== scanB) return scanA - scanB;
      // Higher yield first
      const yieldA = sa?.proposalYield ?? 0;
      const yieldB = sb?.proposalYield ?? 0;
      return yieldB - yieldA;
    });
  }

  parts.push('### What to Do Differently');
  parts.push('');
  parts.push('Knowing everything from the attempts above, take a completely different angle:');
  parts.push('- Do NOT re-read the directories listed above.');
  if (unexplored.length > 0) {
    parts.push(`- Try unexplored areas: ${unexplored.slice(0, 8).map(d => `\`${d}\``).join(', ')}`);
  }
  parts.push('- Switch categories: if you looked for bugs, look for tests. If tests, try security.');
  parts.push('- Read at least 15 NEW source files.');
  parts.push('- If genuinely nothing to improve, explain your analysis across all attempts.');

  return parts.join('\n');
}
