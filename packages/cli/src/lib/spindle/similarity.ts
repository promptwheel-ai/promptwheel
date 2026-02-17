/**
 * Spindle — Similarity computation
 */

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
 * Find repeated phrases between two texts
 */
export function findRepeatedPhrases(a: string, b: string, maxResults: number = 5): string[] {
  const phrases: string[] = [];

  // Split into sentences/fragments
  const fragmentsA = a.split(/[.!?\n]+/).filter(f => f.trim().length > 20);
  const fragmentsB = b.split(/[.!?\n]+/).filter(f => f.trim().length > 20);

  for (const fragA of fragmentsA) {
    for (const fragB of fragmentsB) {
      const sim = computeSimilarity(fragA, fragB);
      if (sim >= 0.9) {
        phrases.push(fragA.trim().slice(0, 60) + '...');
        if (phrases.length >= maxResults) return phrases;
      }
    }
  }

  return phrases;
}
