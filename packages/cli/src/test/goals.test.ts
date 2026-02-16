/**
 * Tests for goals — gap calculation, goal selection, formatting, and ring buffer.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Formula } from '@blockspool/core/formulas/shared';
import type { GoalMeasurement } from '../lib/goals.js';

// We need to mock fs and child_process before importing the module under test.
vi.mock('node:fs');
vi.mock('node:child_process');

// Import after mocking
const { measureGoals, pickGoalByGap, formatGoalContext, recordGoalMeasurement, runMeasurement } =
  await import('../lib/goals.js');
const fs = await import('node:fs');
const { execFileSync } = await import('node:child_process');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeGoal(overrides: Partial<Formula> & { measure: Formula['measure'] }): Formula {
  return {
    name: overrides.name ?? 'test-goal',
    description: overrides.description ?? 'A test goal',
    ...overrides,
  };
}

function makeMeasurement(overrides: Partial<GoalMeasurement> = {}): GoalMeasurement {
  return {
    goalName: 'test-goal',
    current: 50,
    target: 100,
    direction: 'up',
    gapPercent: 50,
    met: false,
    measuredAt: Date.now(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// measureGoals — gap calculation
// ---------------------------------------------------------------------------

describe('measureGoals', () => {
  beforeEach(() => {
    vi.mocked(execFileSync).mockReturnValue('50\n');
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('skips goals without a measure field', () => {
    const goals: Formula[] = [
      { name: 'no-measure', description: 'no measure field' },
    ];
    const result = measureGoals(goals, '/repo');
    expect(result).toHaveLength(0);
  });

  // -- UP direction -----------------------------------------------------------

  describe('direction: up (higher is better)', () => {
    it('value < target: gap is proportional distance from target', () => {
      vi.mocked(execFileSync).mockReturnValue('60\n');
      const goals = [makeGoal({ measure: { cmd: 'echo 60', target: 100, direction: 'up' } })];
      const [m] = measureGoals(goals, '/repo');
      // gap = (100 - 60) / 100 * 100 = 40%
      expect(m.gapPercent).toBe(40);
      expect(m.met).toBe(false);
    });

    it('value >= target: goal is met, gap = 0', () => {
      vi.mocked(execFileSync).mockReturnValue('100\n');
      const goals = [makeGoal({ measure: { cmd: 'echo 100', target: 100, direction: 'up' } })];
      const [m] = measureGoals(goals, '/repo');
      expect(m.gapPercent).toBe(0);
      expect(m.met).toBe(true);
    });

    it('value exceeds target: still met', () => {
      vi.mocked(execFileSync).mockReturnValue('120\n');
      const goals = [makeGoal({ measure: { cmd: 'echo 120', target: 100, direction: 'up' } })];
      const [m] = measureGoals(goals, '/repo');
      expect(m.gapPercent).toBe(0);
      expect(m.met).toBe(true);
    });

    it('target = 0 and value < target (negative): gap stays at initial 100%', () => {
      vi.mocked(execFileSync).mockReturnValue('-5\n');
      const goals = [makeGoal({ measure: { cmd: 'echo -5', target: 0, direction: 'up' } })];
      const [m] = measureGoals(goals, '/repo');
      // value (-5) < target (0), target === 0 so the (target-value)/target branch is skipped
      // gapPercent remains at the initial value of 100
      expect(m.gapPercent).toBe(100);
      expect(m.met).toBe(false);
    });

    it('target = 0 and value = 0: met', () => {
      vi.mocked(execFileSync).mockReturnValue('0\n');
      const goals = [makeGoal({ measure: { cmd: 'echo 0', target: 0, direction: 'up' } })];
      const [m] = measureGoals(goals, '/repo');
      expect(m.gapPercent).toBe(0);
      expect(m.met).toBe(true);
    });

    it('value = 0, target > 0: full gap', () => {
      vi.mocked(execFileSync).mockReturnValue('0\n');
      const goals = [makeGoal({ measure: { cmd: 'echo 0', target: 80, direction: 'up' } })];
      const [m] = measureGoals(goals, '/repo');
      // gap = (80 - 0) / 80 * 100 = 100%
      expect(m.gapPercent).toBe(100);
      expect(m.met).toBe(false);
    });
  });

  // -- DOWN direction ---------------------------------------------------------

  describe('direction: down (lower is better)', () => {
    it('value > target: gap proportional to how far above target', () => {
      vi.mocked(execFileSync).mockReturnValue('80\n');
      const goals = [makeGoal({ measure: { cmd: 'echo 80', target: 20, direction: 'down' } })];
      const [m] = measureGoals(goals, '/repo');
      // gap = (80 - 20) / 80 * 100 = 75%
      expect(m.gapPercent).toBe(75);
      expect(m.met).toBe(false);
    });

    it('value <= target: goal is met, gap = 0', () => {
      vi.mocked(execFileSync).mockReturnValue('10\n');
      const goals = [makeGoal({ measure: { cmd: 'echo 10', target: 20, direction: 'down' } })];
      const [m] = measureGoals(goals, '/repo');
      expect(m.gapPercent).toBe(0);
      expect(m.met).toBe(true);
    });

    it('value equals target: met', () => {
      vi.mocked(execFileSync).mockReturnValue('20\n');
      const goals = [makeGoal({ measure: { cmd: 'echo 20', target: 20, direction: 'down' } })];
      const [m] = measureGoals(goals, '/repo');
      expect(m.gapPercent).toBe(0);
      expect(m.met).toBe(true);
    });

    it('target = 0, value > 0: gap = 100%', () => {
      vi.mocked(execFileSync).mockReturnValue('42\n');
      const goals = [makeGoal({ measure: { cmd: 'echo 42', target: 0, direction: 'down' } })];
      const [m] = measureGoals(goals, '/repo');
      // special case: target=0 and value>0 → 100%
      expect(m.gapPercent).toBe(100);
      expect(m.met).toBe(false);
    });

    it('target = 0, value = 0: met', () => {
      vi.mocked(execFileSync).mockReturnValue('0\n');
      const goals = [makeGoal({ measure: { cmd: 'echo 0', target: 0, direction: 'down' } })];
      const [m] = measureGoals(goals, '/repo');
      expect(m.gapPercent).toBe(0);
      expect(m.met).toBe(true);
    });

    it('target = 0, value = 0 (exact edge): gap is 0, met', () => {
      vi.mocked(execFileSync).mockReturnValue('0\n');
      const goals = [makeGoal({ measure: { cmd: 'echo 0', target: 0, direction: 'down' } })];
      const [m] = measureGoals(goals, '/repo');
      expect(m.gapPercent).toBe(0);
      expect(m.met).toBe(true);
    });
  });

  // -- Measurement failure ----------------------------------------------------

  describe('measurement failure', () => {
    it('null value: gap defaults to 100%, not met', () => {
      vi.mocked(execFileSync).mockImplementation(() => {
        throw new Error('command failed');
      });
      const goals = [makeGoal({ measure: { cmd: 'fail', target: 50, direction: 'up' } })];
      const [m] = measureGoals(goals, '/repo');
      expect(m.current).toBeNull();
      expect(m.gapPercent).toBe(100);
      expect(m.met).toBe(false);
      expect(m.error).toBeDefined();
    });
  });

  // -- Rounding ---------------------------------------------------------------

  describe('rounding', () => {
    it('rounds gap to 1 decimal place', () => {
      // value=33, target=100, up: gap = (100-33)/100 = 67%
      vi.mocked(execFileSync).mockReturnValue('33\n');
      const goals = [makeGoal({ measure: { cmd: 'echo 33', target: 100, direction: 'up' } })];
      const [m] = measureGoals(goals, '/repo');
      expect(m.gapPercent).toBe(67);
    });

    it('rounds fractional gap correctly', () => {
      // value=33, target=99, up: gap = (99-33)/99*100 = 66.6666...
      vi.mocked(execFileSync).mockReturnValue('33\n');
      const goals = [makeGoal({ measure: { cmd: 'echo 33', target: 99, direction: 'up' } })];
      const [m] = measureGoals(goals, '/repo');
      expect(m.gapPercent).toBe(66.7);
    });
  });

  // -- Multiple goals ---------------------------------------------------------

  it('measures multiple goals independently', () => {
    vi.mocked(execFileSync)
      .mockReturnValueOnce('80\n')
      .mockReturnValueOnce('5\n');

    const goals = [
      makeGoal({ name: 'coverage', measure: { cmd: 'echo 80', target: 90, direction: 'up' } }),
      makeGoal({ name: 'errors', measure: { cmd: 'echo 5', target: 0, direction: 'down' } }),
    ];
    const results = measureGoals(goals, '/repo');
    expect(results).toHaveLength(2);
    expect(results[0].goalName).toBe('coverage');
    expect(results[1].goalName).toBe('errors');
  });
});

// ---------------------------------------------------------------------------
// pickGoalByGap
// ---------------------------------------------------------------------------

describe('pickGoalByGap', () => {
  it('picks the goal with the largest gap', () => {
    const measurements: GoalMeasurement[] = [
      makeMeasurement({ goalName: 'small-gap', gapPercent: 10, met: false }),
      makeMeasurement({ goalName: 'big-gap', gapPercent: 80, met: false }),
      makeMeasurement({ goalName: 'medium-gap', gapPercent: 50, met: false }),
    ];
    const result = pickGoalByGap(measurements);
    expect(result).not.toBeNull();
    expect(result!.goalName).toBe('big-gap');
  });

  it('returns null when all goals are met', () => {
    const measurements: GoalMeasurement[] = [
      makeMeasurement({ goalName: 'a', gapPercent: 0, met: true }),
      makeMeasurement({ goalName: 'b', gapPercent: 0, met: true }),
    ];
    const result = pickGoalByGap(measurements);
    expect(result).toBeNull();
  });

  it('returns null for empty measurements', () => {
    expect(pickGoalByGap([])).toBeNull();
  });

  it('skips errored goals (current = null)', () => {
    const measurements: GoalMeasurement[] = [
      makeMeasurement({ goalName: 'errored', current: null, gapPercent: 100, met: false }),
      makeMeasurement({ goalName: 'valid', current: 30, gapPercent: 70, met: false }),
    ];
    const result = pickGoalByGap(measurements);
    expect(result).not.toBeNull();
    expect(result!.goalName).toBe('valid');
  });

  it('skips met goals even if they have a non-zero gap', () => {
    const measurements: GoalMeasurement[] = [
      makeMeasurement({ goalName: 'met-but-gap', gapPercent: 90, met: true }),
      makeMeasurement({ goalName: 'unmet', gapPercent: 30, met: false }),
    ];
    const result = pickGoalByGap(measurements);
    expect(result!.goalName).toBe('unmet');
  });

  it('returns null when all are errored', () => {
    const measurements: GoalMeasurement[] = [
      makeMeasurement({ goalName: 'err1', current: null, gapPercent: 100, met: false }),
      makeMeasurement({ goalName: 'err2', current: null, gapPercent: 50, met: false }),
    ];
    expect(pickGoalByGap(measurements)).toBeNull();
  });

  it('breaks ties deterministically (first in sorted order wins)', () => {
    const measurements: GoalMeasurement[] = [
      makeMeasurement({ goalName: 'a', gapPercent: 50, met: false }),
      makeMeasurement({ goalName: 'b', gapPercent: 50, met: false }),
    ];
    // Both have same gap; the sort is stable so 'a' (first) should win
    const result = pickGoalByGap(measurements);
    expect(result).not.toBeNull();
    expect(result!.goalName).toBe('a');
  });
});

// ---------------------------------------------------------------------------
// formatGoalContext
// ---------------------------------------------------------------------------

describe('formatGoalContext', () => {
  it('formats up-direction goal context', () => {
    const goal = makeGoal({ name: 'coverage', description: 'Increase test coverage', measure: { cmd: 'cov', target: 90, direction: 'up' } });
    const measurement = makeMeasurement({ goalName: 'coverage', current: 60, target: 90, direction: 'up', gapPercent: 33.3 });
    const output = formatGoalContext(goal, measurement);

    expect(output).toContain('<goal>');
    expect(output).toContain('</goal>');
    expect(output).toContain('Active goal: coverage');
    expect(output).toContain('Increase test coverage');
    expect(output).toContain('Current: 60 | Target: 90');
    expect(output).toContain('higher is better');
    expect(output).toContain('Gap: 33.3%');
  });

  it('formats down-direction goal context', () => {
    const goal = makeGoal({ name: 'errors', description: 'Reduce errors', measure: { cmd: 'err', target: 0, direction: 'down' } });
    const measurement = makeMeasurement({ goalName: 'errors', current: 15, target: 0, direction: 'down', gapPercent: 100 });
    const output = formatGoalContext(goal, measurement);

    expect(output).toContain('lower is better');
    expect(output).toContain('Gap: 100%');
  });

  it('uses correct arrow for up direction', () => {
    const goal = makeGoal({ measure: { cmd: 'x', target: 100, direction: 'up' } });
    const measurement = makeMeasurement({ direction: 'up' });
    const output = formatGoalContext(goal, measurement);
    // The up arrow character
    expect(output).toMatch(/↑/);
  });

  it('uses correct arrow for down direction', () => {
    const goal = makeGoal({ measure: { cmd: 'x', target: 0, direction: 'down' } });
    const measurement = makeMeasurement({ direction: 'down' });
    const output = formatGoalContext(goal, measurement);
    expect(output).toMatch(/↓/);
  });
});

// ---------------------------------------------------------------------------
// recordGoalMeasurement — ring buffer
// ---------------------------------------------------------------------------

describe('recordGoalMeasurement', () => {
  beforeEach(() => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.writeFileSync).mockImplementation(() => {});
    // Default: empty goal state. Individual tests override readFileSync as needed.
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      measurements: {},
      lastUpdated: 0,
    }));
    vi.mocked(fs.mkdirSync).mockImplementation(() => undefined as any);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('creates a new entry for a new goal', () => {
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      measurements: {},
      lastUpdated: 0,
    }));

    recordGoalMeasurement('/repo', makeMeasurement({ goalName: 'new-goal', current: 42 }));

    const writeCall = vi.mocked(fs.writeFileSync).mock.calls[0];
    const written = JSON.parse(writeCall[1] as string);
    expect(written.measurements['new-goal']).toHaveLength(1);
    expect(written.measurements['new-goal'][0].value).toBe(42);
  });

  it('appends to existing entries', () => {
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      measurements: {
        'existing': [{ value: 10, timestamp: 1000 }],
      },
      lastUpdated: 1000,
    }));

    recordGoalMeasurement('/repo', makeMeasurement({ goalName: 'existing', current: 20 }));

    const writeCall = vi.mocked(fs.writeFileSync).mock.calls[0];
    const written = JSON.parse(writeCall[1] as string);
    expect(written.measurements['existing']).toHaveLength(2);
    expect(written.measurements['existing'][1].value).toBe(20);
  });

  it('caps ring buffer at 50 entries', () => {
    const existing = Array.from({ length: 50 }, (_, i) => ({
      value: i,
      timestamp: i * 1000,
    }));

    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      measurements: { 'capped': existing },
      lastUpdated: 50000,
    }));

    recordGoalMeasurement('/repo', makeMeasurement({ goalName: 'capped', current: 999 }));

    const writeCall = vi.mocked(fs.writeFileSync).mock.calls[0];
    const written = JSON.parse(writeCall[1] as string);
    // Should still be 50 entries (oldest dropped, newest added)
    expect(written.measurements['capped']).toHaveLength(50);
    // First entry should be the old second (index 1), not the old first (index 0)
    expect(written.measurements['capped'][0].value).toBe(1);
    // Last entry should be the newly added one
    expect(written.measurements['capped'][49].value).toBe(999);
  });

  it('does not cap when under 50 entries', () => {
    const existing = Array.from({ length: 30 }, (_, i) => ({
      value: i,
      timestamp: i * 1000,
    }));

    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      measurements: { 'under': existing },
      lastUpdated: 30000,
    }));

    recordGoalMeasurement('/repo', makeMeasurement({ goalName: 'under', current: 777 }));

    const writeCall = vi.mocked(fs.writeFileSync).mock.calls[0];
    const written = JSON.parse(writeCall[1] as string);
    expect(written.measurements['under']).toHaveLength(31);
  });

  it('records error field when present', () => {
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      measurements: {},
      lastUpdated: 0,
    }));

    recordGoalMeasurement('/repo', makeMeasurement({
      goalName: 'errored',
      current: null,
      error: 'command failed',
    }));

    const writeCall = vi.mocked(fs.writeFileSync).mock.calls[0];
    const written = JSON.parse(writeCall[1] as string);
    expect(written.measurements['errored'][0].error).toBe('command failed');
    expect(written.measurements['errored'][0].value).toBeNull();
  });
});
