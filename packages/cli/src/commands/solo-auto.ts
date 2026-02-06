/**
 * Solo auto commands: auto (default, ci, work modes)
 */

import { Command, Option } from 'commander';
import chalk from 'chalk';
import { createGitService } from '../lib/git.js';
import { runAutoMode, runAutoWorkMode } from '../lib/solo-auto.js';
import { handleCiMode } from './auto-ci-mode.js';
import { resolveBackends, type AuthOptions } from './auto-auth.js';

export function registerAutoCommands(solo: Command): void {
  /**
   * solo auto - Automated improvement workflow
   */
  solo
    .command('auto [mode]')
    .description('Scout, fix, and commit improvements automatically')
    .addHelpText('after', `
Auto-detects backend from environment:
  ANTHROPIC_API_KEY  → Claude
  CODEX_API_KEY      → Codex
  codex login        → Codex CLI

Examples:
  blockspool                    # One improvement cycle
  blockspool --hours 4          # Run for 4 hours
  blockspool --hours 0.5        # Run for 30 minutes
  blockspool --pr               # Create PRs instead of direct commits
  blockspool --formula deep     # Architectural review
  blockspool ci                 # Fix CI failures
`)
    // Primary options (visible in help)
    .option('--hours <n>', 'Run for N hours (accepts decimals: 0.5 = 30min)')
    .option('--pr', 'Create pull requests instead of direct commits')
    .option('--scope <path>', 'Directory to focus on')
    .option('--formula <name>', 'Formula: deep, security-audit, test-coverage')
    .option('--dry-run', 'Preview without making changes')
    .option('-v, --verbose', 'Detailed output')
    // Hidden options (still functional for power users)
    .addOption(new Option('--codex', 'Force Codex').hideHelp())
    .addOption(new Option('--claude', 'Force Claude').hideHelp())
    .addOption(new Option('--safe', 'Safe categories only').hideHelp())
    .addOption(new Option('--tests', 'Seek test proposals').hideHelp())
    .addOption(new Option('--yes', 'Skip prompts').hideHelp())
    .addOption(new Option('--parallel <n>', 'Parallel tickets').default('3').hideHelp())
    .addOption(new Option('--eco', 'Faster model').hideHelp())
    .addOption(new Option('--kimi', 'Use Kimi').hideHelp())
    .addOption(new Option('--local', 'Local server').hideHelp())
    .addOption(new Option('--local-url <url>', 'Local URL').hideHelp())
    .addOption(new Option('--local-model <model>', 'Local model').hideHelp())
    // Legacy/deprecated (kept for backwards compat)
    .addOption(new Option('--minutes <n>').hideHelp())
    .addOption(new Option('--cycles <n>').hideHelp())
    .addOption(new Option('--continuous').hideHelp())
    .addOption(new Option('--max-prs <n>').hideHelp())
    .addOption(new Option('--no-draft').hideHelp())
    .addOption(new Option('--branch <name>').hideHelp())
    .addOption(new Option('--deep').hideHelp())
    .addOption(new Option('--batch-size <n>').hideHelp())
    .addOption(new Option('--individual-prs').hideHelp())
    .addOption(new Option('--scout-backend <name>').hideHelp())
    .addOption(new Option('--execute-backend <name>').hideHelp())
    .addOption(new Option('--codex-model <model>').hideHelp())
    .addOption(new Option('--kimi-model <model>').hideHelp())
    .addOption(new Option('--codex-unsafe-full-access').hideHelp())
    .addOption(new Option('--include-claude-md').hideHelp())
    .addOption(new Option('--batch-token-budget <n>').hideHelp())
    .addOption(new Option('--scout-timeout <seconds>').hideHelp())
    .addOption(new Option('--max-scout-files <n>').hideHelp())
    .addOption(new Option('--scout-concurrency <n>').hideHelp())
    .addOption(new Option('--codex-mcp').hideHelp())
    .addOption(new Option('--local-max-iterations <n>').hideHelp())
    .addOption(new Option('--no-docs-audit').hideHelp())
    .addOption(new Option('--docs-audit-interval <n>').hideHelp())
    .addOption(new Option('--auto-merge').hideHelp())
    .addOption(new Option('--direct-branch <name>').hideHelp())
    .addOption(new Option('--direct-finalize <mode>').hideHelp())
    .addOption(new Option('--qa-fix').hideHelp())
    .action(async (mode: string | undefined, options: {
      dryRun?: boolean;
      scope?: string;
      maxPrs?: string;
      minConfidence?: string;
      safe?: boolean;
      tests?: boolean;
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
      kimi?: boolean;
      scoutBackend?: string;
      executeBackend?: string;
      codexModel?: string;
      kimiModel?: string;
      codexUnsafeFullAccess?: boolean;
      includeClaudeMd?: boolean;
      batchTokenBudget?: string;
      scoutTimeout?: string;
      maxScoutFiles?: string;
      docsAudit?: boolean;
      docsAuditInterval?: string;
      scoutConcurrency?: string;
      codexMcp?: boolean;
      local?: boolean;
      localUrl?: string;
      localModel?: string;
      localMaxIterations?: string;
      pr?: boolean;
      autoMerge?: boolean;
      directBranch?: string;
      directFinalize?: string;
      individualPrs?: boolean;
      qaFix?: boolean;
    }) => {
      if (options.deep && !options.formula) {
        options.formula = 'deep';
      }

      const { scoutBackendName, executeBackendName } = await resolveBackends(options);

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
          pr: options.pr,
          formula: options.formula,
          scoutBackend: scoutBackendName,
          executeBackend: executeBackendName,
          deliveryMode: options.autoMerge ? 'auto-merge' : options.pr ? 'pr' : undefined,
          directFinalize: options.directFinalize as 'pr' | 'merge' | 'none' | undefined,
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
      await handleCiMode(options);
    });
}
