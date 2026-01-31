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

Backend Lanes:
  --claude (default):  scout + execute with Claude  (ANTHROPIC_API_KEY)
  --codex:             scout + execute with Codex   (CODEX_API_KEY or codex login)
  Hybrid:              --scout-backend codex         (CODEX_API_KEY + ANTHROPIC_API_KEY)

Examples:
  blockspool                              # Scout + fix + PR (Claude, default)
  blockspool --codex                      # Full Codex mode (no Anthropic key)
  blockspool --codex --hours 4            # Codex overnight run
  blockspool --dry-run                    # Show what would be done
  blockspool --scope src/api              # Scout specific directory
  blockspool --formula security-audit     # Run a predefined formula
  blockspool --scout-backend codex        # Hybrid: Codex scouts, Claude executes
  blockspool ci                           # Fix failing CI
  blockspool work                         # Process existing tickets
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
    .option('--cycles <n>', 'Number of scout→execute cycles (default: 1)')
    .option('--continuous', 'Run continuously until stopped or PR limit reached')
    .option('-v, --verbose', 'Show detailed output')
    .option('--branch <name>', 'Target branch (default: current)')
    .option('--parallel <n>', 'Number of tickets to run concurrently (default: 3)', '3')
    .option('--formula <name>', 'Use a predefined formula (e.g., security-audit, test-coverage, cleanup, deep)')
    .option('--deep', 'Deep architectural review (shortcut for --formula deep)')
    .option('--eco', 'Use sonnet model for scouting (cheaper, faster, less thorough)')
    .option('--batch-size <n>', 'Milestone mode: merge N tickets into one PR (default: off)')
    .option('--codex', 'Use Codex for both scouting and execution (no Anthropic key needed)')
    .option('--claude', 'Use Claude for both scouting and execution (default)')
    .option('--scout-backend <name>', 'LLM for scouting: claude | codex (default: claude)')
    .option('--execute-backend <name>', 'LLM for execution: claude | codex (default: claude)')
    .option('--codex-unsafe-full-access', 'Use --dangerously-bypass-approvals-and-sandbox for Codex execution (requires isolated runner)')
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
      cycles?: string;
      continuous?: boolean;
      verbose?: boolean;
      branch?: string;
      parallel?: string;
      formula?: string;
      deep?: boolean;
      eco?: boolean;
      batchSize?: string;
      codex?: boolean;
      claude?: boolean;
      scoutBackend?: string;
      executeBackend?: string;
      codexUnsafeFullAccess?: boolean;
    }) => {
      if (options.deep && !options.formula) {
        options.formula = 'deep';
      }

      // --codex / --claude shorthands expand to both backends
      if (options.codex && options.claude) {
        console.error(chalk.red('✗ Cannot use --codex and --claude together'));
        process.exit(1);
      }
      if (options.codex) {
        options.scoutBackend = options.scoutBackend ?? 'codex';
        options.executeBackend = options.executeBackend ?? 'codex';
      }

      const scoutBackendName = options.scoutBackend ?? 'claude';
      const executeBackendName = options.executeBackend ?? 'claude';
      const needsClaude = scoutBackendName === 'claude' || executeBackendName === 'claude';
      const needsCodex = scoutBackendName === 'codex' || executeBackendName === 'codex';
      const insideClaudeCode = process.env.CLAUDECODE === '1';

      // Validate backend names
      for (const [flag, value] of [['--scout-backend', scoutBackendName], ['--execute-backend', executeBackendName]] as const) {
        if (value !== 'claude' && value !== 'codex') {
          console.error(chalk.red(`✗ Invalid ${flag}: ${value}`));
          console.error(chalk.gray('  Valid values: claude, codex'));
          process.exit(1);
        }
      }

      // Detect running inside Claude Code session
      if (insideClaudeCode) {
        if (needsClaude) {
          // Block: spawning `claude -p` inside Claude Code either fails (no key)
          // or double-charges (subscription + API).
          console.error(chalk.red('✗ Cannot run Claude backend inside Claude Code'));
          console.error();
          console.error(chalk.gray('  The CLI spawns Claude as subprocesses (requires ANTHROPIC_API_KEY).'));
          console.error(chalk.gray('  Inside Claude Code, use the plugin instead:'));
          console.error();
          console.error(chalk.white('    /blockspool:run'));
          console.error();
          console.error(chalk.gray('  Or run from a regular terminal:'));
          console.error();
          console.error(chalk.white('    blockspool          # Claude (needs ANTHROPIC_API_KEY)'));
          console.error(chalk.white('    blockspool --codex  # Codex (needs CODEX_API_KEY)'));
          console.error();
          process.exit(1);
        } else {
          // Codex backend inside Claude Code — technically works but wasteful.
          // The outer Claude Code session is running (and billing) while Codex
          // does all the work. Better to run from a regular terminal.
          console.log(chalk.yellow('⚠ Running inside Claude Code session'));
          console.log(chalk.yellow('  This works, but you\'re paying for an idle Claude Code session.'));
          console.log(chalk.yellow('  Consider running from a regular terminal instead:'));
          console.log(chalk.white('    blockspool --codex'));
          console.log();
        }
      }

      // Auth: Claude lane
      if (needsClaude && !process.env.ANTHROPIC_API_KEY) {
        console.error(chalk.red('✗ ANTHROPIC_API_KEY not set'));
        console.error(chalk.gray('  Required for Claude backend. Set the env var, or use:'));
        console.error(chalk.gray('    blockspool --codex  (uses CODEX_API_KEY or codex login)'));
        console.error(chalk.gray('    /blockspool:run    (inside Claude Code, uses subscription)'));
        process.exit(1);
      }

      // Auth: Codex lane
      if (needsCodex) {
        if (process.env.CODEX_API_KEY) {
          // Good — env var present
        } else {
          const { spawnSync } = await import('node:child_process');
          const loginCheck = spawnSync('codex', ['login', 'status'], { encoding: 'utf-8', timeout: 10000 });
          if (loginCheck.status !== 0) {
            console.error(chalk.red('✗ Codex not authenticated'));
            console.error(chalk.gray('  Set CODEX_API_KEY or run: codex login'));
            process.exit(1);
          }
        }
      }

      // Print auth summary
      if (scoutBackendName === executeBackendName) {
        const authSource = scoutBackendName === 'claude'
          ? 'ANTHROPIC_API_KEY (env)'
          : (process.env.CODEX_API_KEY ? 'CODEX_API_KEY (env)' : 'codex login');
        console.log(chalk.gray(`Auth: ${authSource}`));
      } else {
        const scoutAuth = scoutBackendName === 'claude'
          ? 'ANTHROPIC_API_KEY (env)'
          : (process.env.CODEX_API_KEY ? 'CODEX_API_KEY (env)' : 'codex login');
        const execAuth = executeBackendName === 'claude'
          ? 'ANTHROPIC_API_KEY (env)'
          : (process.env.CODEX_API_KEY ? 'CODEX_API_KEY (env)' : 'codex login');
        console.log(chalk.gray(`Auth (scout):   ${scoutAuth}`));
        console.log(chalk.gray(`Auth (execute): ${execAuth}`));
      }

      // Warn about unsafe flag
      if (options.codexUnsafeFullAccess) {
        if (executeBackendName !== 'codex') {
          console.error(chalk.red('✗ --codex-unsafe-full-access only applies with --execute-backend codex'));
          process.exit(1);
        }
        console.log(chalk.yellow('⚠ --codex-unsafe-full-access: sandbox disabled for Codex execution'));
        console.log(chalk.yellow('  Only use this inside an externally hardened/isolated runner'));
      }

      // Periodic billing reminder
      try {
        const { getBillingReminder } = await import('../lib/run-history.js');
        const git = createGitService();
        const root = await git.findRepoRoot(process.cwd());
        const reminder = root ? getBillingReminder(root) : null;
        if (reminder) {
          console.log();
          console.log(chalk.yellow(reminder));
          console.log();
        }
      } catch {
        // Non-fatal
      }

      const effectiveMode = mode || 'auto';

      if (effectiveMode !== 'ci' && effectiveMode !== 'work' && effectiveMode !== 'auto') {
        console.error(chalk.red(`✗ Unknown auto mode: ${effectiveMode}`));
        console.error(chalk.gray('  Available modes: (default), ci, work'));
        process.exit(1);
      }

      if (effectiveMode === 'auto') {
        await runAutoMode({
          ...options,
          formula: options.formula,
          batchSize: options.batchSize,
          scoutBackend: scoutBackendName,
          executeBackend: executeBackendName,
          codexUnsafeFullAccess: options.codexUnsafeFullAccess,
        });
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
