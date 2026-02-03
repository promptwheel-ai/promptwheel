/**
 * Proposal filtering, balancing, and ranking logic for solo-auto mode.
 */

/**
 * Balance test vs non-test proposals by capping the ratio of test-only proposals.
 */
export function balanceProposals<T extends { category: string; impact_score?: number | null }>(
  proposals: T[],
  maxTestRatio: number,
): T[] {
  const tests = proposals.filter(p => (p.category || '').toLowerCase() === 'test');
  const nonTests = proposals.filter(p => (p.category || '').toLowerCase() !== 'test');

  const total = proposals.length;
  const maxTests = Math.floor(total * maxTestRatio);

  if (tests.length <= maxTests) return proposals;

  // Sort tests by impact descending, keep only the top N
  const sortedTests = [...tests].sort(
    (a, b) => (b.impact_score ?? 5) - (a.impact_score ?? 5),
  );

  // Hard-cap tests — even if ALL proposals are tests, keep at most maxTests (min 1)
  const allowedTests = Math.max(maxTests, 1);
  const keptTests = sortedTests.slice(0, allowedTests);

  return [...nonTests, ...keptTests];
}
