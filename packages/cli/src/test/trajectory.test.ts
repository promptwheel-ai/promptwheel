/**
 * Integration tests for CLI trajectory I/O layer (filesystem-backed).
 *
 * Exercises:
 * - Loading YAML definitions from `.promptwheel/trajectories`
 * - State save/load roundtrips in `.promptwheel/trajectory-state.json`
 * - Activation behavior (first ready step becomes active; deterministic startedAt)
 * - State clearing (idempotent delete)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  loadTrajectories,
  loadTrajectory,
  loadTrajectoryState,
  saveTrajectoryState,
  clearTrajectoryState,
  activateTrajectory,
} from '../lib/trajectory.js';
import type { TrajectoryState } from '@promptwheel/core/trajectory/shared';

let tmpDir: string;

function trajectoriesDir(): string {
  return path.join(tmpDir, '.promptwheel', 'trajectories');
}

function trajectoryStateFile(): string {
  return path.join(tmpDir, '.promptwheel', 'trajectory-state.json');
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trajectory-io-test-'));
});

afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('loadTrajectories / loadTrajectory', () => {
  it('returns empty array when trajectories directory does not exist', () => {
    expect(loadTrajectories(tmpDir)).toEqual([]);
  });

  it('loads valid YAML definitions and skips malformed entries', () => {
    fs.mkdirSync(trajectoriesDir(), { recursive: true });

    // Valid .yaml
    fs.writeFileSync(
      path.join(trajectoriesDir(), 'good.yaml'),
      `name: good
description: Good trajectory
steps:
  - id: step1
    title: First
    description: Do first
    acceptance_criteria:
      - A
    verification_commands:
      - echo ok
    depends_on: []
`,
      'utf-8',
    );

    // Valid .yml
    fs.writeFileSync(
      path.join(trajectoriesDir(), 'also.yml'),
      `name: also
description: Another trajectory
steps:
  - id: s
    title: Only
    description: Do only
    acceptance_criteria:
      - B
    verification_commands:
      - echo ok
    depends_on: []
`,
      'utf-8',
    );

    // Empty file -> parseTrajectoryYaml('') yields no name/steps -> should be ignored.
    fs.writeFileSync(path.join(trajectoriesDir(), 'empty.yaml'), '', 'utf-8');

    // "Malformed" file (not real YAML) -> parser yields no name/steps -> should be ignored.
    fs.writeFileSync(path.join(trajectoriesDir(), 'garbage.yaml'), '::: not yaml :::', 'utf-8');

    // Invalid: missing name -> should be skipped (name is falsy).
    fs.writeFileSync(
      path.join(trajectoriesDir(), 'no-name.yaml'),
      `description: Missing name
steps:
  - id: x
    title: X
    description: X
    acceptance_criteria:
      - A
    verification_commands:
      - echo ok
`,
      'utf-8',
    );

    // Invalid: name present but no steps -> should be skipped (steps.length === 0).
    fs.writeFileSync(
      path.join(trajectoriesDir(), 'empty-steps.yaml'),
      `name: empty
description: No steps
steps:
`,
      'utf-8',
    );

    // Failure-path I/O: directory with .yaml suffix -> readFileSync throws -> skipped.
    fs.mkdirSync(path.join(trajectoriesDir(), 'bad.yaml'), { recursive: true });

    const trajectories = loadTrajectories(tmpDir);
    const names = trajectories.map(t => t.name).sort();
    expect(names).toEqual(['also', 'good']);
  });

  it('loads a single trajectory by name (or null)', () => {
    fs.mkdirSync(trajectoriesDir(), { recursive: true });
    fs.writeFileSync(
      path.join(trajectoriesDir(), 't.yaml'),
      `name: pick-me
description: d
steps:
  - id: a
    title: A
    description: d
    acceptance_criteria:
      - A
    verification_commands:
      - echo ok
    depends_on: []
`,
      'utf-8',
    );

    expect(loadTrajectory(tmpDir, 'pick-me')?.name).toBe('pick-me');
    expect(loadTrajectory(tmpDir, 'missing')).toBeNull();
  });
});

describe('loadTrajectoryState / saveTrajectoryState / clearTrajectoryState', () => {
  it('returns null when no state exists', () => {
    expect(loadTrajectoryState(tmpDir)).toBeNull();
  });

  it('round-trips through save and load (auto-creates .promptwheel directory)', () => {
    const state: TrajectoryState = {
      trajectoryName: 't',
      startedAt: 1700000000000,
      currentStepId: 'a',
      paused: false,
      stepStates: {
        a: { stepId: 'a', status: 'active', cyclesAttempted: 0, lastAttemptedCycle: 0 },
      },
    };

    saveTrajectoryState(tmpDir, state);

    expect(fs.existsSync(trajectoryStateFile())).toBe(true);
    expect(loadTrajectoryState(tmpDir)).toEqual(state);
  });

  it('returns null when state file is corrupted JSON', () => {
    fs.mkdirSync(path.dirname(trajectoryStateFile()), { recursive: true });
    fs.writeFileSync(trajectoryStateFile(), 'not json', 'utf-8');
    expect(loadTrajectoryState(tmpDir)).toBeNull();
  });

  it('clears state idempotently', () => {
    expect(() => clearTrajectoryState(tmpDir)).not.toThrow();
    expect(() => clearTrajectoryState(tmpDir)).not.toThrow();

    const state: TrajectoryState = {
      trajectoryName: 't',
      startedAt: 1700000000000,
      currentStepId: null,
      paused: false,
      stepStates: {},
    };
    saveTrajectoryState(tmpDir, state);
    expect(fs.existsSync(trajectoryStateFile())).toBe(true);

    expect(() => clearTrajectoryState(tmpDir)).not.toThrow();
    expect(fs.existsSync(trajectoryStateFile())).toBe(false);

    expect(() => clearTrajectoryState(tmpDir)).not.toThrow();
    expect(fs.existsSync(trajectoryStateFile())).toBe(false);
  });
});

describe('activateTrajectory', () => {
  it('returns null and does not write state when trajectory does not exist', () => {
    expect(activateTrajectory(tmpDir, 'missing')).toBeNull();
    expect(fs.existsSync(trajectoryStateFile())).toBe(false);
  });

  it('activates the first ready step and persists deterministic startedAt', () => {
    fs.mkdirSync(trajectoriesDir(), { recursive: true });
    fs.writeFileSync(
      path.join(trajectoriesDir(), 'my.yaml'),
      `name: my-trajectory
description: test
steps:
  - id: step1
    title: Blocked
    description: blocked by deps
    depends_on: [missing]

  - id: step2
    title: Ready
    description: ready
    depends_on: []
`,
      'utf-8',
    );

    const now = new Date('2025-01-01T00:00:00.000Z');
    vi.useFakeTimers();
    vi.setSystemTime(now);

    const state = activateTrajectory(tmpDir, 'my-trajectory');
    expect(state).not.toBeNull();
    expect(state!.trajectoryName).toBe('my-trajectory');
    expect(state!.startedAt).toBe(now.getTime());
    expect(state!.paused).toBe(false);

    // step1 is blocked; step2 is the first ready step in declaration order.
    expect(state!.currentStepId).toBe('step2');
    expect(state!.stepStates.step1.status).toBe('pending');
    expect(state!.stepStates.step2.status).toBe('active');

    // Persisted to disk.
    expect(loadTrajectoryState(tmpDir)).toEqual(state);
  });

  it('returns null for trajectory with circular dependencies', () => {
    fs.mkdirSync(trajectoriesDir(), { recursive: true });
    fs.writeFileSync(
      path.join(trajectoriesDir(), 'cycle.yaml'),
      `name: cycle-traj
description: has cycle
steps:
  - id: a
    title: A
    description: d
    depends_on: [b]
  - id: b
    title: B
    description: d
    depends_on: [a]
`,
      'utf-8',
    );

    const state = activateTrajectory(tmpDir, 'cycle-traj');
    expect(state).toBeNull();
    expect(fs.existsSync(trajectoryStateFile())).toBe(false);
  });
});
