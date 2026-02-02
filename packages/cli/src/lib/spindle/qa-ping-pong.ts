/**
 * Spindle — QA ping-pong detection
 */

/** Detect alternating failure signatures: A→B→A→B pattern */
export function detectQaPingPong(sigs: string[], cycles: number): string | null {
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
