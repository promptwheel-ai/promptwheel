/**
 * Solo auto commands: auto (default, ci, work modes)
 */

import { Command } from 'commander';
import * as path from 'node:path';
import chalk from 'chalk';
import { projects, tickets } from '@blockspool/core/repos';
import { createGitService } from '../lib/git.js';
import {
  isInitialized,
  loadConfig,
  getAdapter,
} from '../lib/solo-config.js';
import { soloRunTicket } from '../lib/solo-ticket.js';
import { spawnSyncSafe, getCurrentBranch, getCIStatus, getFailureLogs, parseFailure, extractFailureScope, generateCIFixDescription } from '../lib/solo-ci.js';
import { runAutoMode, runAutoWorkMode } from '../lib/solo-auto.js';

export function registerAutoCommands(solo: Command): void {
  /**
   * solo auto - Automated improvement workflow
   */
  solo
    .command('auto [mode]')
    .description('Scout, fix, and create PRs automatically')
    .addHelpText('after', `
Modes:
  (default)  Scout → auto-approve safe changes → run → create draft PRs
  ci         Fix CI failures automatically
  work       Process existing ready tickets

The default mode is the full "just run it" experience:
1. Scouts your codebase for improvements
2. Auto-approves low-risk changes (refactor, tests, docs)
3. Runs tickets one at a time with QA verification
4. Creates draft PRs for review
5. Stops after reaching PR limit (default: 3)

Trust Ladder (use --aggressive for more):
  Default:   refactor, test, docs, types, perf (safe categories only)
  Aggressive: + security fixes (still excludes deps, migrations)

Examples:
  blockspool solo auto                    # Scout + fix + PR (safe defaults)
  blockspool solo auto --dry-run          # Show what would be done
  blockspool solo auto --scope src/api    # Scout specific directory
  blockspool solo auto --formula security-audit  # Run a predefined formula
  blockspool solo auto --max-prs 5        # Allow up to 5 PRs
  blockspool solo auto --aggressive       # Include more categories
  blockspool solo auto --batch-size 30     # Milestone mode: 30 tickets per PR
  blockspool solo auto --minutes 15       # Run for 15 minutes
  blockspool solo auto --hours 4          # Run for 4 hours (overnight mode)
  blockspool solo auto --continuous       # Run until stopped (Ctrl+C)
  blockspool solo auto ci                 # Fix failing CI
  blockspool solo auto work               # Process existing tickets
`)
    .option('--dry-run', 'Show what would be done without making changes')
    .option('--scope <path>', 'Directory to scout (default: src, rotates in continuous mode)')
    .option('--max-prs <n>', 'Maximum PRs to create (default: 3, or 20 in continuous mode)')
    .option('--min-confidence <n>', 'Minimum confidence for auto-approve (default: 70)')
    .option('--aggressive', 'Include more categories (security fixes, etc.)')
    .option('--no-draft', 'Create regular PRs instead of drafts')
    .option('--yes', 'Skip confirmation prompt')
    .option('--minutes <n>', 'Run for N minutes (enables continuous mode)')
    .option('--hours <n>', 'Run for N hours (enables continuous mode)')
    .option('--continuous', 'Run continuously until stopped or PR limit reached')
    .option('-v, --verbose', 'Show detailed output')
    .option('--branch <name>', 'Target branch (default: current)')
    .option('--parallel <n>', 'Number of tickets to run concurrently (default: 3)', '3')
    .option('--formula <name>', 'Use a predefined formula (e.g., security-audit, test-coverage, cleanup, deep)')
    .option('--deep', 'Deep architectural review (shortcut for --formula deep)')
    .option('--batch-size <n>', 'Milestone mode: merge N tickets into one PR (default: off)')
    .action(async (mode: string | undefined, options: {
      dryRun?: boolean;
      scope?: string;
      maxPrs?: string;
      minConfidence?: string;
      aggressive?: boolean;
      draft?: boolean;
      yes?: boolean;
      minutes?: string;
      hours?: string;
      continuous?: boolean;
      verbose?: boolean;
      branch?: string;
      parallel?: string;
      formula?: string;
      deep?: boolean;
      batchSize?: string;
    }) => {
      if (options.deep && !options.formula) {
        options.formula = 'deep';
      }
      const effectiveMode = mode || 'auto';

      if (effectiveMode !== 'ci' && effectiveMode !== 'work' && effectiveMode !== 'auto') {
        console.error(chalk.red(`✗ Unknown auto mode: ${effectiveMode}`));
        console.error(chalk.gray('  Available modes: (default), ci, work'));
        process.exit(1);
      }

      if (effectiveMode === 'auto') {
        await runAutoMode({ ...options, formula: options.formula, batchSize: options.batchSize });
        return;
      }

      if (effectiveMode === 'work') {
        await runAutoWorkMode({
          dryRun: options.dryRun,
          pr: true,
          verbose: options.verbose,
          parallel: options.parallel,
        });
        return;
      }

      // CI mode
      console.log(chalk.blue('🧵 BlockSpool Auto - CI Fix'));
      console.log();

      const git = createGitService();
      const repoRoot = await git.findRepoRoot(process.cwd());

      if (!repoRoot) {
        console.error(chalk.red('✗ Not a git repository'));
        process.exit(1);
      }

      if (!isInitialized(repoRoot)) {
        console.error(chalk.red('✗ BlockSpool not initialized'));
        console.error(chalk.gray('  Run: blockspool solo init'));
        process.exit(1);
      }

      const ghResult = spawnSyncSafe('gh', ['--version']);
      if (!ghResult.ok) {
        console.error(chalk.red('✗ GitHub CLI (gh) not found'));
        console.error(chalk.gray('  Install: https://cli.github.com/'));
        process.exit(1);
      }

      const targetBranch = options.branch || await getCurrentBranch(repoRoot);
      console.log(chalk.gray(`Branch: ${targetBranch}`));

      console.log(chalk.gray('Checking CI status...'));
      const ciStatus = await getCIStatus(repoRoot, targetBranch);

      if (ciStatus.status === 'success') {
        console.log(chalk.green('✓ CI is passing. Nothing to fix.'));
        process.exit(0);
      }

      if (ciStatus.status === 'pending') {
        console.log(chalk.yellow('⏳ CI is still running. Wait for it to complete.'));
        process.exit(0);
      }

      if (ciStatus.status === 'unknown') {
        console.log(chalk.yellow('? Could not determine CI status'));
        console.log(chalk.gray('  Make sure gh is authenticated and the repo has GitHub Actions'));
        process.exit(1);
      }

      console.log(chalk.red(`✗ CI failed: ${ciStatus.conclusion || 'failure'}`));
      console.log();

      if (ciStatus.failedJobs.length === 0) {
        console.log(chalk.yellow('Could not identify failed jobs'));
        console.log(chalk.gray('  Check GitHub Actions manually'));
        process.exit(1);
      }

      console.log(chalk.bold('Failed jobs:'));
      for (const job of ciStatus.failedJobs) {
        console.log(chalk.red(`  • ${job.name}`));
      }
      console.log();

      console.log(chalk.gray('Fetching failure logs...'));
      const logs = await getFailureLogs(ciStatus.runId, ciStatus.failedJobs[0].id);

      if (!logs) {
        console.log(chalk.yellow('Could not fetch failure logs'));
        process.exit(1);
      }

      const failure = parseFailure(logs);

      if (!failure) {
        console.log(chalk.yellow('Could not parse failure from logs'));
        console.log(chalk.gray('  The failure format may not be supported yet'));
        if (options.verbose) {
          console.log();
          console.log(chalk.gray('--- Last 50 lines of logs ---'));
          console.log(logs.split('\n').slice(-50).join('\n'));
        }
        process.exit(1);
      }

      console.log(chalk.bold('Detected failure:'));
      console.log(`  Type: ${failure.type}`);
      if (failure.framework) console.log(`  Framework: ${failure.framework}`);
      console.log(`  Message: ${failure.message}`);
      if (failure.file) console.log(`  File: ${failure.file}${failure.line ? `:${failure.line}` : ''}`);
      console.log();

      const scope = extractFailureScope(failure);
      console.log(chalk.bold('Affected files:'));
      for (const file of scope) {
        console.log(chalk.gray(`  • ${file}`));
      }
      console.log();

      if (options.dryRun) {
        console.log(chalk.yellow('Dry run - no changes made'));
        console.log();
        console.log(chalk.bold('Would create ticket:'));
        console.log(`  Title: Fix ${failure.type} failure${failure.file ? ` in ${failure.file}` : ''}`);
        console.log(`  Scope: ${scope.join(', ')}`);
        console.log();
        console.log('Run without --dry-run to fix the issue.');
        process.exit(0);
      }

      const adapter = await getAdapter(repoRoot);
      const project = await projects.ensureForRepo(adapter, {
        name: path.basename(repoRoot),
        rootPath: repoRoot,
      });

      const title = `Fix ${failure.type} failure${failure.file ? ` in ${failure.file}` : ''}`;
      const description = generateCIFixDescription(failure, scope, ciStatus);

      const ticket = await tickets.create(adapter, {
        projectId: project.id,
        title,
        description,
        priority: 1,
        allowedPaths: scope.length > 0 ? scope : undefined,
        forbiddenPaths: ['node_modules', '.git', 'dist', 'build'],
      });
      const ciTicketId = ticket.id;

      console.log(chalk.green(`✓ Created ticket: ${ciTicketId}`));
      console.log(chalk.gray(`  Title: ${title}`));
      console.log();

      console.log(chalk.bold('Running ticket...'));
      const config = loadConfig(repoRoot);
      const runId = `run_${Date.now().toString(36)}`;

      const result = await soloRunTicket({
        ticket,
        repoRoot,
        config,
        adapter,
        runId,
        skipQa: false,
        createPr: true,
        draftPr: true,
        timeoutMs: 600000,
        verbose: options.verbose ?? false,
        onProgress: (msg) => {
          if (options.verbose) {
            console.log(chalk.gray(`  ${msg}`));
          }
        },
      });

      await adapter.close();

      console.log();
      if (result.success) {
        console.log(chalk.green('✓ CI failure fixed!'));
        if (result.branchName) {
          console.log(chalk.gray(`  Branch: ${result.branchName}`));
        }
        if (result.prUrl) {
          console.log(chalk.cyan(`  PR: ${result.prUrl}`));
        }
        console.log();
        console.log('Next steps:');
        if (!result.prUrl) {
          console.log('  • Review the changes on the branch');
          console.log('  • Create a PR: blockspool solo run ' + ciTicketId + ' --pr');
        } else {
          console.log('  • Review and merge the PR');
        }
      } else {
        console.log(chalk.red('✗ Could not fix CI failure'));
        if (result.error) {
          console.log(chalk.gray(`  Error: ${result.error}`));
        }
        if (result.failureReason === 'spindle_abort') {
          console.log(chalk.yellow('  Agent stopped by Spindle (loop protection)'));
          console.log(chalk.gray('  The issue may be too complex for automated fixing'));
        }
        console.log();
        console.log("Here's what I tried:");
        console.log(chalk.gray(`  Ticket: ${ciTicketId}`));
        console.log(chalk.gray(`  View: blockspool solo artifacts --run ${runId}`));
      }

      process.exit(result.success ? 0 : 1);
    });
}
