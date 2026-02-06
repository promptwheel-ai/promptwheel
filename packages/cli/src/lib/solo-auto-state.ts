/**
 * AutoSessionState — mutable context object for runAutoMode.
 * Replaces ~55 closure variables with a single passable struct.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import chalk from 'chalk';
import { spawnSync } from 'node:child_process';
import type { DatabaseAdapter } from '@blockspool/core/db';
import type { ScoutBackend } from '@blockspool/core/services';
import { projects } from '@blockspool/core/repos';
import { createGitService } from './git.js';
import {
  getAdapter,
  isInitialized,
  initSolo,
  loadConfig,
  createScoutDeps,
} from './solo-config.js';
import { runPreflightChecks } from './solo-utils.js';
import { readRunState } from './run-state.js';
import type { RunTicketResult } from './solo-ticket-types.js';
import { runClaude, type ExecutionBackend } from './execution-backends/index.js';
import { getSessionPhase } from './solo-auto-utils.js';
import { getCycleFormula as getCycleFormulaImpl, getCycleCategories as getCycleCategoriesImpl, type CycleFormulaContext } from './solo-cycle-formula.js';
import {
  createMilestoneBranch,
  cleanupMilestone,
  pushAndPrMilestone,
  ensureDirectBranch,
} from './solo-git.js';
import { startInteractiveConsole, type InteractiveConsole } from './solo-stdin.js';
import { loadGuidelines, formatGuidelinesForPrompt } from './guidelines.js';
import type { ProjectGuidelines, GuidelinesBackend } from './guidelines.js';
import { loadLearnings, type Learning } from './learnings.js';
import {
  loadDedupMemory,
  type DedupEntry,
} from './dedup-memory.js';
import { pruneStaleWorktrees } from './retention.js';
import { resetQaStatsForSession, autoTuneQaConfig } from './qa-stats.js';
import { captureQaBaseline } from './solo-ticket.js';
import { normalizeQaConfig } from './solo-utils.js';
import {
  buildCodebaseIndex,
  type CodebaseIndex,
} from './codebase-index.js';
import { detectProjectMetadata, formatMetadataForPrompt } from './project-metadata/index.js';
import { DEFAULT_AUTO_CONFIG } from './solo-config.js';
import {
  loadOrBuildSectors, pickNextSector,
  type SectorState,
} from './sectors.js';
import { loadTasteProfile } from './taste-profile.js';
import type { TicketOutcome } from './run-history.js';
import type { CycleSummary } from './cycle-context.js';
import type { BatchProgressDisplay } from './spinner.js';
import { initMetrics, closeMetrics, metric } from './metrics.js';

// ── Options type (matches runAutoMode parameter) ────────────────────────────

export interface AutoModeOptions {
  // Primary options
  hours?: string;
  pr?: boolean;  // --pr flag sets deliveryMode to 'pr'
  scope?: string;
  formula?: string;
  dryRun?: boolean;
  verbose?: boolean;

  // Secondary options (hidden but functional)
  codex?: boolean;
  safe?: boolean;
  tests?: boolean;
  yes?: boolean;
  parallel?: string;
  eco?: boolean;

  // Legacy/advanced options (kept for backwards compat)
  minutes?: string;
  cycles?: string;
  continuous?: boolean;
  maxPrs?: string;
  minConfidence?: string;
  draft?: boolean;
  deep?: boolean;
  batchSize?: string;
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
  localUrl?: string;
  localModel?: string;
  localMaxIterations?: string;
  deliveryMode?: 'direct' | 'pr' | 'auto-merge';
  directBranch?: string;
  directFinalize?: 'pr' | 'merge' | 'none';
  individualPrs?: boolean;
  skipQaFix?: boolean;
  /** Enable AI-powered QA baseline fix (off by default — modifies working tree) */
  qaFix?: boolean;
}

// ── Session state ───────────────────────────────────────────────────────────

export interface AutoSessionState {
  // Options & config
  options: AutoModeOptions;
  config: ReturnType<typeof loadConfig>;
  autoConf: Record<string, any>;
  repoRoot: string;

  // Formula
  activeFormula: import('./formulas.js').Formula | null;
  deepFormula: import('./formulas.js').Formula | null;
  docsAuditFormula: import('./formulas.js').Formula | null;
  currentFormulaName: string;

  // Timing
  isContinuous: boolean;
  totalMinutes: number | undefined;
  endTime: number | undefined;
  startTime: number;

  // Limits
  maxPrs: number;
  maxCycles: number;
  minConfidence: number;
  useDraft: boolean;

  // Milestone
  milestoneMode: boolean;
  batchSize: number | undefined;
  milestoneBranch: string | undefined;
  milestoneWorktreePath: string | undefined;
  milestoneTicketCount: number;
  milestoneNumber: number;
  totalMilestonePrs: number;
  milestoneTicketSummaries: string[];

  // Direct delivery
  deliveryMode: 'direct' | 'pr' | 'auto-merge';
  directBranch: string;
  directFinalize: 'pr' | 'merge' | 'none';
  completedDirectTickets: Array<{ title: string; category: string; files: string[] }>;

  // Counters
  totalPrsCreated: number;
  totalFailed: number;
  cycleCount: number;
  allPrUrls: string[];
  totalMergedPrs: number;
  totalClosedPrs: number;
  pendingPrUrls: string[];

  // Sector
  sectorState: SectorState | null;
  currentSectorId: string | null;
  currentSectorCycle: number;

  // Quality
  effectiveMinConfidence: number;
  consecutiveLowYieldCycles: number;

  // Phase
  sessionPhase: 'warmup' | 'deep' | 'cooldown';

  // Outcomes
  allTicketOutcomes: TicketOutcome[];
  cycleOutcomes: TicketOutcome[];

  // PR meta tracking
  prMetaMap: Map<string, { sectorId: string; formula: string }>;

  // Guidelines
  guidelines: ProjectGuidelines | null;
  guidelinesOpts: { backend: GuidelinesBackend; autoCreate: boolean; customPath?: string };
  guidelinesRefreshInterval: number;

  // Learnings
  allLearnings: Learning[];

  // Dedup
  dedupMemory: DedupEntry[];

  // Codebase index
  codebaseIndex: CodebaseIndex | null;
  excludeDirs: string[];

  // Project metadata
  metadataBlock: string | null;

  // Taste profile
  tasteProfile: ReturnType<typeof loadTasteProfile>;

  // Backend config
  batchTokenBudget: number;
  scoutConcurrency: number;
  scoutTimeoutMs: number;
  maxScoutFiles: number;
  activeBackendName: string;

  // Backends
  scoutBackend: ScoutBackend | undefined;
  executionBackend: ExecutionBackend | undefined;

  // DB / project
  adapter: DatabaseAdapter;
  project: Awaited<ReturnType<typeof projects.ensureForRepo>>;
  deps: ReturnType<typeof createScoutDeps>;
  detectedBaseBranch: string;

  // Shutdown / processing flags
  shutdownRequested: boolean;
  currentlyProcessing: boolean;

  // Pull tracking
  pullInterval: number;
  pullPolicy: 'halt' | 'warn';
  cyclesSinceLastPull: number;

  // Scout retry
  scoutRetries: number;
  scoutedDirs: string[];

  // Parallel
  parallelExplicit: boolean;

  // Scope
  userScope: string | undefined;

  // Interactive console
  interactiveConsole: InteractiveConsole | undefined;

  // Helpers (closures that need state)
  getCycleFormula: (cycle: number) => import('./formulas.js').Formula | null;
  getCycleCategories: (formula: import('./formulas.js').Formula | null) => { allow: string[]; block: string[] };
  finalizeMilestone: () => Promise<void>;
  startNewMilestone: () => Promise<void>;
}

// ── Init ────────────────────────────────────────────────────────────────────

export async function initSession(options: AutoModeOptions): Promise<AutoSessionState> {
  // Load formula if specified
  let activeFormula: import('./formulas.js').Formula | null = null;
  if (options.formula) {
    const { loadFormula, listFormulas } = await import('./formulas.js');
    activeFormula = loadFormula(options.formula);
    if (!activeFormula) {
      const available = listFormulas();
      console.error(chalk.red(`✗ Formula not found: ${options.formula}`));
      console.error(chalk.gray(`  Available formulas: ${available.map(f => f.name).join(', ')}`));
      process.exit(1);
    }
    console.log(chalk.cyan(`📜 Using formula: ${activeFormula.name}`));
    console.log(chalk.gray(`   ${activeFormula.description}`));
    if (activeFormula.prompt) {
      console.log(chalk.gray(`   Prompt: ${activeFormula.prompt.slice(0, 80)}...`));
    }
    console.log();
  }

  // Time handling: --hours accepts decimals (0.5 = 30min), --minutes is legacy
  const hoursValue = options.hours ? parseFloat(options.hours) : 0;
  const minutesValue = options.minutes ? parseFloat(options.minutes) : 0;
  const totalMinutes = (hoursValue * 60 + minutesValue) || undefined;

  // Continuous mode: enabled by --hours, --continuous, or explicit --cycles > 1
  const maxCycles = options.cycles ? parseInt(options.cycles, 10) : 1;
  const isContinuous = options.continuous || totalMinutes !== undefined || maxCycles > 1;
  const endTime = totalMinutes ? Date.now() + (totalMinutes * 60 * 1000) : undefined;

  // PR limits: effectively unlimited for timed/continuous runs, otherwise use defaults
  // Users can override with --max-prs
  const defaultMaxPrs = isContinuous ? 999 : 3;
  const maxPrs = parseInt(options.maxPrs || String(activeFormula?.maxPrs ?? defaultMaxPrs), 10);
  const minConfidence = parseInt(options.minConfidence || String(activeFormula?.minConfidence ?? DEFAULT_AUTO_CONFIG.minConfidence), 10);
  const useDraft = options.draft !== false;

  // Milestone mode vs Direct mode:
  // - Milestone mode: batches tickets into milestone PRs (good for PR-based workflows)
  // - Direct mode: commits directly to a branch, no PRs by default (good for solo devs)
  //
  // Direct mode is the default (deliveryMode: 'direct').
  // Milestone mode is enabled when:
  // - deliveryMode is 'pr' or 'auto-merge', OR
  // - --batch-size is explicitly set
  //
  // Use --individual-prs to create separate PR per ticket (disables milestone batching)
  const batchSize = options.batchSize ? parseInt(options.batchSize, 10) : undefined;
  // Milestone mode is only enabled for PR-based delivery or explicit batch-size
  const milestoneMode = batchSize !== undefined && batchSize > 0;

  const userScope = options.scope || activeFormula?.scope;

  const git = createGitService();
  const repoRoot = await git.findRepoRoot(process.cwd());

  if (!repoRoot) {
    console.error(chalk.red('✗ Not a git repository'));
    process.exit(1);
  }

  // Initialize metrics for this session
  initMetrics(repoRoot);
  metric('session', 'started', { codex: !!options.codex, hours: options.hours });

  // Clean up stale worktrees from previous interrupted runs
  const prunedWorktrees = pruneStaleWorktrees(repoRoot);
  if (prunedWorktrees > 0) {
    console.log(chalk.gray(`  Cleaned up ${prunedWorktrees} stale worktree(s)`));
  }

  // Reset QA stats for fresh auto-tuning each session
  // This prevents the catch-22 where disabled commands can never re-enable
  const reEnabledQa = resetQaStatsForSession(repoRoot);
  if (reEnabledQa > 0) {
    console.log(chalk.gray(`  Reset QA auto-tune (${reEnabledQa} command(s) re-enabled for fresh baseline)`));
  }

  let config = loadConfig(repoRoot);

  // ── Pre-session QA Tuning ─────────────────────────────────────────────────
  // Run all QA commands once upfront to establish baselines before any work.
  // This "tunes" the auto-tune system so we know what's working immediately.
  // If commands fail, offer to fix them first before proceeding.
  if (config?.qa?.commands?.length && !options.dryRun) {
    console.log(chalk.cyan('🎛️  Tuning QA baselines...'));
    const qaConfig = normalizeQaConfig(config);

    // Run each command to establish baseline
    let baseline = await captureQaBaseline(repoRoot, config, (msg) => console.log(chalk.gray(msg)), repoRoot);

    // Check for failures
    const failingCommands = [...baseline.entries()].filter(([, r]) => !r.passed).map(([name]) => name);

    // Try auto-fix for lint commands (--fix flag)
    if (failingCommands.length > 0) {
      const lintCommands = failingCommands.filter(name =>
        name.toLowerCase().includes('lint') ||
        qaConfig.commands.find(c => c.name === name)?.cmd.includes('eslint') ||
        qaConfig.commands.find(c => c.name === name)?.cmd.includes('prettier')
      );

      if (lintCommands.length > 0) {
        console.log(chalk.cyan('  🔧 Attempting auto-fix for lint issues...'));
        for (const name of lintCommands) {
          const cmd = qaConfig.commands.find(c => c.name === name);
          if (!cmd) continue;

          // Try adding --fix flag
          const fixCmd = cmd.cmd.includes('--fix') ? cmd.cmd : `${cmd.cmd} --fix`;
          try {
            const { execFileSync } = await import('node:child_process');
            execFileSync('sh', ['-c', fixCmd], {
              cwd: cmd.cwd ? path.resolve(repoRoot, cmd.cwd) : repoRoot,
              timeout: cmd.timeoutMs ?? 120_000,
              stdio: 'pipe',
            });
            console.log(chalk.green(`    ✓ Auto-fixed: ${name}`));
          } catch {
            console.log(chalk.gray(`    • Could not auto-fix: ${name}`));
          }
        }

        // Re-run baseline after auto-fix
        console.log(chalk.gray('  Re-checking baselines...'));
        // Reset stats before re-check
        resetQaStatsForSession(repoRoot);
        baseline = await captureQaBaseline(repoRoot, config, (msg) => console.log(chalk.gray(msg)), repoRoot);
      }
    }

    // Check for remaining failures after auto-fix attempts
    const stillFailing = [...baseline.entries()].filter(([, r]) => !r.passed).map(([name]) => name);

    if (stillFailing.length > 0 && options.qaFix) {
      // Try one AI fix cycle silently — no prompts, no wheel
      console.log(chalk.gray(`  ${stillFailing.length} failing — trying quick fix...`));

      const { ClaudeExecutionBackend, CodexExecutionBackend } = await import('./execution-backends/index.js');
      const backend = options.codex
        ? new CodexExecutionBackend({ model: options.codexModel })
        : new ClaudeExecutionBackend();

      // Build prompt with command info and error output
      const failingDetails = stillFailing.map(name => {
        const cmd = qaConfig.commands.find(c => c.name === name);
        const result = baseline.get(name);
        let detail = `## ${name}\nCommand: ${cmd?.cmd || name}`;
        if (result?.output) {
          detail += `\nError output:\n\`\`\`\n${result.output}\n\`\`\``;
        }
        return detail;
      }).join('\n\n');

      const fixPrompt = `These QA commands are failing. Fix the source code so they pass.

${failingDetails}

Read the error output above, then fix the source code. Minimal, targeted changes only.`;

      const { createSpinner } = await import('./spinner.js');
      const spinner = createSpinner(`Fixing ${stillFailing.length} QA issue(s)...`);

      try {
        await backend.run({
          worktreePath: repoRoot,
          prompt: fixPrompt,
          timeoutMs: 0,
          verbose: true,
          onProgress: (msg) => spinner.update(msg),
        });
        spinner.stop();

        // Re-check baselines
        const checkSpinner = createSpinner('Re-checking baselines...');
        resetQaStatsForSession(repoRoot);
        baseline = await captureQaBaseline(repoRoot, config, (msg) => checkSpinner.update(msg), repoRoot);

        const nowFailing = [...baseline.entries()].filter(([, r]) => !r.passed).map(([name]) => name);

        if (nowFailing.length === 0) {
          checkSpinner.succeed('All QA commands now passing!');
        } else if (nowFailing.length < stillFailing.length) {
          const fixed = stillFailing.length - nowFailing.length;
          checkSpinner.succeed(`${fixed} fixed, ${nowFailing.length} still failing`);
        } else {
          checkSpinner.fail(`${nowFailing.length} still failing`);
        }

        // Update stillFailing for final reporting
        stillFailing.length = 0;
        stillFailing.push(...nowFailing);
      } catch (err) {
        spinner.fail(`Fix error: ${err instanceof Error ? err.message : err}`);
      }
      console.log();
    }

    // Now auto-tune based on final results
    const tuneResult = autoTuneQaConfig(repoRoot, qaConfig);

    const working = qaConfig.commands.length - tuneResult.disabled.length;
    if (tuneResult.disabled.length > 0) {
      console.log(chalk.yellow(`  ⚠ ${tuneResult.disabled.length} command(s) failing — will be skipped:`));
      for (const d of tuneResult.disabled) {
        console.log(chalk.gray(`    • ${d.name}`));
      }
    }
    if (working > 0) {
      console.log(chalk.green(`  ✓ ${working} QA command(s) ready`));
    } else {
      console.log(chalk.yellow(`  ⚠ No QA commands passing — tickets won't be verified`));
    }

    // Update config with tuned commands
    config = {
      ...config,
      qa: {
        ...config.qa,
        commands: tuneResult.config.commands.map(c => ({
          name: c.name,
          cmd: c.cmd,
          cwd: c.cwd,
          timeoutMs: c.timeoutMs,
        })),
      },
    };
    console.log();
  }

  // Session phase (initialized as deep)
  const sessionPhase: 'warmup' | 'deep' | 'cooldown' = 'deep';

  const DEEP_SCAN_INTERVAL = 5;
  let deepFormula: import('./formulas.js').Formula | null = null;
  let docsAuditFormula: import('./formulas.js').Formula | null = null;
  if (!activeFormula) {
    const { loadFormula: loadF } = await import('./formulas.js');
    if (isContinuous) {
      deepFormula = loadF('deep');
    }
    if (options.docsAudit !== false) {
      docsAuditFormula = loadF('docs-audit');
    }
  }

  // Build getCycleFormula/getCycleCategories (need state reference — we'll patch after)
  // These closures reference `state` which we build below.

  // Single shutdown handler using a mutable reference.  Before `state` is
  // constructed the reference points at a temporary flags object; once `state`
  // exists we redirect it so the handler reads/writes `state` directly.
  // This eliminates the old dual-handler pattern and the race window where a
  // SIGINT could set a local variable that the state object never observed.
  let shutdownRef: { shutdownRequested: boolean; currentlyProcessing: boolean } = {
    shutdownRequested: false,
    currentlyProcessing: false,
  };

  const shutdownHandler = () => {
    if (shutdownRef.shutdownRequested) {
      console.log(chalk.red('\nForce quit. Exiting immediately.'));
      process.exit(1);
    }
    shutdownRef.shutdownRequested = true;
    if (shutdownRef.currentlyProcessing) {
      console.log(chalk.yellow('\nShutdown requested. Finishing current ticket...'));
    } else {
      console.log(chalk.yellow('\nShutdown requested. Exiting...'));
      process.exit(0);
    }
  };

  process.on('SIGINT', shutdownHandler);
  process.on('SIGTERM', shutdownHandler);

  const autoConf: Record<string, any> = { ...DEFAULT_AUTO_CONFIG, ...config?.auto };

  // We need a temporary getFormulaCtx before state exists
  const getFormulaCtx = (): CycleFormulaContext => ({
    activeFormula, sessionPhase, deepFormula, docsAuditFormula,
    isContinuous, repoRoot, options, config,
    sectorProductionFileCount: undefined,
  });
  const getCycleFormula = (cycle: number) => getCycleFormulaImpl(getFormulaCtx(), cycle);
  const getCycleCategories = (formula: typeof activeFormula) => getCycleCategoriesImpl(getFormulaCtx(), formula);

  // Print header
  const initialCategories = getCycleCategories(getCycleFormula(1));

  console.log(chalk.blue('🧵 BlockSpool Auto'));
  console.log();
  if (isContinuous) {
    console.log(chalk.gray('  Mode: Continuous (Ctrl+C to stop gracefully)'));
    if (totalMinutes) {
      const endDate = new Date(endTime!);
      const budgetLabel = totalMinutes < 60
        ? `${Math.round(totalMinutes)} minutes`
        : totalMinutes % 60 === 0
          ? `${totalMinutes / 60} hours`
          : `${Math.floor(totalMinutes / 60)}h ${Math.round(totalMinutes % 60)}m`;
      console.log(chalk.gray(`  Time budget: ${budgetLabel} (until ${endDate.toLocaleTimeString()})`));
    }
  } else {
    console.log(chalk.gray('  Mode: Scout → Auto-approve → Run → PR'));
  }
  console.log(chalk.gray(`  Scope: ${userScope || (isContinuous ? 'rotating' : 'auto')}`));
  console.log(chalk.gray(`  Categories: ${initialCategories.allow.join(', ')}`));

  // Delivery mode resolution
  // - 'direct': commits to a branch, no PRs (default)
  // - 'pr': creates individual PRs per ticket
  // - 'auto-merge': creates PRs with auto-merge enabled
  const deliveryMode = options.deliveryMode ?? autoConf.deliveryMode ?? 'direct';
  const directBranch = options.directBranch ?? autoConf.directBranch ?? 'blockspool-direct';
  // Default to 'none' - no PR creation at end of session (truly "no PRs" by default)
  const directFinalize = options.directFinalize ?? autoConf.directFinalize ?? 'none';
  {
    const finalizeLabel = directFinalize === 'none' ? 'no PR' : directFinalize;
    console.log(chalk.gray(`  Delivery: ${deliveryMode}${deliveryMode === 'direct' ? ` (branch: ${directBranch}, finalize: ${finalizeLabel})` : ''}`));
  }
  if (milestoneMode) {
    console.log(chalk.gray(`  Milestone mode: batch size ${batchSize}, max PRs ${maxPrs}`));
    console.log(chalk.gray(`  Draft PRs: ${useDraft ? 'yes' : 'no'}`));
  } else if (deliveryMode === 'pr' || deliveryMode === 'auto-merge') {
    console.log(chalk.gray(`  Max PRs: ${maxPrs}`));
  }
  console.log();

  // Start interactive console
  let interactiveConsole: InteractiveConsole | undefined;
  // Will be wired up to shutdownRequested after state is created
  let requestShutdown: (() => void) | undefined;

  // Check working tree
  const statusResult = spawnSync('git', ['status', '--porcelain'], { cwd: repoRoot });
  const statusLines = statusResult.stdout?.toString().trim().split('\n').filter(Boolean) || [];
  const modifiedFiles = statusLines.filter(line => !line.startsWith('??'));
  if (modifiedFiles.length > 0 && !options.dryRun) {
    const onlyGitignore = modifiedFiles.length === 1 &&
      modifiedFiles[0].trim().endsWith('.gitignore');
    if (onlyGitignore) {
      const gitignorePath = path.join(repoRoot, '.gitignore');
      const content = fs.readFileSync(gitignorePath, 'utf-8');
      if (content.includes('.blockspool')) {
        spawnSync('git', ['add', '.gitignore'], { cwd: repoRoot });
        spawnSync('git', ['commit', '-m', 'chore: add .blockspool to .gitignore'], { cwd: repoRoot });
        console.log(chalk.gray('  Auto-committed .gitignore update'));
      }
    } else {
      console.error(chalk.red('✗ Working tree has uncommitted changes'));
      console.error(chalk.gray('  Commit or stash your changes first'));
      process.exit(1);
    }
  }

  if (!isInitialized(repoRoot)) {
    console.log(chalk.gray('Initializing BlockSpool...'));
    await initSolo(repoRoot);
  }

  // Only require PR capability if we'll actually create PRs
  const willCreatePrs = milestoneMode || deliveryMode === 'pr' || deliveryMode === 'auto-merge' || directFinalize === 'pr';
  const preflight = await runPreflightChecks(repoRoot, { needsPr: willCreatePrs });
  if (!preflight.ok) {
    console.error(chalk.red(`✗ ${preflight.error}`));
    process.exit(1);
  }
  for (const warning of preflight.warnings) {
    console.log(chalk.yellow(`⚠ ${warning}`));
  }

  const adapter = await getAdapter(repoRoot);

  // Guidelines
  const guidelinesBackend: GuidelinesBackend =
    [options.scoutBackend, options.executeBackend].find(b => b && b !== 'claude') ?? 'claude';
  const guidelinesOpts = {
    backend: guidelinesBackend,
    autoCreate: config?.auto?.autoCreateGuidelines !== false,
    customPath: config?.auto?.guidelinesPath || undefined,
  };
  const guidelines: ProjectGuidelines | null = loadGuidelines(repoRoot, guidelinesOpts);
  const guidelinesRefreshInterval = config?.auto?.guidelinesRefreshCycles ?? 10;
  if (guidelines) {
    console.log(chalk.gray(`  Guidelines loaded: ${guidelines.source}`));
  }

  // Learnings
  const allLearnings: Learning[] = autoConf.learningsEnabled
    ? loadLearnings(repoRoot, autoConf.learningsDecayRate) : [];
  if (allLearnings.length > 0) {
    console.log(chalk.gray(`  Learnings loaded: ${allLearnings.length}`));
  }

  // Wheel health summary
  {
    const { getQualityRate } = await import('./run-state.js');
    const { loadQaStats } = await import('./qa-stats.js');
    const qualityRate = getQualityRate(repoRoot);
    const qaStats = loadQaStats(repoRoot);
    const disabledCount = qaStats.disabledCommands.length;
    const qualityPct = Math.round(qualityRate * 100);
    const confValue = autoConf.minConfidence ?? 20;
    const qualityColor = qualityRate < 0.5 ? chalk.yellow : chalk.gray;
    console.log(qualityColor(`  Quality rate: ${qualityPct}% | Confidence: ${confValue} | Disabled: ${disabledCount} cmds`));
  }

  // Backend settings
  const activeBackendName = options.scoutBackend ?? 'claude';
  const backendConf = activeBackendName === 'codex' ? autoConf.codex : autoConf.claude;
  const { getProvider: getProviderDefaults } = await import('./providers/index.js');
  const activeProviderDefaults = getProviderDefaults(activeBackendName);

  const batchTokenBudget = options.batchTokenBudget
    ? parseInt(options.batchTokenBudget, 10)
    : (backendConf?.batchTokenBudget ?? autoConf.batchTokenBudget ?? activeProviderDefaults.defaultBatchTokenBudget);
  const scoutConcurrency = options.scoutConcurrency
    ? parseInt(options.scoutConcurrency, 10)
    : (backendConf?.scoutConcurrency ?? autoConf.scoutConcurrency ?? activeProviderDefaults.defaultScoutConcurrency);
  const scoutTimeoutMs = options.scoutTimeout
    ? parseInt(options.scoutTimeout, 10) * 1000
    : (autoConf.scoutTimeoutMs ?? activeProviderDefaults.defaultScoutTimeoutMs);
  const maxScoutFiles = options.maxScoutFiles
    ? parseInt(options.maxScoutFiles, 10)
    : autoConf.maxFilesPerCycle;

  // Dedup memory
  const dedupMemory: DedupEntry[] = loadDedupMemory(repoRoot);
  if (dedupMemory.length > 0) {
    console.log(chalk.gray(`  Dedup memory loaded: ${dedupMemory.length} titles`));
  }

  // Codebase index — git tracking auto-excludes build artifacts (playwright-report, etc.)
  // Hardcoded list is fallback for non-git repos
  const excludeDirs = ['node_modules', 'dist', 'build', '.git', '.blockspool', 'coverage', '__pycache__'];
  let codebaseIndex: CodebaseIndex | null = null;
  try {
    codebaseIndex = buildCodebaseIndex(repoRoot, excludeDirs, true);
    console.log(chalk.gray(`  Codebase index: ${codebaseIndex.modules.length} modules, ${codebaseIndex.untested_modules.length} untested, ${codebaseIndex.large_files.length} hotspots`));
  } catch {
    // Non-fatal
  }

  // Project metadata
  const projectMeta = detectProjectMetadata(repoRoot);
  const metadataBlock = formatMetadataForPrompt(projectMeta);
  if (projectMeta.languages.length > 0) {
    console.log(chalk.gray(`  Project: ${projectMeta.languages.join(', ')}${projectMeta.framework ? ` / ${projectMeta.framework}` : ''}${projectMeta.test_runner ? ` / ${projectMeta.test_runner.name}` : ''}`));
  }

  // Auto-prune
  try {
    const { pruneAllAsync: pruneAllAsyncFn, getRetentionConfig } = await import('./retention.js');
    const retentionConfig = getRetentionConfig(config);
    const pruneReport = await pruneAllAsyncFn(repoRoot, retentionConfig, adapter);
    if (pruneReport.totalPruned > 0) {
      console.log(chalk.gray(`  Pruned ${pruneReport.totalPruned} stale item(s)`));
    }
  } catch {
    // Non-fatal
  }

  // Sectors
  let sectorState: SectorState | null = null;
  if (codebaseIndex) {
    try {
      sectorState = loadOrBuildSectors(repoRoot, codebaseIndex.modules);
      console.log(chalk.gray(`  Sectors loaded: ${sectorState.sectors.length} sector(s)`));
    } catch {
      // Non-fatal
    }
  }

  // Taste profile
  const tasteProfile = loadTasteProfile(repoRoot);

  // Project & deps
  const project = await projects.ensureForRepo(adapter, {
    name: path.basename(repoRoot),
    rootPath: repoRoot,
  });
  const deps = createScoutDeps(adapter, { verbose: options.verbose });

  // Instantiate backends
  const { getProvider } = await import('./providers/index.js');
  let scoutBackend: ScoutBackend | undefined;
  let executionBackend: ExecutionBackend | undefined;

  const scoutBackendName = options.scoutBackend ?? 'claude';
  const execBackendName = options.executeBackend ?? 'claude';

  const modelForBackend = (name: string): string | undefined => {
    if (name === 'codex') return options.codexModel;
    if (name === 'kimi') return options.kimiModel;
    if (name === 'openai-local') return options.localModel;
    return undefined;
  };

  const apiKeyForBackend = (name: string): string | undefined => {
    const provider = getProvider(name);
    return provider.apiKeyEnvVar ? process.env[provider.apiKeyEnvVar] : undefined;
  };

  if (scoutBackendName !== 'claude') {
    if (scoutBackendName === 'codex' && options.codexMcp) {
      const { CodexMcpScoutBackend } = await import('@blockspool/core/scout');
      scoutBackend = new CodexMcpScoutBackend({ apiKey: process.env.CODEX_API_KEY, model: options.codexModel });
      console.log(chalk.cyan('  Scout: Codex MCP (persistent session)'));
    } else {
      const scoutProvider = getProvider(scoutBackendName);
      scoutBackend = await scoutProvider.createScoutBackend({
        apiKey: apiKeyForBackend(scoutBackendName),
        model: modelForBackend(scoutBackendName),
        baseUrl: scoutBackendName === 'openai-local' ? options.localUrl : undefined,
      });
    }
  }

  if (execBackendName !== 'claude') {
    const execProvider = getProvider(execBackendName);
    executionBackend = await execProvider.createExecutionBackend({
      apiKey: apiKeyForBackend(execBackendName),
      model: modelForBackend(execBackendName),
      unsafeBypassSandbox: options.codexUnsafeFullAccess,
      baseUrl: execBackendName === 'openai-local' ? options.localUrl : undefined,
      maxIterations: options.localMaxIterations ? parseInt(options.localMaxIterations, 10) : undefined,
    });

    // Non-Claude backends (Codex, Kimi) are slower — apply timeout multiplier
    if (!autoConf.timeoutMultiplier) {
      autoConf.timeoutMultiplier = 1.5;
    }
  }

  // Detect base branch
  let detectedBaseBranch = 'master';
  try {
    const { gitExec } = await import('./solo-git.js');
    const remoteHead = (await gitExec(
      'git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null || echo "refs/remotes/origin/master"',
      { cwd: repoRoot }
    )).trim();
    detectedBaseBranch = remoteHead.replace('refs/remotes/origin/', '');
  } catch {
    // Fall back to master
  }

  // Branch initialization - mutually exclusive:
  // - Milestone mode: creates milestone branches for batched PRs
  // - Direct mode: commits directly to a single branch (no PRs)
  let milestoneBranch: string | undefined;
  let milestoneWorktreePath: string | undefined;
  let milestoneNumber = 0;

  if (!options.dryRun) {
    if (milestoneMode) {
      // Milestone mode: create milestone branch for batched PR workflow
      const ms = await createMilestoneBranch(repoRoot, detectedBaseBranch);
      milestoneBranch = ms.milestoneBranch;
      milestoneWorktreePath = ms.milestoneWorktreePath;
      milestoneNumber = 1;
      console.log(chalk.cyan(`Milestone branch: ${milestoneBranch}`));
      console.log();
    } else if (deliveryMode === 'direct') {
      // Direct mode: commit directly to branch (no PRs by default)
      await ensureDirectBranch(repoRoot, directBranch, detectedBaseBranch);
      console.log(chalk.cyan(`Direct branch: ${directBranch}`));
      console.log();
    }
    // Note: 'pr' and 'auto-merge' modes create per-ticket branches, no init needed
  }

  const pullInterval = config?.auto?.pullEveryNCycles ?? 5;
  const pullPolicy: 'halt' | 'warn' = config?.auto?.pullPolicy ?? 'halt';
  const parallelExplicit = options.parallel !== undefined && options.parallel !== '3';

  // Build state object
  const state: AutoSessionState = {
    options,
    config,
    autoConf,
    repoRoot,

    activeFormula,
    deepFormula,
    docsAuditFormula,
    currentFormulaName: 'default',

    isContinuous,
    totalMinutes,
    endTime,
    startTime: Date.now(),

    maxPrs,
    maxCycles,
    minConfidence,
    useDraft,

    milestoneMode,
    batchSize,
    milestoneBranch,
    milestoneWorktreePath,
    milestoneTicketCount: 0,
    milestoneNumber,
    totalMilestonePrs: 0,
    milestoneTicketSummaries: [],

    deliveryMode,
    directBranch,
    directFinalize,
    completedDirectTickets: [],

    totalPrsCreated: 0,
    totalFailed: 0,
    cycleCount: 0,
    allPrUrls: [],
    totalMergedPrs: 0,
    totalClosedPrs: 0,
    pendingPrUrls: [],

    sectorState,
    currentSectorId: null,
    currentSectorCycle: 0,

    effectiveMinConfidence: autoConf.minConfidence ?? 20,
    consecutiveLowYieldCycles: 0,

    sessionPhase,
    allTicketOutcomes: [],
    cycleOutcomes: [],
    prMetaMap: new Map(),

    guidelines,
    guidelinesOpts,
    guidelinesRefreshInterval,

    allLearnings,
    dedupMemory,
    codebaseIndex,
    excludeDirs,
    metadataBlock,
    tasteProfile,

    batchTokenBudget,
    scoutConcurrency,
    scoutTimeoutMs,
    maxScoutFiles,
    activeBackendName,

    scoutBackend,
    executionBackend,

    adapter,
    project,
    deps,
    detectedBaseBranch,

    shutdownRequested: shutdownRef.shutdownRequested,  // carry over any early signal
    currentlyProcessing: false,

    pullInterval,
    pullPolicy,
    cyclesSinceLastPull: 0,

    scoutRetries: 0,
    scoutedDirs: [],

    parallelExplicit,
    userScope,
    interactiveConsole,

    // These closures capture `state` via the getFormulaCtx closure which reads sessionPhase.
    // We need to patch them to read from state.
    getCycleFormula: null as any,
    getCycleCategories: null as any,
    finalizeMilestone: null as any,
    startNewMilestone: null as any,
  };

  // Redirect shutdown handler to read/write state flags directly.
  // No listener removal needed — same handler, just a new backing object.
  shutdownRef = state;

  // Patch formula helpers to read from state
  const stateFormulaCtx = (): CycleFormulaContext => ({
    activeFormula: state.activeFormula,
    sessionPhase: state.sessionPhase,
    deepFormula: state.deepFormula,
    docsAuditFormula: state.docsAuditFormula,
    isContinuous: state.isContinuous,
    repoRoot: state.repoRoot,
    options: state.options,
    config: state.config,
    sectorProductionFileCount: state.currentSectorId
      ? state.sectorState?.sectors.find(s => s.path === state.currentSectorId)?.productionFileCount
      : undefined,
  });
  state.getCycleFormula = (cycle: number) => getCycleFormulaImpl(stateFormulaCtx(), cycle);
  state.getCycleCategories = (formula) => getCycleCategoriesImpl(stateFormulaCtx(), formula);

  // Milestone helpers
  state.finalizeMilestone = async () => {
    if (!state.milestoneMode || !state.milestoneBranch || !state.milestoneWorktreePath) return;
    if (state.milestoneTicketCount === 0) return;

    console.log(chalk.cyan(`\nFinalizing milestone #${state.milestoneNumber} (${state.milestoneTicketCount} tickets)...`));
    const prUrl = await pushAndPrMilestone(
      state.repoRoot,
      state.milestoneBranch,
      state.milestoneWorktreePath,
      state.milestoneNumber,
      state.milestoneTicketCount,
      [...state.milestoneTicketSummaries]
    );
    if (prUrl) {
      state.allPrUrls.push(prUrl);
      console.log(chalk.green(`  ✓ Milestone PR: ${prUrl}`));
    } else {
      console.log(chalk.yellow(`  ⚠ Milestone pushed but PR creation failed`));
    }
    state.totalMilestonePrs++;
  };

  state.startNewMilestone = async () => {
    if (!state.milestoneMode) return;
    await cleanupMilestone(state.repoRoot);
    state.milestoneTicketCount = 0;
    state.milestoneTicketSummaries.length = 0;
    const ms = await createMilestoneBranch(state.repoRoot, state.detectedBaseBranch);
    state.milestoneBranch = ms.milestoneBranch;
    state.milestoneWorktreePath = ms.milestoneWorktreePath;
    state.milestoneNumber++;
    console.log(chalk.cyan(`New milestone branch: ${state.milestoneBranch}`));
  };

  // Start interactive console now that state exists
  if (isContinuous) {
    state.interactiveConsole = startInteractiveConsole({
      repoRoot,
      onQuit: () => {
        state.shutdownRequested = true;
      },
      onStatus: () => {
        const elapsed = Math.floor((Date.now() - state.startTime) / 1000);
        const mins = Math.floor(elapsed / 60);
        const secs = elapsed % 60;
        console.log(chalk.cyan('\n  📊 Session Status:'));
        console.log(chalk.gray(`    Cycle: ${state.cycleCount}`));
        console.log(chalk.gray(`    Elapsed: ${mins}m ${secs}s`));
        if (state.milestoneMode) {
          console.log(chalk.gray(`    Tickets this milestone: ${state.milestoneTicketCount}`));
          console.log(chalk.gray(`    Milestone PRs: ${state.totalMilestonePrs}/${state.maxPrs}`));
        } else if (state.deliveryMode === 'direct') {
          console.log(chalk.gray(`    Completed tickets: ${state.completedDirectTickets.length}`));
        } else {
          console.log(chalk.gray(`    PRs created: ${state.totalPrsCreated}/${state.maxPrs}`));
        }
        console.log(chalk.gray(`    Failed: ${state.totalFailed}`));
        if (state.endTime) {
          const remaining = Math.max(0, Math.floor((state.endTime - Date.now()) / 60000));
          console.log(chalk.gray(`    Time remaining: ${remaining}m`));
        }
        console.log();
      },
    });
  }

  return state;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

export function shouldContinue(state: AutoSessionState): boolean {
  if (state.shutdownRequested) return false;

  // PR limits only apply to PR-based workflows, not direct mode
  if (state.milestoneMode) {
    if (state.totalMilestonePrs >= state.maxPrs) return false;
  } else if (state.deliveryMode === 'pr' || state.deliveryMode === 'auto-merge') {
    if (state.totalPrsCreated >= state.maxPrs) return false;
  }
  // Direct mode: no PR limit, just time/cycles

  if (state.endTime && Date.now() >= state.endTime) return false;
  if (state.cycleCount >= state.maxCycles && !state.isContinuous) return false;
  return true;
}

export function getNextScope(state: AutoSessionState): string {
  if (state.userScope) return state.userScope;
  if (state.sectorState) {
    const rs = readRunState(state.repoRoot);
    state.currentSectorCycle = rs.totalCycles;
    const pick = pickNextSector(state.sectorState, state.currentSectorCycle);
    if (pick) {
      state.currentSectorId = pick.sector.path;
      return pick.scope;
    }
  }
  state.currentSectorId = null;
  return '**';
}
