/**
 * Spindle — Command failure detection and recording
 */

import { createHash } from 'node:crypto';
import type { SpindleState } from './types.js';

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

/** Short hash for command signature tracking */
export function shortHash(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 12);
}

/** Record a failing command for spindle tracking */
export function recordCommandFailure(state: SpindleState, command: string, error: string): void {
  const sig = shortHash(`${command}::${error.slice(0, 200)}`);
  state.failingCommandSignatures.push(sig);
  if (state.failingCommandSignatures.length > 20) state.failingCommandSignatures.shift();
}
