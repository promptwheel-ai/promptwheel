/**
 * Trajectory algorithm tests — covers all pure functions in trajectory/shared.ts:
 *   - stepReady
 *   - getNextStep
 *   - trajectoryComplete
 *   - trajectoryStuck
 *   - formatTrajectoryForPrompt
 *   - parseTrajectoryYaml
 *   - createInitialStepStates
 *
 * Tests pure functions only (no filesystem).
 */

import { describe, it, expect } from 'vitest';
import {
  stepReady,
  getNextStep,
  trajectoryComplete,
  trajectoryStuck,
  formatTrajectoryForPrompt,
  parseTrajectoryYaml,
  serializeTrajectoryToYaml,
  createInitialStepStates,
  type Trajectory,
  type TrajectoryStep,
  type StepState,
} from '../trajectory/shared.js';

function makeStep(partial: Partial<TrajectoryStep> & Pick<TrajectoryStep, 'id'>): TrajectoryStep {
  return {
    id: partial.id,
    title: partial.title ?? partial.id,
    description: partial.description ?? '',
    scope: partial.scope,
    categories: partial.categories,
    acceptance_criteria: partial.acceptance_criteria ?? [],
    verification_commands: partial.verification_commands ?? [],
    depends_on: partial.depends_on ?? [],
    measure: partial.measure,
  };
}

function makeTrajectory(steps: TrajectoryStep[], overrides?: Partial<Trajectory>): Trajectory {
  return {
    name: overrides?.name ?? 'Test Trajectory',
    description: overrides?.description ?? 'A test trajectory.',
    steps,
  };
}

// ---------------------------------------------------------------------------
// stepReady
// ---------------------------------------------------------------------------

describe('stepReady', () => {
  it('returns true when depends_on is empty (even if states is empty)', () => {
    const step = makeStep({ id: 'a', depends_on: [] });
    expect(stepReady(step, {})).toBe(true);
  });

  it('returns false when a dependency is missing from states', () => {
    const step = makeStep({ id: 'b', depends_on: ['a'] });
    expect(stepReady(step, {})).toBe(false);
  });

  it('returns false when a dependency is not completed', () => {
    const states: Record<string, StepState> = {
      a: { stepId: 'a', status: 'pending', cyclesAttempted: 0, lastAttemptedCycle: 0 },
    };
    const step = makeStep({ id: 'b', depends_on: ['a'] });
    expect(stepReady(step, states)).toBe(false);
  });

  it('treats skipped dependencies as not ready (only completed satisfies deps)', () => {
    const states: Record<string, StepState> = {
      a: { stepId: 'a', status: 'skipped', cyclesAttempted: 0, lastAttemptedCycle: 0 },
    };
    const step = makeStep({ id: 'b', depends_on: ['a'] });
    expect(stepReady(step, states)).toBe(false);
  });

  it('returns true when all dependencies are completed', () => {
    const states: Record<string, StepState> = {
      a: { stepId: 'a', status: 'completed', cyclesAttempted: 1, lastAttemptedCycle: 1, completedAt: Date.now() },
    };
    const step = makeStep({ id: 'b', depends_on: ['a'] });
    expect(stepReady(step, states)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getNextStep
// ---------------------------------------------------------------------------

describe('getNextStep', () => {
  it('returns the first ready step in declaration order (pending)', () => {
    const trajectory = makeTrajectory([
      makeStep({ id: 'a' }),
      makeStep({ id: 'b', depends_on: ['a'] }),
    ]);
    const states = createInitialStepStates(trajectory);

    const next = getNextStep(trajectory, states);
    expect(next?.id).toBe('a');
  });

  it('returns the first ready step after completed/skipped/failed steps', () => {
    const trajectory = makeTrajectory([
      makeStep({ id: 'a' }),
      makeStep({ id: 'b', depends_on: ['a'] }),
      makeStep({ id: 'c' }),
    ]);
    const states = createInitialStepStates(trajectory);
    states.a.status = 'completed';

    const next = getNextStep(trajectory, states);
    // b is ready (depends on a completed) and appears before c.
    expect(next?.id).toBe('b');
  });

  it('skips steps that are pending/active but not ready and continues to later ready steps', () => {
    const trajectory = makeTrajectory([
      makeStep({ id: 'blocked', depends_on: ['missing'] }),
      makeStep({ id: 'ready' }),
    ]);
    const states = createInitialStepStates(trajectory);

    const next = getNextStep(trajectory, states);
    expect(next?.id).toBe('ready');
  });

  it('does not return failed steps', () => {
    const trajectory = makeTrajectory([
      makeStep({ id: 'a' }),
      makeStep({ id: 'b' }),
    ]);
    const states = createInitialStepStates(trajectory);
    states.a.status = 'failed';

    const next = getNextStep(trajectory, states);
    expect(next?.id).toBe('b');
  });

  it('returns null for an empty trajectory', () => {
    const trajectory = makeTrajectory([]);
    const next = getNextStep(trajectory, {});
    expect(next).toBeNull();
  });

  it('returns null when all steps are blocked by circular dependencies', () => {
    const trajectory = makeTrajectory([
      makeStep({ id: 'a', depends_on: ['b'] }),
      makeStep({ id: 'b', depends_on: ['a'] }),
    ]);
    const states = createInitialStepStates(trajectory);

    const next = getNextStep(trajectory, states);
    expect(next).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// trajectoryComplete
// ---------------------------------------------------------------------------

describe('trajectoryComplete', () => {
  it('treats an empty trajectory as complete', () => {
    const trajectory = makeTrajectory([]);
    expect(trajectoryComplete(trajectory, {})).toBe(true);
  });

  it('returns true when all steps are completed or skipped', () => {
    const trajectory = makeTrajectory([makeStep({ id: 'a' }), makeStep({ id: 'b' })]);
    const states = createInitialStepStates(trajectory);
    states.a.status = 'completed';
    states.b.status = 'skipped';

    expect(trajectoryComplete(trajectory, states)).toBe(true);
  });

  it('returns false when any step is pending/active/failed', () => {
    const trajectory = makeTrajectory([makeStep({ id: 'a' }), makeStep({ id: 'b' }), makeStep({ id: 'c' })]);
    const states = createInitialStepStates(trajectory);
    states.a.status = 'completed';
    states.b.status = 'active';
    states.c.status = 'failed';

    expect(trajectoryComplete(trajectory, states)).toBe(false);
  });

  it('returns false when a step state is missing', () => {
    const trajectory = makeTrajectory([makeStep({ id: 'a' })]);
    expect(trajectoryComplete(trajectory, {})).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// trajectoryStuck
// ---------------------------------------------------------------------------

describe('trajectoryStuck', () => {
  it('returns null when no active step exceeds retry threshold', () => {
    const states: Record<string, StepState> = {
      a: { stepId: 'a', status: 'active', cyclesAttempted: 2, lastAttemptedCycle: 2 },
      b: { stepId: 'b', status: 'pending', cyclesAttempted: 0, lastAttemptedCycle: 0 },
      c: { stepId: 'c', status: 'failed', cyclesAttempted: 10, lastAttemptedCycle: 10 },
    };
    expect(trajectoryStuck(states)).toBeNull();
  });

  it('returns the step id when an active step reaches default max retries (3)', () => {
    const states: Record<string, StepState> = {
      a: { stepId: 'a', status: 'active', cyclesAttempted: 3, lastAttemptedCycle: 3 },
    };
    expect(trajectoryStuck(states)).toBe('a');
  });

  it('respects custom maxRetries', () => {
    const states: Record<string, StepState> = {
      a: { stepId: 'a', status: 'active', cyclesAttempted: 4, lastAttemptedCycle: 4 },
    };
    expect(trajectoryStuck(states, 5)).toBeNull();
    expect(trajectoryStuck(states, 4)).toBe('a');
  });

  it('ignores non-active steps even if cyclesAttempted is high', () => {
    const states: Record<string, StepState> = {
      a: { stepId: 'a', status: 'failed', cyclesAttempted: 999, lastAttemptedCycle: 999 },
      b: { stepId: 'b', status: 'completed', cyclesAttempted: 999, lastAttemptedCycle: 999, completedAt: Date.now() },
    };
    expect(trajectoryStuck(states)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// formatTrajectoryForPrompt
// ---------------------------------------------------------------------------

describe('formatTrajectoryForPrompt', () => {
  it('formats trajectory context with completed/current/upcoming sections and step overrides', () => {
    const step1 = makeStep({ id: 'setup', title: 'Setup', description: 'Prepare the repo.', depends_on: [] });
    const step2 = makeStep({
      id: 'refactor',
      title: 'Refactor',
      description: 'Refactor the core module.',
      scope: 'packages/core/**',
      categories: ['type-safety', 'cleanup'],
      acceptance_criteria: ['No implicit any', 'Add unit tests'],
      depends_on: ['setup'],
      measure: { cmd: 'echo 12', target: 10, direction: 'up' },
    });
    const step3 = makeStep({ id: 'polish', title: 'Polish', description: 'Polish remaining edges.', depends_on: ['refactor'] });
    const trajectory = makeTrajectory([step1, step2, step3], { name: 'Quality Sweep', description: 'Incrementally raise quality.' });

    const states = createInitialStepStates(trajectory);
    states.setup.status = 'completed';
    states.refactor.status = 'active';
    states.refactor.cyclesAttempted = 2;

    const formatted = formatTrajectoryForPrompt(trajectory, states, step2);

    expect(formatted).toContain('<trajectory>');
    expect(formatted).toContain('## Trajectory: Quality Sweep');
    expect(formatted).toContain('Incrementally raise quality.');

    // Completed step list
    expect(formatted).toContain('### Completed Steps');
    expect(formatted).toContain('- [x] Setup');

    // Current step focus block
    expect(formatted).toContain('### Current Step (FOCUS HERE)');
    expect(formatted).toContain('**Refactor**');
    expect(formatted).toContain('Refactor the core module.');
    expect(formatted).toContain('**Acceptance Criteria:**');
    expect(formatted).toContain('- No implicit any');
    expect(formatted).toContain('- Add unit tests');
    expect(formatted).toContain('**Scope:** `packages/core/**`');
    expect(formatted).toContain('**Categories:** type-safety, cleanup');
    expect(formatted).toContain('**Measure:** target >= 10');
    expect(formatted).toContain('**Attempts:** 2 cycle(s) so far');

    // Upcoming steps include dependency hints by id
    expect(formatted).toContain('### Upcoming Steps');
    expect(formatted).toContain('- [ ] Polish (after: refactor)');
    expect(formatted).not.toContain('- [ ] Refactor');

    expect(formatted).toContain('Proposals should advance the **current step** toward its acceptance criteria.');
    expect(formatted).toContain('</trajectory>');
  });

  it('omits Completed Steps section when none are completed', () => {
    const step = makeStep({ id: 'a', title: 'A', description: 'A', acceptance_criteria: [], depends_on: [] });
    const trajectory = makeTrajectory([step]);
    const states = createInitialStepStates(trajectory);

    const formatted = formatTrajectoryForPrompt(trajectory, states, step);
    expect(formatted).not.toContain('### Completed Steps');
  });

  it('renders a down-direction measure using <=', () => {
    const step = makeStep({
      id: 'a',
      title: 'Reduce',
      description: 'Reduce failures.',
      depends_on: [],
      measure: { cmd: 'echo 5', target: 1, direction: 'down' },
    });
    const trajectory = makeTrajectory([step]);
    const states = createInitialStepStates(trajectory);

    const formatted = formatTrajectoryForPrompt(trajectory, states, step);
    expect(formatted).toContain('**Measure:** target <= 1');
  });
});

// ---------------------------------------------------------------------------
// parseTrajectoryYaml
// ---------------------------------------------------------------------------

describe('parseTrajectoryYaml', () => {
  it('parses a trajectory YAML document (including lists and measure)', () => {
    const yaml = `# Sample trajectory
name: my-trajectory
description: Improve reliability
steps:
  - id: step1
    title: Setup
    description: Prepare things
    scope: "packages/core/**"
    categories: [fix, test]
    acceptance_criteria:
      - Add tests
      - Green CI
    verification_commands:
      - npm test
    depends_on: []
    measure:
      cmd: "echo 12"
      target: 10
      direction: up

  - id: step2
    title: Next
    description: Do next
    depends_on: [step1]
    acceptance_criteria:
      - Ship
    verification_commands:
      - echo ok
`;

    const result = parseTrajectoryYaml(yaml);
    expect(result.name).toBe('my-trajectory');
    expect(result.description).toBe('Improve reliability');
    expect(result.steps).toHaveLength(2);

    const s1 = result.steps[0]!;
    expect(s1.id).toBe('step1');
    expect(s1.title).toBe('Setup');
    expect(s1.description).toBe('Prepare things');
    expect(s1.scope).toBe('packages/core/**');
    expect(s1.categories).toEqual(['fix', 'test']);
    expect(s1.acceptance_criteria).toEqual(['Add tests', 'Green CI']);
    expect(s1.verification_commands).toEqual(['npm test']);
    expect(s1.depends_on).toEqual([]);
    expect(s1.measure).toEqual({ cmd: 'echo 12', target: 10, direction: 'up' });

    const s2 = result.steps[1]!;
    expect(s2.id).toBe('step2');
    expect(s2.depends_on).toEqual(['step1']);
    expect(s2.acceptance_criteria).toEqual(['Ship']);
    expect(s2.verification_commands).toEqual(['echo ok']);
  });

  it('handles empty input', () => {
    const result = parseTrajectoryYaml('');
    expect(result).toEqual({ name: '', description: '', steps: [] });
  });

  it('ignores malformed/incomplete steps (missing id)', () => {
    const yaml = `name: t
description: d
steps:
  - id:
    title: Missing id value
    description: should be ignored
  - id: ok
    title: OK
    description: Works
    acceptance_criteria:
      - A
    verification_commands:
      - echo ok
    depends_on: []
`;
    const result = parseTrajectoryYaml(yaml);
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]!.id).toBe('ok');
  });

  it('does not set measure unless cmd, target, and direction are all present', () => {
    const yaml = `name: t
description: d
steps:
  - id: s1
    title: S1
    description: d
    acceptance_criteria:
      - A
    verification_commands:
      - echo ok
    depends_on: []
    measure:
      cmd: echo 1
      target: 10
`;
    const result = parseTrajectoryYaml(yaml);
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]!.measure).toBeUndefined();
  });

  it('parses comma-separated inline lists (categories, depends_on)', () => {
    const yaml = `name: t
description: d
steps:
  - id: a
    title: A
    description: d
    categories: security, test
    depends_on: x, y
    acceptance_criteria:
      - A
    verification_commands:
      - echo ok
`;
    const result = parseTrajectoryYaml(yaml);
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]!.categories).toEqual(['security', 'test']);
    expect(result.steps[0]!.depends_on).toEqual(['x', 'y']);
  });

  it('defaults list fields to empty arrays when list keys are present but empty', () => {
    const yaml = `name: t
description: d
steps:
  - id: a
    title: A
    description: d
    acceptance_criteria:
    verification_commands:
    depends_on: []
`;
    const result = parseTrajectoryYaml(yaml);
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]!.acceptance_criteria).toEqual([]);
    expect(result.steps[0]!.verification_commands).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// createInitialStepStates
// ---------------------------------------------------------------------------

describe('createInitialStepStates', () => {
  it('creates pending state for each step', () => {
    const trajectory = makeTrajectory([makeStep({ id: 'a' }), makeStep({ id: 'b' })]);
    const states = createInitialStepStates(trajectory);

    expect(Object.keys(states).sort()).toEqual(['a', 'b']);
    expect(states.a).toEqual({ stepId: 'a', status: 'pending', cyclesAttempted: 0, lastAttemptedCycle: 0 });
    expect(states.b).toEqual({ stepId: 'b', status: 'pending', cyclesAttempted: 0, lastAttemptedCycle: 0 });
  });

  it('returns an empty object for an empty trajectory', () => {
    const trajectory = makeTrajectory([]);
    expect(createInitialStepStates(trajectory)).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// serializeTrajectoryToYaml
// ---------------------------------------------------------------------------

describe('serializeTrajectoryToYaml', () => {
  it('round-trips through parseTrajectoryYaml', () => {
    const trajectory: Trajectory = {
      name: 'test-roundtrip',
      description: 'Ensure serialization round-trips',
      steps: [
        {
          id: 'setup',
          title: 'Setup infrastructure',
          description: 'Install dependencies and configure',
          scope: 'packages/core/**',
          categories: ['fix', 'test'],
          acceptance_criteria: ['Tests pass', 'Build succeeds'],
          verification_commands: ['npm test', 'npm run build'],
          depends_on: [],
          measure: { cmd: 'echo 5', target: 10, direction: 'up' },
        },
        {
          id: 'implement',
          title: 'Implement feature',
          description: 'Build the core logic',
          acceptance_criteria: ['Feature works'],
          verification_commands: ['npm test'],
          depends_on: ['setup'],
        },
      ],
    };

    const yaml = serializeTrajectoryToYaml(trajectory);
    const parsed = parseTrajectoryYaml(yaml);

    expect(parsed.name).toBe(trajectory.name);
    expect(parsed.description).toBe(trajectory.description);
    expect(parsed.steps).toHaveLength(2);
    expect(parsed.steps[0].id).toBe('setup');
    expect(parsed.steps[0].scope).toBe('packages/core/**');
    expect(parsed.steps[0].categories).toEqual(['fix', 'test']);
    expect(parsed.steps[0].acceptance_criteria).toEqual(['Tests pass', 'Build succeeds']);
    expect(parsed.steps[0].verification_commands).toEqual(['npm test', 'npm run build']);
    expect(parsed.steps[0].depends_on).toEqual([]);
    expect(parsed.steps[0].measure).toEqual({ cmd: 'echo 5', target: 10, direction: 'up' });
    expect(parsed.steps[1].id).toBe('implement');
    expect(parsed.steps[1].depends_on).toEqual(['setup']);
  });

  it('handles steps without optional fields', () => {
    const trajectory: Trajectory = {
      name: 'minimal',
      description: 'Minimal trajectory',
      steps: [
        {
          id: 'only-step',
          title: 'Do something',
          description: 'Just do it',
          acceptance_criteria: ['Done'],
          verification_commands: ['echo ok'],
          depends_on: [],
        },
      ],
    };

    const yaml = serializeTrajectoryToYaml(trajectory);
    const parsed = parseTrajectoryYaml(yaml);

    expect(parsed.steps).toHaveLength(1);
    expect(parsed.steps[0].id).toBe('only-step');
    expect(parsed.steps[0].scope).toBeUndefined();
    expect(parsed.steps[0].categories).toBeUndefined();
    expect(parsed.steps[0].measure).toBeUndefined();
  });
});

