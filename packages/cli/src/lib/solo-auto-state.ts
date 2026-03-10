/**
 * AutoSessionState — mutable context object for runAutoMode.
 * Replaces ~55 closure variables with a single passable struct.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import chalk from 'chalk';

const _require = createRequire(import.meta.url);
const CLI_VERSION: string = _require('../../package.json').version;
import { spawnSync } from 'node:child_process';
import type { DatabaseAdapter } from '@promptwheel/core/db';
import type { ScoutBackend } from '@promptwheel/core/services';
import { projects } from '@promptwheel/core/repos';
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
import { type ExecutionBackend } from './execution-backends/index.js';
/** Inline replacement for deleted solo-cycle-formula.ts — returns allow/block from config with option overrides. */
function getCycleCategoriesImpl(
  ctx: { options: AutoModeOptions; config: ReturnType<typeof loadConfig> },
  _formula: null,
): { allow: string[]; block: string[] } {
  const autoConf = ctx.config?.auto;
  let allow = [...(autoConf?.allowCategories ?? DEFAULT_AUTO_CONFIG.allowCategories)];
  let block = [...(autoConf?.blockCategories ?? DEFAULT_AUTO_CONFIG.blockCategories)];

  if (ctx.options.safe) {
    allow = allow.filter(c => ['refactor', 'docs', 'types', 'perf'].includes(c));
  }
  if (ctx.options.allow) {
    const explicit = ctx.options.allow.split(',').map(s => s.trim()).filter(Boolean);
    allow = explicit;
  }
  if (ctx.options.block) {
    const blocked = ctx.options.block.split(',').map(s => s.trim()).filter(Boolean);
    block = [...block, ...blocked];
  }
  if (ctx.options.tests) {
    if (!allow.includes('test')) allow.push('test');
  }

  return { allow, block };
}
import {
  createMilestoneBranch,
  cleanupMilestone,
  pushAndPrMilestone,
  ensureDirectBranch,
  cleanupMergedDirectBranch,
} from './solo-git.js';
import { startInteractiveConsole } from './solo-stdin.js';
import { loadGuidelines } from './guidelines.js';
import type { ProjectGuidelines, GuidelinesBackend } from './guidelines.js';
import { loadLearnings, type Learning } from './learnings.js';
import {
  loadDedupMemory,
  type DedupEntry,
} from './dedup-memory.js';
import { pruneStaleWorktrees, pruneStaleBranches, pruneStaleCodexSessions, gitWorktreePrune, acquireSessionLock, releaseSessionLock } from './retention.js';
import { resetQaStatsForSession } from './qa-stats.js';
import {
  buildCodebaseIndex,
  type CodebaseIndex,
} from './codebase-index.js';
import { detectProjectMetadata, formatMetadataForPrompt } from './project-metadata/index.js';
import { DEFAULT_AUTO_CONFIG } from './solo-config.js';
import { loadExcludePatterns } from './exclude.js';
import {
  loadGoals, measureGoals, pickGoalByGap, recordGoalMeasurement,
  type GoalMeasurement,
} from './goals.js';
import {
  loadTrajectoryState,
  loadTrajectory,
} from './trajectory.js';
import type { Trajectory, TrajectoryState, TrajectoryStep } from '@promptwheel/core/trajectory/shared';
import { getNextStep as getTrajectoryNextStep, trajectoryComplete } from '@promptwheel/core/trajectory/shared';
import type { DisplayAdapter } from './display-adapter.js';
import { SpinnerDisplayAdapter } from './display-adapter-spinner.js';
import { initMetrics, metric } from './metrics.js';
import { loadIntegrations } from './integrations.js';

// ── Session state ───────────────────────────────────────────────────────────

// RunMode and AutoModeOptions live in solo-auto-types.ts to avoid circular
// imports; re-export them here for backwards compatibility.
export type { RunMode, AutoModeOptions } from './solo-auto-types.js';

import type {
  RunMode,
  AutoModeOptions,
  SessionOptions,
  SessionConfig,
  SessionRuntime,
  SessionDeps,
  SessionUI,
} from './solo-auto-types.js';

export type { SessionOptions, SessionConfig, SessionRuntime, SessionDeps, SessionUI };

/**
 * Full session state — extends all five sub-interfaces.
 *
 * Functions that need the full bag can take `AutoSessionState`.
 * Functions that only need a subset can declare narrower types
 * (e.g. `SessionConfig & SessionRuntime`).
 */
export interface AutoSessionState extends SessionOptions, SessionConfig, SessionRuntime, SessionDeps, SessionUI {}

// ── Init — sub-functions ─────────────────────────────────────────────────────

/** Resolved values from CLI options — no I/O, no side effects. */
interface ResolvedOptions {
  totalMinutes: number | undefined;
  maxCycles: number;
  runMode: RunMode;
  endTime: number | undefined;
  maxPrs: number;
  minConfidence: number;
  useDraft: boolean;
  batchSize: number | undefined;
  milestoneMode: boolean;
  userScope: string | undefined;
  parallelExplicit: boolean;
}

/** Parse CLI options into resolved values. */
async function resolveOptions(options: AutoModeOptions): Promise<ResolvedOptions> {
  const hoursValue = options.hours ? parseFloat(options.hours) : 0;
  const minutesValue = options.minutes ? parseFloat(options.minutes) : 0;
  const totalMinutes = (hoursValue * 60 + minutesValue) || undefined;

  const maxCycles = options.cycles ? parseInt(options.cycles, 10) : 999;
  const runMode: RunMode = options.plan ? 'planning' : 'spin';
  const endTime = totalMinutes ? Date.now() + (totalMinutes * 60 * 1000) : undefined;

  const defaultMaxPrs = runMode === 'spin' ? 999 : 3;
  const maxPrs = parseInt(options.maxPrs || String(defaultMaxPrs), 10);
  const minConfidence = parseInt(options.minConfidence || String(DEFAULT_AUTO_CONFIG.minConfidence), 10);
  const useDraft = options.draft !== false;

  const batchSize = options.batchSize ? parseInt(options.batchSize, 10) : undefined;
  const milestoneMode = batchSize !== undefined && batchSize > 0;
  const userScope = options.scope;
  const parallelExplicit = options.parallel !== undefined && options.parallel !== '3';

  return {
    totalMinutes, maxCycles, runMode, endTime,
    maxPrs, minConfidence, useDraft, batchSize, milestoneMode,
    userScope, parallelExplicit,
  };
}

/** Environment result from initEnvironment. */
interface EnvironmentResult {
  repoRoot: string;
  config: ReturnType<typeof loadConfig>;
  autoConf: Record<string, any>;
  cachedQaBaseline: ReadonlyMap<string, boolean> | null;
  adapter: DatabaseAdapter;
}

/**
 * Set up the execution environment: find repo, acquire lock, clean up stale
 * resources, run setup command, QA baseline, preflight checks.
 */
async function initEnvironment(
  options: AutoModeOptions,
  resolved: ResolvedOptions,
): Promise<EnvironmentResult> {
  const git = createGitService();
  const repoRoot = await git.findRepoRoot(process.cwd());

  if (!repoRoot) {
    console.error(chalk.red('✗ Not a git repository'));
    process.exit(1);
  }

  initMetrics(repoRoot);
  metric('session', 'started', { codex: !!options.codex, hours: options.hours });

  // Session lock
  const lockResult = acquireSessionLock(repoRoot);
  if (!lockResult.acquired) {
    console.error(chalk.red('✗ Another PromptWheel session is already running in this repo'));
    process.exit(1);
  }
  if (options.verbose && lockResult.stalePid) {
    console.log(chalk.gray(`  Cleaned up stale session lock (PID ${lockResult.stalePid})`));
  }
  const releaseLock = () => releaseSessionLock(repoRoot);
  process.on('exit', releaseLock);

  // Clean up stale resources
  gitWorktreePrune(repoRoot);
  const prunedWorktrees = pruneStaleWorktrees(repoRoot);
  if (options.verbose && prunedWorktrees > 0) {
    console.log(chalk.gray(`  Cleaned up ${prunedWorktrees} stale worktree(s)`));
  }
  const prunedBranches = pruneStaleBranches(repoRoot, 7);
  if (options.verbose && prunedBranches > 0) {
    console.log(chalk.gray(`  Cleaned up ${prunedBranches} stale branch(es)`));
  }
  const prunedCodexSessions = pruneStaleCodexSessions(7);
  if (options.verbose && prunedCodexSessions > 0) {
    console.log(chalk.gray(`  Cleaned up ${prunedCodexSessions} stale codex session(s)`));
  }

  resetQaStatsForSession(repoRoot);

  let config = loadConfig(repoRoot);

  // Project setup command
  if (config?.setup && !options.dryRun) {
    if (options.verbose) console.log(chalk.gray(`  Running setup: ${config.setup}`));
    try {
      const { execSync } = await import('node:child_process');
      execSync(config.setup, { cwd: repoRoot, timeout: 300_000, stdio: 'pipe' });
      if (options.verbose) console.log(chalk.green('  ✓ Setup complete'));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(chalk.yellow(`  ⚠ Setup failed: ${msg.split('\n')[0]}`));
    }
  }

  // QA baseline
  let cachedQaBaseline: ReadonlyMap<string, boolean> | null = null;
  if (config?.qa?.commands?.length && !options.dryRun) {
    const { initQaBaseline } = await import('./solo-auto-init-qa.js');
    const qaResult = await initQaBaseline(repoRoot, config, {
      qaFix: !!options.qaFix,
      codex: options.codex,
      codexModel: options.codexModel,
      dryRun: options.dryRun,
    });
    config = qaResult.config;
    cachedQaBaseline = qaResult.qaBaseline;
  }

  // Auto-init if needed (before .gitignore and dirty check so the
  // auto-committed .gitignore doesn't trip the "uncommitted changes" error)
  if (!isInitialized(repoRoot)) {
    console.log(chalk.cyan('First run — initializing PromptWheel...'));
    const { detectedQa } = await initSolo(repoRoot);
    if (detectedQa.length > 0) {
      console.log(chalk.green(`  ✓ Detected QA: ${detectedQa.map(q => q.name).join(', ')}`));
    }
    console.log(chalk.green('  ✓ Ready'));
    console.log();
  }

  // Ensure .promptwheel is in .gitignore
  const gitignorePath = path.join(repoRoot, '.gitignore');
  if (fs.existsSync(gitignorePath)) {
    const giContent = fs.readFileSync(gitignorePath, 'utf-8');
    if (!giContent.includes('.promptwheel')) {
      fs.appendFileSync(gitignorePath, '\n# PromptWheel local state\n.promptwheel/\n');
    }
  }

  // Check working tree
  const statusResult = spawnSync('git', ['status', '--porcelain'], { cwd: repoRoot, timeout: 15000 });
  const statusLines = statusResult.stdout?.toString().trim().split('\n').filter(Boolean) || [];
  const modifiedFiles = statusLines.filter(line => !line.startsWith('??'));
  if (modifiedFiles.length > 0 && !options.dryRun) {
    const onlyGitignore = modifiedFiles.length === 1 &&
      modifiedFiles[0].trim().endsWith('.gitignore');
    if (onlyGitignore) {
      const giPath = path.join(repoRoot, '.gitignore');
      const content = fs.readFileSync(giPath, 'utf-8');
      if (content.includes('.promptwheel')) {
        spawnSync('git', ['add', '.gitignore'], { cwd: repoRoot, timeout: 15000 });
        spawnSync('git', ['commit', '-m', 'chore: add .promptwheel to .gitignore'], { cwd: repoRoot, timeout: 15000 });
        if (options.verbose) console.log(chalk.gray('  Auto-committed .gitignore update'));
      }
    } else {
      console.error(chalk.red('✗ Working tree has uncommitted changes'));
      console.error(chalk.gray('  Commit or stash your changes first'));
      process.exit(1);
    }
  }

  // Preflight — delivery mode isn't resolved yet (needs autoConf), so check
  // the raw CLI flags. Config-level delivery defaults to 'direct' which
  // doesn't need PR capabilities, so CLI flags are sufficient here.
  const willCreatePrs = resolved.milestoneMode || options.deliveryMode === 'pr' || options.deliveryMode === 'auto-merge' || options.directFinalize === 'pr';
  const preflight = await runPreflightChecks(repoRoot, { needsPr: willCreatePrs });
  if (!preflight.ok) {
    console.error(chalk.red(`✗ ${preflight.error}`));
    process.exit(1);
  }
  for (const warning of preflight.warnings) {
    console.log(chalk.yellow(`⚠ ${warning}`));
  }

  const autoConf: Record<string, any> = { ...DEFAULT_AUTO_CONFIG, ...config?.auto };

  // Validate drill config — clamp user values to safe ranges
  if (autoConf.drill) {
    const { validateDrillConfig } = await import('./solo-config.js');
    autoConf.drill = validateDrillConfig(autoConf.drill);
  }
  const adapter = await getAdapter(repoRoot);

  return { repoRoot, config, autoConf, cachedQaBaseline, adapter };
}

/** Loaded session data — read from disk, no external services. */
interface SessionData {
  guidelines: ProjectGuidelines | null;
  guidelinesOpts: { backend: GuidelinesBackend; autoCreate: boolean; customPath?: string };
  guidelinesRefreshInterval: number;
  allLearnings: Learning[];
  dedupMemory: DedupEntry[];
  codebaseIndex: CodebaseIndex | null;
  excludeDirs: string[];
  excludePatterns: string[];
  /** Loaded ast-grep module for AST-level analysis, or undefined if unavailable. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  astGrepModule?: any;
  metadataBlock: string | null;
  goals: import('./goals.js').Goal[];
  activeGoal: import('./goals.js').Goal | null;
  activeGoalMeasurement: GoalMeasurement | null;
  activeTrajectory: Trajectory | null;
  activeTrajectoryState: TrajectoryState | null;
  currentTrajectoryStep: TrajectoryStep | null;
  batchTokenBudget: number;
  scoutConcurrency: number;
  scoutTimeoutMs: number;
  maxScoutFiles: number;
  activeBackendName: string;
  integrations: import('./integrations.js').IntegrationConfig;
}

/**
 * Load all session data from disk: formulas, guidelines, learnings, dedup
 * memory, codebase index, metadata, sectors, goals, backend settings.
 */
async function loadSessionData(
  options: AutoModeOptions,
  resolved: ResolvedOptions,
  repoRoot: string,
  config: ReturnType<typeof loadConfig>,
  autoConf: Record<string, any>,
  cachedQaBaseline: ReadonlyMap<string, boolean> | null,
  adapter: DatabaseAdapter,
): Promise<SessionData> {
  // Guidelines
  const guidelinesBackend: GuidelinesBackend =
    options.scoutBackend ?? options.executeBackend ?? 'codex';
  const guidelinesOpts = {
    backend: guidelinesBackend,
    autoCreate: config?.auto?.autoCreateGuidelines !== false,
    customPath: config?.auto?.guidelinesPath || undefined,
  };
  const guidelines: ProjectGuidelines | null = loadGuidelines(repoRoot, guidelinesOpts);
  const guidelinesRefreshInterval = config?.auto?.guidelinesRefreshCycles ?? 10;
  if (options.verbose && guidelines) {
    console.log(chalk.gray(`  Guidelines loaded: ${guidelines.source}`));
  }

  // Learnings
  const allLearnings: Learning[] = autoConf.learningsEnabled
    ? loadLearnings(repoRoot, autoConf.learningsDecayRate) : [];
  if (options.verbose && allLearnings.length > 0) {
    console.log(chalk.gray(`  Learnings loaded: ${allLearnings.length}`));
  }

  // Wheel health summary
  if (options.verbose) {
    const { getQualityRate } = await import('./run-state.js');
    const qualityRate = getQualityRate(repoRoot);
    const qualityPct = Math.round(qualityRate * 100);
    const confValue = autoConf.minConfidence ?? 20;
    const baselineFailing = cachedQaBaseline
      ? [...cachedQaBaseline.values()].filter(v => !v).length
      : 0;
    const qualityColor = qualityRate < 0.5 ? chalk.yellow : chalk.gray;
    const healthParts = [`Quality rate: ${qualityPct}%`, `Confidence: ${confValue}`];
    if (baselineFailing > 0) healthParts.push(`Baseline failing: ${baselineFailing}`);
    console.log(qualityColor(`  ${healthParts.join(' | ')}`));
  }

  // Backend settings
  const activeBackendName = options.scoutBackend ?? 'codex';
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
  if (options.verbose && dedupMemory.length > 0) {
    console.log(chalk.gray(`  Dedup memory loaded: ${dedupMemory.length} titles`));
  }

  // User-defined exclude patterns
  const excludePatterns = loadExcludePatterns(repoRoot);
  if (excludePatterns.length > 0) {
    console.log(chalk.gray(`  Exclude: ${excludePatterns.length} pattern(s) from .promptwheel/exclude.json`));
  }

  // Codebase index
  const excludeDirs = ['node_modules', 'dist', 'build', '.git', '.promptwheel', 'coverage', '__pycache__', ...excludePatterns];
  let codebaseIndex: CodebaseIndex | null = null;
  // Try to load ast-grep for AST-level analysis (optional)
  let astGrepModule: unknown = null;
  try {
    const moduleName = '@ast-grep/napi';
    astGrepModule = await import(/* webpackIgnore: true */ moduleName);
  } catch {
    // ast-grep not installed — regex fallback
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    codebaseIndex = buildCodebaseIndex(repoRoot, excludeDirs, true, (astGrepModule ?? undefined) as any);
    if (options.verbose) console.log(chalk.gray(`  Codebase index: ${codebaseIndex.modules.length} modules, ${codebaseIndex.untested_modules.length} untested, ${codebaseIndex.large_files.length} hotspots${codebaseIndex.analysis_backend === 'ast-grep' ? ' (AST)' : ''}`));
  } catch {
    // Non-fatal
  }

  // TypeScript deep analysis (optional, only on initial build)
  if (codebaseIndex && !codebaseIndex.typescript_analysis) {
    try {
      const { loadTsAnalysisCache, saveTsAnalysisCache } = await import('./ts-analysis-cache.js');
      // Try cache first
      const cached = loadTsAnalysisCache(repoRoot);
      if (cached) {
        codebaseIndex.typescript_analysis = cached;
        if (options.verbose) console.log(chalk.gray(`  TypeScript analysis (cached): ${cached.any_count} any, ${cached.unchecked_type_assertions} assertions`));
      } else {
        const { analyzeTypeScript } = await import('./ts-analysis.js');
        const tsResult = await analyzeTypeScript(repoRoot, codebaseIndex.modules, 30_000);
        if (tsResult) {
          codebaseIndex.typescript_analysis = tsResult;
          saveTsAnalysisCache(repoRoot, tsResult, codebaseIndex.modules.length);
          if (options.verbose) console.log(chalk.gray(`  TypeScript analysis: ${tsResult.any_count} any, ${tsResult.unchecked_type_assertions} assertions`));
        }
      }
    } catch {
      // Non-fatal — ts-morph not available or analysis failed
    }
  }

  // Project metadata
  const projectMeta = detectProjectMetadata(repoRoot);
  const metadataBlock = formatMetadataForPrompt(projectMeta);
  if (options.verbose && projectMeta.languages.length > 0) {
    console.log(chalk.gray(`  Project: ${projectMeta.languages.join(', ')}${projectMeta.framework ? ` / ${projectMeta.framework}` : ''}${projectMeta.test_runner ? ` / ${projectMeta.test_runner.name}` : ''}`));
  }

  // Auto-prune
  try {
    const { pruneAllAsync: pruneAllAsyncFn, getRetentionConfig } = await import('./retention.js');
    const retentionConfig = getRetentionConfig(config);
    const pruneReport = await pruneAllAsyncFn(repoRoot, retentionConfig, adapter);
    if (options.verbose && pruneReport.totalPruned > 0) {
      console.log(chalk.gray(`  Pruned ${pruneReport.totalPruned} stale item(s)`));
    }
  } catch {
    // Non-fatal
  }

  // Goals
  const goals = loadGoals(repoRoot);
  let activeGoal: import('./goals.js').Goal | null = null;
  let activeGoalMeasurement: GoalMeasurement | null = null;
  if (goals.length > 0) {
    console.log(chalk.cyan(`🎯 Goals loaded: ${goals.length}`));
    const measurements = measureGoals(goals, repoRoot);
    for (const m of measurements) {
      if (m.current !== null) {
        const arrow = m.direction === 'up' ? '↑' : '↓';
        const statusIcon = m.met ? '✓' : '○';
        console.log(chalk.gray(`  ${statusIcon} ${m.goalName}: ${m.current} ${arrow} ${m.target}${m.met ? ' (met)' : ` (gap: ${m.gapPercent}%)`}`));
      } else {
        console.log(chalk.yellow(`  ⚠ ${m.goalName}: measurement failed${m.error ? ` — ${m.error}` : ''}`));
      }
      recordGoalMeasurement(repoRoot, m);
    }
    const picked = pickGoalByGap(measurements);
    if (picked) {
      activeGoal = goals.find(g => g.name === picked.goalName) ?? null;
      activeGoalMeasurement = picked;
      console.log(chalk.cyan(`  → Active goal: ${picked.goalName} (gap: ${picked.gapPercent}%)`));
    } else {
      const allMet = measurements.every(m => m.met);
      if (allMet) {
        console.log(chalk.green(`  ✓ All goals met!`));
      }
    }
    console.log();
  }

  // Integrations
  const integrations = loadIntegrations(repoRoot);
  if (options.verbose && integrations.providers.length > 0) {
    console.log(chalk.gray(`  Integrations loaded: ${integrations.providers.map(p => p.name).join(', ')}`));
  }

  // Trajectories
  let activeTrajectory: Trajectory | null = null;
  let activeTrajectoryState: TrajectoryState | null = null;
  let currentTrajectoryStep: TrajectoryStep | null = null;
  {
    const trajState = loadTrajectoryState(repoRoot);
    if (trajState && !trajState.paused) {
      const traj = loadTrajectory(repoRoot, trajState.trajectoryName);
      if (traj) {
        activeTrajectory = traj;
        activeTrajectoryState = trajState;
        const nextStep = getTrajectoryNextStep(traj, trajState.stepStates);
        if (nextStep) {
          currentTrajectoryStep = nextStep;
          activeTrajectoryState.currentStepId = nextStep.id;
          const completed = traj.steps.filter(s => trajState.stepStates[s.id]?.status === 'completed').length;
          console.log(chalk.cyan(`📐 Trajectory: ${traj.name} — step ${completed + 1}/${traj.steps.length}: ${nextStep.title}`));
        } else if (trajectoryComplete(traj, trajState.stepStates)) {
          console.log(chalk.green(`  ✓ Trajectory "${traj.name}" — all steps complete`));
          activeTrajectory = null;
          activeTrajectoryState = null;
        } else {
          // Steps remain but are blocked (failed deps, cycles, etc.)
          const failed = traj.steps.filter(s => trajState.stepStates[s.id]?.status === 'failed').length;
          console.log(chalk.yellow(`  ⚠ Trajectory "${traj.name}" — stalled (${failed} failed, remaining steps blocked)`));
          console.log(chalk.gray(`    Use 'promptwheel trajectory show ${traj.name}' to inspect, or 'trajectory skip <step>' to unblock`));
          activeTrajectory = null;
          activeTrajectoryState = null;
        }
      }
    }
  }

  return {
    guidelines, guidelinesOpts, guidelinesRefreshInterval,
    allLearnings, dedupMemory, codebaseIndex, excludeDirs, excludePatterns, astGrepModule: astGrepModule ?? undefined, metadataBlock,
    goals, activeGoal, activeGoalMeasurement,
    activeTrajectory, activeTrajectoryState, currentTrajectoryStep,
    batchTokenBudget, scoutConcurrency, scoutTimeoutMs, maxScoutFiles, activeBackendName,
    integrations,
  };
}

/** External service dependencies. */
interface DepsResult {
  project: Awaited<ReturnType<typeof projects.ensureForRepo>>;
  deps: ReturnType<typeof createScoutDeps>;
  scoutBackend: ScoutBackend | undefined;
  executionBackend: ExecutionBackend | undefined;
  detectedBaseBranch: string;
  /** Bind the display adapter so logger output routes through the interactive console. */
  bindDisplayAdapter: (da: { log(msg: string): void }) => void;
}

/** Initialize external dependencies: project, scout deps, backends, base branch. */
async function initDependencies(
  options: AutoModeOptions,
  repoRoot: string,
  autoConf: Record<string, any>,
  adapter: DatabaseAdapter,
): Promise<DepsResult> {
  const project = await projects.ensureForRepo(adapter, {
    name: path.basename(repoRoot),
    rootPath: repoRoot,
  });
  // Late-bound output: routes through display adapter once state is initialized.
  // Before state exists, falls back to console.log. The display adapter's outputFn
  // gets redirected to the interactive console in initInteractiveConsole().
  let stateRef: { displayAdapter: { log(msg: string): void } } | null = null;
  const depsOutput = (msg: string) => stateRef ? stateRef.displayAdapter.log(msg) : console.log(msg);
  const deps = createScoutDeps(adapter, { verbose: options.verbose, output: depsOutput });

  const { getProvider } = await import('./providers/index.js');
  let scoutBackend: ScoutBackend | undefined;
  let executionBackend: ExecutionBackend | undefined;

  const scoutBackendName = options.scoutBackend ?? 'codex';
  const execBackendName = options.executeBackend ?? 'codex';

  const modelForBackend = (name: string): string | undefined => {
    if (name === 'codex') return options.codexModel;
    return undefined;
  };

  const apiKeyForBackend = (name: string): string | undefined => {
    const provider = getProvider(name);
    return provider.apiKeyEnvVar ? process.env[provider.apiKeyEnvVar] : undefined;
  };

  if (scoutBackendName !== 'claude') {
    if (scoutBackendName === 'codex' && options.codexMcp) {
      const { CodexMcpScoutBackend } = await import('@promptwheel/core/scout');
      scoutBackend = new CodexMcpScoutBackend({ apiKey: process.env.OPENAI_API_KEY, model: options.codexModel });
      if (options.verbose) console.log(chalk.cyan('  Scout: Codex MCP (persistent session)'));
    } else {
      const scoutProvider = getProvider(scoutBackendName);
      scoutBackend = await scoutProvider.createScoutBackend({
        apiKey: apiKeyForBackend(scoutBackendName),
        model: modelForBackend(scoutBackendName),
      });
    }
  }

  if (execBackendName !== 'claude') {
    const execProvider = getProvider(execBackendName);
    executionBackend = await execProvider.createExecutionBackend({
      apiKey: apiKeyForBackend(execBackendName),
      model: modelForBackend(execBackendName),
      unsafeBypassSandbox: options.codexUnsafeFullAccess,
    });

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

  return {
    project, deps, scoutBackend, executionBackend, detectedBaseBranch,
    bindDisplayAdapter: (da: { log(msg: string): void }) => { stateRef = { displayAdapter: da }; },
  };
}

/** Branch initialization result. */
interface BranchResult {
  milestoneBranch: string | undefined;
  milestoneWorktreePath: string | undefined;
  milestoneNumber: number;
}

/** Initialize milestone or direct branches. */
async function initBranches(
  options: AutoModeOptions,
  resolved: ResolvedOptions,
  deliveryMode: string,
  directBranch: string,
  repoRoot: string,
  detectedBaseBranch: string,
): Promise<BranchResult> {
  let milestoneBranch: string | undefined;
  let milestoneWorktreePath: string | undefined;
  let milestoneNumber = 0;

  if (!options.dryRun) {
    if (resolved.milestoneMode) {
      const ms = await createMilestoneBranch(repoRoot, detectedBaseBranch);
      milestoneBranch = ms.milestoneBranch;
      milestoneWorktreePath = ms.milestoneWorktreePath;
      milestoneNumber = 1;
      console.log(chalk.cyan(`Milestone branch: ${milestoneBranch}`));
      console.log();
    } else if (deliveryMode === 'direct') {
      const cleaned = await cleanupMergedDirectBranch(repoRoot, directBranch);
      if (options.verbose && cleaned) console.log(chalk.gray(`  Cleaned up merged direct branch: ${directBranch}`));
      await ensureDirectBranch(repoRoot, directBranch, detectedBaseBranch);
      console.log(chalk.cyan(`Direct branch: ${directBranch}`));
      console.log();
    }
  }

  return { milestoneBranch, milestoneWorktreePath, milestoneNumber };
}

/** Print the session header to console. */
function printSessionHeader(
  resolved: ResolvedOptions,
  deliveryMode: string,
  directBranch: string,
  directFinalize: string,
  autoConf: Record<string, any>,
  cachedQaBaseline: ReadonlyMap<string, boolean> | null,
  getCycleCategories: (formula: null) => { allow: string[]; block: string[] },
  drillMode: boolean,
) {
  const { runMode, totalMinutes, endTime, userScope, milestoneMode, batchSize, maxPrs, useDraft } = resolved;

  const initialCategories = getCycleCategories(null);

  {
    console.log(chalk.blue(`🛞 PromptWheel Auto v${CLI_VERSION}`));
    console.log();
    if (runMode === 'spin') {
      const drillLabel = drillMode ? ' + Drill' : '';
      console.log(chalk.gray(`  Mode: Spin${drillLabel} (Ctrl+C to stop gracefully)`));
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
      console.log(chalk.gray('  Mode: Planning (scout all → roadmap → approve → execute)'));
    }
  }
  console.log(chalk.gray(`  Scope: ${userScope || (runMode === 'spin' ? 'rotating' : 'all sectors')}`));

  const catDisplay = initialCategories.allow.join(', ');
  const baselineFailCount = cachedQaBaseline
    ? [...cachedQaBaseline.values()].filter(v => !v).length
    : 0;
  if (baselineFailCount > 0 && !initialCategories.allow.includes('fix')) {
    console.log(chalk.gray(`  Categories: ${catDisplay} (+fix for baseline healing)`));
  } else {
    console.log(chalk.gray(`  Categories: ${catDisplay}`));
  }

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
}

/**
 * Patch closures on state that need a back-reference to the state object.
 * Called after the state object is constructed.
 */
function patchStateClosures(
  state: AutoSessionState,
  shutdownRef: { shutdownRequested: boolean; currentlyProcessing: boolean },
) {
  // Redirect shutdown handler to read/write state flags directly.
  Object.assign(shutdownRef, { shutdownRequested: state.shutdownRequested, currentlyProcessing: state.currentlyProcessing });
  // Reassigning shutdownRef won't work here (local binding), so the caller
  // passes the original object and we need to redirect at the call site.
  // Instead, the caller will do: shutdownRef = state; after this call.

  // Patch category helpers to read from state
  state.getCycleFormula = (_cycle: number) => {
    if (state.activeGoal) {
      return state.activeGoal;
    }
    return null;
  };
  state.getCycleCategories = () => getCycleCategoriesImpl({ options: state.options, config: state.config }, null);

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
}

/** Start the interactive console (spin mode only). */
function initInteractiveConsole(state: AutoSessionState) {
  if (state.runMode !== 'spin') return;
  // TUI has its own input handling — skip the raw stdin listener to avoid conflicts
  const isTui = state.options.tui !== false && !state.options.dryRun && process.stdout.isTTY;
  if (isTui) return;

  state.interactiveConsole = startInteractiveConsole({
    repoRoot: state.repoRoot,
    onQuit: () => {
      state.shutdownRequested = true;
      if (state.shutdownReason === null) state.shutdownReason = 'user_quit';
    },
    onStatus: () => {
      const log = (msg: string) => state.interactiveConsole?.log(msg) ?? console.log(msg);
      const elapsed = Math.floor((Date.now() - state.startTime) / 1000);
      const mins = Math.floor(elapsed / 60);
      const secs = elapsed % 60;
      log(chalk.cyan('\n  📊 Session Status:'));
      log(chalk.gray(`    Cycle: ${state.cycleCount}`));
      log(chalk.gray(`    Elapsed: ${mins}m ${secs}s`));
      if (state.milestoneMode) {
        log(chalk.gray(`    Tickets this milestone: ${state.milestoneTicketCount}`));
        log(chalk.gray(`    Milestone PRs: ${state.totalMilestonePrs}/${state.maxPrs}`));
      } else if (state.deliveryMode === 'direct') {
        log(chalk.gray(`    Completed tickets: ${state.completedDirectTickets.length}`));
      } else {
        const limit = state.maxPrs < 999 ? `/${state.maxPrs}` : '';
        log(chalk.gray(`    PRs created: ${state.totalPrsCreated}${limit}`));
      }
      log(chalk.gray(`    Failed: ${state.totalFailed}`));
      if (state.endTime) {
        const remaining = Math.max(0, Math.floor((state.endTime - Date.now()) / 60000));
        log(chalk.gray(`    Time remaining: ${remaining}m`));
      }
    },
  });

  // Route display adapter output through the interactive console
  const da = state.displayAdapter;
  if ('setOutputFn' in da && typeof (da as any).setOutputFn === 'function') {
    (da as SpinnerDisplayAdapter).setOutputFn((msg) => state.interactiveConsole!.log(msg));
  }
}

// ── Init ────────────────────────────────────────────────────────────────────

export async function initSession(options: AutoModeOptions): Promise<AutoSessionState> {
  const resolved = await resolveOptions(options);
  const env = await initEnvironment(options, resolved);
  const { repoRoot, config, autoConf, cachedQaBaseline, adapter } = env;

  const sessionData = await loadSessionData(
    options, resolved, repoRoot, config, autoConf, cachedQaBaseline, adapter,
  );
  const depsResult = await initDependencies(options, repoRoot, autoConf, adapter);

  // Shutdown handler — mutable reference that gets redirected to state after construction
  let shutdownRef: { shutdownRequested: boolean; currentlyProcessing: boolean } = {
    shutdownRequested: false,
    currentlyProcessing: false,
  };

  // Track whether TUI is active — set below after display adapter is created
  let tuiActive = false;

  const shutdownHandler = () => {
    if (shutdownRef.shutdownRequested) {
      if (!tuiActive) console.log(chalk.red('\nForce quit. Exiting immediately.'));
      process.exit(1);
    }
    shutdownRef.shutdownRequested = true;
    if ('shutdownReason' in shutdownRef && shutdownRef.shutdownReason === null) {
      (shutdownRef as any).shutdownReason = 'user_signal';
    }
    // TUI handles its own shutdown display — don't write raw console output
    if (!tuiActive) {
      if (shutdownRef.currentlyProcessing) {
        console.log(chalk.yellow('\nShutdown requested. Finishing current ticket then finalizing...'));
      } else {
        console.log(chalk.yellow('\nShutdown requested. Finalizing session...'));
      }
    }
  };

  process.on('SIGINT', shutdownHandler);
  process.on('SIGTERM', shutdownHandler);

  // Temporary category helpers for header printing (before state exists)
  const sessionPhase: 'warmup' | 'deep' | 'cooldown' = 'deep';
  const tmpGetCycleCategories = (_formula: null) =>
    getCycleCategoriesImpl({ options, config }, null);

  // Delivery mode — need autoConf for defaults
  const deliveryMode = options.deliveryMode ?? autoConf.deliveryMode ?? 'direct';
  const directBranch = options.directBranch ?? autoConf.directBranch ?? 'promptwheel-direct';
  const directFinalize = options.directFinalize ?? autoConf.directFinalize ?? 'merge';

  const drillMode = options.drill !== false && autoConf.drill?.enabled !== false && resolved.runMode === 'spin';
  printSessionHeader(resolved, deliveryMode, directBranch, directFinalize, autoConf, cachedQaBaseline, tmpGetCycleCategories, drillMode);

  const branches = await initBranches(options, resolved, deliveryMode, directBranch, repoRoot, depsResult.detectedBaseBranch);

  // Display adapter
  let displayAdapter: DisplayAdapter;
  {
    const useTui = options.tui !== false && !options.dryRun && process.stdout.isTTY;
    displayAdapter = new SpinnerDisplayAdapter();
    if (useTui) {
      tuiActive = true;
      const { TuiDisplayAdapter } = await import('./display-adapter-tui.js');
      displayAdapter = new TuiDisplayAdapter({
        repoRoot,
        onQuit: () => {
          shutdownRef.shutdownRequested = true;
          if ('shutdownReason' in shutdownRef && (shutdownRef as any).shutdownReason === null) {
            (shutdownRef as any).shutdownReason = 'user_quit';
          }
        },
        onStatus: () => {
          // Will be patched after state is created
        },
      });
    }
  }

  const pullInterval = config?.auto?.pullEveryNCycles ?? 5;
  const pullPolicy: 'halt' | 'warn' = config?.auto?.pullPolicy ?? 'halt';

  // Build state object
  const state: AutoSessionState = {
    options,
    config,
    autoConf,
    repoRoot,

    runMode: resolved.runMode,
    totalMinutes: resolved.totalMinutes,
    endTime: resolved.endTime,
    startTime: Date.now(),

    maxPrs: resolved.maxPrs,
    maxCycles: resolved.maxCycles,
    minConfidence: resolved.minConfidence,
    useDraft: resolved.useDraft,

    milestoneMode: resolved.milestoneMode,
    batchSize: resolved.batchSize,
    milestoneBranch: branches.milestoneBranch,
    milestoneWorktreePath: branches.milestoneWorktreePath,
    milestoneTicketCount: 0,
    milestoneNumber: branches.milestoneNumber,
    totalMilestonePrs: 0,
    milestoneTicketSummaries: [],

    deliveryMode,
    directBranch,
    directFinalize,
    completedDirectTickets: [],
    allTraceAnalyses: [],

    totalPrsCreated: 0,
    totalFailed: 0,
    cycleCount: 0,
    allPrUrls: [],
    totalMergedPrs: 0,
    totalClosedPrs: 0,
    pendingPrUrls: [],

    effectiveMinConfidence: (() => {
      const rs = readRunState(repoRoot);
      const persisted = rs.lastEffectiveMinConfidence;
      const configured = autoConf.minConfidence ?? 20;
      return (persisted !== undefined && persisted >= configured && persisted <= 80)
        ? persisted : configured;
    })(),
    consecutiveLowYieldCycles: 0,
    consecutiveIdleCycles: 0,
    consecutiveFailureCycles: 0,
    backpressureRetries: 0,
    _prevCycleCompleted: 0,

    sessionPhase,
    allTicketOutcomes: [],
    cycleOutcomes: [],
    prMetaMap: new Map(),

    guidelines: sessionData.guidelines,
    guidelinesOpts: sessionData.guidelinesOpts,
    guidelinesRefreshInterval: sessionData.guidelinesRefreshInterval,
    integrations: sessionData.integrations,

    allLearnings: sessionData.allLearnings,
    dedupMemory: sessionData.dedupMemory,
    codebaseIndex: sessionData.codebaseIndex,
    excludeDirs: sessionData.excludeDirs,
    excludePatterns: sessionData.excludePatterns,
    metadataBlock: sessionData.metadataBlock,

    goals: sessionData.goals,
    activeGoal: sessionData.activeGoal,
    activeGoalMeasurement: sessionData.activeGoalMeasurement,

    activeTrajectory: sessionData.activeTrajectory,
    activeTrajectoryState: sessionData.activeTrajectoryState,
    currentTrajectoryStep: sessionData.currentTrajectoryStep,

    qaBaseline: cachedQaBaseline,

    batchTokenBudget: sessionData.batchTokenBudget,
    scoutConcurrency: sessionData.scoutConcurrency,
    scoutTimeoutMs: sessionData.scoutTimeoutMs,
    maxScoutFiles: sessionData.maxScoutFiles,
    activeBackendName: sessionData.activeBackendName,
    lastScanCommit: null,
    repos: [],
    repoIndex: 0,

    scoutBackend: depsResult.scoutBackend,
    executionBackend: depsResult.executionBackend,

    adapter,
    project: depsResult.project,
    deps: depsResult.deps,
    detectedBaseBranch: depsResult.detectedBaseBranch,

    shutdownRequested: shutdownRef.shutdownRequested,
    shutdownReason: null,
    currentlyProcessing: false,

    pullInterval,
    pullPolicy,
    cyclesSinceLastPull: 0,

    scoutRetries: 0,
    scoutedDirs: [],
    _pendingIntegrationProposals: [],
    integrationLastRun: {},
    _cycleProgress: null,
    escalationCandidates: new Set(),
    drillMode,
    drillLastGeneratedAtCycle: 0,
    drillTrajectoriesGenerated: 0,
    drillLastOutcome: null,
    drillHistory: [],
    drillCoveredCategories: new Map(),
    drillCoveredScopes: new Map(),
    drillLastSurveyTimestamp: null,
    drillConsecutiveInsufficient: readRunState(repoRoot).lastDrillConsecutiveInsufficient ?? 0,
    drillGenerationTelemetry: null,
    drillLastFreshnessDropRatio: null,

    parallelExplicit: resolved.parallelExplicit,
    userScope: resolved.userScope,
    interactiveConsole: undefined,
    displayAdapter,

    getCycleFormula: null as any,
    getCycleCategories: null as any,
    finalizeMilestone: null as any,
    startNewMilestone: null as any,
  };

  // Redirect shutdown handler to state
  shutdownRef = state;

  // Restore from crash-resume checkpoint if recent enough
  {
    const rs = readRunState(repoRoot);
    const cp = rs.sessionCheckpoint;
    const recoveryWindowMs = (autoConf.recoveryWindowMinutes ?? 120) * 60 * 1000;
    if (cp && Date.now() - cp.savedAt < recoveryWindowMs) {
      state.cycleCount = cp.cycleCount;
      state.totalPrsCreated = cp.totalPrsCreated;
      state.totalFailed = cp.totalFailed;
      state.consecutiveLowYieldCycles = cp.consecutiveLowYieldCycles;
      state.pendingPrUrls = [...cp.pendingPrUrls];
      state.allPrUrls = [...cp.allPrUrls];
      console.log(chalk.yellow(`Resuming from checkpoint: cycle ${cp.cycleCount}, ${cp.totalPrsCreated} PRs`));
    }
  }

  // Multi-repo: resolve --repos directories to absolute repo roots
  if (options.repos) {
    const repoDirs = options.repos.split(',').map(d => d.trim()).filter(Boolean);
    const resolvedRepos: string[] = [];
    for (const dir of repoDirs) {
      const absDir = path.isAbsolute(dir) ? dir : path.resolve(dir);
      const git = createGitService();
      const root = await git.findRepoRoot(absDir);
      if (root) {
        resolvedRepos.push(root);
      } else {
        console.log(chalk.yellow(`  ⚠ Skipping ${dir}: not a git repository`));
      }
    }
    if (resolvedRepos.length > 0) {
      // Deduplicate
      state.repos = [...new Set(resolvedRepos)];
      state.repoIndex = 0;
      console.log(chalk.gray(`  Multi-repo: ${state.repos.length} repo(s) — ${state.repos.map(r => path.basename(r)).join(', ')}`));
    }
  }

  // Patch closures that need state reference
  patchStateClosures(state, shutdownRef);

  // Hydrate drill history from disk (cross-session diversity)
  if (state.drillMode) {
    const { hydrateDrillState } = await import('./solo-auto-drill.js');
    hydrateDrillState(state);
    if (options.verbose && state.drillHistory.length > 0) {
      console.log(chalk.gray(`  Drill history loaded: ${state.drillHistory.length} previous trajectory(s)`));
    }
    // Notify display adapter of initial drill state
    state.displayAdapter.drillStateChanged({
      active: true,
      trajectoryName: state.activeTrajectory?.name,
      trajectoryProgress: state.activeTrajectory
        ? `${Object.values(state.activeTrajectoryState?.stepStates ?? {}).filter(s => s.status === 'completed').length}/${state.activeTrajectory.steps.length}`
        : undefined,
    });
  }

  // Bind display adapter so logger output routes through it
  depsResult.bindDisplayAdapter(state.displayAdapter);

  // Start interactive console
  initInteractiveConsole(state);

  return state;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

export function shouldContinue(state: AutoSessionState): boolean {
  if (state.shutdownRequested) return false;

  // PR limits only apply to PR-based workflows, not direct mode
  if (state.milestoneMode) {
    if (state.totalMilestonePrs >= state.maxPrs) {
      if (state.shutdownReason === null) state.shutdownReason = 'pr_limit';
      return false;
    }
  } else if (state.deliveryMode === 'pr' || state.deliveryMode === 'auto-merge') {
    if (state.totalPrsCreated >= state.maxPrs) {
      if (state.shutdownReason === null) state.shutdownReason = 'pr_limit';
      return false;
    }
  }
  // Direct mode: no PR limit, just time/cycles

  if (state.endTime && Date.now() >= state.endTime) {
    if (state.shutdownReason === null) state.shutdownReason = 'time_limit';
    return false;
  }
  if (state.cycleCount >= state.maxCycles && state.runMode !== 'spin') return false;
  return true;
}

export function getNextScope(state: AutoSessionState): string | null {
  if (state.userScope) return state.userScope;
  return '**';
}
