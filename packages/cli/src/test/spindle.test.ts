/**
 * Tests for Spindle loop detection
 */

import { describe, it, expect } from 'vitest';
import {
  computeSimilarity,
  estimateTokens,
  detectOscillation,
  detectRepetition,
  checkSpindleLoop,
  createSpindleState,
  formatSpindleResult,
  recordCommandFailure,
  getFileEditWarnings,
  DEFAULT_SPINDLE_CONFIG,
  type SpindleConfig,
  type SpindleState,
} from '../lib/spindle/index.js';
import { findRepeatedPhrases } from '../lib/spindle/similarity.js';

describe('estimateTokens', () => {
  it('estimates tokens from text length', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('test')).toBe(1); // 4 chars = 1 token
    expect(estimateTokens('hello world')).toBe(3); // 11 chars = ~3 tokens
    expect(estimateTokens('a'.repeat(100))).toBe(25); // 100 chars = 25 tokens
  });

  it('handles null/undefined gracefully', () => {
    expect(estimateTokens(null as unknown as string)).toBe(0);
    expect(estimateTokens(undefined as unknown as string)).toBe(0);
  });
});

describe('computeSimilarity', () => {
  it('returns 1 for identical strings', () => {
    expect(computeSimilarity('hello world', 'hello world')).toBe(1);
  });

  it('returns 0 for completely different strings', () => {
    expect(computeSimilarity('hello world', 'foo bar baz')).toBe(0);
  });

  it('returns partial similarity for overlapping content', () => {
    const sim = computeSimilarity('the quick brown fox', 'the slow brown dog');
    expect(sim).toBeGreaterThan(0.3);
    expect(sim).toBeLessThan(0.7);
  });

  it('is case-insensitive', () => {
    expect(computeSimilarity('Hello World', 'hello world')).toBe(1);
  });

  it('handles empty strings', () => {
    expect(computeSimilarity('', '')).toBe(1);
    expect(computeSimilarity('hello', '')).toBe(0);
    expect(computeSimilarity('', 'world')).toBe(0);
  });

  it('ignores punctuation', () => {
    expect(computeSimilarity('hello, world!', 'hello world')).toBe(1);
  });
});

describe('detectOscillation', () => {
  it('returns false for empty or single diff', () => {
    expect(detectOscillation([]).detected).toBe(false);
    expect(detectOscillation(['+line added']).detected).toBe(false);
  });

  it('detects add then remove pattern', () => {
    const diffs = [
      '+const foo = "bar";',
      '-const foo = "bar";',
    ];
    const result = detectOscillation(diffs);
    expect(result.detected).toBe(true);
    expect(result.confidence).toBeGreaterThan(0.8);
  });

  it('detects remove then add pattern', () => {
    const diffs = [
      '-const x = 1;',
      '+const x = 1;',
    ];
    const result = detectOscillation(diffs);
    expect(result.detected).toBe(true);
  });

  it('detects oscillation across three diffs', () => {
    const diffs = [
      '+export function helper() { return true; }',
      '-export function helper() { return true; }',
      '+export function helper() { return true; }',
    ];
    const result = detectOscillation(diffs);
    expect(result.detected).toBe(true);
    // Pattern can be "Oscillating" or "Removed then re-added" depending on detection path
    expect(result.pattern).toBeDefined();
  });

  it('does not flag unrelated changes', () => {
    const diffs = [
      '+const a = 1;',
      '+const b = 2;',
      '+const c = 3;',
    ];
    const result = detectOscillation(diffs);
    expect(result.detected).toBe(false);
  });

  it('ignores trivial lines', () => {
    const diffs = [
      '+}',
      '-}',
    ];
    const result = detectOscillation(diffs);
    expect(result.detected).toBe(false);
  });
});

describe('detectRepetition', () => {
  const config = DEFAULT_SPINDLE_CONFIG;

  it('detects similar consecutive outputs', () => {
    const outputs = [
      'Let me try a different approach to solve this problem.',
      'Let me try a different approach to solve this problem.',
    ];
    const result = detectRepetition(
      outputs.slice(0, -1),
      outputs[outputs.length - 1],
      config
    );
    expect(result.detected).toBe(true);
    expect(result.confidence).toBeGreaterThan(0.9);
  });

  it('detects stuck phrases', () => {
    // Need 3+ occurrences of "i apologize" to trigger stuck phrase detection
    const outputs = [
      'I apologize for the confusion. Let me fix this.',
      'I apologize for the error. Let me correct this.',
      'I apologize for the mistake. Let me try again.',
    ];
    const result = detectRepetition(
      outputs.slice(0, -1),
      outputs[outputs.length - 1],
      config
    );
    expect(result.detected).toBe(true);
    expect(result.patterns.some(p => p.toLowerCase().includes('apologize'))).toBe(true);
  });

  it('detects "let me try" repetition', () => {
    // Need 3+ occurrences to trigger stuck phrase detection
    const outputs = [
      'Let me try to implement this feature.',
      'That did not work. Let me try again with a different approach.',
      'Still not right. Let me try a third approach.',
      'Almost there. Let me try one more time.',
    ];
    const latest = outputs[outputs.length - 1];
    const result = detectRepetition(outputs.slice(0, -1), latest, config);
    expect(result.detected).toBe(true);
    expect(result.patterns.some(p => p.includes('let me try'))).toBe(true);
  });

  it('allows different outputs without flagging', () => {
    const outputs = [
      'First, I will analyze the codebase structure.',
      'Now I will implement the feature in src/module.ts.',
    ];
    const result = detectRepetition(
      outputs.slice(0, -1),
      outputs[outputs.length - 1],
      config
    );
    expect(result.detected).toBe(false);
  });
});

describe('checkSpindleLoop', () => {
  it('passes when Spindle is disabled', () => {
    const config: SpindleConfig = { ...DEFAULT_SPINDLE_CONFIG, enabled: false };
    const state = createSpindleState();
    const result = checkSpindleLoop(state, 'any output', null, config);
    expect(result.shouldAbort).toBe(false);
  });

  it('aborts on token budget exceeded', () => {
    const config: SpindleConfig = { ...DEFAULT_SPINDLE_CONFIG, tokenBudgetAbort: 1000 };
    const state = createSpindleState();
    state.estimatedTokens = 500;

    // Add output that pushes over the limit
    const result = checkSpindleLoop(state, 'x'.repeat(2500), null, config);
    expect(result.shouldAbort).toBe(true);
    expect(result.reason).toBe('token_budget');
    expect(result.confidence).toBe(1.0);
  });

  it('warns but continues at token budget warning', () => {
    const config: SpindleConfig = {
      ...DEFAULT_SPINDLE_CONFIG,
      tokenBudgetWarning: 100,
      tokenBudgetAbort: 200,
    };
    const state = createSpindleState();
    state.estimatedTokens = 90;

    const result = checkSpindleLoop(state, 'x'.repeat(50), null, config);
    expect(result.shouldAbort).toBe(false);
    expect(state.warnings.length).toBeGreaterThan(0);
    expect(state.warnings[0]).toContain('token budget');
  });

  it('aborts on stalling (no changes for N iterations)', () => {
    const config: SpindleConfig = { ...DEFAULT_SPINDLE_CONFIG, maxStallIterations: 3 };
    const state = createSpindleState();

    // Simulate iterations without changes
    checkSpindleLoop(state, 'output 1', '', config);
    checkSpindleLoop(state, 'output 2', '', config);
    const result = checkSpindleLoop(state, 'output 3', '', config);

    expect(result.shouldAbort).toBe(true);
    expect(result.reason).toBe('stalling');
    expect(result.diagnostics.iterationsWithoutChange).toBe(3);
  });

  it('resets stall counter when changes occur', () => {
    const config: SpindleConfig = { ...DEFAULT_SPINDLE_CONFIG, maxStallIterations: 3 };
    const state = createSpindleState();

    checkSpindleLoop(state, 'output 1', '', config);
    checkSpindleLoop(state, 'output 2', '', config);
    checkSpindleLoop(state, 'output 3', '+const x = 1;', config); // Change!
    const result = checkSpindleLoop(state, 'output 4', '', config);

    expect(result.shouldAbort).toBe(false);
    expect(state.iterationsSinceChange).toBe(1); // Reset
  });

  it('aborts on oscillating diffs', () => {
    const config: SpindleConfig = { ...DEFAULT_SPINDLE_CONFIG, similarityThreshold: 0.8 };
    const state = createSpindleState();

    checkSpindleLoop(state, 'output', '+const foo = "bar";', config);
    const result = checkSpindleLoop(state, 'output', '-const foo = "bar";', config);

    expect(result.shouldAbort).toBe(true);
    expect(result.reason).toBe('oscillation');
  });

  it('aborts on repeated similar outputs', () => {
    const config: SpindleConfig = {
      ...DEFAULT_SPINDLE_CONFIG,
      maxSimilarOutputs: 2,
      similarityThreshold: 0.8,
    };
    const state = createSpindleState();

    checkSpindleLoop(state, 'Let me try a different approach to fix this.', '+a', config);
    const result = checkSpindleLoop(
      state,
      'Let me try a different approach to fix this.',
      '+b',
      config
    );

    expect(result.shouldAbort).toBe(true);
    expect(result.reason).toBe('repetition');
  });

  it('tracks estimated tokens correctly', () => {
    const state = createSpindleState();
    const config = DEFAULT_SPINDLE_CONFIG;

    checkSpindleLoop(state, 'hello world', '+code', config); // ~3 + ~1 tokens
    expect(state.estimatedTokens).toBeGreaterThan(0);
    expect(state.estimatedTokens).toBeLessThan(20);

    checkSpindleLoop(state, 'more output', '+more code', config);
    expect(state.estimatedTokens).toBeGreaterThan(4);
  });

  it('maintains output and diff history', () => {
    const state = createSpindleState();
    const config: SpindleConfig = { ...DEFAULT_SPINDLE_CONFIG, maxSimilarOutputs: 3 };

    checkSpindleLoop(state, 'output 1', '+diff 1', config);
    checkSpindleLoop(state, 'output 2', '+diff 2', config);
    checkSpindleLoop(state, 'output 3', '+diff 3', config);
    checkSpindleLoop(state, 'output 4', '+diff 4', config);

    // Should keep last N+1 outputs (for comparison)
    expect(state.outputs.length).toBe(4);
    expect(state.outputs[0]).toBe('output 1');
    expect(state.outputs[3]).toBe('output 4');

    // Should keep last 5 diffs
    expect(state.diffs.length).toBe(4);
  });
});

describe('formatSpindleResult', () => {
  it('formats non-abort result', () => {
    const result = formatSpindleResult({
      shouldAbort: false,
      confidence: 0,
      diagnostics: {},
    });
    expect(result).toBe('No spindle loop detected');
  });

  it('formats token budget abort', () => {
    const result = formatSpindleResult({
      shouldAbort: true,
      reason: 'token_budget',
      confidence: 1.0,
      diagnostics: { estimatedTokens: 150000 },
    });
    expect(result).toContain('token_budget');
    expect(result).toContain('150000');
  });

  it('formats oscillation abort', () => {
    const result = formatSpindleResult({
      shouldAbort: true,
      reason: 'oscillation',
      confidence: 0.85,
      diagnostics: { oscillationPattern: 'Added then removed: const x...' },
    });
    expect(result).toContain('oscillation');
    expect(result).toContain('85%');
    expect(result).toContain('Added then removed');
  });

  it('formats repetition abort', () => {
    const result = formatSpindleResult({
      shouldAbort: true,
      reason: 'repetition',
      confidence: 0.9,
      diagnostics: { repeatedPatterns: ['let me try', 'i apologize'] },
    });
    expect(result).toContain('repetition');
    expect(result).toContain('let me try');
  });
});

describe('createSpindleState', () => {
  it('creates clean initial state', () => {
    const state = createSpindleState();
    expect(state.outputs).toEqual([]);
    expect(state.diffs).toEqual([]);
    expect(state.iterationsSinceChange).toBe(0);
    expect(state.estimatedTokens).toBe(0);
    expect(state.warnings).toEqual([]);
    expect(state.totalOutputChars).toBe(0);
    expect(state.totalChangeChars).toBe(0);
  });
});

describe('integration scenarios', () => {
  it('simulates healthy run', () => {
    const state = createSpindleState();
    const config = DEFAULT_SPINDLE_CONFIG;

    const outputs = [
      'Analyzing the codebase structure...',
      'Found the issue in src/module.ts, implementing fix.',
      'Fix complete, running tests to verify.',
    ];
    const diffs = [
      '',
      '+export function fix() { return true; }',
      '+test("fix works", () => expect(fix()).toBe(true));',
    ];

    for (let i = 0; i < outputs.length; i++) {
      const result = checkSpindleLoop(state, outputs[i], diffs[i], config);
      expect(result.shouldAbort).toBe(false);
    }
  });

  it('simulates stuck agent', () => {
    const state = createSpindleState();
    const config: SpindleConfig = { ...DEFAULT_SPINDLE_CONFIG, maxSimilarOutputs: 2 };

    const stuckOutputs = [
      'Let me try to fix this by modifying the function...',
      'That approach did not work. Let me try a different way...',
      'Let me try to fix this by modifying the function...',
    ];

    let aborted = false;
    for (const output of stuckOutputs) {
      const result = checkSpindleLoop(state, output, '', config);
      if (result.shouldAbort) {
        aborted = true;
        expect(result.reason).toBe('repetition');
        break;
      }
    }
    expect(aborted).toBe(true);
  });

  it('simulates oscillating agent', () => {
    const state = createSpindleState();
    const config = DEFAULT_SPINDLE_CONFIG;

    const oscillatingDiffs = [
      '+const DEBUG = true;',
      '-const DEBUG = true;\n+const DEBUG = false;',
      '-const DEBUG = false;\n+const DEBUG = true;',
    ];

    let aborted = false;
    for (const diff of oscillatingDiffs) {
      const result = checkSpindleLoop(state, 'output', diff, config);
      if (result.shouldAbort) {
        aborted = true;
        expect(result.reason).toBe('oscillation');
        break;
      }
    }
    expect(aborted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// QA ping-pong detection
// ---------------------------------------------------------------------------

describe('QA ping-pong detection', () => {
  it('detects alternating failure signatures', () => {
    const state = createSpindleState();
    const config: SpindleConfig = { ...DEFAULT_SPINDLE_CONFIG, maxQaPingPong: 2 };

    // Record alternating failures: A, B, A, B (2 cycles = 4 sigs)
    recordCommandFailure(state, 'npm test', 'Error in module A');
    recordCommandFailure(state, 'npm lint', 'Lint error B');
    recordCommandFailure(state, 'npm test', 'Error in module A');
    recordCommandFailure(state, 'npm lint', 'Lint error B');

    const result = checkSpindleLoop(state, 'output', '+diff', config);
    expect(result.shouldAbort).toBe(true);
    expect(result.reason).toBe('qa_ping_pong');
    expect(result.diagnostics.pingPongPattern).toContain('Alternating');
  });

  it('does not trigger on non-alternating failures', () => {
    const state = createSpindleState();
    const config: SpindleConfig = { ...DEFAULT_SPINDLE_CONFIG, maxQaPingPong: 2 };

    // All same failure
    recordCommandFailure(state, 'npm test', 'Error A');
    recordCommandFailure(state, 'npm test', 'Error A');
    recordCommandFailure(state, 'npm test', 'Error A');
    recordCommandFailure(state, 'npm test', 'Error A');

    const result = checkSpindleLoop(state, 'different output each time', '+diff', config);
    // Should not be qa_ping_pong (might be command_failure instead)
    expect(result.reason).not.toBe('qa_ping_pong');
  });

  it('requires enough cycles', () => {
    const state = createSpindleState();
    const config: SpindleConfig = { ...DEFAULT_SPINDLE_CONFIG, maxQaPingPong: 3 };

    // Only 2 alternating pairs (need 3)
    recordCommandFailure(state, 'npm test', 'Error A');
    recordCommandFailure(state, 'npm lint', 'Error B');
    recordCommandFailure(state, 'npm test', 'Error A');
    recordCommandFailure(state, 'npm lint', 'Error B');

    const result = checkSpindleLoop(state, 'output', '+diff', config);
    expect(result.reason).not.toBe('qa_ping_pong');
  });
});

// ---------------------------------------------------------------------------
// Command signature failure tracking
// ---------------------------------------------------------------------------

describe('command signature failure tracking', () => {
  it('blocks when same command fails N times', () => {
    const state = createSpindleState();
    const config: SpindleConfig = { ...DEFAULT_SPINDLE_CONFIG, maxCommandFailures: 3 };

    // Same command+error 3 times
    recordCommandFailure(state, 'npm test', 'Module not found: foo');
    recordCommandFailure(state, 'npm test', 'Module not found: foo');
    recordCommandFailure(state, 'npm test', 'Module not found: foo');

    const result = checkSpindleLoop(state, 'output', '+diff', config);
    expect(result.shouldBlock).toBe(true);
    expect(result.shouldAbort).toBe(false);
    expect(result.reason).toBe('command_failure');
  });

  it('does not block with different errors', () => {
    const state = createSpindleState();
    const config: SpindleConfig = { ...DEFAULT_SPINDLE_CONFIG, maxCommandFailures: 3 };

    recordCommandFailure(state, 'npm test', 'Error A');
    recordCommandFailure(state, 'npm test', 'Error B');
    recordCommandFailure(state, 'npm test', 'Error C');

    const result = checkSpindleLoop(state, 'different output', '+diff', config);
    expect(result.shouldBlock).toBe(false);
    expect(result.reason).not.toBe('command_failure');
  });

  it('recordCommandFailure caps history at 20', () => {
    const state = createSpindleState();
    for (let i = 0; i < 25; i++) {
      recordCommandFailure(state, `cmd-${i}`, `error-${i}`);
    }
    expect(state.failingCommandSignatures.length).toBe(20);
  });
});

// ---------------------------------------------------------------------------
// Per-file edit frequency tracking
// ---------------------------------------------------------------------------

describe('per-file edit frequency tracking', () => {
  it('tracks file edit counts from diffs', () => {
    const state = createSpindleState();
    const config = DEFAULT_SPINDLE_CONFIG;

    const diff = '+++ b/src/lib/foo.ts\n+const x = 1;\n+++ b/src/lib/bar.ts\n+const y = 2;';
    checkSpindleLoop(state, 'output', diff, config);

    expect(state.fileEditCounts['src/lib/foo.ts']).toBe(1);
    expect(state.fileEditCounts['src/lib/bar.ts']).toBe(1);
  });

  it('increments counts on repeated edits', () => {
    const state = createSpindleState();
    const config = DEFAULT_SPINDLE_CONFIG;

    const diff = '+++ b/src/lib/foo.ts\n+const x = 1;';
    checkSpindleLoop(state, 'output 1', diff, config);
    checkSpindleLoop(state, 'output 2', diff, config);
    checkSpindleLoop(state, 'output 3', diff, config);

    expect(state.fileEditCounts['src/lib/foo.ts']).toBe(3);
  });

  it('generates warnings when threshold exceeded', () => {
    const state = createSpindleState();
    state.fileEditCounts = { 'src/hot.ts': 5, 'src/cold.ts': 1 };

    const warnings = getFileEditWarnings(state, 3);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('src/hot.ts');
    expect(warnings[0]).toContain('5 times');
  });

  it('returns empty for no violations', () => {
    const state = createSpindleState();
    state.fileEditCounts = { 'src/a.ts': 1, 'src/b.ts': 2 };
    expect(getFileEditWarnings(state, 3)).toEqual([]);
  });

  it('adds file churn warnings to state', () => {
    const state = createSpindleState();
    const config: SpindleConfig = { ...DEFAULT_SPINDLE_CONFIG, maxFileEdits: 2 };

    const diff = '+++ b/src/hot.ts\n+x';
    checkSpindleLoop(state, 'out1', diff, config);
    checkSpindleLoop(state, 'out2', diff, config);

    expect(state.warnings.some(w => w.includes('File churn'))).toBe(true);
  });

  it('caps file_edit_counts at 200 keys', () => {
    const state = createSpindleState();
    const config = DEFAULT_SPINDLE_CONFIG;

    // Build a diff with 250 files (exceeds the 200-key cap)
    const lines = [];
    for (let i = 0; i < 250; i++) {
      lines.push(`+++ b/src/file${i}.ts`, `+const x${i} = 1;`);
    }
    checkSpindleLoop(state, 'output', lines.join('\n'), config);

    expect(Object.keys(state.fileEditCounts).length).toBeLessThanOrEqual(200);
  });
});

// ---------------------------------------------------------------------------
// createSpindleState with new fields
// ---------------------------------------------------------------------------

describe('createSpindleState new fields', () => {
  it('initializes new tracking fields', () => {
    const state = createSpindleState();
    expect(state.failingCommandSignatures).toEqual([]);
    expect(state.fileEditCounts).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// formatSpindleResult with new reasons
// ---------------------------------------------------------------------------

describe('formatSpindleResult new reasons', () => {
  it('formats qa_ping_pong abort', () => {
    const result = formatSpindleResult({
      shouldAbort: true,
      shouldBlock: false,
      reason: 'qa_ping_pong',
      confidence: 0.9,
      diagnostics: { pingPongPattern: 'Alternating failures: abc ↔ def (3 cycles)' },
    });
    expect(result).toContain('qa_ping_pong');
    expect(result).toContain('Alternating');
  });

  it('formats command_failure block', () => {
    const result = formatSpindleResult({
      shouldAbort: false,
      shouldBlock: true,
      reason: 'command_failure',
      confidence: 0.8,
      diagnostics: { commandSignature: 'abc123', commandFailureThreshold: 3 },
    });
    expect(result).toContain('blocked (needs human)');
    expect(result).toContain('command_failure');
    expect(result).toContain('abc123');
  });

  it('does not trigger for clean state', () => {
    const result = formatSpindleResult({
      shouldAbort: false,
      shouldBlock: false,
      confidence: 0,
      diagnostics: {},
    });
    expect(result).toBe('No spindle loop detected');
  });
});

// ---------------------------------------------------------------------------
// findRepeatedPhrases
// ---------------------------------------------------------------------------

describe('findRepeatedPhrases', () => {
  it('finds identical long sentences across texts', () => {
    const phrase = 'The quick brown fox jumps over the lazy dog near the river';
    const a = `Start. ${phrase}. End of first.`;
    const b = `Begin. ${phrase}. End of second.`;
    const result = findRepeatedPhrases(a, b);
    expect(result.length).toBeGreaterThan(0);
  });

  it('returns empty for completely different texts', () => {
    const a = 'Alpha bravo charlie delta echo foxtrot golf hotel india.';
    const b = 'One two three four five six seven eight nine ten eleven.';
    const result = findRepeatedPhrases(a, b);
    expect(result).toEqual([]);
  });

  it('filters out short fragments (< 20 chars)', () => {
    // All fragments after splitting on .!?\n will be < 20 chars
    const a = 'Short. Tiny. Small.';
    const b = 'Short. Tiny. Small.';
    const result = findRepeatedPhrases(a, b);
    expect(result).toEqual([]);
  });

  it('respects maxResults parameter', () => {
    // Build texts with many repeated long sentences
    const sentences = Array.from({ length: 10 }, (_, i) =>
      `This is a sufficiently long repeated sentence number ${i} with padding words`
    );
    const text = sentences.join('. ');
    const result = findRepeatedPhrases(text, text, 2);
    expect(result.length).toBeLessThanOrEqual(2);
  });

  it('handles empty strings', () => {
    expect(findRepeatedPhrases('', '')).toEqual([]);
    expect(findRepeatedPhrases('Some long enough text for fragment processing.', '')).toEqual([]);
    expect(findRepeatedPhrases('', 'Some long enough text for fragment processing.')).toEqual([]);
  });

  it('truncates matched phrases to 60 chars plus ellipsis', () => {
    const longPhrase = 'a]'.repeat(1) + 'This is a very long repeated phrase that should definitely exceed the sixty character truncation limit applied by the function';
    const a = `${longPhrase}. Done.`;
    const b = `${longPhrase}. Finished.`;
    const result = findRepeatedPhrases(a, b);
    if (result.length > 0) {
      expect(result[0].endsWith('...')).toBe(true);
      // 60 chars + '...' = 63 max
      expect(result[0].length).toBeLessThanOrEqual(63);
    }
  });
});

// ---------------------------------------------------------------------------
// detectRepetition
// ---------------------------------------------------------------------------

describe('detectRepetition', () => {
  const baseConfig: SpindleConfig = {
    ...DEFAULT_SPINDLE_CONFIG,
    similarityThreshold: 0.8,
    maxSimilarOutputs: 3,
  };

  it('detects highly similar consecutive outputs', () => {
    const outputs = [
      'I will now read the file src/utils.ts and check for errors in the parsing logic',
      'I will now read the file src/utils.ts and check for errors in the parsing logic',
    ];
    const latest = 'I will now read the file src/utils.ts and check for errors in the parsing logic';
    const result = detectRepetition(outputs, latest, baseConfig);
    expect(result.detected).toBe(true);
    expect(result.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it('does not detect with completely different outputs', () => {
    const outputs = [
      'Reading the database configuration file to understand the schema',
      'Now running the test suite to validate the migration worked',
    ];
    const latest = 'The API endpoint returns a 404 error when accessing the user profile';
    const result = detectRepetition(outputs, latest, baseConfig);
    expect(result.detected).toBe(false);
    expect(result.patterns).toEqual([]);
  });

  it('detects stuck phrases when repeated across outputs', () => {
    const outputs = [
      'Let me try a different approach to fix this issue with the parser',
      'Let me try another way to resolve the compilation problem here',
    ];
    const latest = 'Let me try once more to get this working correctly now';
    const result = detectRepetition(outputs, latest, baseConfig);
    expect(result.detected).toBe(true);
    expect(result.patterns.some(p => p.includes('let me try'))).toBe(true);
  });

  it('requires at least 2 prior occurrences for stuck phrase detection', () => {
    const outputs = [
      'Let me try to fix this issue',
    ];
    const latest = 'Let me try another approach here';
    const result = detectRepetition(outputs, latest, baseConfig);
    // Only 1 prior occurrence — not enough for stuck phrase
    expect(result.patterns.filter(p => p.includes('let me try'))).toHaveLength(0);
  });

  it('deduplicates patterns and limits to 5', () => {
    // Create outputs that will generate many pattern matches
    const repeated = 'I apologize for the confusion and let me try again with a better approach';
    const outputs = [repeated, repeated, repeated];
    const latest = repeated;
    const result = detectRepetition(outputs, latest, baseConfig);
    expect(result.patterns.length).toBeLessThanOrEqual(5);
    // Check dedup: no duplicate entries
    const unique = new Set(result.patterns);
    expect(unique.size).toBe(result.patterns.length);
  });
});
