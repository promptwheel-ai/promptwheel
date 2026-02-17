import { describe, it, expect } from 'vitest';
import {
  computeAdaptiveInterval,
  isInQuietHours,
  createInitialDaemonState,
  DEFAULT_DAEMON_CONFIG,
  type DaemonConfig,
  type DaemonState,
} from '../lib/daemon.js';

// ── computeAdaptiveInterval ──────────────────────────────────────────────────

describe('computeAdaptiveInterval', () => {
  const config: DaemonConfig = { ...DEFAULT_DAEMON_CONFIG, pollIntervalMinutes: 30 };
  const baseMs = 30 * 60_000;

  function makeState(overrides: Partial<DaemonState> = {}): DaemonState {
    return { ...createInitialDaemonState(config), ...overrides };
  }

  it('halves interval when work done and new commits', () => {
    const interval = computeAdaptiveInterval(
      makeState(),
      config,
      { hadWork: true, hadNewCommits: true, isQuietBoost: false },
    );
    expect(interval).toBe(baseMs * 0.5);
  });

  it('keeps base interval when new commits but no proposals', () => {
    const interval = computeAdaptiveInterval(
      makeState(),
      config,
      { hadWork: false, hadNewCommits: true, isQuietBoost: false },
    );
    expect(interval).toBe(baseMs);
  });

  it('lengthens interval when no new commits', () => {
    const interval = computeAdaptiveInterval(
      makeState({ consecutiveNoWorkCycles: 0 }),
      config,
      { hadWork: false, hadNewCommits: false, isQuietBoost: false },
    );
    expect(interval).toBe(baseMs * 1.5);
  });

  it('further lengthens with more consecutive idle cycles', () => {
    const interval = computeAdaptiveInterval(
      makeState({ consecutiveNoWorkCycles: 3 }),
      config,
      { hadWork: false, hadNewCommits: false, isQuietBoost: false },
    );
    // 1.5 + 3*0.25 = 2.25
    expect(interval).toBe(Math.round(baseMs * 2.25));
  });

  it('caps lengthening at 3x', () => {
    const interval = computeAdaptiveInterval(
      makeState({ consecutiveNoWorkCycles: 100 }),
      config,
      { hadWork: false, hadNewCommits: false, isQuietBoost: false },
    );
    expect(interval).toBe(baseMs * 3);
  });

  it('uses boost multiplier in quiet hours', () => {
    const interval = computeAdaptiveInterval(
      makeState(),
      config,
      { hadWork: false, hadNewCommits: false, isQuietBoost: true },
    );
    // 0.25 * 30min = 7.5min, but floor is 5min
    expect(interval).toBe(Math.round(baseMs * 0.25));
  });

  it('enforces 5-minute floor', () => {
    const shortConfig: DaemonConfig = { ...config, pollIntervalMinutes: 1 };
    const interval = computeAdaptiveInterval(
      makeState(),
      shortConfig,
      { hadWork: true, hadNewCommits: true, isQuietBoost: false },
    );
    expect(interval).toBe(5 * 60_000);
  });

  it('enforces ceiling at 3x base', () => {
    const interval = computeAdaptiveInterval(
      makeState({ consecutiveNoWorkCycles: 50 }),
      config,
      { hadWork: false, hadNewCommits: false, isQuietBoost: false },
    );
    expect(interval).toBe(baseMs * 3);
  });
});

// ── isInQuietHours ───────────────────────────────────────────────────────────

describe('isInQuietHours', () => {
  it('returns false when no quiet hours configured', () => {
    expect(isInQuietHours(DEFAULT_DAEMON_CONFIG)).toBe(false);
  });

  it('detects time within same-day window', () => {
    const config: DaemonConfig = {
      ...DEFAULT_DAEMON_CONFIG,
      quietHours: { start: '09:00', end: '17:00', policy: 'pause' },
    };
    // 12:00 is within 09:00-17:00
    expect(isInQuietHours(config, new Date('2024-01-01T12:00:00'))).toBe(true);
    // 08:00 is outside
    expect(isInQuietHours(config, new Date('2024-01-01T08:00:00'))).toBe(false);
    // 18:00 is outside
    expect(isInQuietHours(config, new Date('2024-01-01T18:00:00'))).toBe(false);
  });

  it('detects time within midnight-crossing window', () => {
    const config: DaemonConfig = {
      ...DEFAULT_DAEMON_CONFIG,
      quietHours: { start: '22:00', end: '06:00', policy: 'pause' },
    };
    // 23:00 is within 22:00-06:00
    expect(isInQuietHours(config, new Date('2024-01-01T23:00:00'))).toBe(true);
    // 03:00 is within 22:00-06:00
    expect(isInQuietHours(config, new Date('2024-01-01T03:00:00'))).toBe(true);
    // 12:00 is outside
    expect(isInQuietHours(config, new Date('2024-01-01T12:00:00'))).toBe(false);
    // 07:00 is outside
    expect(isInQuietHours(config, new Date('2024-01-01T07:00:00'))).toBe(false);
  });

  it('handles boundary: start time is inclusive', () => {
    const config: DaemonConfig = {
      ...DEFAULT_DAEMON_CONFIG,
      quietHours: { start: '22:00', end: '06:00', policy: 'pause' },
    };
    expect(isInQuietHours(config, new Date('2024-01-01T22:00:00'))).toBe(true);
  });

  it('handles boundary: end time is exclusive', () => {
    const config: DaemonConfig = {
      ...DEFAULT_DAEMON_CONFIG,
      quietHours: { start: '22:00', end: '06:00', policy: 'pause' },
    };
    expect(isInQuietHours(config, new Date('2024-01-01T06:00:00'))).toBe(false);
  });
});

// ── createInitialDaemonState ─────────────────────────────────────────────────

describe('createInitialDaemonState', () => {
  it('creates state with correct defaults', () => {
    const state = createInitialDaemonState(DEFAULT_DAEMON_CONFIG);
    expect(state.startedAt).toBeGreaterThan(0);
    expect(state.lastWakeAt).toBe(0);
    expect(state.totalWakes).toBe(0);
    expect(state.consecutiveNoWorkCycles).toBe(0);
    expect(state.currentInterval).toBe(30 * 60_000);
  });

  it('respects custom interval', () => {
    const config: DaemonConfig = { ...DEFAULT_DAEMON_CONFIG, pollIntervalMinutes: 15 };
    const state = createInitialDaemonState(config);
    expect(state.currentInterval).toBe(15 * 60_000);
  });
});
