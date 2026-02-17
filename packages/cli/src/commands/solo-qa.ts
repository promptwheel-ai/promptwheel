/**
 * Solo QA commands: qa, tui
 */

import { Command } from 'commander';
import * as path from 'node:path';
import chalk from 'chalk';
import {
  scoutRepo,
  runQa,
  getQaRunDetails,
  type QaConfig,
} from '@promptwheel/core/services';
import { projects } from '@promptwheel/core/repos';
import { createGitService } from '../lib/git.js';
import { createExecRunner } from '../lib/exec.js';
import { createLogger } from '../lib/logger.js';
import { startTuiApp } from '../tui/index.js';
import {
  isInitialized,
  initSolo,
  loadConfig,
  getAdapter,
  createScoutDeps,
} from '../lib/solo-config.js';
import {
  formatDuration,
  normalizeQaConfig,
  type QaOutput,
} from '../lib/solo-utils.js';

export function registerQaCommands(solo: Command): void {
  /**
   * solo qa - Run QA commands
   */
  solo
    .command('qa')
    .description('Run local QA commands (lint, test, etc.) and record results')
    .option('-v, --verbose', 'Show detailed output')
    .option('--json', 'Output as JSON')
    .option('--max-attempts <n>', 'Override retry attempts', (v: string) => parseInt(v, 10))
    .action(async (options: {
      verbose?: boolean;
      json?: boolean;
      maxAttempts?: number;
    }) => {
      const isJsonMode = options.json;

      if (!isJsonMode) {
        console.log(chalk.blue('🧪 PromptWheel Solo QA'));
        console.log();
      }

      const git = createGitService();
      const repoRoot = await git.findRepoRoot(process.cwd());

      if (!repoRoot) {
        if (isJsonMode) {
          console.log(JSON.stringify({ success: false, error: 'Not a git repository' }));
        } else {
          console.error(chalk.red('✗ Not a git repository'));
        }
        process.exit(1);
      }

      if (!isInitialized(repoRoot)) {
        if (!isJsonMode) {
          console.log(chalk.gray('Initializing local state...'));
        }
        await initSolo(repoRoot);
      }

      const config = loadConfig(repoRoot);
      if (!config) {
        if (isJsonMode) {
          console.log(JSON.stringify({ success: false, error: 'No config found' }));
        } else {
          console.error(chalk.red('✗ No config found. Run: promptwheel solo init'));
        }
        process.exit(1);
      }

      let qaConfig: QaConfig;
      try {
        qaConfig = normalizeQaConfig(config, { maxAttempts: options.maxAttempts });
      } catch (err) {
        if (isJsonMode) {
          console.log(JSON.stringify({
            success: false,
            error: err instanceof Error ? err.message : String(err),
          }));
        } else {
          console.error(chalk.red(`✗ ${err instanceof Error ? err.message : err}`));
        }
        process.exit(1);
      }

      if (!isJsonMode) {
        console.log(chalk.gray(`Project: ${path.basename(repoRoot)}`));
        console.log(chalk.gray(`Commands: ${qaConfig.commands.map(c => c.name).join(', ')}`));
        if (qaConfig.retry.maxAttempts > 1) {
          console.log(chalk.gray(`Max attempts: ${qaConfig.retry.maxAttempts}`));
        }
        console.log();
      }

      const adapter = await getAdapter(repoRoot);

      const project = await projects.ensureForRepo(adapter, {
        name: path.basename(repoRoot),
        rootPath: repoRoot,
      });

      const exec = createExecRunner({
        defaultMaxLogBytes: qaConfig.artifacts.maxLogBytes,
        defaultTailBytes: qaConfig.artifacts.tailBytes,
      });

      const logger = createLogger({ verbose: options.verbose, quiet: isJsonMode });

      const controller = new AbortController();
      process.on('SIGINT', () => {
        if (!isJsonMode) {
          console.log(chalk.yellow('\n\nCanceling QA run...'));
        }
        controller.abort();
      });

      try {
        const result = await runQa(
          { db: adapter, exec, logger },
          {
            projectId: project.id,
            repoRoot,
            config: qaConfig,
            maxAttemptsOverride: options.maxAttempts,
            signal: controller.signal,
          }
        );

        const details = await getQaRunDetails(adapter, result.runId);

        if (isJsonMode) {
          const output: QaOutput = {
            runId: result.runId,
            projectId: result.projectId,
            status: result.status,
            attempts: result.attempts,
            durationMs: result.durationMs,
            failedAt: result.failedAt,
            steps: (details?.steps ?? []).map(s => ({
              name: s.name,
              status: s.status,
              exitCode: s.exitCode,
              durationMs: s.durationMs,
              errorMessage: s.errorMessage,
              stdoutPath: s.stdoutPath,
              stderrPath: s.stderrPath,
              stdoutTail: s.stdoutTail,
              stderrTail: s.stderrTail,
            })),
          };
          console.log(JSON.stringify(output, null, 2));
        } else {
          console.log();
          const statusColor = result.status === 'success' ? chalk.green :
                            result.status === 'canceled' ? chalk.yellow : chalk.red;
          console.log(`Result: ${statusColor(result.status.toUpperCase())}`);
          console.log(`Duration: ${formatDuration(result.durationMs)}`);

          if (result.attempts > 1) {
            console.log(`Attempts: ${result.attempts}`);
          }

          if (result.failedAt) {
            console.log(chalk.red(`Failed at: ${result.failedAt.stepName} (attempt ${result.failedAt.attempt})`));
          }

          if (details?.steps.length) {
            console.log();
            console.log(chalk.cyan('Steps:'));

            const byAttempt = new Map<number, typeof details.steps>();
            for (const step of details.steps) {
              const existing = byAttempt.get(step.attempt) ?? [];
              existing.push(step);
              byAttempt.set(step.attempt, existing);
            }

            for (const [attempt, steps] of byAttempt) {
              if (byAttempt.size > 1) {
                console.log(chalk.gray(`  Attempt ${attempt}:`));
              }

              for (const step of steps) {
                const icon = step.status === 'success' ? chalk.green('✓') :
                            step.status === 'failed' ? chalk.red('✗') :
                            step.status === 'skipped' ? chalk.gray('○') :
                            step.status === 'canceled' ? chalk.yellow('•') :
                            chalk.gray('?');
                const dur = step.durationMs !== null ? chalk.gray(` (${formatDuration(step.durationMs)})`) : '';
                console.log(`  ${icon} ${step.name}${dur}`);

                if (step.status !== 'success' && step.status !== 'skipped') {
                  if (step.errorMessage) {
                    console.log(chalk.gray(`      ${step.errorMessage}`));
                  }
                  if (step.stderrTail && options.verbose) {
                    const lines = step.stderrTail.trim().split('\n').slice(-5);
                    for (const line of lines) {
                      console.log(chalk.gray(`      │ ${line}`));
                    }
                  }
                  if (step.stderrPath) {
                    console.log(chalk.gray(`      stderr: ${step.stderrPath}`));
                  }
                }
              }
            }
          }
        }

        process.exitCode = result.status === 'success' ? 0 : 1;

      } finally {
        await adapter.close();
      }
    });

  /**
   * solo tui - Interactive terminal UI
   */
  solo
    .command('tui')
    .description('Launch interactive terminal UI (lazygit-style)')
    .action(async () => {
      const git = createGitService();
      const repoRoot = await git.findRepoRoot(process.cwd());

      if (!repoRoot) {
        console.error(chalk.red('Not a git repository'));
        process.exit(1);
      }

      if (!isInitialized(repoRoot)) {
        console.log(chalk.gray('Initializing local state...'));
        await initSolo(repoRoot);
      }

      const config = loadConfig(repoRoot);

      const adapter = await getAdapter(repoRoot);

      try {
        const actions = {
          runScout: async () => {
            const deps = createScoutDeps(adapter, { quiet: true });
            await scoutRepo(deps, {
              path: repoRoot,
              scope: 'src/**',
              maxProposals: 10,
              minConfidence: 50,
              model: 'haiku',
              autoApprove: false,
            });
          },
          runQa: config?.qa?.commands?.length ? async () => {
            const project = await projects.ensureForRepo(adapter, {
              name: path.basename(repoRoot),
              rootPath: repoRoot,
            });

            const qaConfig = normalizeQaConfig(config);
            const exec = createExecRunner({
              defaultMaxLogBytes: qaConfig.artifacts.maxLogBytes,
              defaultTailBytes: qaConfig.artifacts.tailBytes,
            });
            const logger = createLogger({ quiet: true });

            await runQa(
              { db: adapter, exec, logger },
              {
                projectId: project.id,
                repoRoot,
                config: qaConfig,
              }
            );
          } : undefined,
        };

        const { stop } = await startTuiApp({
          db: adapter,
          repoRoot,
          actions,
        });

        process.on('SIGINT', async () => {
          await stop();
          await adapter.close();
          process.exit(0);
        });

        await new Promise(() => {});

      } finally {
        await adapter.close();
      }
    });
}
