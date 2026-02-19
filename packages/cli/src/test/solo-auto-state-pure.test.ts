/**
 * Unit tests for pure helper functions exported from solo-auto-state.ts.
 *
 * Focuses on `shouldContinue` — the session-termination predicate
 * that decides whether the auto-mode loop keeps running.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { shouldContinue } from '../lib/solo-auto-state.js';
import type { AutoSessionState } from '../lib/solo-auto-state.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal mock state — only the fields shouldContinue reads. */
function makeState(overrides: Partial<AutoSessionState> = {}): AutoSessionState {
  return {
    shutdownRequested: false,
    milestoneMode: false,
    totalMilestonePrs: 0,
    maxPrs: 5,
    deliveryMode: 'direct',
    totalPrsCreated: 0,
    endTime: undefined,
    cycleCount: 0,
    maxCycles: 999,
    runMode: 'planning',
    ...overrides,
  } as AutoSessionState;
}

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// shouldContinue
// ---------------------------------------------------------------------------

describe('shouldContinue', () => {
  // ── Shutdown ────────────────────────────────────────────────────────────
  describe('shutdown', () => {
    it('returns false when shutdownRequested is true', () => {
      expect(shouldContinue(makeState({ shutdownRequested: true }))).toBe(false);
    });

    it('returns true when shutdownRequested is false and no limits hit', () => {
      expect(shouldContinue(makeState())).toBe(true);
    });
  });

  // ── PR limits — milestone mode ─────────────────────────────────────────
  describe('milestone mode PR limit', () => {
    it('returns false when milestone PRs reach maxPrs', () => {
      expect(shouldContinue(makeState({
        milestoneMode: true,
        totalMilestonePrs: 5,
        maxPrs: 5,
      }))).toBe(false);
    });

    it('returns false when milestone PRs exceed maxPrs', () => {
      expect(shouldContinue(makeState({
        milestoneMode: true,
        totalMilestonePrs: 7,
        maxPrs: 5,
      }))).toBe(false);
    });

    it('returns true when milestone PRs are below maxPrs', () => {
      expect(shouldContinue(makeState({
        milestoneMode: true,
        totalMilestonePrs: 4,
        maxPrs: 5,
      }))).toBe(true);
    });
  });

  // ── PR limits — pr / auto-merge delivery mode ──────────────────────────
  describe('pr/auto-merge delivery mode PR limit', () => {
    it('returns false when totalPrsCreated reaches maxPrs (pr mode)', () => {
      expect(shouldContinue(makeState({
        deliveryMode: 'pr',
        totalPrsCreated: 5,
        maxPrs: 5,
      }))).toBe(false);
    });

    it('returns false when totalPrsCreated reaches maxPrs (auto-merge mode)', () => {
      expect(shouldContinue(makeState({
        deliveryMode: 'auto-merge',
        totalPrsCreated: 3,
        maxPrs: 3,
      }))).toBe(false);
    });

    it('returns true when totalPrsCreated is below maxPrs', () => {
      expect(shouldContinue(makeState({
        deliveryMode: 'pr',
        totalPrsCreated: 2,
        maxPrs: 5,
      }))).toBe(true);
    });
  });

  // ── Direct mode ignores PR limits ──────────────────────────────────────
  describe('direct mode ignores PR limits', () => {
    it('returns true even when totalPrsCreated exceeds maxPrs', () => {
      expect(shouldContinue(makeState({
        deliveryMode: 'direct',
        totalPrsCreated: 100,
        maxPrs: 5,
      }))).toBe(true);
    });

    it('returns true regardless of totalMilestonePrs when milestoneMode is off', () => {
      expect(shouldContinue(makeState({
        deliveryMode: 'direct',
        milestoneMode: false,
        totalMilestonePrs: 99,
        maxPrs: 1,
      }))).toBe(true);
    });
  });

  // ── Time limit ─────────────────────────────────────────────────────────
  describe('time limit', () => {
    it('returns false when current time is past endTime', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2025-06-01T12:00:00Z'));

      expect(shouldContinue(makeState({
        endTime: new Date('2025-06-01T11:00:00Z').getTime(), // 1 hour ago
      }))).toBe(false);
    });

    it('returns false when current time equals endTime', () => {
      vi.useFakeTimers();
      const now = new Date('2025-06-01T12:00:00Z');
      vi.setSystemTime(now);

      expect(shouldContinue(makeState({
        endTime: now.getTime(),
      }))).toBe(false);
    });

    it('returns true when current time is before endTime', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2025-06-01T12:00:00Z'));

      expect(shouldContinue(makeState({
        endTime: new Date('2025-06-01T13:00:00Z').getTime(), // 1 hour from now
      }))).toBe(true);
    });

    it('returns true when endTime is undefined (no time budget)', () => {
      expect(shouldContinue(makeState({ endTime: undefined }))).toBe(true);
    });
  });

  // ── Cycle limit ────────────────────────────────────────────────────────
  describe('cycle limit', () => {
    it('returns false when cycleCount reaches maxCycles in planning mode', () => {
      expect(shouldContinue(makeState({
        runMode: 'planning',
        cycleCount: 3,
        maxCycles: 3,
      }))).toBe(false);
    });

    it('returns false when cycleCount exceeds maxCycles in planning mode', () => {
      expect(shouldContinue(makeState({
        runMode: 'planning',
        cycleCount: 10,
        maxCycles: 3,
      }))).toBe(false);
    });

    it('returns true when cycleCount is below maxCycles in planning mode', () => {
      expect(shouldContinue(makeState({
        runMode: 'planning',
        cycleCount: 2,
        maxCycles: 3,
      }))).toBe(true);
    });
  });

  // ── Spin mode ignores cycle limit ──────────────────────────────────────
  describe('spin mode ignores cycle limit', () => {
    it('returns true even when cycleCount exceeds maxCycles', () => {
      expect(shouldContinue(makeState({
        runMode: 'spin',
        cycleCount: 999,
        maxCycles: 3,
      }))).toBe(true);
    });

    it('returns true at exactly maxCycles in spin mode', () => {
      expect(shouldContinue(makeState({
        runMode: 'spin',
        cycleCount: 3,
        maxCycles: 3,
      }))).toBe(true);
    });
  });

  // ── Combined conditions ────────────────────────────────────────────────
  describe('combined conditions', () => {
    it('shutdown takes priority over all other conditions', () => {
      expect(shouldContinue(makeState({
        shutdownRequested: true,
        deliveryMode: 'direct',
        totalPrsCreated: 0,
        cycleCount: 0,
        maxCycles: 999,
      }))).toBe(false);
    });

    it('PR limit checked before time limit', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2025-06-01T12:00:00Z'));

      // Both PR limit and time limit would trigger — function returns false
      expect(shouldContinue(makeState({
        deliveryMode: 'pr',
        totalPrsCreated: 5,
        maxPrs: 5,
        endTime: new Date('2025-06-01T11:00:00Z').getTime(),
      }))).toBe(false);
    });

    it('all conditions passing returns true', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2025-06-01T12:00:00Z'));

      expect(shouldContinue(makeState({
        shutdownRequested: false,
        deliveryMode: 'pr',
        totalPrsCreated: 2,
        maxPrs: 5,
        endTime: new Date('2025-06-01T13:00:00Z').getTime(),
        cycleCount: 1,
        maxCycles: 10,
        runMode: 'planning',
      }))).toBe(true);
    });
  });
});
