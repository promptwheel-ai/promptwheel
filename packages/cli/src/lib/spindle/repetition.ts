/**
 * Spindle — Repetition detection
 */

import { computeSimilarity, findRepeatedPhrases } from './similarity.js';
import type { SpindleConfig } from './types.js';

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
