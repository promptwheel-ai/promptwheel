/**
 * Spindle — Failure pattern detectors (command failures, QA ping-pong, file edits)
 *
 * Merged from command-failure.ts, qa-ping-pong.ts, and file-edits.ts.
 * Core detection algorithms live in @promptwheel/core; this module
 * re-exports them and adds CLI-specific state helpers.
 */

import type { SpindleState } from './types.js';
import {
  shortHash,
  detectQaPingPong,
  detectCommandFailure,
  extractFilesFromDiff,
  getFileEditWarnings as _getFileEditWarnings,
} from '@promptwheel/core/spindle/shared';

// Re-export shared detectors for consumers
export { shortHash, detectQaPingPong, detectCommandFailure, extractFilesFromDiff };

/** Get file edit frequency warnings from CLI SpindleState */
export function getFileEditWarnings(state: SpindleState, threshold: number = 3): string[] {
  return _getFileEditWarnings(state.fileEditCounts, threshold);
}

/** Record a failing command for spindle tracking */
export function recordCommandFailure(state: SpindleState, command: string, error: string): void {
  const sig = shortHash(`${command}::${error.slice(0, 200)}`);
  state.failingCommandSignatures.push(sig);
  if (state.failingCommandSignatures.length > 20) state.failingCommandSignatures.shift();
}
