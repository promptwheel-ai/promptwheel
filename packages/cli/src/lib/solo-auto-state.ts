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
import { getCycleFormula as getCycleFormulaImpl, getCycleCategories as getCycleCategoriesImpl, type CycleFormulaContext } from './solo-cycle-formula.js';
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
import {
  loadOrBuildSectors, pickNextSector,
  type SectorState,
} from './sectors.js';
import { loadTasteProfile } from './taste-profile.js';
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
import { LogDisplayAdapter } from './display-adapter-log.js';
import { initMetrics, metric } from './metrics.js';

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
  activeFormula: import('./formulas.js').Formula | null;
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

/** Parse CLI options into resolved values. Loads formula if specified. */
async function resolveOptions(options: AutoModeOptions): Promise<ResolvedOptions> {
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

  const hoursValue = options.hours ? parseFloat(options.hours) : 0;
  const minutesValue = options.minutes ? parseFloat(options.minutes) : 0;
  const totalMinutes = (hoursValue * 60 + minutesValue) || undefined;

  const maxCycles = options.cycles ? parseInt(options.cycles, 10) : 999;
  const explicitSpin = options.spin || options.continuous;
  const impliedSpin = totalMinutes !== undefined || (options.cycles && maxCycles > 1);
  const runMode: RunMode = (explicitSpin || impliedSpin) ? 'spin' : 'planning';
  const endTime = totalMinutes ? Date.now() + (totalMinutes * 60 * 1000) : undefined;

  const defaultMaxPrs = runMode === 'spin' ? 999 : 3;
  const maxPrs = parseInt(options.maxPrs || String(activeFormula?.maxPrs ?? defaultMaxPrs), 10);
  const minConfidence = parseInt(options.minConfidence || String(activeFormula?.minConfidence ?? DEFAULT_AUTO_CONFIG.minConfidence), 10);
  const useDraft = options.draft !== false;

  const batchSize = options.batchSize ? parseInt(options.batchSize, 10) : undefined;
  const milestoneMode = batchSize !== undefined && batchSize > 0;
  const userScope = options.scope || activeFormula?.scope;
  const parallelExplicit = options.parallel !== undefined && options.parallel !== '3';

  return {
    activeFormula, totalMinutes, maxCycles, runMode, endTime,
    maxPrs, minConfidence, useDraft, batchSize, milestoneMode,
    userScope, parallelExplicit,
  };
}

/** Environment result from initEnvironment. */
interface EnvironmentResult {
  repoRoot: string;
  config: ReturnType<typeof loadConfig>;
  autoConf: Record<string, any>;
  cachedQaBaseline: Map<string, boolean> | null;
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
  if (lockResult.stalePid) {
    console.log(chalk.gray(`  Cleaned up stale session lock (PID ${lockResult.stalePid})`));
  }
  const releaseLock = () => releaseSessionLock(repoRoot);
  process.on('exit', releaseLock);

  // Clean up stale resources
  gitWorktreePrune(repoRoot);
  const prunedWorktrees = pruneStaleWorktrees(repoRoot);
  if (prunedWorktrees > 0) {
    console.log(chalk.gray(`  Cleaned up ${prunedWorktrees} stale worktree(s)`));
  }
  const prunedBranches = pruneStaleBranches(repoRoot, 7);
  if (prunedBranches > 0) {
    console.log(chalk.gray(`  Cleaned up ${prunedBranches} stale branch(es)`));
  }
  const prunedCodexSessions = pruneStaleCodexSessions(7);
  if (prunedCodexSessions > 0) {
    console.log(chalk.gray(`  Cleaned up ${prunedCodexSessions} stale codex session(s)`));
  }

  resetQaStatsForSession(repoRoot);

  let config = loadConfig(repoRoot);

  // Project setup command
  if (config?.setup && !options.dryRun) {
    console.log(chalk.gray(`  Running setup: ${config.setup}`));
    try {
      const { execSync } = await import('node:child_process');
      execSync(config.setup, { cwd: repoRoot, timeout: 300_000, stdio: 'pipe' });
      console.log(chalk.green('  ✓ Setup complete'));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(chalk.yellow(`  ⚠ Setup failed: ${msg.split('\n')[0]}`));
    }
  }

  // QA baseline
  let cachedQaBaseline: Map<string, boolean> | null = null;
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
        console.log(chalk.gray('  Auto-committed .gitignore update'));
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
  const adapter = await getAdapter(repoRoot);

  return { repoRoot, config, autoConf, cachedQaBaseline, adapter };
}

/** Loaded session data — read from disk, no external services. */
interface SessionData {
  deepFormula: import('./formulas.js').Formula | null;
  docsAuditFormula: import('./formulas.js').Formula | null;
  guidelines: ProjectGuidelines | null;
  guidelinesOpts: { backend: GuidelinesBackend; autoCreate: boolean; customPath?: string };
  guidelinesRefreshInterval: number;
  allLearnings: Learning[];
  dedupMemory: DedupEntry[];
  codebaseIndex: CodebaseIndex | null;
  excludeDirs: string[];
  metadataBlock: string | null;
  sectorState: SectorState | null;
  tasteProfile: ReturnType<typeof loadTasteProfile>;
  goals: import('./formulas.js').Formula[];
  activeGoal: import('./formulas.js').Formula | null;
  activeGoalMeasurement: GoalMeasurement | null;
  activeTrajectory: Trajectory | null;
  activeTrajectoryState: TrajectoryState | null;
  currentTrajectoryStep: TrajectoryStep | null;
  batchTokenBudget: number;
  scoutConcurrency: number;
  scoutTimeoutMs: number;
  maxScoutFiles: number;
  activeBackendName: string;
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
  cachedQaBaseline: Map<string, boolean> | null,
  adapter: DatabaseAdapter,
): Promise<SessionData> {
  // Formulas for deep scan and docs audit
  let deepFormula: import('./formulas.js').Formula | null = null;
  let docsAuditFormula: import('./formulas.js').Formula | null = null;
  if (!resolved.activeFormula) {
    const { loadFormula: loadF } = await import('./formulas.js');
    if (resolved.runMode === 'spin') {
      deepFormula = loadF('deep');
    }
    if (options.docsAudit !== false) {
      docsAuditFormula = loadF('docs-audit');
    }
  }

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

  // Codebase index
  const excludeDirs = ['node_modules', 'dist', 'build', '.git', '.promptwheel', 'coverage', '__pycache__'];
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

  // Goals
  const goals = loadGoals(repoRoot);
  let activeGoal: import('./formulas.js').Formula | null = null;
  let activeGoalMeasurement: GoalMeasurement | null = null;
  if (goals.length > 0 && !options.formula) {
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
    deepFormula, docsAuditFormula, guidelines, guidelinesOpts, guidelinesRefreshInterval,
    allLearnings, dedupMemory, codebaseIndex, excludeDirs, metadataBlock,
    sectorState, tasteProfile, goals, activeGoal, activeGoalMeasurement,
    activeTrajectory, activeTrajectoryState, currentTrajectoryStep,
    batchTokenBudget, scoutConcurrency, scoutTimeoutMs, maxScoutFiles, activeBackendName,
  };
}

/** External service dependencies. */
interface DepsResult {
  project: Awaited<ReturnType<typeof projects.ensureForRepo>>;
  deps: ReturnType<typeof createScoutDeps>;
  scoutBackend: ScoutBackend | undefined;
  executionBackend: ExecutionBackend | undefined;
  detectedBaseBranch: string;
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
  const deps = createScoutDeps(adapter, { verbose: options.verbose });

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
      const { CodexMcpScoutBackend } = await import('@promptwheel/core/scout');
      scoutBackend = new CodexMcpScoutBackend({ apiKey: process.env.OPENAI_API_KEY, model: options.codexModel });
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

  return { project, deps, scoutBackend, executionBackend, detectedBaseBranch };
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
      if (cleaned) console.log(chalk.gray(`  Cleaned up merged direct branch: ${directBranch}`));
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
  cachedQaBaseline: Map<string, boolean> | null,
  getCycleFormula: (cycle: number) => import('./formulas.js').Formula | null,
  getCycleCategories: (formula: import('./formulas.js').Formula | null) => { allow: string[]; block: string[] },
) {
  const { runMode, totalMinutes, endTime, userScope, milestoneMode, batchSize, maxPrs, useDraft } = resolved;

  const initialCategories = getCycleCategories(getCycleFormula(1));

  {
    console.log(chalk.blue(`🧵 PromptWheel Auto v${CLI_VERSION}`));
    console.log();
    if (runMode === 'spin') {
      console.log(chalk.gray('  Mode: Spin (Ctrl+C to stop gracefully)'));
      if (totalMinutes) {
        const endDate = new Date(endTime!);
        const budgetLabel = totalMinutes < 60
          ? `${Math.round(totalMinutes)} minutes`
          : totalMinutes % 60 === 0
            ? `${totalMinutes / 60} hours`
            : `${Math.floor(totalMinutes / 60)}h ${Math.round(totalMinutes % 60)}m`;
        console.log(chalk.gray(`  Time budget: ${budgetLabel} (until ${endDate.toLocaleTimeString()})`));
        if ((totalMinutes ?? 0) >= 360) {
          console.log(chalk.gray(`  Tip: For always-on improvement, try: promptwheel solo daemon start`));
        }
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

  // Patch formula helpers to read from state
  const stateFormulaCtx = (): CycleFormulaContext => ({
    activeFormula: state.activeFormula,
    sessionPhase: state.sessionPhase,
    deepFormula: state.deepFormula,
    docsAuditFormula: state.docsAuditFormula,
    isContinuous: state.runMode === 'spin',
    repoRoot: state.repoRoot,
    options: state.options,
    config: state.config,
    sectorProductionFileCount: state.currentSectorId
      ? state.sectorState?.sectors.find(s => s.path === state.currentSectorId)?.productionFileCount
      : undefined,
  });
  state.getCycleFormula = (cycle: number) => {
    if (state.activeGoal && !state.options.formula) {
      return state.activeGoal;
    }
    return getCycleFormulaImpl(stateFormulaCtx(), cycle);
  };
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
}

/** Start the interactive console (spin mode only, not in daemon mode). */
function initInteractiveConsole(state: AutoSessionState) {
  if (state.runMode !== 'spin' || state.options.daemon) return;

  state.interactiveConsole = startInteractiveConsole({
    repoRoot: state.repoRoot,
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

  const shutdownHandler = () => {
    if (shutdownRef.shutdownRequested) {
      console.log(chalk.red('\nForce quit. Exiting immediately.'));
      process.exit(1);
    }
    shutdownRef.shutdownRequested = true;
    if (shutdownRef.currentlyProcessing) {
      console.log(chalk.yellow('\nShutdown requested. Finishing current ticket then finalizing...'));
    } else {
      console.log(chalk.yellow('\nShutdown requested. Finalizing session...'));
    }
  };

  // In daemon mode, the daemon loop handles signals itself
  if (!options.daemon) {
    process.on('SIGINT', shutdownHandler);
    process.on('SIGTERM', shutdownHandler);
  }

  // Temporary formula helpers for header printing (before state exists)
  const sessionPhase: 'warmup' | 'deep' | 'cooldown' = 'deep';
  const tmpFormulaCtx = (): CycleFormulaContext => ({
    activeFormula: resolved.activeFormula,
    sessionPhase,
    deepFormula: sessionData.deepFormula,
    docsAuditFormula: sessionData.docsAuditFormula,
    isContinuous: resolved.runMode === 'spin',
    repoRoot,
    options,
    config,
    sectorProductionFileCount: undefined,
  });
  const tmpGetCycleFormula = (cycle: number) => getCycleFormulaImpl(tmpFormulaCtx(), cycle);
  const tmpGetCycleCategories = (formula: import('./formulas.js').Formula | null) =>
    getCycleCategoriesImpl(tmpFormulaCtx(), formula);

  // Delivery mode — need autoConf for defaults
  const deliveryMode = options.deliveryMode ?? autoConf.deliveryMode ?? 'direct';
  const directBranch = options.directBranch ?? autoConf.directBranch ?? 'promptwheel-direct';
  const directFinalize = options.directFinalize ?? autoConf.directFinalize ?? 'merge';

  printSessionHeader(resolved, deliveryMode, directBranch, directFinalize, autoConf, cachedQaBaseline, tmpGetCycleFormula, tmpGetCycleCategories);

  const branches = await initBranches(options, resolved, deliveryMode, directBranch, repoRoot, depsResult.detectedBaseBranch);

  // Display adapter
  let displayAdapter: DisplayAdapter;
  if (options.daemon) {
    displayAdapter = new LogDisplayAdapter();
  } else {
    const useTui = options.tui !== false && process.stdout.isTTY;
    displayAdapter = new SpinnerDisplayAdapter();
    if (useTui) {
      const { TuiDisplayAdapter } = await import('./display-adapter-tui.js');
      displayAdapter = new TuiDisplayAdapter({
        repoRoot,
        onQuit: () => { shutdownRef.shutdownRequested = true; },
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

    activeFormula: resolved.activeFormula,
    deepFormula: sessionData.deepFormula,
    docsAuditFormula: sessionData.docsAuditFormula,
    currentFormulaName: 'default',

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

    sectorState: sessionData.sectorState,
    currentSectorId: null,
    currentSectorCycle: 0,
    sessionScannedSectors: new Set(),

    effectiveMinConfidence: autoConf.minConfidence ?? 20,
    consecutiveLowYieldCycles: 0,

    sessionPhase,
    allTicketOutcomes: [],
    cycleOutcomes: [],
    prMetaMap: new Map(),

    guidelines: sessionData.guidelines,
    guidelinesOpts: sessionData.guidelinesOpts,
    guidelinesRefreshInterval: sessionData.guidelinesRefreshInterval,

    allLearnings: sessionData.allLearnings,
    dedupMemory: sessionData.dedupMemory,
    codebaseIndex: sessionData.codebaseIndex,
    excludeDirs: sessionData.excludeDirs,
    metadataBlock: sessionData.metadataBlock,
    tasteProfile: sessionData.tasteProfile,

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

    scoutBackend: depsResult.scoutBackend,
    executionBackend: depsResult.executionBackend,

    adapter,
    project: depsResult.project,
    deps: depsResult.deps,
    detectedBaseBranch: depsResult.detectedBaseBranch,

    shutdownRequested: shutdownRef.shutdownRequested,
    currentlyProcessing: false,

    pullInterval,
    pullPolicy,
    cyclesSinceLastPull: 0,

    scoutRetries: 0,
    scoutedDirs: [],

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

  // Patch closures that need state reference
  patchStateClosures(state, shutdownRef);

  // Start interactive console
  initInteractiveConsole(state);

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
  if (state.cycleCount >= state.maxCycles && state.runMode !== 'spin') return false;
  return true;
}

/**
 * Check if a sector has files modified since its last scan.
 * Uses `git diff --name-only` against the sector's scope.
 */
function sectorHasChanges(repoRoot: string, sector: { path: string; lastScannedAt: number }): boolean {
  if (sector.lastScannedAt === 0) return true; // never scanned = always scan
  try {
    const sinceDate = new Date(sector.lastScannedAt).toISOString();
    const result = spawnSync('git', ['log', '--since', sinceDate, '--name-only', '--pretty=format:', '--', `${sector.path}/**`], {
      cwd: repoRoot,
      encoding: 'utf-8',
      timeout: 5000,
    });
    const changedFiles = (result.stdout ?? '').trim();
    return changedFiles.length > 0;
  } catch {
    return true; // on error, assume changes exist
  }
}

export function getNextScope(state: AutoSessionState): string | null {
  if (state.userScope) return state.userScope;
  if (state.sectorState) {
    const rs = readRunState(state.repoRoot);
    state.currentSectorCycle = rs.totalCycles;

    // Keep picking sectors until we find one with changes (or unscanned)
    const tried = new Set<string>();
    while (tried.size < state.sectorState.sectors.length) {
      const pick = pickNextSector(state.sectorState, state.currentSectorCycle);
      if (!pick) break;

      if (tried.has(pick.sector.path)) break; // looped back
      tried.add(pick.sector.path);

      // Always scan each sector at least once per session; after that, only on changes
      const scannedThisSession = state.sessionScannedSectors.has(pick.sector.path);
      if (pick.sector.scanCount === 0 || !scannedThisSession || sectorHasChanges(state.repoRoot, pick.sector)) {
        state.sessionScannedSectors.add(pick.sector.path);
        state.currentSectorId = pick.sector.path;
        return pick.scope;
      }

      // Mark as "just scanned" so pickNextSector moves to the next one
      pick.sector.lastScannedCycle = state.currentSectorCycle;
    }

    // All sectors scanned and no changes detected
    state.currentSectorId = null;
    return null;
  }
  state.currentSectorId = null;
  return '**';
}
