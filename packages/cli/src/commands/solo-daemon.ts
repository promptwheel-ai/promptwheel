/**
 * Daemon CLI commands: start, stop, status, logs.
 *
 * promptwheel solo daemon start [--interval 30] [--formula deep] [--scope src/**]
 * promptwheel solo daemon stop
 * promptwheel solo daemon status [--json]
 * promptwheel solo daemon logs [-n 50] [-f]
 * promptwheel solo daemon __run  (hidden — invoked by forked child)
 */

import { Command } from 'commander';
import chalk from 'chalk';
import * as fs from 'node:fs';
import { createGitService } from '../lib/git.js';
import { isInitialized, loadConfig } from '../lib/solo-config.js';
import {
  DEFAULT_DAEMON_CONFIG,
  readDaemonState,
  startDaemon,
  type DaemonConfig,
} from '../lib/daemon.js';
import {
  forkDaemon,
  isDaemonRunning,
  stopDaemon,
  readDaemonPid,
  getDaemonLogPath,
} from '../lib/daemon-fork.js';

async function resolveRepoRoot(): Promise<string> {
  const git = createGitService();
  const repoRoot = await git.findRepoRoot(process.cwd());
  if (!repoRoot) {
    console.error(chalk.red('Not a git repository'));
    process.exit(1);
  }
  if (!isInitialized(repoRoot)) {
    console.error(chalk.red('PromptWheel not initialized. Run: promptwheel solo init'));
    process.exit(1);
  }
  return repoRoot;
}

function loadDaemonConfig(repoRoot: string): DaemonConfig {
  const config = loadConfig(repoRoot);
  return {
    ...DEFAULT_DAEMON_CONFIG,
    ...config?.daemon,
  };
}

export function registerDaemonCommands(solo: Command): void {
  const daemon = solo
    .command('daemon')
    .description('Background daemon for continuous improvement');

  // ── start ──────────────────────────────────────────────────────────────────

  daemon
    .command('start')
    .description('Start the daemon in the background')
    .option('--interval <minutes>', 'Poll interval in minutes', '30')
    .option('--formula <name>', 'Formula to use (e.g. deep, security-audit)')
    .option('--scope <path>', 'Directory scope')
    .action(async (options: { interval?: string; formula?: string; scope?: string }) => {
      const repoRoot = await resolveRepoRoot();

      if (isDaemonRunning(repoRoot)) {
        const pid = readDaemonPid(repoRoot);
        console.log(chalk.yellow(`Daemon already running (pid=${pid})`));
        console.log(chalk.gray('  Stop it first: promptwheel solo daemon stop'));
        process.exit(1);
      }

      const interval = parseInt(options.interval ?? '30', 10);
      const pid = forkDaemon(repoRoot, {
        interval,
        formula: options.formula,
        scope: options.scope,
      });

      console.log(chalk.green(`Daemon started (pid=${pid})`));
      console.log(chalk.gray(`  Interval: ${interval}m`));
      if (options.formula) console.log(chalk.gray(`  Formula: ${options.formula}`));
      if (options.scope) console.log(chalk.gray(`  Scope: ${options.scope}`));
      console.log(chalk.gray(`  Logs: promptwheel solo daemon logs -f`));
      console.log(chalk.gray(`  Stop: promptwheel solo daemon stop`));
    });

  // ── stop ───────────────────────────────────────────────────────────────────

  daemon
    .command('stop')
    .description('Stop the running daemon')
    .action(async () => {
      const repoRoot = await resolveRepoRoot();

      if (!isDaemonRunning(repoRoot)) {
        console.log(chalk.yellow('No daemon is running'));
        return;
      }

      const pid = readDaemonPid(repoRoot);
      console.log(chalk.gray(`Stopping daemon (pid=${pid})...`));

      const stopped = await stopDaemon(repoRoot);
      if (stopped) {
        console.log(chalk.green('Daemon stopped'));
      } else {
        console.log(chalk.red('Failed to stop daemon'));
        process.exit(1);
      }
    });

  // ── status ─────────────────────────────────────────────────────────────────

  daemon
    .command('status')
    .description('Show daemon status')
    .option('--json', 'Output as JSON')
    .action(async (options: { json?: boolean }) => {
      const repoRoot = await resolveRepoRoot();
      const running = isDaemonRunning(repoRoot);
      const pid = readDaemonPid(repoRoot);
      const state = readDaemonState(repoRoot);
      const config = loadDaemonConfig(repoRoot);

      if (options.json) {
        console.log(JSON.stringify({ running, pid, config, state }, null, 2));
        return;
      }

      if (!running) {
        console.log(chalk.yellow('Daemon is not running'));
        if (state) {
          const elapsed = Date.now() - state.startedAt;
          const hours = Math.floor(elapsed / 3600_000);
          const mins = Math.floor((elapsed % 3600_000) / 60_000);
          console.log(chalk.gray(`  Last session: ${state.totalWakes} wakes, ${state.totalTicketsCompleted} tickets`));
          console.log(chalk.gray(`  Last ran: ${hours}h ${mins}m ago`));
        }
        return;
      }

      console.log(chalk.green(`Daemon running (pid=${pid})`));
      console.log(chalk.gray(`  Interval: ${config.pollIntervalMinutes}m`));
      if (state) {
        const uptime = Date.now() - state.startedAt;
        const hours = Math.floor(uptime / 3600_000);
        const mins = Math.floor((uptime % 3600_000) / 60_000);
        console.log(chalk.gray(`  Uptime: ${hours}h ${mins}m`));
        console.log(chalk.gray(`  Wakes: ${state.totalWakes}`));
        console.log(chalk.gray(`  Tickets completed: ${state.totalTicketsCompleted}`));
        console.log(chalk.gray(`  Tickets failed: ${state.totalTicketsFailed}`));
        console.log(chalk.gray(`  Current interval: ${Math.round(state.currentInterval / 60_000)}m`));
        if (state.lastWakeAt > 0) {
          const ago = Math.round((Date.now() - state.lastWakeAt) / 60_000);
          console.log(chalk.gray(`  Last wake: ${ago}m ago (${state.lastTrigger})`));
        }
      }
    });

  // ── logs ───────────────────────────────────────────────────────────────────

  daemon
    .command('logs')
    .description('Show daemon logs')
    .option('-n <lines>', 'Number of lines to show', '50')
    .option('-f, --follow', 'Follow log output')
    .action(async (options: { n?: string; follow?: boolean }) => {
      const repoRoot = await resolveRepoRoot();
      const logPath = getDaemonLogPath(repoRoot);

      if (!fs.existsSync(logPath)) {
        console.log(chalk.yellow('No daemon log file found'));
        return;
      }

      const { execSync, spawn } = await import('node:child_process');

      if (options.follow) {
        const tail = spawn('tail', ['-f', logPath], { stdio: 'inherit' });
        process.on('SIGINT', () => { tail.kill(); process.exit(0); });
      } else {
        const lines = parseInt(options.n ?? '50', 10);
        const output = execSync(`tail -n ${lines} "${logPath}"`, { encoding: 'utf-8' });
        process.stdout.write(output);
      }
    });

  // ── __run (hidden) ─────────────────────────────────────────────────────────
  // Invoked by the forked child process. Not shown in help.

  daemon
    .command('__run', { hidden: true })
    .option('--interval <minutes>', 'Poll interval')
    .option('--formula <name>', 'Formula')
    .option('--scope <path>', 'Scope')
    .action(async (options: { interval?: string; formula?: string; scope?: string }) => {
      const repoRoot = await resolveRepoRoot();
      const baseConfig = loadDaemonConfig(repoRoot);

      const config: DaemonConfig = {
        ...baseConfig,
        ...(options.interval ? { pollIntervalMinutes: parseInt(options.interval, 10) } : {}),
        ...(options.formula ? { formula: options.formula } : {}),
        ...(options.scope ? { scope: options.scope } : {}),
      };

      await startDaemon(repoRoot, config);
    });
}
