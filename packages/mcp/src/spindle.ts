/**
 * Spindle Loop Detection — MCP server adaptation.
 *
 * Monitors agent execution for unproductive patterns:
 * - Oscillation: diffs flip-flopping (A→B→A)
 * - Repetition: similar outputs repeated
 * - Stalling: no file changes for N iterations
 * - QA ping-pong: alternating test/lint failures
 * - Command signature: same command fails repeatedly
 *
 * Ported from packages/cli/src/lib/spindle.ts, adapted for the
 * event-driven MCP architecture.
 */

import type { SpindleState } from './types.js';
import {
  shortHash,
  detectQaPingPong,
  detectCommandFailure,
  extractFilesFromDiff,
  getFileEditWarnings as _getFileEditWarnings,
} from '@promptwheel/core/spindle/shared';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface SpindleConfig {
  similarityThreshold: number;
  maxSimilarOutputs: number;
  maxStallIterations: number;
  maxCommandFailures: number;
  maxQaPingPong: number;
  maxFileEdits: number;
}

export const DEFAULT_SPINDLE_CONFIG: SpindleConfig = {
  similarityThreshold: 0.8,
  maxSimilarOutputs: 3,
  maxStallIterations: 5,
  maxCommandFailures: 3,
  maxQaPingPong: 3,
  maxFileEdits: 3,
};

// ---------------------------------------------------------------------------
// Check result
// ---------------------------------------------------------------------------

export type SpindleReason =
  | 'oscillation'
  | 'repetition'
  | 'stalling'
  | 'qa_ping_pong'
  | 'command_failure';

export interface SpindleCheckResult {
  shouldAbort: boolean;
  shouldBlock: boolean; // BLOCKED_NEEDS_HUMAN instead of FAILED_SPINDLE
  reason?: SpindleReason;
  confidence: number;
  diagnostics: Record<string, unknown>;
  risk: 'none' | 'low' | 'medium' | 'high';
}

const PASS: SpindleCheckResult = {
  shouldAbort: false,
  shouldBlock: false,
  confidence: 0,
  diagnostics: {},
  risk: 'none',
};

// ---------------------------------------------------------------------------
// Core check — runs on every advance()
// ---------------------------------------------------------------------------

export function checkSpindle(
  spindle: SpindleState,
  config: SpindleConfig = DEFAULT_SPINDLE_CONFIG,
): SpindleCheckResult {
  // 1. Stalling — no file changes
  if (spindle.iterations_since_change >= config.maxStallIterations) {
    return {
      shouldAbort: true,
      shouldBlock: false,
      reason: 'stalling',
      confidence: 0.9,
      diagnostics: {
        iterations_without_change: spindle.iterations_since_change,
        threshold: config.maxStallIterations,
      },
      risk: 'high',
    };
  }

  // 2. Oscillation — diff flip-flops
  if (spindle.diff_hashes.length >= 3) {
    const osc = detectOscillation(spindle.diff_hashes);
    if (osc) {
      return {
        shouldAbort: true,
        shouldBlock: false,
        reason: 'oscillation',
        confidence: 0.95,
        diagnostics: { pattern: osc },
        risk: 'high',
      };
    }
  }

  // 3. Repetition — similar output hashes
  if (spindle.output_hashes.length >= config.maxSimilarOutputs) {
    const rep = detectRepetition(spindle.output_hashes, config.maxSimilarOutputs);
    if (rep) {
      return {
        shouldAbort: true,
        shouldBlock: false,
        reason: 'repetition',
        confidence: 0.85,
        diagnostics: { repeated_hash: rep, count: config.maxSimilarOutputs },
        risk: 'high',
      };
    }
  }

  // 4. QA ping-pong — alternating failure types
  if (spindle.failing_command_signatures.length >= config.maxQaPingPong * 2) {
    const pp = detectQaPingPong(spindle.failing_command_signatures, config.maxQaPingPong);
    if (pp) {
      return {
        shouldAbort: true,
        shouldBlock: false,
        reason: 'qa_ping_pong',
        confidence: 0.9,
        diagnostics: { pattern: pp },
        risk: 'high',
      };
    }
  }

  // 5. Command signature — same command fails N times
  const cmdFail = detectCommandFailure(spindle.failing_command_signatures, config.maxCommandFailures);
  if (cmdFail) {
    return {
      shouldAbort: false,
      shouldBlock: true, // → BLOCKED_NEEDS_HUMAN
      reason: 'command_failure',
      confidence: 0.8,
      diagnostics: { command: cmdFail, threshold: config.maxCommandFailures },
      risk: 'high',
    };
  }

  // Compute risk level
  const risk = computeRisk(spindle, config);

  return { ...PASS, risk };
}

// ---------------------------------------------------------------------------
// State update helpers — called from event processor
// ---------------------------------------------------------------------------

export function recordOutput(spindle: SpindleState, output: string): void {
  const hash = shortHash(output);
  spindle.output_hashes.push(hash);
  if (spindle.output_hashes.length > 10) spindle.output_hashes.shift();
  spindle.total_output_chars += output.length;
}

export function recordDiff(spindle: SpindleState, diff: string | null): void {
  if (!diff || diff.trim() === '') {
    spindle.iterations_since_change++;
    return;
  }

  spindle.iterations_since_change = 0;
  const hash = shortHash(diff);
  spindle.diff_hashes.push(hash);
  if (spindle.diff_hashes.length > 10) spindle.diff_hashes.shift();
  spindle.total_change_chars += diff.length;

  // Track per-file edit frequency
  const files = extractFilesFromDiff(diff);
  for (const f of files) {
    const existing = spindle.file_edit_counts?.[f] ?? 0;
    if (!spindle.file_edit_counts) spindle.file_edit_counts = {};
    spindle.file_edit_counts[f] = existing + 1;
  }

  // Cap file_edit_counts keys to prevent unbounded growth
  const MAX_FILE_EDIT_KEYS = 50;
  if (spindle.file_edit_counts && Object.keys(spindle.file_edit_counts).length > MAX_FILE_EDIT_KEYS) {
    const sorted = Object.entries(spindle.file_edit_counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_FILE_EDIT_KEYS);
    spindle.file_edit_counts = Object.fromEntries(sorted);
  }
}

export function recordCommandFailure(spindle: SpindleState, command: string, error: string): void {
  const sig = shortHash(`${command}::${error.slice(0, 200)}`);
  spindle.failing_command_signatures.push(sig);
  if (spindle.failing_command_signatures.length > 20) spindle.failing_command_signatures.shift();
}

export function recordPlanHash(spindle: SpindleState, plan: unknown): void {
  const hash = shortHash(JSON.stringify(plan));
  spindle.plan_hashes.push(hash);
  if (spindle.plan_hashes.length > 10) spindle.plan_hashes.shift();
}

export function recordTicketResult(spindle: SpindleState, changedFiles: string[], diff: string | null): void {
  recordDiff(spindle, diff);
}

// ---------------------------------------------------------------------------
// Detection functions
// ---------------------------------------------------------------------------

/** Detect A→B→A hash oscillation */
function detectOscillation(hashes: string[]): string | null {
  // Check for A→B→A pattern in last 3
  const recent = hashes.slice(-3);
  if (recent.length === 3 && recent[0] === recent[2] && recent[0] !== recent[1]) {
    return `Hash ${recent[0]} appeared at positions -3 and -1 (flip-flop)`;
  }

  // Check for any hash appearing in alternating positions
  for (let i = hashes.length - 1; i >= 2; i--) {
    if (hashes[i] === hashes[i - 2] && hashes[i] !== hashes[i - 1]) {
      return `Hash ${hashes[i]} oscillating at positions ${i - 2}, ${i}`;
    }
  }

  return null;
}

/** Detect N consecutive identical output hashes */
function detectRepetition(hashes: string[], threshold: number): string | null {
  if (hashes.length < threshold) return null;

  const recent = hashes.slice(-threshold);
  const first = recent[0];
  if (recent.every(h => h === first)) {
    return first;
  }

  return null;
}


// ---------------------------------------------------------------------------
// Risk computation
// ---------------------------------------------------------------------------

function computeRisk(
  spindle: SpindleState,
  config: SpindleConfig,
): 'none' | 'low' | 'medium' | 'high' {
  let score = 0;

  // Stall proximity
  if (spindle.iterations_since_change >= config.maxStallIterations * 0.6) score += 2;
  else if (spindle.iterations_since_change >= 2) score += 1;

  // Repeated outputs
  const recentOutputs = spindle.output_hashes.slice(-3);
  if (recentOutputs.length >= 2 && recentOutputs[recentOutputs.length - 1] === recentOutputs[recentOutputs.length - 2]) {
    score += 1;
  }

  // File edit frequency warnings
  if (spindle.file_edit_counts) {
    for (const count of Object.values(spindle.file_edit_counts)) {
      if (count >= config.maxFileEdits) score += 2;
    }
  }

  // Command failures
  if (spindle.failing_command_signatures.length >= 2) score += 1;

  if (score >= 4) return 'high';
  if (score >= 2) return 'medium';
  if (score >= 1) return 'low';
  return 'none';
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Get file edit frequency warnings — wraps shared function, handles optional field */
export function getFileEditWarnings(spindle: SpindleState, threshold: number = 3): string[] {
  if (!spindle.file_edit_counts) return [];
  return _getFileEditWarnings(spindle.file_edit_counts, threshold);
}
