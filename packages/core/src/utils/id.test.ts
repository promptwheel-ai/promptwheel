/**
 * Tests for ID generation utilities
 */

import { describe, it, expect } from 'vitest';
import { nanoid, prefixedId } from './id.js';

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

describe('nanoid', () => {
  describe('length', () => {
    it('generates string of default length (21)', () => {
      const id = nanoid();
      expect(id).toHaveLength(21);
    });

    it('generates string of specified length', () => {
      expect(nanoid(10)).toHaveLength(10);
      expect(nanoid(32)).toHaveLength(32);
      expect(nanoid(100)).toHaveLength(100);
    });

    it('handles size=0', () => {
      const id = nanoid(0);
      expect(id).toBe('');
      expect(id).toHaveLength(0);
    });

    it('handles size=1', () => {
      const id = nanoid(1);
      expect(id).toHaveLength(1);
      expect(ALPHABET).toContain(id);
    });
  });

  describe('character set', () => {
    it('only uses characters from ALPHABET', () => {
      // Generate multiple IDs to increase coverage
      for (let i = 0; i < 100; i++) {
        const id = nanoid(50);
        for (const char of id) {
          expect(ALPHABET).toContain(char);
        }
      }
    });

    it('produces lowercase alphanumeric characters only', () => {
      const id = nanoid(100);
      expect(id).toMatch(/^[0-9a-z]+$/);
    });
  });

  describe('uniqueness', () => {
    it('generates unique IDs across multiple calls', () => {
      const ids = new Set<string>();
      const count = 1000;

      for (let i = 0; i < count; i++) {
        ids.add(nanoid());
      }

      expect(ids.size).toBe(count);
    });

    it('generates unique IDs even with small size', () => {
      // With size=8 and 36-char alphabet, we have 36^8 = 2.8 trillion possibilities
      // 100 samples should still be unique
      const ids = new Set<string>();
      const count = 100;

      for (let i = 0; i < count; i++) {
        ids.add(nanoid(8));
      }

      expect(ids.size).toBe(count);
    });
  });

  describe('randomness', () => {
    it('produces different IDs on consecutive calls', () => {
      const id1 = nanoid();
      const id2 = nanoid();
      const id3 = nanoid();

      expect(id1).not.toBe(id2);
      expect(id2).not.toBe(id3);
      expect(id1).not.toBe(id3);
    });
  });

  describe('edge cases', () => {
    it('handles large sizes', () => {
      const id = nanoid(1000);
      expect(id).toHaveLength(1000);
      expect(id).toMatch(/^[0-9a-z]+$/);
    });
  });
});

describe('prefixedId', () => {
  describe('format', () => {
    it('returns prefix_id format', () => {
      const id = prefixedId('tkt');
      expect(id).toMatch(/^tkt_[0-9a-z]+$/);
    });

    it('uses underscore as separator', () => {
      const id = prefixedId('usr');
      const parts = id.split('_');
      expect(parts).toHaveLength(2);
      expect(parts[0]).toBe('usr');
    });

    it('preserves prefix exactly', () => {
      const prefixes = ['tkt', 'run', 'step', 'ABC', '123'];
      for (const prefix of prefixes) {
        const id = prefixedId(prefix);
        expect(id.startsWith(`${prefix}_`)).toBe(true);
      }
    });
  });

  describe('default size', () => {
    it('uses default size of 12 for random part', () => {
      const id = prefixedId('tkt');
      const randomPart = id.split('_')[1];
      expect(randomPart).toHaveLength(12);
    });
  });

  describe('custom size', () => {
    it('respects custom size parameter', () => {
      const id = prefixedId('tkt', 8);
      const randomPart = id.split('_')[1];
      expect(randomPart).toHaveLength(8);
    });

    it('handles size=0', () => {
      const id = prefixedId('tkt', 0);
      expect(id).toBe('tkt_');
    });

    it('handles size=1', () => {
      const id = prefixedId('tkt', 1);
      const randomPart = id.split('_')[1];
      expect(randomPart).toHaveLength(1);
      expect(ALPHABET).toContain(randomPart);
    });

    it('handles large sizes', () => {
      const id = prefixedId('tkt', 100);
      const randomPart = id.split('_')[1];
      expect(randomPart).toHaveLength(100);
    });
  });

  describe('uniqueness', () => {
    it('generates unique IDs with same prefix', () => {
      const ids = new Set<string>();
      const count = 100;

      for (let i = 0; i < count; i++) {
        ids.add(prefixedId('tkt'));
      }

      expect(ids.size).toBe(count);
    });
  });

  describe('character set', () => {
    it('random part only uses characters from ALPHABET', () => {
      for (let i = 0; i < 50; i++) {
        const id = prefixedId('test', 20);
        const randomPart = id.split('_')[1];
        for (const char of randomPart) {
          expect(ALPHABET).toContain(char);
        }
      }
    });
  });

  describe('edge cases', () => {
    it('handles empty prefix', () => {
      const id = prefixedId('');
      expect(id).toMatch(/^_[0-9a-z]+$/);
    });

    it('handles prefix with special characters', () => {
      const id = prefixedId('test-prefix');
      expect(id.startsWith('test-prefix_')).toBe(true);
    });

    it('handles prefix with underscore', () => {
      const id = prefixedId('my_prefix');
      expect(id.startsWith('my_prefix_')).toBe(true);
      // Verify format still works (split produces 3 parts now)
      const parts = id.split('_');
      expect(parts[0]).toBe('my');
      expect(parts[1]).toBe('prefix');
      // Random part is the third element
      expect(parts[2]).toHaveLength(12);
    });
  });
});
