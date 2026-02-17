/**
 * Tests for selection parser
 */

import { describe, it, expect } from 'vitest';
import { parseSelection, isValidSelection, formatSelection } from '../lib/selection.js';

describe('parseSelection', () => {
  it('parses single number', () => {
    expect(parseSelection('1', 5)).toEqual([0]);
    expect(parseSelection('3', 5)).toEqual([2]);
  });

  it('parses comma-separated numbers', () => {
    expect(parseSelection('1,3,5', 5)).toEqual([0, 2, 4]);
    expect(parseSelection('1, 3, 5', 5)).toEqual([0, 2, 4]); // with spaces
  });

  it('parses ranges', () => {
    expect(parseSelection('1-3', 5)).toEqual([0, 1, 2]);
    expect(parseSelection('2-4', 5)).toEqual([1, 2, 3]);
  });

  it('parses mixed selection', () => {
    expect(parseSelection('1-3,5', 5)).toEqual([0, 1, 2, 4]);
    expect(parseSelection('1,3-5', 5)).toEqual([0, 2, 3, 4]);
  });

  it('handles "all"', () => {
    expect(parseSelection('all', 5)).toEqual([0, 1, 2, 3, 4]);
    expect(parseSelection('ALL', 3)).toEqual([0, 1, 2]);
    expect(parseSelection('  all  ', 2)).toEqual([0, 1]);
  });

  it('deduplicates and sorts', () => {
    expect(parseSelection('3,1,2,1', 5)).toEqual([0, 1, 2]);
    expect(parseSelection('1-3,2-4', 5)).toEqual([0, 1, 2, 3]);
  });

  it('ignores out-of-range values', () => {
    expect(parseSelection('1,10,2', 5)).toEqual([0, 1]); // 10 is out of range
    expect(parseSelection('0,1,2', 5)).toEqual([0, 1]); // 0 is invalid (1-indexed input)
  });

  it('throws on invalid input', () => {
    expect(() => parseSelection('abc', 5)).toThrow('Invalid selection');
    expect(() => parseSelection('1-', 5)).toThrow();
    expect(() => parseSelection('3-1', 5)).toThrow('start (3) > end (1)');
  });
});

describe('isValidSelection', () => {
  it('returns true for valid selections', () => {
    expect(isValidSelection('1', 5)).toBe(true);
    expect(isValidSelection('1-3', 5)).toBe(true);
    expect(isValidSelection('all', 5)).toBe(true);
  });

  it('returns false for invalid selections', () => {
    expect(isValidSelection('abc', 5)).toBe(false);
    expect(isValidSelection('3-1', 5)).toBe(false);
  });
});

describe('formatSelection', () => {
  it('formats single index', () => {
    expect(formatSelection([0])).toBe('1');
    expect(formatSelection([4])).toBe('5');
  });

  it('formats non-consecutive indices', () => {
    expect(formatSelection([0, 2, 4])).toBe('1, 3, 5');
  });

  it('formats consecutive ranges', () => {
    expect(formatSelection([0, 1, 2])).toBe('1-3');
    expect(formatSelection([1, 2, 3])).toBe('2-4');
  });

  it('formats mixed', () => {
    expect(formatSelection([0, 1, 2, 4])).toBe('1-3, 5');
    expect(formatSelection([0, 2, 3, 4])).toBe('1, 3-5');
  });

  it('handles empty', () => {
    expect(formatSelection([])).toBe('none');
  });
});
