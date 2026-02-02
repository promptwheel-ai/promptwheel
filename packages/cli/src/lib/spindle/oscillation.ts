/**
 * Spindle — Oscillation detection
 */

import { computeSimilarity } from './similarity.js';

/**
 * Extract added and removed lines from a unified diff
 */
function extractDiffLines(diff: string): { added: string[]; removed: string[] } {
  const lines = diff.split('\n');
  const added: string[] = [];
  const removed: string[] = [];

  for (const line of lines) {
    // Skip diff headers
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@')) {
      continue;
    }
    if (line.startsWith('+')) {
      added.push(line.slice(1).trim());
    } else if (line.startsWith('-')) {
      removed.push(line.slice(1).trim());
    }
  }

  return { added, removed };
}

/**
 * Detect oscillation pattern in diffs
 *
 * Looks for add→remove→add or remove→add→remove patterns where similar
 * content is being repeatedly changed back and forth.
 *
 * @returns Object with detected flag and pattern description
 */
export function detectOscillation(
  diffs: string[],
  similarityThreshold: number = 0.8
): { detected: boolean; pattern?: string; confidence: number } {
  if (diffs.length < 2) {
    return { detected: false, confidence: 0 };
  }

  // Analyze last 3 diffs (or 2 if only 2 available)
  const recentDiffs = diffs.slice(-3);
  const patterns = recentDiffs.map(d => extractDiffLines(d));

  // With 2 diffs: check if what was added is now removed (or vice versa)
  if (patterns.length >= 2) {
    const [prev, curr] = patterns.slice(-2);

    // Check: lines added in prev are now removed in curr
    for (const addedLine of prev.added) {
      if (addedLine.length < 3) continue; // Skip trivial lines
      for (const removedLine of curr.removed) {
        const sim = computeSimilarity(addedLine, removedLine);
        if (sim >= similarityThreshold) {
          return {
            detected: true,
            pattern: `Added then removed: "${addedLine.slice(0, 50)}..."`,
            confidence: sim,
          };
        }
      }
    }

    // Check: lines removed in prev are now added in curr
    for (const removedLine of prev.removed) {
      if (removedLine.length < 3) continue;
      for (const addedLine of curr.added) {
        const sim = computeSimilarity(removedLine, addedLine);
        if (sim >= similarityThreshold) {
          return {
            detected: true,
            pattern: `Removed then re-added: "${removedLine.slice(0, 50)}..."`,
            confidence: sim,
          };
        }
      }
    }
  }

  // With 3 diffs: check for A→B→A pattern
  if (patterns.length === 3) {
    const [first, , third] = patterns;

    // Check if first additions match third additions (came back to same state)
    for (const line1 of first.added) {
      if (line1.length < 3) continue;
      for (const line3 of third.added) {
        const sim = computeSimilarity(line1, line3);
        if (sim >= similarityThreshold) {
          return {
            detected: true,
            pattern: `Oscillating: same content added in iterations 1 and 3`,
            confidence: sim,
          };
        }
      }
    }
  }

  return { detected: false, confidence: 0 };
}
