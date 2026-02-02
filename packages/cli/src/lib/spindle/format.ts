/**
 * Spindle — Result formatting
 */

import type { SpindleResult } from './types.js';

/**
 * Format Spindle result for display
 */
export function formatSpindleResult(result: SpindleResult): string {
  if (!result.shouldAbort && !result.shouldBlock) {
    return 'No spindle loop detected';
  }

  const label = result.shouldBlock ? 'Spindle blocked (needs human)' : 'Spindle loop detected';
  const parts = [`${label}: ${result.reason}`];
  parts.push(`Confidence: ${(result.confidence * 100).toFixed(0)}%`);

  if (result.diagnostics.estimatedTokens) {
    parts.push(`Tokens: ~${result.diagnostics.estimatedTokens}`);
  }
  if (result.diagnostics.iterationsWithoutChange) {
    parts.push(`Iterations without change: ${result.diagnostics.iterationsWithoutChange}`);
  }
  if (result.diagnostics.oscillationPattern) {
    parts.push(`Pattern: ${result.diagnostics.oscillationPattern}`);
  }
  if (result.diagnostics.repeatedPatterns?.length) {
    parts.push(`Repeated: ${result.diagnostics.repeatedPatterns.join(', ')}`);
  }
  if (result.diagnostics.pingPongPattern) {
    parts.push(`Pattern: ${result.diagnostics.pingPongPattern}`);
  }
  if (result.diagnostics.commandSignature) {
    parts.push(`Command signature: ${result.diagnostics.commandSignature}`);
  }
  if (result.diagnostics.fileEditWarnings?.length) {
    parts.push(`File churn: ${result.diagnostics.fileEditWarnings.join(', ')}`);
  }

  return parts.join('\n');
}
