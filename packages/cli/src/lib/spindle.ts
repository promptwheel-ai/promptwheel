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

import { createHash } from 'node:crypto';

/**
 * Configuration for Spindle loop detection
 */
export interface SpindleConfig {
  /** Enable Spindle detection (default: true) */
  enabled: boolean;

  /** Similarity threshold for duplicate detection (0-1, default: 0.8) */
  similarityThreshold: number;

  /** Max consecutive similar outputs before abort (default: 3) */
  maxSimilarOutputs: number;

  /** Max iterations without file changes (default: 5) */
  maxStallIterations: number;

  /** Output/action ratio threshold (default: 10) - high = verbose without action */
  verbosityThreshold: number;

  /** Estimated token budget before warning (default: 100000) */
  tokenBudgetWarning: number;

  /** Estimated token budget before abort (default: 140000) */
  tokenBudgetAbort: number;

  /** Max times the same command signature can fail before blocking (default: 3) */
  maxCommandFailures: number;

  /** Max QA ping-pong cycles (A↔B alternating failures) before abort (default: 3) */
  maxQaPingPong: number;

  /** Max edits to the same file before warning (default: 3) */
  maxFileEdits: number;
}

/**
 * Default Spindle configuration
 */
export const DEFAULT_SPINDLE_CONFIG: SpindleConfig = {
  enabled: true,
  similarityThreshold: 0.8,
  maxSimilarOutputs: 3,
  maxStallIterations: 5,
  verbosityThreshold: 10,
  tokenBudgetWarning: 100000,
  tokenBudgetAbort: 140000,
  maxCommandFailures: 3,
  maxQaPingPong: 3,
  maxFileEdits: 3,
};

/**
 * Tracked state for Spindle detection across iterations
 */
export interface SpindleState {
  /** Recent agent outputs for similarity comparison */
  outputs: string[];

  /** Recent diffs for oscillation detection */
  diffs: string[];

  /** Count of iterations without meaningful file changes */
  iterationsSinceChange: number;

  /** Estimated total tokens consumed */
  estimatedTokens: number;

  /** Accumulated warnings */
  warnings: string[];

  /** Total characters of output (for verbosity ratio) */
  totalOutputChars: number;

  /** Total characters of actual changes (for verbosity ratio) */
  totalChangeChars: number;

  /** Rolling history of failing command signatures (hashed command+error) */
  failingCommandSignatures: string[];

  /** Per-file edit counts extracted from diffs */
  fileEditCounts: Record<string, number>;
}

/**
 * Create initial Spindle state
 */
export function createSpindleState(): SpindleState {
  return {
    outputs: [],
    diffs: [],
    iterationsSinceChange: 0,
    estimatedTokens: 0,
    warnings: [],
    totalOutputChars: 0,
    totalChangeChars: 0,
    failingCommandSignatures: [],
    fileEditCounts: {},
  };
}

/**
 * Result of Spindle loop check
 */
export interface SpindleResult {
  /** Whether the agent should be aborted */
  shouldAbort: boolean;

  /** Whether the ticket should be blocked (needs human intervention) instead of failed */
  shouldBlock: boolean;

  /** Reason for abort if shouldAbort is true */
  reason?: 'oscillation' | 'spinning' | 'stalling' | 'repetition' | 'token_budget' | 'qa_ping_pong' | 'command_failure';

  /** Confidence in the detection (0-1) */
  confidence: number;

  /** Diagnostic information for artifact */
  diagnostics: {
    similarityScore?: number;
    iterationsWithoutChange?: number;
    estimatedTokens?: number;
    repeatedPatterns?: string[];
    verbosityRatio?: number;
    oscillationPattern?: string;
    pingPongPattern?: string;
    commandSignature?: string;
    commandFailureThreshold?: number;
    fileEditWarnings?: string[];
  };
}

/**
 * Estimate token count from text
 * Rough approximation: ~4 characters per token for English text
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/**
 * Compute similarity between two strings using Jaccard index on word tokens
 *
 * @returns Similarity score from 0 (completely different) to 1 (identical)
 */
export function computeSimilarity(a: string, b: string): number {
  if (!a && !b) return 1;
  if (!a || !b) return 0;

  // Tokenize on whitespace and punctuation, lowercase
  const tokenize = (s: string): Set<string> => {
    const tokens = s
      .toLowerCase()
      .split(/[\s.,;:!?\-()[\]{}"']+/)
      .filter(t => t.length > 0);
    return new Set(tokens);
  };

  const tokensA = tokenize(a);
  const tokensB = tokenize(b);

  if (tokensA.size === 0 && tokensB.size === 0) return 1;
  if (tokensA.size === 0 || tokensB.size === 0) return 0;

  // Jaccard index: |intersection| / |union|
  let intersectionSize = 0;
  for (const token of tokensA) {
    if (tokensB.has(token)) {
      intersectionSize++;
    }
  }

  const unionSize = tokensA.size + tokensB.size - intersectionSize;
  return intersectionSize / unionSize;
}

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

/**
 * Detect repetition in agent outputs
 *
 * Looks for consecutive similar outputs that indicate the agent is stuck
 * in a loop saying the same things.
 */
export function detectRepetition(
  outputs: string[],
  latestOutput: string,
  config: SpindleConfig
): { detected: boolean; patterns: string[]; confidence: number } {
  const patterns: string[] = [];
  let maxSimilarity = 0;

  // Compare latest output with recent outputs
  for (const prevOutput of outputs.slice(-config.maxSimilarOutputs)) {
    const sim = computeSimilarity(latestOutput, prevOutput);
    if (sim >= config.similarityThreshold) {
      maxSimilarity = Math.max(maxSimilarity, sim);

      // Extract repeated phrases
      const phrases = findRepeatedPhrases(latestOutput, prevOutput);
      patterns.push(...phrases);
    }
  }

  // Check for common "stuck" phrases
  const stuckPhrases = [
    'let me try',
    'i apologize',
    "i'll try again",
    'let me attempt',
    'trying again',
    'one more time',
    'another approach',
  ];

  const lowerOutput = latestOutput.toLowerCase();
  for (const phrase of stuckPhrases) {
    if (lowerOutput.includes(phrase)) {
      const occurrences = outputs.filter(o =>
        o.toLowerCase().includes(phrase)
      ).length;
      if (occurrences >= 2) {
        patterns.push(`Repeated phrase: "${phrase}" (${occurrences + 1} times)`);
        // Set high similarity since stuck phrases are a strong signal
        maxSimilarity = Math.max(maxSimilarity, 0.85);
      }
    }
  }

  const detected = patterns.length > 0 && maxSimilarity >= config.similarityThreshold;
  return {
    detected,
    patterns: [...new Set(patterns)].slice(0, 5), // Dedupe and limit
    confidence: maxSimilarity,
  };
}

/**
 * Find repeated phrases between two texts
 */
function findRepeatedPhrases(a: string, b: string): string[] {
  const phrases: string[] = [];

  // Split into sentences/fragments
  const fragmentsA = a.split(/[.!?\n]+/).filter(f => f.trim().length > 20);
  const fragmentsB = b.split(/[.!?\n]+/).filter(f => f.trim().length > 20);

  for (const fragA of fragmentsA) {
    for (const fragB of fragmentsB) {
      const sim = computeSimilarity(fragA, fragB);
      if (sim >= 0.9) {
        phrases.push(fragA.trim().slice(0, 60) + '...');
      }
    }
  }

  return phrases;
}

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
    const MAX_FILE_EDIT_KEYS = 50;
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
  }

  // Check 1: Token budget
  if (state.estimatedTokens >= config.tokenBudgetAbort) {
    return {
      shouldAbort: true,
      shouldBlock: false,
      reason: 'token_budget',
      confidence: 1.0,
      diagnostics: {
        estimatedTokens: state.estimatedTokens,
      },
    };
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
    return {
      shouldAbort: true,
      shouldBlock: false,
      reason: 'stalling',
      confidence: 0.9,
      diagnostics: {
        iterationsWithoutChange: state.iterationsSinceChange,
      },
    };
  }

  // Check 3: Oscillation in diffs
  if (state.diffs.length >= 2) {
    const oscillation = detectOscillation(state.diffs, config.similarityThreshold);
    if (oscillation.detected) {
      return {
        shouldAbort: true,
        shouldBlock: false,
        reason: 'oscillation',
        confidence: oscillation.confidence,
        diagnostics: {
          oscillationPattern: oscillation.pattern,
        },
      };
    }
  }

  // Check 4: Repetition in outputs
  if (state.outputs.length >= 2) {
    const repetition = detectRepetition(state.outputs.slice(0, -1), latestOutput, config);
    if (repetition.detected) {
      return {
        shouldAbort: true,
        shouldBlock: false,
        reason: 'repetition',
        confidence: repetition.confidence,
        diagnostics: {
          repeatedPatterns: repetition.patterns,
          similarityScore: repetition.confidence,
        },
      };
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
      return {
        shouldAbort: true,
        shouldBlock: false,
        reason: 'qa_ping_pong',
        confidence: 0.9,
        diagnostics: { pingPongPattern: pp },
      };
    }
  }

  // Check 7: Command signature — same command fails N times → block (needs human)
  const cmdFail = detectCommandFailure(state.failingCommandSignatures, config.maxCommandFailures);
  if (cmdFail) {
    return {
      shouldAbort: false,
      shouldBlock: true,
      reason: 'command_failure',
      confidence: 0.8,
      diagnostics: { commandSignature: cmdFail, commandFailureThreshold: config.maxCommandFailures },
    };
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

// ---------------------------------------------------------------------------
// QA ping-pong detection
// ---------------------------------------------------------------------------

/** Detect alternating failure signatures: A→B→A→B pattern */
function detectQaPingPong(sigs: string[], cycles: number): string | null {
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

// ---------------------------------------------------------------------------
// Command signature failure detection
// ---------------------------------------------------------------------------

/** Detect same command failing N times */
function detectCommandFailure(sigs: string[], threshold: number): string | null {
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

// ---------------------------------------------------------------------------
// File edit frequency helpers
// ---------------------------------------------------------------------------

/** Extract file paths from a unified diff */
function extractFilesFromDiff(diff: string): string[] {
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

// ---------------------------------------------------------------------------
// Command failure recording
// ---------------------------------------------------------------------------

/** Short hash for command signature tracking */
function shortHash(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 12);
}

/** Record a failing command for spindle tracking */
export function recordCommandFailure(state: SpindleState, command: string, error: string): void {
  const sig = shortHash(`${command}::${error.slice(0, 200)}`);
  state.failingCommandSignatures.push(sig);
  if (state.failingCommandSignatures.length > 20) state.failingCommandSignatures.shift();
}

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

// Backwards-compatible aliases (deprecated — remove after next release)
/** @deprecated Use SpindleConfig */
export type RalphConfig = SpindleConfig;
/** @deprecated Use SpindleState */
export type RalphState = SpindleState;
/** @deprecated Use SpindleResult */
export type RalphResult = SpindleResult;
/** @deprecated Use DEFAULT_SPINDLE_CONFIG */
export const DEFAULT_RALPH_CONFIG = DEFAULT_SPINDLE_CONFIG;
/** @deprecated Use createSpindleState */
export const createRalphState = createSpindleState;
/** @deprecated Use checkSpindleLoop */
export const checkRalphLoop = checkSpindleLoop;
/** @deprecated Use formatSpindleResult */
export const formatRalphResult = formatSpindleResult;
