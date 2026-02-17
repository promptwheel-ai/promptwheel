import { describe, it, expect } from 'vitest';
import { parseSelection } from '../lib/solo-auto-planning.js';

// ---------------------------------------------------------------------------
// parseSelection
// ---------------------------------------------------------------------------

describe('parseSelection', () => {
  it('returns empty array for empty string', () => {
    expect(parseSelection('', 10)).toEqual([]);
  });

  it('parses a single number', () => {
    // "3" with max=5 → [2] (0-based)
    expect(parseSelection('3', 5)).toEqual([2]);
  });

  it('parses comma-separated numbers', () => {
    expect(parseSelection('1,3,5', 5)).toEqual([0, 2, 4]);
  });

  it('parses a range', () => {
    // "2-4" → [1, 2, 3] (0-based)
    expect(parseSelection('2-4', 5)).toEqual([1, 2, 3]);
  });

  it('parses mixed ranges and singles', () => {
    expect(parseSelection('1-3,5,7-9', 10)).toEqual([0, 1, 2, 4, 6, 7, 8]);
  });

  it('handles reversed range (5-3 treated same as 3-5)', () => {
    expect(parseSelection('5-3', 5)).toEqual([2, 3, 4]);
  });

  it('ignores out-of-range values (too high)', () => {
    expect(parseSelection('1,10,3', 5)).toEqual([0, 2]);
  });

  it('ignores out-of-range values (zero and negative)', () => {
    expect(parseSelection('0,1,-1', 5)).toEqual([0]);
  });

  it('ignores non-numeric input', () => {
    expect(parseSelection('abc,1,xyz', 5)).toEqual([0]);
  });

  it('deduplicates repeated indices', () => {
    // "1,1,1" should yield [0] not [0,0,0]
    expect(parseSelection('1,1,1', 5)).toEqual([0]);
  });

  it('deduplicates overlapping ranges', () => {
    // "1-3,2-4" → indices 0,1,2,3 (no duplicates)
    expect(parseSelection('1-3,2-4', 5)).toEqual([0, 1, 2, 3]);
  });

  it('returns sorted output', () => {
    expect(parseSelection('5,1,3', 5)).toEqual([0, 2, 4]);
  });

  it('handles whitespace around values', () => {
    expect(parseSelection(' 1 , 3 , 5 ', 5)).toEqual([0, 2, 4]);
  });

  it('handles whitespace around range dash', () => {
    expect(parseSelection('1 - 3', 5)).toEqual([0, 1, 2]);
  });

  it('clips range to max boundary', () => {
    // "3-8" with max=5 → only 3,4,5 are valid → [2,3,4]
    expect(parseSelection('3-8', 5)).toEqual([2, 3, 4]);
  });

  it('returns empty for all-invalid input', () => {
    expect(parseSelection('abc,xyz', 5)).toEqual([]);
  });

  it('handles max=1 correctly', () => {
    expect(parseSelection('1', 1)).toEqual([0]);
    expect(parseSelection('2', 1)).toEqual([]);
  });

  it('handles single-element range', () => {
    // "3-3" → [2]
    expect(parseSelection('3-3', 5)).toEqual([2]);
  });
});
