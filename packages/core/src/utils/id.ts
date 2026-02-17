/**
 * ID generation utilities
 */

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/**
 * Generate a random ID
 */
export function nanoid(size: number = 21): string {
  let id = '';
  const bytes = new Uint8Array(size);
  // eslint-disable-next-line no-undef
  crypto.getRandomValues(bytes);

  for (let i = 0; i < size; i++) {
    id += ALPHABET[bytes[i] % ALPHABET.length];
  }

  return id;
}

/**
 * Generate a prefixed ID
 */
export function prefixedId(prefix: string, size: number = 12): string {
  return `${prefix}_${nanoid(size)}`;
}
