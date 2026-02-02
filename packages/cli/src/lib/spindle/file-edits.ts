/**
 * Spindle — File edit frequency helpers
 */

import type { SpindleState } from './types.js';

/** Extract file paths from a unified diff */
export function extractFilesFromDiff(diff: string): string[] {
  const files: string[] = [];
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ b/')) {
      files.push(line.slice(6));
    }
  }
  return files;
}

/** Get file edit frequency warnings */
export function getFileEditWarnings(state: SpindleState, threshold: number = 3): string[] {
  const warnings: string[] = [];
  for (const [file, count] of Object.entries(state.fileEditCounts)) {
    if (count >= threshold) {
      warnings.push(`${file} edited ${count} times`);
    }
  }
  return warnings;
}
