/**
 * Solo lifecycle commands: init, doctor, reset
 */

import { Command } from 'commander';
import * as path from 'node:path';
import * as fs from 'node:fs';
import chalk from 'chalk';
import { createGitService } from '../lib/git.js';
import {
  getPromptwheelDir,
  getDbPath,
  isInitialized,
  initSolo,
  getAdapter,
} from '../lib/solo-config.js';
import {
  runDoctorChecks,
  formatDoctorReport,
  formatDoctorReportJson,
} from '../lib/doctor.js';

export function registerLifecycleCommands(solo: Command): void {
  /**
   * solo init - Initialize local state
   */
  solo
    .command('init')
    .description('Initialize PromptWheel local state for this repository')
    .option('-f, --force', 'Reinitialize even if already initialized')
    .action(async (options: { force?: boolean }) => {
      const git = createGitService();
      const repoRoot = await git.findRepoRoot(process.cwd());

      if (!repoRoot) {
        console.error(chalk.red('✗ Not a git repository'));
        console.error('  Run this command from within a git repository');
        process.exit(1);
      }

      if (isInitialized(repoRoot) && !options.force) {
        console.log(chalk.yellow('Already initialized.'));
        console.log(chalk.gray(`  Config: ${getPromptwheelDir(repoRoot)}/config.json`));
        console.log(chalk.gray(`  Database: ${getDbPath(repoRoot)}`));
        console.log();
        console.log('Run with --force to reinitialize.');
        return;
      }

      const { config, detectedQa } = await initSolo(repoRoot);

      // Initialize database
      const adapter = await getAdapter(repoRoot);
      await adapter.close();

      console.log(chalk.green('✓ Initialized PromptWheel solo mode'));
      console.log(chalk.gray(`  Config: ${getPromptwheelDir(repoRoot)}/config.json`));
      console.log(chalk.gray(`  Database: ${config.dbPath}`));

      // Show detected QA commands
      if (detectedQa.length > 0) {
        console.log();
        console.log(chalk.green('✓ Detected QA commands from package.json:'));
        for (const cmd of detectedQa) {
          console.log(chalk.gray(`  • ${cmd.name}: ${cmd.cmd}`));
        }
        console.log(chalk.gray('  (Edit .promptwheel/config.json to customize)'));
      } else {
        console.log();
        console.log(chalk.yellow('⚠ No QA commands detected'));
        console.log(chalk.gray('  Add qa.commands to .promptwheel/config.json to enable QA:'));
        console.log(chalk.gray('  {'));
        console.log(chalk.gray('    "qa": {'));
        console.log(chalk.gray('      "commands": ['));
        console.log(chalk.gray('        { "name": "lint", "cmd": "npm run lint" },'));
        console.log(chalk.gray('        { "name": "test", "cmd": "npm test" }'));
        console.log(chalk.gray('      ]'));
        console.log(chalk.gray('    }'));
        console.log(chalk.gray('  }'));
      }

      console.log();
      console.log('Next steps:');
      console.log('  promptwheel solo scout .    Scan for improvement opportunities');
      console.log('  promptwheel solo status     View local state');
    });

  /**
   * solo report - View session reports
   */
  solo
    .command('report')
    .description('View session reports')
    .option('--list', 'List all reports')
    .option('--last', 'Show most recent report (default)')
    .action(async (options: { list?: boolean; last?: boolean }) => {
      const git = createGitService();
      const repoRoot = await git.findRepoRoot(process.cwd());

      if (!repoRoot) {
        console.error(chalk.red('✗ Not a git repository'));
        process.exit(1);
      }

      const reportsDir = path.join(getPromptwheelDir(repoRoot), 'reports');
      if (!fs.existsSync(reportsDir)) {
        console.log(chalk.gray('No reports yet. Run promptwheel to generate one.'));
        return;
      }

      const files = fs.readdirSync(reportsDir)
        .filter(f => f.endsWith('.md'))
        .sort()
        .reverse();

      if (files.length === 0) {
        console.log(chalk.gray('No reports yet. Run promptwheel to generate one.'));
        return;
      }

      if (options.list) {
        for (const f of files) {
          console.log(f);
        }
      } else {
        const latest = files[0];
        console.log(fs.readFileSync(path.join(reportsDir, latest), 'utf-8'));
      }
    });

  /**
   * solo doctor - Check prerequisites and environment
   */
  solo
    .command('doctor')
    .description('Check prerequisites and environment health')
    .option('--json', 'Output as JSON')
    .option('-v, --verbose', 'Show all details')
    .action(async (options: { json?: boolean; verbose?: boolean }) => {
      const git = createGitService();
      const repoRoot = await git.findRepoRoot(process.cwd());

      const report = await runDoctorChecks({
        repoRoot: repoRoot ?? undefined,
        verbose: options.verbose,
      });

      if (options.json) {
        console.log(formatDoctorReportJson(report));
      } else {
        console.log(formatDoctorReport(report));
      }

      if (!report.canRun) {
        process.exitCode = 1;
      }
    });

  /**
   * solo reset - Clear all local state
   */
  solo
    .command('reset')
    .description('Clear all local state (destructive)')
    .option('-f, --force', 'Skip confirmation prompt')
    .action(async (options: { force?: boolean }) => {
      const git = createGitService();
      const repoRoot = await git.findRepoRoot(process.cwd());

      if (!repoRoot) {
        console.error(chalk.red('✗ Not a git repository'));
        process.exit(1);
      }

      const dir = getPromptwheelDir(repoRoot);
      const dbPathVal = getDbPath(repoRoot);

      if (!fs.existsSync(dir)) {
        console.log(chalk.gray('No local state to clear'));
        return;
      }

      if (!options.force) {
        console.log(chalk.yellow('⚠ This will delete all local PromptWheel data:'));
        console.log(chalk.gray(`  ${dir}`));
        console.log();
        console.log('Run with --force to confirm.');
        process.exit(1);
      }

      if (fs.existsSync(dbPathVal)) {
        fs.unlinkSync(dbPathVal);
      }
      if (fs.existsSync(`${dbPathVal}-wal`)) {
        fs.unlinkSync(`${dbPathVal}-wal`);
      }
      if (fs.existsSync(`${dbPathVal}-shm`)) {
        fs.unlinkSync(`${dbPathVal}-shm`);
      }

      const configPath = path.join(dir, 'config.json');
      if (fs.existsSync(configPath)) {
        fs.unlinkSync(configPath);
      }

      try {
        fs.rmdirSync(dir);
      } catch {
        // Directory not empty, leave it
      }

      console.log(chalk.green('✓ Local state cleared'));
    });

  /**
   * solo prune - Clean up stale state
   */
  solo
    .command('prune').alias('clean')
    .description('Remove stale runs, history, artifacts, and archives')
    .option('--dry-run', 'Show what would be deleted without deleting')
    .action(async (options: { dryRun?: boolean }) => {
      const git = createGitService();
      const repoRoot = await git.findRepoRoot(process.cwd());

      if (!repoRoot) {
        console.error(chalk.red('✗ Not a git repository'));
        process.exit(1);
      }

      if (!isInitialized(repoRoot)) {
        console.error(chalk.red('✗ PromptWheel not initialized'));
        console.error(chalk.gray('  Run: promptwheel init'));
        process.exit(1);
      }

      const { loadConfig } = await import('../lib/solo-config.js');
      const {
        pruneAllAsync,
        getRetentionConfig,
        formatPruneReport,
      } = await import('../lib/retention.js');

      const config = loadConfig(repoRoot);
      const retentionConfig = getRetentionConfig(config);

      let adapter: Awaited<ReturnType<typeof getAdapter>> | null = null;
      try {
        adapter = await getAdapter(repoRoot);
      } catch {
        // DB may not exist yet — prune without it
      }

      const dryRun = options.dryRun ?? false;

      console.log(chalk.blue(dryRun ? 'Prune (dry run)' : 'Pruning stale state...'));
      console.log();

      const report = await pruneAllAsync(
        repoRoot,
        retentionConfig,
        adapter,
        dryRun,
      );

      console.log(formatPruneReport(report, dryRun));
      console.log();

      if (!dryRun && report.totalPruned > 0) {
        console.log(chalk.green(`✓ Pruned ${report.totalPruned} item(s)`));
      } else if (!dryRun) {
        console.log(chalk.green('✓ Nothing to prune'));
      }

      if (adapter) {
        await adapter.close();
      }
    });
}
