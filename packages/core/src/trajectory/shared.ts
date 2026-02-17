/**
 * Pure trajectory algorithms — no filesystem.
 *
 * Shared by both @promptwheel/cli and @promptwheel/mcp.
 * Callers handle file I/O (reading YAML files from .promptwheel/trajectories/).
 *
 * A trajectory is a DAG of ordered steps that the wheel follows across cycles.
 * Each step constrains the scout's scope, categories, and acceptance criteria.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TrajectoryStep {
  id: string;
  title: string;
  description: string;
  scope?: string;                // overrides session scope for this step
  categories?: string[];          // overrides formula categories
  acceptance_criteria: string[];
  verification_commands: string[];
  depends_on: string[];           // step IDs that must complete first
  measure?: {
    cmd: string;
    target: number;
    direction: 'up' | 'down';
  };
}

export interface Trajectory {
  name: string;
  description: string;
  steps: TrajectoryStep[];
}

export type StepStatus = 'pending' | 'active' | 'completed' | 'failed' | 'skipped';

export interface StepState {
  stepId: string;
  status: StepStatus;
  cyclesAttempted: number;
  lastAttemptedCycle: number;
  completedAt?: number;
  failureReason?: string;
  measurement?: { value: number | null; timestamp: number };
}

export interface TrajectoryState {
  trajectoryName: string;
  startedAt: number;
  stepStates: Record<string, StepState>;
  currentStepId: string | null;
  paused: boolean;
}

// ---------------------------------------------------------------------------
// Pure algorithms
// ---------------------------------------------------------------------------

const DEFAULT_MAX_RETRIES = 3;

/** Can this step start? All dependencies must be completed. */
export function stepReady(step: TrajectoryStep, states: Record<string, StepState>): boolean {
  for (const depId of step.depends_on) {
    const dep = states[depId];
    if (!dep || dep.status !== 'completed') return false;
  }
  return true;
}

/** Pick next step: first ready step in declaration order that is pending or active. */
export function getNextStep(trajectory: Trajectory, states: Record<string, StepState>): TrajectoryStep | null {
  for (const step of trajectory.steps) {
    const state = states[step.id];
    if (!state) continue;
    if (state.status === 'completed' || state.status === 'skipped' || state.status === 'failed') continue;
    if (stepReady(step, states)) return step;
  }
  return null;
}

/** All steps completed or skipped? */
export function trajectoryComplete(trajectory: Trajectory, states: Record<string, StepState>): boolean {
  for (const step of trajectory.steps) {
    const state = states[step.id];
    if (!state) return false;
    if (state.status !== 'completed' && state.status !== 'skipped') return false;
  }
  return true;
}

/** Stuck: current step has failed 3+ cycles with no progress. Returns stuck step ID or null. */
export function trajectoryStuck(states: Record<string, StepState>, maxRetries: number = DEFAULT_MAX_RETRIES): string | null {
  for (const [stepId, state] of Object.entries(states)) {
    if (state.status === 'active' && state.cyclesAttempted >= maxRetries) {
      return stepId;
    }
  }
  return null;
}

/** Format trajectory context for scout prompt injection. */
export function formatTrajectoryForPrompt(
  trajectory: Trajectory,
  states: Record<string, StepState>,
  currentStep: TrajectoryStep,
): string {
  const lines: string[] = [
    '<trajectory>',
    `## Trajectory: ${trajectory.name}`,
    trajectory.description,
    '',
  ];

  // Completed steps
  const completed = trajectory.steps.filter(s => states[s.id]?.status === 'completed');
  if (completed.length > 0) {
    lines.push('### Completed Steps');
    for (const step of completed) {
      lines.push(`- [x] ${step.title}`);
    }
    lines.push('');
  }

  // Current step (the focus)
  lines.push('### Current Step (FOCUS HERE)');
  lines.push(`**${currentStep.title}**`);
  lines.push(currentStep.description);
  lines.push('');
  if (currentStep.acceptance_criteria.length > 0) {
    lines.push('**Acceptance Criteria:**');
    for (const ac of currentStep.acceptance_criteria) {
      lines.push(`- ${ac}`);
    }
    lines.push('');
  }
  if (currentStep.scope) {
    lines.push(`**Scope:** \`${currentStep.scope}\``);
  }
  if (currentStep.categories && currentStep.categories.length > 0) {
    lines.push(`**Categories:** ${currentStep.categories.join(', ')}`);
  }
  if (currentStep.measure) {
    const arrow = currentStep.measure.direction === 'up' ? '>' : '<';
    lines.push(`**Measure:** target ${arrow}= ${currentStep.measure.target}`);
  }

  const stepState = states[currentStep.id];
  if (stepState && stepState.cyclesAttempted > 0) {
    lines.push(`**Attempts:** ${stepState.cyclesAttempted} cycle(s) so far`);
  }
  lines.push('');

  // Remaining steps
  const remaining = trajectory.steps.filter(s => {
    const st = states[s.id];
    return st && s.id !== currentStep.id && st.status !== 'completed' && st.status !== 'skipped';
  });
  if (remaining.length > 0) {
    lines.push('### Upcoming Steps');
    for (const step of remaining) {
      if (step.id === currentStep.id) continue;
      const deps = step.depends_on.length > 0 ? ` (after: ${step.depends_on.join(', ')})` : '';
      lines.push(`- [ ] ${step.title}${deps}`);
    }
    lines.push('');
  }

  lines.push('Proposals should advance the **current step** toward its acceptance criteria.');
  lines.push('</trajectory>');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Trajectory YAML parsing (pure — no filesystem)
// ---------------------------------------------------------------------------

/**
 * Parse a trajectory YAML document into a Trajectory object.
 * Handles the nested steps array with all fields.
 */
export function parseTrajectoryYaml(content: string): Trajectory {
  const lines = content.split('\n');

  let name = '';
  let description = '';
  const steps: TrajectoryStep[] = [];
  let currentStep: Partial<TrajectoryStep> | null = null;
  let currentListKey: string | null = null;
  let currentList: string[] = [];
  let inMeasure = false;
  let measureObj: { cmd?: string; target?: number; direction?: 'up' | 'down' } = {};

  function flushList() {
    if (currentStep && currentListKey && currentList.length > 0) {
      (currentStep as any)[currentListKey] = [...currentList];
    }
    currentListKey = null;
    currentList = [];
  }

  function flushMeasure() {
    if (currentStep && inMeasure && measureObj.cmd !== undefined && measureObj.target !== undefined && measureObj.direction) {
      currentStep.measure = { cmd: measureObj.cmd, target: measureObj.target, direction: measureObj.direction };
    }
    inMeasure = false;
    measureObj = {};
  }

  function flushStep() {
    flushList();
    flushMeasure();
    if (currentStep && currentStep.id) {
      steps.push({
        id: currentStep.id,
        title: currentStep.title ?? '',
        description: currentStep.description ?? '',
        scope: currentStep.scope,
        categories: currentStep.categories,
        acceptance_criteria: currentStep.acceptance_criteria ?? [],
        verification_commands: currentStep.verification_commands ?? [],
        depends_on: currentStep.depends_on ?? [],
        measure: currentStep.measure,
      });
    }
    currentStep = null;
  }

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip comments and empty lines at top level
    if (trimmed.startsWith('#') || trimmed === '') {
      // Empty line in a list context ends the list
      if (trimmed === '' && currentListKey) {
        flushList();
      }
      continue;
    }

    // Top-level fields
    if (!line.startsWith(' ') && !line.startsWith('\t')) {
      flushStep();
      const match = trimmed.match(/^(\w[\w_-]*)\s*:\s*(.*)/);
      if (match) {
        const [, key, value] = match;
        if (key === 'name') name = value.trim();
        else if (key === 'description') description = value.trim();
      }
      continue;
    }

    // Steps array marker
    if (trimmed === '- id:' || trimmed.startsWith('- id:')) {
      flushStep();
      currentStep = {};
      const idMatch = trimmed.match(/^-\s*id\s*:\s*(.*)/);
      if (idMatch) {
        currentStep.id = idMatch[1].trim();
      }
      continue;
    }

    // Inside a step
    if (currentStep) {
      // Check for measure sub-object
      if (inMeasure) {
        const mMatch = trimmed.match(/^(\w[\w_-]*)\s*:\s*(.*)/);
        if (mMatch) {
          const [, mKey, mVal] = mMatch;
          // Check indent — measure fields should be deeper than "measure:"
          const indent = line.length - line.trimStart().length;
          if (indent >= 6) {
            if (mKey === 'cmd') measureObj.cmd = mVal.trim().replace(/^["']|["']$/g, '');
            else if (mKey === 'target') measureObj.target = parseFloat(mVal.trim());
            else if (mKey === 'direction') measureObj.direction = mVal.trim() as 'up' | 'down';
            continue;
          } else {
            // Back to step level
            flushMeasure();
          }
        }
      }

      // List item
      if (trimmed.startsWith('- ')) {
        const item = trimmed.slice(2).trim();
        if (currentListKey) {
          currentList.push(item);
          continue;
        }
      }

      // Key: value within a step
      const kvMatch = trimmed.match(/^(\w[\w_-]*)\s*:\s*(.*)/);
      if (kvMatch) {
        flushList();
        const [, key, rawVal] = kvMatch;
        const val = rawVal.trim();

        switch (key) {
          case 'title':
            currentStep.title = val;
            break;
          case 'description':
            currentStep.description = val;
            break;
          case 'scope':
            currentStep.scope = val.replace(/^["']|["']$/g, '');
            break;
          case 'categories':
            currentStep.categories = parseSimpleList(val);
            break;
          case 'acceptance_criteria':
            currentListKey = 'acceptance_criteria';
            currentList = [];
            break;
          case 'verification_commands':
            currentListKey = 'verification_commands';
            currentList = [];
            break;
          case 'depends_on':
            currentStep.depends_on = parseSimpleList(val);
            break;
          case 'measure':
            inMeasure = true;
            measureObj = {};
            break;
          default:
            break;
        }
      }
    }
  }

  // Flush final step
  flushStep();

  return { name, description, steps };
}

/** Parse "[a, b, c]" or "a, b, c" → string[]. Also handles YAML inline sequences. */
function parseSimpleList(value: string): string[] {
  const stripped = value.replace(/^\[/, '').replace(/\]$/, '');
  return stripped.split(',').map(s => s.trim()).filter(s => s.length > 0);
}

// ---------------------------------------------------------------------------
// State initialization
// ---------------------------------------------------------------------------

/** Create initial step states for a trajectory. */
export function createInitialStepStates(trajectory: Trajectory): Record<string, StepState> {
  const states: Record<string, StepState> = {};
  for (const step of trajectory.steps) {
    states[step.id] = {
      stepId: step.id,
      status: 'pending',
      cyclesAttempted: 0,
      lastAttemptedCycle: 0,
    };
  }
  return states;
}

// ---------------------------------------------------------------------------
// YAML serialization (inverse of parseTrajectoryYaml)
// ---------------------------------------------------------------------------

/** Serialize a Trajectory to YAML that parseTrajectoryYaml can round-trip. */
export function serializeTrajectoryToYaml(trajectory: Trajectory): string {
  const lines: string[] = [];
  lines.push(`name: ${trajectory.name}`);
  lines.push(`description: ${trajectory.description}`);
  lines.push('steps:');

  for (const step of trajectory.steps) {
    lines.push(`  - id: ${step.id}`);
    lines.push(`    title: ${step.title}`);
    lines.push(`    description: ${step.description}`);
    if (step.scope) {
      lines.push(`    scope: "${step.scope}"`);
    }
    if (step.categories && step.categories.length > 0) {
      lines.push(`    categories: [${step.categories.join(', ')}]`);
    }
    lines.push('    acceptance_criteria:');
    for (const ac of step.acceptance_criteria) {
      lines.push(`      - ${ac}`);
    }
    lines.push('    verification_commands:');
    for (const vc of step.verification_commands) {
      lines.push(`      - ${vc}`);
    }
    lines.push(`    depends_on: [${step.depends_on.join(', ')}]`);
    if (step.measure) {
      lines.push('    measure:');
      lines.push(`      cmd: "${step.measure.cmd}"`);
      lines.push(`      target: ${step.measure.target}`);
      lines.push(`      direction: ${step.measure.direction}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
