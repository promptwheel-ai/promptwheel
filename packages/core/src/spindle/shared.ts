/**
 * Shared Spindle detection functions used by both CLI and MCP spindle.
 */

import { createHash } from 'node:crypto';

/** Short hash for signature tracking */
export function shortHash(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 12);
}

/** Detect alternating failure signatures: A→B→A→B pattern */
export function detectQaPingPong(sigs: string[], cycles: number): string | null {
  if (sigs.length < cycles * 2) return null;

  const recent = sigs.slice(-(cycles * 2));
  const a = recent[0];
  const b = recent[1];
  if (a === b) return null;

  let alternating = true;
  for (let i = 0; i < recent.length; i++) {
    const expected = i % 2 === 0 ? a : b;
    if (recent[i] !== expected) {
      alternating = false;
      break;
    }
  }

  if (alternating) {
    return `Alternating failures: ${a} ↔ ${b} (${cycles} cycles)`;
  }

  return null;
}

/** Detect same command failing N times */
export function detectCommandFailure(sigs: string[], threshold: number): string | null {
  if (sigs.length < threshold) return null;

  const counts = new Map<string, number>();
  for (const sig of sigs) {
    counts.set(sig, (counts.get(sig) ?? 0) + 1);
  }

  for (const [sig, count] of counts) {
    if (count >= threshold) return sig;
  }

  return null;
}

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

/** Get file edit frequency warnings (state-shape-agnostic) */
export function getFileEditWarnings(counts: Record<string, number>, threshold: number = 3): string[] {
  const warnings: string[] = [];
  for (const [file, count] of Object.entries(counts)) {
    if (count >= threshold) {
      warnings.push(`${file} edited ${count} times`);
    }
  }
  return warnings;
}
