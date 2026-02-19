/**
 * Solo auto commands: auto (default, ci, work modes)
 */

import { Command, Option } from 'commander';
import chalk from 'chalk';
import { createGitService } from '../lib/git.js';
import { runAutoMode, runAutoWorkMode } from '../lib/solo-auto.js';
import { handleCiMode } from './auto-ci-mode.js';
import { resolveBackends } from './auto-auth.js';

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
  OPENAI_API_KEY     → Codex
  codex login        → Codex CLI

Examples:
  promptwheel                    # Scout all, approve roadmap, execute
  promptwheel --spin             # Spin mode (run until Ctrl+C)
  promptwheel --spin --hours 4   # Timed spin
  promptwheel --pr               # Create PRs instead of direct commits
  promptwheel --formula deep     # Architectural review
  promptwheel ci                 # Fix CI failures
`)
    // Primary options (visible in help)
    .option('--spin', 'Spin mode — scout, fix, repeat (run until Ctrl+C or --hours expires)')
    .option('--hours <n>', 'Run for N hours (accepts decimals: 0.5 = 30min)')
    .option('--pr', 'Create pull requests instead of direct commits')
    .option('--scope <path>', 'Directory to focus on')
    .option('--formula <name>', 'Formula: deep, security-audit, test-coverage')
    .option('--dry-run', 'Preview without making changes')
    .option('-v, --verbose', 'Detailed output')
    .option('--no-tui', 'Disable live terminal UI (use spinner output instead)')
    // Backend and execution options
    .option('--codex', 'Use Codex (OpenAI) backend')
    .option('--kimi', 'Use Kimi backend')
    .option('--local', 'Use local LLM server (Ollama, vLLM, etc.)')
    .addOption(new Option('--local-model <model>', 'Local model name').implies({ local: true }))
    .addOption(new Option('--local-url <url>', 'Local server URL (default: http://localhost:11434)').implies({ local: true }))
    .option('--batch-size <n>', 'Merge N tickets into one milestone PR')
    .option('--safe', 'Safe categories only (no tests, no risky changes)')
    .option('--tests', 'Include test-writing proposals')
    .option('--deep', 'Architectural review mode')
    // Power-user options (hidden)
    .addOption(new Option('--claude', 'Force Claude').hideHelp())
    .addOption(new Option('--yes', 'Skip prompts').hideHelp())
    .addOption(new Option('--parallel <n>', 'Parallel tickets').default('3').hideHelp())
    .addOption(new Option('--eco', 'Faster model').hideHelp())
    // Legacy/deprecated (kept for backwards compat)
    .addOption(new Option('--minutes <n>').hideHelp())
    .addOption(new Option('--cycles <n>').hideHelp())
    .addOption(new Option('--continuous').hideHelp())
    .addOption(new Option('--max-prs <n>').hideHelp())
    .addOption(new Option('--no-draft').hideHelp())
    .addOption(new Option('--branch <name>').hideHelp())
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
    .addOption(new Option('--qa-fix').default(true).hideHelp())
    .addOption(new Option('--no-qa-fix').hideHelp())
    .action(async (mode: string | undefined, options: {
      spin?: boolean;
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
      tui?: boolean;
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
          spin: options.spin,
          pr: options.pr,
          formula: options.formula,
          tui: options.tui,
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
