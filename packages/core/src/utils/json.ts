/**
 * JSON parsing utilities
 */

/**
 * Parse a JSON string that should contain an array.
 * Returns an empty array if the value is null, empty, or invalid JSON.
 */
export function parseJsonArray(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
