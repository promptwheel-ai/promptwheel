/**
 * Solo auto commands: auto (default, ci, work modes)
 */

import { Command } from 'commander';
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

Trust Ladder:
  Default:   refactor, docs, types, perf, security, fix, cleanup
  --tests:   Add test proposals (opt-in)
  --safe:    refactor, docs, types, perf only

Backend Lanes:
  --claude (default):  scout + execute with Claude  (ANTHROPIC_API_KEY)
  --codex:             scout + execute with Codex   (CODEX_API_KEY or codex login)
  --kimi:              scout + execute with Kimi    (MOONSHOT_API_KEY or kimi /login)
  --local:             scout + execute with local   (Ollama/vLLM/SGLang/LM Studio)
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
    .option('--safe', 'Restrict to safe categories only (refactor, docs, types, perf)')
    .option('--tests', 'Include test proposals (excluded by default)')
    .option('--no-draft', 'Create regular PRs instead of drafts')
    .option('--yes', 'Skip confirmation prompt')
    .option('--minutes <n>', 'Run for N minutes (enables continuous mode)')
    .option('--hours <n>', 'Run for N hours (enables continuous mode)')
    .option('--cycles <n>', 'Number of scout→execute cycles (default: 3)')
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
    .option('--kimi', 'Use Kimi for both scouting and execution (MOONSHOT_API_KEY)')
    .option('--scout-backend <name>', 'LLM for scouting: claude | codex | kimi (default: claude)')
    .option('--execute-backend <name>', 'LLM for execution: claude | codex | kimi (default: claude)')
    .option('--codex-model <model>', 'Model for Codex backend (default: codex-mini)')
    .option('--kimi-model <model>', 'Model for Kimi backend (default: kimi-k2.5)')
    .option('--codex-unsafe-full-access', 'Use --dangerously-bypass-approvals-and-sandbox for Codex execution (requires isolated runner)')
    .option('--include-claude-md', 'Allow the scout to propose changes to CLAUDE.md and .claude/ (excluded by default)')
    .option('--batch-token-budget <n>', 'Token budget per scout batch (default: auto based on backend)')
    .option('--scout-timeout <seconds>', 'Timeout per scout batch in seconds (default: auto — 300s codex, 120s claude)')
    .option('--max-scout-files <n>', 'Maximum files to scan per scout cycle (default: 60)')
    .option('--scout-concurrency <n>', 'Max parallel scout batches (default: auto — 4 codex, 3 claude)')
    .option('--codex-mcp', 'Use persistent MCP session for Codex scouting (experimental, requires --codex)')
    .option('--local', 'Use a local OpenAI-compatible server (Ollama, vLLM, SGLang, LM Studio)')
    .option('--local-url <url>', 'Base URL for local server (default: http://localhost:11434/v1)')
    .option('--local-model <model>', 'Model name for local server (required with --local)')
    .option('--local-max-iterations <n>', 'Max agentic loop iterations for local backend (default: 20)')
    .option('--no-docs-audit', 'Disable automatic docs-audit cycles')
    .option('--docs-audit-interval <n>', 'Run docs-audit every N cycles (default: 3)')
    .option('--pr', 'Use PR delivery mode (one draft PR per ticket)')
    .option('--auto-merge', 'Use auto-merge delivery mode')
    .option('--direct-branch <name>', 'Branch name for direct mode (default: blockspool)')
    .option('--direct-finalize <mode>', 'End-of-session: pr | merge | none (default: pr)')
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
          formula: options.formula,
          batchSize: options.batchSize,
          scoutBackend: scoutBackendName,
          executeBackend: executeBackendName,
          codexModel: options.codexModel,
          kimiModel: options.kimiModel,
          codexUnsafeFullAccess: options.codexUnsafeFullAccess,
          scoutConcurrency: options.scoutConcurrency,
          codexMcp: options.codexMcp,
          localUrl: options.localUrl,
          localModel: options.localModel,
          localMaxIterations: options.localMaxIterations,
          deliveryMode: options.autoMerge ? 'auto-merge' : options.pr ? 'pr' : undefined,
          directBranch: options.directBranch,
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
