/**
 * Selection parser for user input
 *
 * Parses selection strings like:
 * - "1"       → [0]
 * - "1,3,5"   → [0, 2, 4]
 * - "1-3"     → [0, 1, 2]
 * - "1-3,5,7" → [0, 1, 2, 4, 6]
 * - "all"     → all indices
 *
 * Note: User input is 1-indexed, output is 0-indexed.
 */

/**
 * Parse a selection string into 0-indexed array indices
 *
 * @param input - Selection string (e.g., "1-3,5,7" or "all")
 * @param maxIndex - Maximum valid index (0-indexed, exclusive)
 * @returns Array of 0-indexed indices, sorted and deduplicated
 * @throws Error for invalid input
 */
export function parseSelection(input: string, maxIndex: number): number[] {
  const trimmed = input.trim().toLowerCase();

  // Handle "all" case
  if (trimmed === 'all') {
    return Array.from({ length: maxIndex }, (_, i) => i);
  }

  const indices = new Set<number>();

  // Split on commas
  const parts = trimmed.split(',').map(p => p.trim()).filter(Boolean);

  for (const part of parts) {
    // Check if it's a range (e.g., "1-3")
    if (part.includes('-')) {
      const [startStr, endStr] = part.split('-').map(s => s.trim());
      const start = parseInt(startStr, 10);
      const end = parseInt(endStr, 10);

      if (isNaN(start) || isNaN(end)) {
        throw new Error(`Invalid range: "${part}"`);
      }

      if (start > end) {
        throw new Error(`Invalid range: start (${start}) > end (${end})`);
      }

      // Convert to 0-indexed and add all in range
      for (let i = start; i <= end; i++) {
        const idx = i - 1; // Convert to 0-indexed
        if (idx >= 0 && idx < maxIndex) {
          indices.add(idx);
        }
      }
    } else {
      // Single number
      const num = parseInt(part, 10);

      if (isNaN(num)) {
        throw new Error(`Invalid selection: "${part}"`);
      }

      const idx = num - 1; // Convert to 0-indexed
      if (idx >= 0 && idx < maxIndex) {
        indices.add(idx);
      }
    }
  }

  // Return sorted array
  return Array.from(indices).sort((a, b) => a - b);
}

/**
 * Validate a selection string without parsing
 *
 * @returns true if valid, false otherwise
 */
export function isValidSelection(input: string, maxIndex: number): boolean {
  try {
    parseSelection(input, maxIndex);
    return true;
  } catch {
    return false;
  }
}

/**
 * Format a selection for display (1-indexed)
 *
 * @param indices - 0-indexed array indices
 * @returns Human-readable string like "1, 2, 3" or "1-3"
 */
export function formatSelection(indices: number[]): string {
  if (indices.length === 0) return 'none';

  // Convert to 1-indexed and sort
  const oneIndexed = indices.map(i => i + 1).sort((a, b) => a - b);

  // Group consecutive numbers into ranges
  const ranges: Array<[number, number]> = [];
  let rangeStart = oneIndexed[0];
  let rangeEnd = oneIndexed[0];

  for (let i = 1; i < oneIndexed.length; i++) {
    if (oneIndexed[i] === rangeEnd + 1) {
      rangeEnd = oneIndexed[i];
    } else {
      ranges.push([rangeStart, rangeEnd]);
      rangeStart = oneIndexed[i];
      rangeEnd = oneIndexed[i];
    }
  }
  ranges.push([rangeStart, rangeEnd]);

  // Format ranges
  return ranges
    .map(([start, end]) => (start === end ? String(start) : `${start}-${end}`))
    .join(', ');
}
