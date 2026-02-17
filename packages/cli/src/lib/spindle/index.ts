/**
 * Spindle Loop Detection
 *
 * Monitors agent execution for unproductive patterns:
 * - Oscillation: Similar diffs being applied and reverted
 * - Spinning: High tool call rate without progress
 * - Stalling: Verbose output without meaningful changes
 * - Repetition: Same errors or phrases repeated
 *
 * Named "Spindle" after the spinning wheel component — when the spindle
 * jams, it spins without producing thread.
 */

export type { SpindleConfig, SpindleState, SpindleResult } from './types.js';
export { DEFAULT_SPINDLE_CONFIG, createSpindleState, estimateTokens } from './types.js';
export { computeSimilarity } from './similarity.js';
export { detectOscillation } from './oscillation.js';
export { detectRepetition } from './repetition.js';
export { detectQaPingPong, detectCommandFailure, recordCommandFailure, shortHash, extractFilesFromDiff, getFileEditWarnings } from './failure-patterns.js';
export { formatSpindleResult } from './format.js';

import type { SpindleConfig, SpindleState, SpindleResult } from './types.js';
import { estimateTokens } from './types.js';
import { detectOscillation } from './oscillation.js';
import { detectRepetition } from './repetition.js';
import { detectQaPingPong, detectCommandFailure, extractFilesFromDiff, getFileEditWarnings } from './failure-patterns.js';
import { metric } from '../metrics.js';

/**
 * Check if agent is in a Spindle loop
 *
 * Updates state in-place and returns detection result.
 *
 * @param state - Current Spindle state (will be mutated)
 * @param latestOutput - Agent's latest output text
 * @param latestDiff - Latest git diff (null if no changes)
 * @param config - Spindle configuration
 * @returns Detection result
 */
export function checkSpindleLoop(
  state: SpindleState,
  latestOutput: string,
  latestDiff: string | null,
  config: SpindleConfig
): SpindleResult {
  // If disabled, always pass
  if (!config.enabled) {
    return { shouldAbort: false, shouldBlock: false, confidence: 0, diagnostics: {} };
  }

  // Update state with latest data
  const outputTokens = estimateTokens(latestOutput);
  const diffTokens = estimateTokens(latestDiff ?? '');

  state.estimatedTokens += outputTokens + diffTokens;
  state.totalOutputChars += latestOutput.length;
  state.totalChangeChars += (latestDiff ?? '').length;

  // Store for pattern detection (keep last N)
  state.outputs.push(latestOutput);
  if (state.outputs.length > config.maxSimilarOutputs + 1) {
    state.outputs.shift();
  }

  if (latestDiff) {
    state.diffs.push(latestDiff);
    if (state.diffs.length > 5) {
      state.diffs.shift();
    }

    // Track per-file edit frequency
    const editedFiles = extractFilesFromDiff(latestDiff);
    for (const f of editedFiles) {
      state.fileEditCounts[f] = (state.fileEditCounts[f] ?? 0) + 1;
    }
    // Cap file_edit_counts keys to prevent unbounded growth
    const MAX_FILE_EDIT_KEYS = 200;
    const editKeys = Object.keys(state.fileEditCounts);
    if (editKeys.length > MAX_FILE_EDIT_KEYS) {
      const sorted = Object.entries(state.fileEditCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, MAX_FILE_EDIT_KEYS);
      state.fileEditCounts = Object.fromEntries(sorted);
    }
  }

  // Track iterations without changes
  if (!latestDiff || latestDiff.trim() === '') {
    state.iterationsSinceChange++;
  } else {
    state.iterationsSinceChange = 0;
    state.lastProgressAt = Date.now();
  }

  // Check 1: Token budget
  if (state.estimatedTokens >= config.tokenBudgetAbort) {
    return triggerSpindle({
      shouldAbort: true,
      shouldBlock: false,
      reason: 'token_budget',
      confidence: 1.0,
      diagnostics: {
        estimatedTokens: state.estimatedTokens,
      },
    });
  }

  // Token budget warning (don't abort, just warn)
  if (state.estimatedTokens >= config.tokenBudgetWarning) {
    const warning = `Approaching token budget: ~${state.estimatedTokens} tokens`;
    if (!state.warnings.includes(warning)) {
      state.warnings.push(warning);
    }
  }

  // Check 2: Stalling (no changes for too many iterations)
  if (state.iterationsSinceChange >= config.maxStallIterations) {
    return triggerSpindle({
      shouldAbort: true,
      shouldBlock: false,
      reason: 'stalling',
      confidence: 0.9,
      diagnostics: {
        iterationsWithoutChange: state.iterationsSinceChange,
      },
    });
  }

  // Check 2b: Time-based stall (wall-clock)
  if (config.maxStallMinutes > 0) {
    const minutesSinceProgress = (Date.now() - state.lastProgressAt) / 60_000;
    if (minutesSinceProgress >= config.maxStallMinutes) {
      return triggerSpindle({
        shouldAbort: true,
        shouldBlock: false,
        reason: 'time_stall',
        confidence: 0.95,
        diagnostics: {
          minutesSinceProgress: Math.round(minutesSinceProgress),
          maxStallMinutes: config.maxStallMinutes,
        },
      });
    }
  }

  // Check 3: Oscillation in diffs
  if (state.diffs.length >= 2) {
    const oscillation = detectOscillation(state.diffs, config.similarityThreshold);
    if (oscillation.detected) {
      return triggerSpindle({
        shouldAbort: true,
        shouldBlock: false,
        reason: 'oscillation',
        confidence: oscillation.confidence,
        diagnostics: {
          oscillationPattern: oscillation.pattern,
        },
      });
    }
  }

  // Check 4: Repetition in outputs
  if (state.outputs.length >= 2) {
    const repetition = detectRepetition(state.outputs.slice(0, -1), latestOutput, config);
    if (repetition.detected) {
      return triggerSpindle({
        shouldAbort: true,
        shouldBlock: false,
        reason: 'repetition',
        confidence: repetition.confidence,
        diagnostics: {
          repeatedPatterns: repetition.patterns,
          similarityScore: repetition.confidence,
        },
      });
    }
  }

  // Check 5: Verbosity ratio (lots of output, few changes)
  if (state.totalOutputChars > 5000 && state.totalChangeChars > 0) {
    const verbosityRatio = state.totalOutputChars / state.totalChangeChars;
    if (verbosityRatio >= config.verbosityThreshold) {
      // Only warn, don't abort on verbosity alone
      const warning = `High verbosity ratio: ${verbosityRatio.toFixed(1)}x output vs changes`;
      if (!state.warnings.includes(warning)) {
        state.warnings.push(warning);
      }
    }
  }

  // Check 6: QA ping-pong — alternating failure signatures
  if (state.failingCommandSignatures.length >= config.maxQaPingPong * 2) {
    const pp = detectQaPingPong(state.failingCommandSignatures, config.maxQaPingPong);
    if (pp) {
      return triggerSpindle({
        shouldAbort: true,
        shouldBlock: false,
        reason: 'qa_ping_pong',
        confidence: 0.9,
        diagnostics: { pingPongPattern: pp },
      });
    }
  }

  // Check 7: Command signature — same command fails N times → block (needs human)
  const cmdFail = detectCommandFailure(state.failingCommandSignatures, config.maxCommandFailures);
  if (cmdFail) {
    return triggerSpindle({
      shouldAbort: false,
      shouldBlock: true,
      reason: 'command_failure',
      confidence: 0.8,
      diagnostics: { commandSignature: cmdFail, commandFailureThreshold: config.maxCommandFailures },
    });
  }

  // Check 8: File edit frequency warnings
  const fileWarnings = getFileEditWarnings(state, config.maxFileEdits);
  if (fileWarnings.length > 0) {
    for (const w of fileWarnings) {
      const warning = `File churn: ${w}`;
      if (!state.warnings.includes(warning)) {
        state.warnings.push(warning);
      }
    }
  }

  // No issues detected
  // Instrument: track spindle check (no trigger)
  metric('spindle', 'check_passed', {
    tokens: state.estimatedTokens,
    iterations: state.iterationsSinceChange,
  });

  return {
    shouldAbort: false,
    shouldBlock: false,
    confidence: 0,
    diagnostics: {
      estimatedTokens: state.estimatedTokens,
      iterationsWithoutChange: state.iterationsSinceChange,
      ...(fileWarnings.length > 0 ? { fileEditWarnings: fileWarnings } : {}),
    },
  };
}

/**
 * Helper to record spindle trigger and return result
 */
function triggerSpindle(result: SpindleResult): SpindleResult {
  metric('spindle', 'triggered', {
    reason: result.reason,
    shouldAbort: result.shouldAbort,
    shouldBlock: result.shouldBlock,
    confidence: result.confidence,
  });
  return result;
}

