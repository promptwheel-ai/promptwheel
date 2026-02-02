/**
 * Spindle Loop Detection — Types and defaults
 */

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

  /** Max wall-clock minutes with no file changes or command successes before abort (default: 30, 0 = disabled) */
  maxStallMinutes: number;
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
  maxStallMinutes: 30,
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

  /** Timestamp (ms) of last meaningful progress (file change or command success) */
  lastProgressAt: number;
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
    lastProgressAt: Date.now(),
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
  reason?: 'oscillation' | 'spinning' | 'stalling' | 'repetition' | 'token_budget' | 'qa_ping_pong' | 'command_failure' | 'time_stall';

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
    minutesSinceProgress?: number;
    maxStallMinutes?: number;
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
