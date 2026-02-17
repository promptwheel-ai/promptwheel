import { describe, it, expect } from 'vitest';
import {
  computeTicketTimeout,
  getSessionPhase,
  formatElapsed,
} from '../lib/solo-auto-utils.js';

// ---------------------------------------------------------------------------
// computeTicketTimeout
// ---------------------------------------------------------------------------

describe('computeTicketTimeout', () => {
  describe('complexity-based defaults (no config)', () => {
    it('returns 240_000 (4 min) for trivial', () => {
      expect(computeTicketTimeout({ estimated_complexity: 'trivial' })).toBe(240_000);
    });

    it('returns 600_000 (10 min) for simple', () => {
      expect(computeTicketTimeout({ estimated_complexity: 'simple' })).toBe(600_000);
    });

    it('returns 900_000 (15 min) for moderate (default)', () => {
      expect(computeTicketTimeout({ estimated_complexity: 'moderate' })).toBe(900_000);
    });

    it('returns 1_200_000 (20 min) for complex', () => {
      expect(computeTicketTimeout({ estimated_complexity: 'complex' })).toBe(1_200_000);
    });

    it('returns 900_000 (15 min) for unknown complexity', () => {
      expect(computeTicketTimeout({ estimated_complexity: 'unknown' })).toBe(900_000);
    });

    it('returns 900_000 (15 min) when complexity is undefined', () => {
      expect(computeTicketTimeout({})).toBe(900_000);
    });
  });

  describe('timeoutMultiplier', () => {
    it('scales base timeout by multiplier', () => {
      expect(computeTicketTimeout(
        { estimated_complexity: 'simple' },
        { timeoutMultiplier: 2 },
      )).toBe(1_200_000); // 600_000 * 2
    });

    it('caps at 30 min (1_800_000) even with large multiplier', () => {
      expect(computeTicketTimeout(
        { estimated_complexity: 'complex' },
        { timeoutMultiplier: 10 },
      )).toBe(1_800_000);
    });

    it('defaults multiplier to 1 when not specified', () => {
      expect(computeTicketTimeout(
        { estimated_complexity: 'trivial' },
        {},
      )).toBe(240_000);
    });
  });

  describe('categoryTimeouts override', () => {
    it('uses category timeout when matching category exists', () => {
      expect(computeTicketTimeout(
        { estimated_complexity: 'trivial', category: 'security' },
        { categoryTimeouts: { security: 500_000 } },
      )).toBe(500_000);
    });

    it('applies multiplier to category timeout', () => {
      expect(computeTicketTimeout(
        { category: 'security' },
        { categoryTimeouts: { security: 500_000 }, timeoutMultiplier: 2 },
      )).toBe(1_000_000);
    });

    it('caps category timeout at 30 min', () => {
      expect(computeTicketTimeout(
        { category: 'security' },
        { categoryTimeouts: { security: 2_000_000 } },
      )).toBe(1_800_000);
    });

    it('falls back to complexity-based when category not in config', () => {
      expect(computeTicketTimeout(
        { estimated_complexity: 'simple', category: 'refactor' },
        { categoryTimeouts: { security: 500_000 } },
      )).toBe(600_000);
    });

    it('falls back to complexity-based when category is undefined', () => {
      expect(computeTicketTimeout(
        { estimated_complexity: 'simple' },
        { categoryTimeouts: { security: 500_000 } },
      )).toBe(600_000);
    });
  });
});

// ---------------------------------------------------------------------------
// getSessionPhase
// ---------------------------------------------------------------------------

describe('getSessionPhase', () => {
  it('returns "deep" when no time budget is set', () => {
    expect(getSessionPhase(5000, undefined)).toBe('deep');
  });

  it('returns "warmup" when elapsed < 20% of budget', () => {
    expect(getSessionPhase(1000, 10000)).toBe('warmup'); // 10%
  });

  it('returns "warmup" at exactly 0% elapsed', () => {
    expect(getSessionPhase(0, 10000)).toBe('warmup');
  });

  it('returns "deep" when elapsed is between 20% and 80%', () => {
    expect(getSessionPhase(5000, 10000)).toBe('deep'); // 50%
  });

  it('returns "deep" at exactly 20% elapsed', () => {
    expect(getSessionPhase(2000, 10000)).toBe('deep'); // boundary
  });

  it('returns "cooldown" when elapsed > 80% of budget', () => {
    expect(getSessionPhase(9000, 10000)).toBe('cooldown'); // 90%
  });

  it('returns "cooldown" at exactly 80.1% elapsed', () => {
    expect(getSessionPhase(8010, 10000)).toBe('cooldown');
  });

  it('returns "deep" at exactly 80% elapsed', () => {
    expect(getSessionPhase(8000, 10000)).toBe('deep'); // boundary: >0.8, not >=0.8
  });

  it('returns "cooldown" when elapsed exceeds budget', () => {
    expect(getSessionPhase(15000, 10000)).toBe('cooldown'); // 150%
  });
});

// ---------------------------------------------------------------------------
// formatElapsed
// ---------------------------------------------------------------------------

describe('formatElapsed', () => {
  it('formats minutes only when < 1 hour', () => {
    expect(formatElapsed(5 * 60_000)).toBe('5m');
  });

  it('formats hours and minutes', () => {
    expect(formatElapsed(90 * 60_000)).toBe('1h 30m');
  });

  it('formats exact hours', () => {
    expect(formatElapsed(2 * 3600_000)).toBe('2h 0m');
  });

  it('formats 0 minutes', () => {
    expect(formatElapsed(0)).toBe('0m');
  });

  it('formats sub-minute as 0m', () => {
    expect(formatElapsed(30_000)).toBe('0m');
  });

  it('floors minutes (no rounding)', () => {
    expect(formatElapsed(89_999)).toBe('1m'); // 1.49 min → 1m
  });

  it('formats large values', () => {
    expect(formatElapsed(10 * 3600_000 + 45 * 60_000)).toBe('10h 45m');
  });
});
