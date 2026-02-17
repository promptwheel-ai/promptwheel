/**
 * CI fix mode handler for solo auto.
 */

import * as path from 'node:path';
import chalk from 'chalk';
import { projects, tickets } from '@promptwheel/core/repos';
import {
  isInitialized,
  loadConfig,
  getAdapter,
} from '../lib/solo-config.js';
import { soloRunTicket } from '../lib/solo-ticket.js';
import { spawnSyncSafe, getCurrentBranch, getCIStatus, getFailureLogs, parseFailure, extractFailureScope, generateCIFixDescription } from '../lib/solo-ci.js';
import { createGitService } from '../lib/git.js';

export async function handleCiMode(options: {
  dryRun?: boolean;
  verbose?: boolean;
  branch?: string;
}): Promise<void> {
  console.log(chalk.blue('🧵 PromptWheel Auto - CI Fix'));
  console.log();

  const git = createGitService();
  const repoRoot = await git.findRepoRoot(process.cwd());

  if (!repoRoot) {
    console.error(chalk.red('✗ Not a git repository'));
    process.exit(1);
  }

  if (!isInitialized(repoRoot)) {
    console.error(chalk.red('✗ PromptWheel not initialized'));
    console.error(chalk.gray('  Run: promptwheel solo init'));
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
      console.log('  • Create a PR: promptwheel solo run ' + ciTicketId + ' --pr');
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
    console.log(chalk.gray(`  View: promptwheel solo artifacts --run ${runId}`));
  }

  process.exit(result.success ? 0 : 1);
}
