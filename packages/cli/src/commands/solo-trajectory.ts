/**
 * Solo trajectory commands: list, show, activate, pause, resume, skip, reset, generate.
 */

import * as path from 'node:path';
import { Command } from 'commander';
import chalk from 'chalk';
import { createGitService } from '../lib/git.js';
import {
  loadTrajectories,
  loadTrajectoryState,
  saveTrajectoryState,
  clearTrajectoryState,
  activateTrajectory,
  loadTrajectory,
} from '../lib/trajectory.js';
import type { StepStatus } from '@promptwheel/core/trajectory/shared';
import { getNextStep } from '@promptwheel/core/trajectory/shared';

async function getRepoRoot(): Promise<string> {
  const git = createGitService();
  const repoRoot = await git.findRepoRoot(process.cwd());
  if (!repoRoot) {
    console.error(chalk.red('Not a git repository'));
    process.exit(1);
  }
  return repoRoot;
}

const STATUS_ICONS: Record<StepStatus, string> = {
  pending: '  ',
  active: '>>',
  completed: 'ok',
  failed: '!!',
  skipped: '--',
};

export function registerTrajectoryCommands(solo: Command): void {
  const traj = solo
    .command('trajectory')
    .alias('traj')
    .description('Manage multi-step trajectory plans');

  // list
  traj
    .command('list')
    .description('List all trajectories and their status')
    .action(async () => {
      const repoRoot = await getRepoRoot();
      const trajectories = loadTrajectories(repoRoot);
      const state = loadTrajectoryState(repoRoot);

      if (trajectories.length === 0) {
        console.log(chalk.gray('No trajectories found.'));
        console.log(chalk.gray('Create one at .promptwheel/trajectories/<name>.yaml'));
        return;
      }

      console.log(chalk.bold(`${trajectories.length} trajectory(s):`));
      console.log();
      for (const t of trajectories) {
        const isActive = state?.trajectoryName === t.name;
        const isPaused = isActive && state?.paused;
        const statusLabel = isActive
          ? isPaused ? chalk.yellow(' [paused]') : chalk.green(' [active]')
          : '';
        console.log(`  ${chalk.bold(t.name)}${statusLabel}`);
        console.log(chalk.gray(`    ${t.description}`));
        console.log(chalk.gray(`    ${t.steps.length} step(s)`));

        if (isActive && state) {
          const completed = t.steps.filter(s => state.stepStates[s.id]?.status === 'completed').length;
          const failed = t.steps.filter(s => state.stepStates[s.id]?.status === 'failed').length;
          console.log(chalk.gray(`    Progress: ${completed}/${t.steps.length} completed${failed > 0 ? `, ${failed} failed` : ''}`));
        }
        console.log();
      }
    });

  // show
  traj
    .command('show <name>')
    .description('Show steps and progress for a trajectory')
    .action(async (name: string) => {
      const repoRoot = await getRepoRoot();
      const trajectory = loadTrajectory(repoRoot, name);

      if (!trajectory) {
        console.error(chalk.red(`Trajectory not found: ${name}`));
        process.exit(1);
      }

      const state = loadTrajectoryState(repoRoot);
      const isActive = state?.trajectoryName === name;

      console.log(chalk.bold(trajectory.name));
      console.log(chalk.gray(trajectory.description));
      if (isActive) {
        console.log(state!.paused ? chalk.yellow('Status: paused') : chalk.green('Status: active'));
      }
      console.log();

      for (const step of trajectory.steps) {
        const stepState = isActive ? state?.stepStates[step.id] : undefined;
        const status: StepStatus = stepState?.status ?? 'pending';
        const icon = STATUS_ICONS[status];
        const statusColor = status === 'completed' ? chalk.green
          : status === 'active' ? chalk.cyan
          : status === 'failed' ? chalk.red
          : status === 'skipped' ? chalk.yellow
          : chalk.gray;

        console.log(`  [${statusColor(icon)}] ${chalk.bold(step.id)}: ${step.title}`);
        console.log(chalk.gray(`       ${step.description}`));

        if (step.depends_on.length > 0) {
          console.log(chalk.gray(`       depends on: ${step.depends_on.join(', ')}`));
        }
        if (step.scope) {
          console.log(chalk.gray(`       scope: ${step.scope}`));
        }
        if (stepState?.cyclesAttempted) {
          console.log(chalk.gray(`       attempts: ${stepState.cyclesAttempted}`));
        }
        if (stepState?.failureReason) {
          console.log(chalk.red(`       failure: ${stepState.failureReason}`));
        }
        console.log();
      }
    });

  // activate
  traj
    .command('activate <name>')
    .description('Set active trajectory')
    .action(async (name: string) => {
      const repoRoot = await getRepoRoot();
      const existing = loadTrajectoryState(repoRoot);
      if (existing && existing.trajectoryName !== name) {
        console.log(chalk.yellow(`Deactivating current trajectory: ${existing.trajectoryName}`));
      }

      const state = activateTrajectory(repoRoot, name);
      if (!state) {
        console.error(chalk.red(`Trajectory not found: ${name}`));
        console.log(chalk.gray('Available trajectories:'));
        const all = loadTrajectories(repoRoot);
        for (const t of all) {
          console.log(chalk.gray(`  - ${t.name}`));
        }
        process.exit(1);
      }

      console.log(chalk.green(`Trajectory "${name}" activated`));
      if (state.currentStepId) {
        console.log(chalk.cyan(`  First step: ${state.currentStepId}`));
      }
    });

  // pause
  traj
    .command('pause')
    .description('Pause active trajectory')
    .action(async () => {
      const repoRoot = await getRepoRoot();
      const state = loadTrajectoryState(repoRoot);
      if (!state) {
        console.log(chalk.gray('No active trajectory.'));
        return;
      }
      if (state.paused) {
        console.log(chalk.gray(`Trajectory "${state.trajectoryName}" is already paused.`));
        return;
      }
      state.paused = true;
      saveTrajectoryState(repoRoot, state);
      console.log(chalk.yellow(`Trajectory "${state.trajectoryName}" paused.`));
    });

  // resume
  traj
    .command('resume')
    .description('Resume paused trajectory')
    .action(async () => {
      const repoRoot = await getRepoRoot();
      const state = loadTrajectoryState(repoRoot);
      if (!state) {
        console.log(chalk.gray('No active trajectory.'));
        return;
      }
      if (!state.paused) {
        console.log(chalk.gray(`Trajectory "${state.trajectoryName}" is already running.`));
        return;
      }
      state.paused = false;
      saveTrajectoryState(repoRoot, state);
      console.log(chalk.green(`Trajectory "${state.trajectoryName}" resumed.`));
    });

  // skip
  traj
    .command('skip <step-id>')
    .description('Skip a stuck or failed step')
    .action(async (stepId: string) => {
      const repoRoot = await getRepoRoot();
      const state = loadTrajectoryState(repoRoot);
      if (!state) {
        console.log(chalk.gray('No active trajectory.'));
        return;
      }
      const stepState = state.stepStates[stepId];
      if (!stepState) {
        console.error(chalk.red(`Step not found: ${stepId}`));
        process.exit(1);
      }
      if (stepState.status === 'completed') {
        console.log(chalk.gray(`Step "${stepId}" is already completed.`));
        return;
      }

      stepState.status = 'skipped';
      stepState.completedAt = Date.now();

      // Advance to next step
      const trajectory = loadTrajectory(repoRoot, state.trajectoryName);
      if (trajectory) {
        const next = getNextStep(trajectory, state.stepStates);
        state.currentStepId = next?.id ?? null;
        if (next) {
          state.stepStates[next.id].status = 'active';
        }
      }

      saveTrajectoryState(repoRoot, state);
      console.log(chalk.yellow(`Step "${stepId}" skipped.`));
      if (state.currentStepId) {
        console.log(chalk.cyan(`  Next step: ${state.currentStepId}`));
      }
    });

  // reset
  traj
    .command('reset <name>')
    .description('Reset all step states for a trajectory')
    .action(async (name: string) => {
      const repoRoot = await getRepoRoot();
      const state = loadTrajectoryState(repoRoot);

      if (state && state.trajectoryName === name) {
        clearTrajectoryState(repoRoot);
        console.log(chalk.green(`Trajectory "${name}" reset.`));
        console.log(chalk.gray('  Run `promptwheel trajectory activate ${name}` to start again.'));
      } else {
        console.log(chalk.gray(`Trajectory "${name}" is not active. Nothing to reset.`));
      }
    });

  // generate
  traj
    .command('generate <goal>')
    .description('Generate a trajectory YAML from a high-level goal using an LLM')
    .option('--activate', 'Activate the trajectory immediately after generation')
    .option('--model <model>', 'LLM model to use', 'sonnet')
    .action(async (goal: string, opts: { activate?: boolean; model?: string }) => {
      const repoRoot = await getRepoRoot();

      if (!process.env.ANTHROPIC_API_KEY) {
        console.error(chalk.red('ANTHROPIC_API_KEY required for trajectory generation.'));
        process.exit(1);
      }

      console.log(chalk.bold('Generating trajectory...'));
      console.log(chalk.gray(`  Goal: ${goal}`));

      try {
        const { generateTrajectory } = await import('../lib/trajectory-generate.js');
        const result = await generateTrajectory({
          goal,
          repoRoot,
          model: opts.model,
        });

        console.log(chalk.green(`\nTrajectory "${result.trajectory.name}" generated`));
        console.log(chalk.gray(`  ${result.trajectory.steps.length} step(s)`));
        console.log(chalk.gray(`  Written to: ${path.relative(repoRoot, result.filePath)}`));
        console.log();

        for (const step of result.trajectory.steps) {
          const deps = step.depends_on.length > 0 ? chalk.gray(` (after: ${step.depends_on.join(', ')})`) : '';
          console.log(`  ${chalk.cyan(step.id)} ${step.title}${deps}`);
        }

        if (opts.activate) {
          const state = activateTrajectory(repoRoot, result.trajectory.name);
          if (state) {
            console.log(chalk.green(`\nTrajectory activated. First step: ${state.currentStepId}`));
          }
        } else {
          console.log(chalk.gray(`\nRun: promptwheel trajectory activate ${result.trajectory.name}`));
        }
      } catch (err) {
        console.error(chalk.red(`Generation failed: ${(err as Error).message}`));
        process.exit(1);
      }
    });
}
