/**
 * I/O tests for goals.ts — loadGoals, readGoalState, writeGoalState.
 *
 * Separate from goals.test.ts which uses vi.mock('node:fs') for the
 * pure-logic tests (measureGoals, pickGoalByGap, etc.).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { loadGoals, readGoalState, writeGoalState, type GoalState } from '../lib/goals.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

function goalsDir(): string {
  return path.join(tmpDir, '.promptwheel', 'goals');
}

function writeGoalYaml(filename: string, content: string): void {
  const dir = goalsDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, filename), content, 'utf-8');
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'goals-io-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// loadGoals
// ---------------------------------------------------------------------------

describe('loadGoals', () => {
  it('returns empty array when goals directory does not exist', () => {
    const goals = loadGoals(tmpDir);
    expect(goals).toEqual([]);
  });

  it('returns empty array when goals directory is empty', () => {
    fs.mkdirSync(goalsDir(), { recursive: true });
    const goals = loadGoals(tmpDir);
    expect(goals).toEqual([]);
  });

  it('parses a valid goal YAML file with all measure fields', () => {
    writeGoalYaml('coverage.yaml', [
      'name: test-coverage',
      'description: Increase test coverage to 80%',
      'categories: test',
      'measure_cmd: echo 75',
      'measure_target: 80',
      'measure_direction: up',
    ].join('\n'));

    const goals = loadGoals(tmpDir);
    expect(goals).toHaveLength(1);
    expect(goals[0].name).toBe('test-coverage');
    expect(goals[0].description).toBe('Increase test coverage to 80%');
    expect(goals[0].measure).toBeDefined();
    expect(goals[0].measure!.cmd).toBe('echo 75');
    expect(goals[0].measure!.target).toBe(80);
    expect(goals[0].measure!.direction).toBe('up');
  });

  it('uses filename as name when name field is absent', () => {
    writeGoalYaml('reduce-bundle.yaml', [
      'description: Reduce bundle size',
      'measure_cmd: echo 500',
      'measure_target: 400',
      'measure_direction: down',
    ].join('\n'));

    const goals = loadGoals(tmpDir);
    expect(goals).toHaveLength(1);
    expect(goals[0].name).toBe('reduce-bundle');
  });

  it('skips files missing measure_cmd', () => {
    writeGoalYaml('no-cmd.yaml', [
      'name: no-cmd',
      'measure_target: 80',
      'measure_direction: up',
    ].join('\n'));

    const goals = loadGoals(tmpDir);
    expect(goals).toEqual([]);
  });

  it('skips files missing measure_target', () => {
    writeGoalYaml('no-target.yaml', [
      'name: no-target',
      'measure_cmd: echo 50',
      'measure_direction: up',
    ].join('\n'));

    const goals = loadGoals(tmpDir);
    expect(goals).toEqual([]);
  });

  it('skips files missing measure_direction', () => {
    writeGoalYaml('no-direction.yaml', [
      'name: no-direction',
      'measure_cmd: echo 50',
      'measure_target: 80',
    ].join('\n'));

    const goals = loadGoals(tmpDir);
    expect(goals).toEqual([]);
  });

  it('loads multiple goal files', () => {
    writeGoalYaml('goal-a.yaml', [
      'name: goal-a',
      'measure_cmd: echo 10',
      'measure_target: 20',
      'measure_direction: up',
    ].join('\n'));

    writeGoalYaml('goal-b.yml', [
      'name: goal-b',
      'measure_cmd: echo 100',
      'measure_target: 50',
      'measure_direction: down',
    ].join('\n'));

    const goals = loadGoals(tmpDir);
    expect(goals).toHaveLength(2);
    const names = goals.map(g => g.name).sort();
    expect(names).toEqual(['goal-a', 'goal-b']);
  });

  it('ignores non-yaml files', () => {
    writeGoalYaml('readme.txt', 'This is not a goal file');
    writeGoalYaml('valid.yaml', [
      'name: valid-goal',
      'measure_cmd: echo 1',
      'measure_target: 10',
      'measure_direction: up',
    ].join('\n'));

    // The txt file is in the directory but should be filtered by extension
    const goals = loadGoals(tmpDir);
    expect(goals).toHaveLength(1);
    expect(goals[0].name).toBe('valid-goal');
  });

  it('skips malformed YAML gracefully', () => {
    writeGoalYaml('valid.yaml', [
      'name: valid',
      'measure_cmd: echo 1',
      'measure_target: 10',
      'measure_direction: up',
    ].join('\n'));

    // Write a file that will cause JSON.parse to throw but parseSimpleYaml handles it
    writeGoalYaml('broken.yaml', '\x00\x01\x02');

    const goals = loadGoals(tmpDir);
    // At least the valid goal should load
    expect(goals.length).toBeGreaterThanOrEqual(1);
    expect(goals.some(g => g.name === 'valid')).toBe(true);
  });

  it('parses min_confidence from YAML', () => {
    writeGoalYaml('with-conf.yaml', [
      'name: with-confidence',
      'min_confidence: 70',
      'measure_cmd: echo 1',
      'measure_target: 10',
      'measure_direction: up',
    ].join('\n'));

    const goals = loadGoals(tmpDir);
    expect(goals).toHaveLength(1);
    expect(goals[0].minConfidence).toBe(70);
  });
});

// ---------------------------------------------------------------------------
// readGoalState / writeGoalState
// ---------------------------------------------------------------------------

describe('readGoalState', () => {
  it('returns default state when file does not exist', () => {
    const state = readGoalState(tmpDir);
    expect(state).toEqual({ measurements: {}, lastUpdated: 0 });
  });

  it('returns default state when .promptwheel directory does not exist', () => {
    const nonExistent = path.join(os.tmpdir(), 'no-such-dir-' + Date.now());
    const state = readGoalState(nonExistent);
    expect(state).toEqual({ measurements: {}, lastUpdated: 0 });
  });

  it('returns default state for corrupted file', () => {
    const stateDir = path.join(tmpDir, '.promptwheel');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'goal-state.json'), 'not valid json', 'utf-8');

    const state = readGoalState(tmpDir);
    expect(state).toEqual({ measurements: {}, lastUpdated: 0 });
  });
});

describe('writeGoalState', () => {
  it('creates .promptwheel directory if missing', () => {
    const state: GoalState = { measurements: {}, lastUpdated: 0 };
    writeGoalState(tmpDir, state);

    expect(fs.existsSync(path.join(tmpDir, '.promptwheel', 'goal-state.json'))).toBe(true);
  });

  it('round-trips state through write and read', () => {
    const state: GoalState = {
      measurements: {
        'test-goal': [
          { value: 50, timestamp: 1000000 },
          { value: 60, timestamp: 2000000 },
        ],
      },
      lastUpdated: 0,
    };

    writeGoalState(tmpDir, state);
    const loaded = readGoalState(tmpDir);

    expect(loaded.measurements['test-goal']).toHaveLength(2);
    expect(loaded.measurements['test-goal'][0].value).toBe(50);
    expect(loaded.measurements['test-goal'][1].value).toBe(60);
    // writeGoalState sets lastUpdated to Date.now()
    expect(loaded.lastUpdated).toBeGreaterThan(0);
  });

  it('preserves error field in measurement entries', () => {
    const state: GoalState = {
      measurements: {
        'failing-goal': [
          { value: null, timestamp: 1000000, error: 'Command timed out' },
        ],
      },
      lastUpdated: 0,
    };

    writeGoalState(tmpDir, state);
    const loaded = readGoalState(tmpDir);

    expect(loaded.measurements['failing-goal'][0].value).toBeNull();
    expect(loaded.measurements['failing-goal'][0].error).toBe('Command timed out');
  });

  it('overwrites existing state file', () => {
    const state1: GoalState = {
      measurements: { a: [{ value: 1, timestamp: 100 }] },
      lastUpdated: 0,
    };
    const state2: GoalState = {
      measurements: { b: [{ value: 2, timestamp: 200 }] },
      lastUpdated: 0,
    };

    writeGoalState(tmpDir, state1);
    writeGoalState(tmpDir, state2);

    const loaded = readGoalState(tmpDir);
    expect(loaded.measurements['b']).toBeDefined();
    expect(loaded.measurements['a']).toBeUndefined();
  });
});
