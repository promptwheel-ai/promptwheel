/**
 * Solo mode continuous execution
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import chalk from 'chalk';
import { spawnSync } from 'node:child_process';
import type { DatabaseAdapter } from '@blockspool/core/db';
import {
  scoutRepo,
  type ScoutProgress,
  type ScoutBackend,
} from '@blockspool/core/services';
import { projects, tickets, runs } from '@blockspool/core/repos';
import { createGitService } from './git.js';
import { createSpinner, createBatchProgress, type BatchProgressDisplay } from './spinner.js';
import {
  getBlockspoolDir,
  getAdapter,
  isInitialized,
  initSolo,
  loadConfig,
  createScoutDeps,
  formatProgress,
} from './solo-config.js';
import { runPreflightChecks } from './solo-utils.js';
import { recordCycle, isDocsAuditDue, recordDocsAudit, deferProposal, popDeferredForScope } from './run-state.js';
import { soloRunTicket, runClaude, type RunTicketResult, type ExecutionBackend, CodexExecutionBackend } from './solo-ticket.js';
import {
  createMilestoneBranch,
  mergeTicketToMilestone,
  pushAndPrMilestone,
  cleanupMilestone,
} from './solo-git.js';
import { consumePendingHints } from './solo-hints.js';
import { startStdinListener } from './solo-stdin.js';
import { loadGuidelines, formatGuidelinesForPrompt } from './guidelines.js';
import type { ProjectGuidelines, GuidelinesBackend } from './guidelines.js';
import {
  loadLearnings, addLearning, confirmLearning, recordAccess,
  consolidateLearnings, formatLearningsForPrompt, selectRelevant, extractTags,
  type Learning,
} from './learnings.js';
import {
  buildCodebaseIndex, refreshCodebaseIndex, hasStructuralChanges,
  formatIndexForPrompt, type CodebaseIndex,
} from './codebase-index.js';
import {
  buildProposalReviewPrompt, parseReviewedProposals, applyReviewToProposals,
} from './proposal-review.js';
import { detectProjectMetadata, formatMetadataForPrompt } from './project-metadata/index.js';
import { DEFAULT_AUTO_CONFIG } from './solo-config.js';
import {
  loadDedupMemory, recordDedupEntry, recordDedupEntries, formatDedupForPrompt,
  type DedupEntry,
} from './dedup-memory.js';
import { sleep, normalizeTitle, titleSimilarity, isDuplicateProposal, getDeduplicationContext, getAdaptiveParallelCount } from './dedup.js';
import { partitionIntoWaves, buildScoutEscalation } from './wave-scheduling.js';

// Re-export so existing importers don't break
export { sleep, normalizeTitle, titleSimilarity, isDuplicateProposal, getDeduplicationContext, getAdaptiveParallelCount } from './dedup.js';
export { partitionIntoWaves, buildScoutEscalation } from './wave-scheduling.js';

/**
 * Balance proposals so test proposals don't dominate the batch.
 * Keeps at most floor(total * maxTestRatio) test proposals (highest impact first).
 * If there aren't enough non-test proposals to fill, allows more tests.
 */
function balanceProposals<T extends { category: string; impact_score?: number | null }>(
  proposals: T[],
  maxTestRatio: number,
): T[] {
  const tests = proposals.filter(p => (p.category || '').toLowerCase() === 'test');
  const nonTests = proposals.filter(p => (p.category || '').toLowerCase() !== 'test');

  const total = proposals.length;
  const maxTests = Math.floor(total * maxTestRatio);

  if (tests.length <= maxTests) return proposals;

  // Sort tests by impact descending, keep only the top N
  const sortedTests = [...tests].sort(
    (a, b) => (b.impact_score ?? 5) - (a.impact_score ?? 5),
  );

  // Allow more tests if there aren't enough non-tests to fill the batch
  const allowedTests = Math.max(maxTests, total - nonTests.length);
  const keptTests = sortedTests.slice(0, allowedTests);

  return [...nonTests, ...keptTests];
}

/**
 * Run auto work mode - process ready tickets in parallel
 */
export async function runAutoWorkMode(options: {
  dryRun?: boolean;
  pr?: boolean;
  verbose?: boolean;
  parallel?: string;
}): Promise<void> {
  const parallelCount = Math.max(1, parseInt(options.parallel || '1', 10));

  console.log(chalk.blue('🧵 BlockSpool Auto - Work Mode'));
  console.log(chalk.gray(`  Parallel workers: ${parallelCount}`));
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

  const adapter = await getAdapter(repoRoot);
  const projectList = await projects.list(adapter);

  if (projectList.length === 0) {
    console.log(chalk.yellow('No projects found.'));
    console.log(chalk.gray('  Run: blockspool solo scout . to create proposals'));
    await adapter.close();
    process.exit(0);
  }

  const readyTickets: Array<Awaited<ReturnType<typeof tickets.getById>> & {}> = [];
  for (const project of projectList) {
    const projectTickets = await tickets.listByProject(adapter, project.id, { status: 'ready' });
    readyTickets.push(...projectTickets);
  }

  if (readyTickets.length === 0) {
    console.log(chalk.yellow('No ready tickets found.'));
    console.log(chalk.gray('  Create tickets with: blockspool solo approve'));
    await adapter.close();
    process.exit(0);
  }

  console.log(chalk.bold(`Found ${readyTickets.length} ready ticket(s)`));
  for (const ticket of readyTickets) {
    console.log(chalk.gray(`  • ${ticket.id}: ${ticket.title}`));
  }
  console.log();

  if (options.dryRun) {
    console.log(chalk.yellow('Dry run - no changes made'));
    console.log();
    console.log(`Would process ${Math.min(readyTickets.length, parallelCount)} ticket(s) concurrently.`);
    await adapter.close();
    process.exit(0);
  }

  const config = loadConfig(repoRoot);

  // Load project guidelines for execution prompts
  const guidelines = loadGuidelines(repoRoot, {
    customPath: config?.auto?.guidelinesPath ?? undefined,
  });
  if (guidelines) {
    console.log(chalk.gray(`  Guidelines loaded: ${guidelines.source}`));
  }

  // Load cross-run learnings
  const autoConf = { ...DEFAULT_AUTO_CONFIG, ...config?.auto };
  const allLearningsWork = autoConf.learningsEnabled
    ? loadLearnings(repoRoot, autoConf.learningsDecayRate) : [];
  if (allLearningsWork.length > 0) {
    console.log(chalk.gray(`  Learnings loaded: ${allLearningsWork.length}`));
  }

  // Detect project metadata
  const projectMetaWork = detectProjectMetadata(repoRoot);
  const metadataBlockWork = formatMetadataForPrompt(projectMetaWork) || undefined;

  const inFlight = new Map<string, { ticket: typeof readyTickets[0]; startTime: number }>();
  const results: Array<{ ticketId: string; title: string; result: RunTicketResult }> = [];

  let ticketIndex = 0;

  async function runNextTicket(): Promise<void> {
    if (ticketIndex >= readyTickets.length) {
      return;
    }

    const ticket = readyTickets[ticketIndex++];

    inFlight.set(ticket.id, { ticket, startTime: Date.now() });
    updateProgressDisplay();

    let run: Awaited<ReturnType<typeof runs.create>> | undefined;

    try {
      await tickets.updateStatus(adapter, ticket.id, 'in_progress');

      run = await runs.create(adapter, {
        projectId: ticket.projectId,
        type: 'worker',
        ticketId: ticket.id,
        metadata: {
          parallel: true,
          createPr: options.pr ?? false,
        },
      });

      // Build learnings context for this ticket
      const relevantLearnings = autoConf.learningsEnabled
        ? selectRelevant(allLearningsWork, {
            paths: ticket.allowedPaths,
            commands: ticket.verificationCommands,
          })
        : [];
      const learningsBlock = formatLearningsForPrompt(relevantLearnings, autoConf.learningsBudget);
      if (relevantLearnings.length > 0) {
        recordAccess(repoRoot!, relevantLearnings.map(l => l.id));
      }

      const result = await soloRunTicket({
        ticket,
        repoRoot: repoRoot!,
        config,
        adapter,
        runId: run.id,
        skipQa: false,
        createPr: options.pr ?? false,
        timeoutMs: 600000,
        verbose: options.verbose ?? false,
        onProgress: (msg) => {
          if (options.verbose) {
            console.log(chalk.gray(`  [${ticket.id}] ${msg}`));
          }
        },
        guidelinesContext: guidelines ? formatGuidelinesForPrompt(guidelines) : undefined,
        learningsContext: learningsBlock || undefined,
        metadataContext: metadataBlockWork,
      });

      if (result.success) {
        await runs.markSuccess(adapter, run.id);
        await tickets.updateStatus(adapter, ticket.id, result.prUrl ? 'in_review' : 'done');
        // Confirm learnings that contributed to this success
        if (autoConf.learningsEnabled && relevantLearnings.length > 0) {
          for (const l of relevantLearnings) {
            confirmLearning(repoRoot!, l.id);
          }
        }
        results.push({ ticketId: ticket.id, title: ticket.title, result });
      } else if (result.scopeExpanded) {
        await runs.markFailure(adapter, run.id, `Scope expanded: retry ${result.scopeExpanded.newRetryCount}`);

        const updatedTicket = await tickets.getById(adapter, ticket.id);
        if (updatedTicket && updatedTicket.status === 'ready') {
          readyTickets.push(updatedTicket);
          console.log(chalk.yellow(`↻ Scope expanded for ${ticket.id}, re-queued (retry ${result.scopeExpanded.newRetryCount})`));
        }

        // Record scope violation learning
        if (autoConf.learningsEnabled) {
          addLearning(repoRoot!, {
            text: `${ticket.title} failed: scope expanded`.slice(0, 200),
            category: 'warning',
            source: { type: 'scope_violation', detail: result.error },
            tags: extractTags(ticket.allowedPaths, ticket.verificationCommands),
          });
        }

        results.push({ ticketId: ticket.id, title: ticket.title, result });
      } else {
        await runs.markFailure(adapter, run.id, result.error ?? 'Unknown error');
        await tickets.updateStatus(adapter, ticket.id, 'blocked');

        // Record failure learning
        if (autoConf.learningsEnabled && result.failureReason) {
          const reason = result.error ?? result.failureReason;
          const sourceType = result.failureReason === 'qa_failed' ? 'qa_failure' as const
            : result.failureReason === 'scope_violation' ? 'scope_violation' as const
            : 'ticket_failure' as const;
          addLearning(repoRoot!, {
            text: `${ticket.title} failed: ${reason}`.slice(0, 200),
            category: sourceType === 'qa_failure' ? 'gotcha' : 'warning',
            source: { type: sourceType, detail: reason },
            tags: extractTags(ticket.allowedPaths, ticket.verificationCommands),
          });
        }

        results.push({ ticketId: ticket.id, title: ticket.title, result });
      }
    } catch (error) {
      if (run) {
        await runs.markFailure(adapter, run.id, error instanceof Error ? error.message : String(error));
      }
      await tickets.updateStatus(adapter, ticket.id, 'blocked');

      results.push({
        ticketId: ticket.id,
        title: ticket.title,
        result: {
          success: false,
          durationMs: Date.now() - (inFlight.get(ticket.id)?.startTime ?? Date.now()),
          error: error instanceof Error ? error.message : String(error),
          failureReason: 'agent_error',
        },
      });
    } finally {
      inFlight.delete(ticket.id);
      updateProgressDisplay();
    }
  }

  function updateProgressDisplay(): void {
    if (inFlight.size > 0) {
      const ticketIds = Array.from(inFlight.keys()).join(', ');
      process.stdout.write(`\r${chalk.cyan('⏳ In-flight:')} ${ticketIds}${' '.repeat(20)}`);
    } else {
      process.stdout.write('\r' + ' '.repeat(80) + '\r');
    }
  }

  console.log(chalk.bold('Processing tickets...'));
  console.log();

  while (ticketIndex < readyTickets.length || inFlight.size > 0) {
    const startPromises: Promise<void>[] = [];
    while (inFlight.size < parallelCount && ticketIndex < readyTickets.length) {
      startPromises.push(runNextTicket());
    }

    if (startPromises.length > 0) {
      await Promise.race(startPromises);
    } else if (inFlight.size > 0) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  while (inFlight.size > 0) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  await adapter.close();

  console.log();
  console.log(chalk.bold('Results:'));
  console.log();

  const successful = results.filter(r => r.result.success);
  const failed = results.filter(r => !r.result.success);

  for (const { ticketId, title, result } of successful) {
    console.log(chalk.green(`✓ ${ticketId}: ${title}`));
    if (result.prUrl) {
      console.log(chalk.gray(`    PR: ${result.prUrl}`));
    }
  }

  for (const { ticketId, title, result } of failed) {
    console.log(chalk.red(`✗ ${ticketId}: ${title}`));
    if (result.error) {
      console.log(chalk.gray(`    Error: ${result.error}`));
    }
  }

  console.log();
  console.log(chalk.bold('Summary:'));
  console.log(chalk.green(`  Successful: ${successful.length}`));
  console.log(chalk.red(`  Failed: ${failed.length}`));

  process.exit(failed.length > 0 ? 1 : 0);
}

/**
 * Run auto mode - the full "just run it" experience
 * Scout → auto-approve safe changes → run → create draft PRs
 */
export async function runAutoMode(options: {
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
  parallel?: string;
  formula?: string;
  deep?: boolean;
  eco?: boolean;
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
}): Promise<void> {
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

  const maxCycles = options.cycles ? parseInt(options.cycles, 10) : 1;
  const isContinuous = options.continuous || options.hours !== undefined || options.minutes !== undefined || maxCycles > 1;
  const totalMinutes = (options.hours ? parseFloat(options.hours) * 60 : 0)
    + (options.minutes ? parseFloat(options.minutes) : 0) || undefined;
  const endTime = totalMinutes ? Date.now() + (totalMinutes * 60 * 1000) : undefined;

  const defaultMaxPrs = isContinuous ? 20 : 3;
  const maxPrs = parseInt(options.maxPrs || String(activeFormula?.maxPrs ?? defaultMaxPrs), 10);
  const minConfidence = parseInt(options.minConfidence || String(activeFormula?.minConfidence ?? 70), 10);
  const useDraft = options.draft !== false;

  // Milestone mode state (declared early so header can reference)
  const batchSize = options.batchSize ? parseInt(options.batchSize, 10) : undefined;
  const milestoneMode = batchSize !== undefined && batchSize > 0;

  const defaultScopes = ['src', 'lib', 'packages', 'app', 'tests', 'scripts'];
  const userScope = options.scope || activeFormula?.scope;
  let scopeIndex = 0;

  const git = createGitService();
  const repoRoot = await git.findRepoRoot(process.cwd());

  if (!repoRoot) {
    console.error(chalk.red('✗ Not a git repository'));
    process.exit(1);
  }

  const config = loadConfig(repoRoot);

  const DEEP_SCAN_INTERVAL = 5;
  let deepFormula: import('./formulas.js').Formula | null = null;
  let docsAuditFormula: import('./formulas.js').Formula | null = null;
  if (!activeFormula) {
    const { loadFormula: loadF } = await import('./formulas.js');
    if (isContinuous) {
      deepFormula = loadF('deep');
    }
    // Docs-audit loaded here; enabled/interval resolved after config is loaded
    if (options.docsAudit !== false) {
      docsAuditFormula = loadF('docs-audit');
    }
  }

  const getCycleFormula = (cycle: number) => {
    if (activeFormula) return activeFormula;
    if (deepFormula && isContinuous && cycle % DEEP_SCAN_INTERVAL === 0) return deepFormula;
    // Auto docs-audit every N cycles (persisted across sessions)
    if (docsAuditFormula && repoRoot) {
      const interval = options.docsAuditInterval
        ? parseInt(options.docsAuditInterval, 10)
        : config?.auto?.docsAuditInterval ?? 3;
      // Config can also disable docs-audit
      const enabled = config?.auto?.docsAudit !== false;
      if (enabled && isDocsAuditDue(repoRoot, interval)) return docsAuditFormula;
    }
    return null;
  };
  const getCycleCategories = (formula: typeof activeFormula) => {
    const allow = formula?.categories
      ? formula.categories as string[]
      : options.aggressive
        ? ['refactor', 'test', 'docs', 'types', 'perf', 'security']
        : ['refactor', 'test', 'docs', 'types', 'perf'];
    const block = formula?.categories
      ? []
      : options.aggressive
        ? ['deps', 'migration', 'config']
        : ['deps', 'migration', 'config', 'security'];
    return { allow, block };
  };

  let shutdownRequested = false;
  let currentlyProcessing = false;

  const shutdownHandler = () => {
    if (shutdownRequested) {
      console.log(chalk.red('\nForce quit. Exiting immediately.'));
      process.exit(1);
    }
    shutdownRequested = true;
    if (currentlyProcessing) {
      console.log(chalk.yellow('\nShutdown requested. Finishing current ticket, then finalizing milestone...'));
    } else {
      console.log(chalk.yellow('\nShutdown requested. Exiting...'));
      process.exit(0);
    }
  };

  process.on('SIGINT', shutdownHandler);
  process.on('SIGTERM', shutdownHandler);

  // Print header — need initial categories for display
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
  console.log(chalk.gray(`  Max PRs: ${maxPrs}`));
  console.log(chalk.gray(`  Min confidence: ${minConfidence}%`));
  console.log(chalk.gray(`  Categories: ${initialCategories.allow.join(', ')}`));
  console.log(chalk.gray(`  Draft PRs: ${useDraft ? 'yes' : 'no'}`));
  if (milestoneMode) {
    console.log(chalk.gray(`  Milestone mode: batch size ${batchSize}`));
  }
  console.log();

  // Start stdin listener for live hints in continuous/hours mode
  let stopStdinListener: (() => void) | undefined;
  if (isContinuous) {
    stopStdinListener = startStdinListener(repoRoot);
  }

  const statusResult = spawnSync('git', ['status', '--porcelain'], { cwd: repoRoot });
  const statusLines = statusResult.stdout?.toString().trim().split('\n').filter(Boolean) || [];
  const modifiedFiles = statusLines.filter(line => !line.startsWith('??'));
  if (modifiedFiles.length > 0 && !options.dryRun) {
    // Auto-commit .gitignore if it's the only change (from blockspool init)
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

  // Validate remote matches what was recorded at init
  const preflight = await runPreflightChecks(repoRoot, { needsPr: true });
  if (!preflight.ok) {
    console.error(chalk.red(`✗ ${preflight.error}`));
    process.exit(1);
  }
  for (const warning of preflight.warnings) {
    console.log(chalk.yellow(`⚠ ${warning}`));
  }

  const adapter = await getAdapter(repoRoot);

  // Determine guidelines backend — use whichever non-claude backend is active, or 'claude'
  const guidelinesBackend: GuidelinesBackend =
    [options.scoutBackend, options.executeBackend].find(b => b && b !== 'claude') ?? 'claude';
  const guidelinesOpts = {
    backend: guidelinesBackend,
    autoCreate: config?.auto?.autoCreateGuidelines !== false,
    customPath: config?.auto?.guidelinesPath ?? undefined,
  };

  // Load project guidelines (CLAUDE.md for Claude, AGENTS.md for Codex)
  let guidelines: ProjectGuidelines | null = loadGuidelines(repoRoot, guidelinesOpts);
  const guidelinesRefreshInterval = config?.auto?.guidelinesRefreshCycles ?? 10;
  if (guidelines) {
    console.log(chalk.gray(`  Guidelines loaded: ${guidelines.source}`));
  }

  // Load cross-run learnings
  const autoConf = { ...DEFAULT_AUTO_CONFIG, ...config?.auto };
  let allLearnings: Learning[] = autoConf.learningsEnabled
    ? loadLearnings(repoRoot, autoConf.learningsDecayRate) : [];
  if (allLearnings.length > 0) {
    console.log(chalk.gray(`  Learnings loaded: ${allLearnings.length}`));
  }

  // Resolve per-backend settings: CLI flag > auto.<backend>.<setting> > auto.<setting> > hardcoded default
  const activeBackendName = options.scoutBackend ?? 'claude';
  const backendConf = activeBackendName === 'codex' ? autoConf.codex : autoConf.claude;

  // Use provider defaults as final fallback
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

  // Load dedup memory (with decay)
  let dedupMemory: DedupEntry[] = loadDedupMemory(repoRoot);
  if (dedupMemory.length > 0) {
    console.log(chalk.gray(`  Dedup memory loaded: ${dedupMemory.length} titles`));
  }

  // Build codebase index for structural awareness
  const excludeDirs = ['node_modules', 'dist', 'build', '.git', '.blockspool', 'coverage', '__pycache__'];
  let codebaseIndex: CodebaseIndex | null = null;
  try {
    codebaseIndex = buildCodebaseIndex(repoRoot, excludeDirs);
    console.log(chalk.gray(`  Codebase index: ${codebaseIndex.modules.length} modules, ${codebaseIndex.untested_modules.length} untested, ${codebaseIndex.large_files.length} hotspots`));
  } catch {
    // Non-fatal — index failure shouldn't block the session
  }

  // Detect project metadata (test runner, framework, linter, etc.)
  const projectMeta = detectProjectMetadata(repoRoot);
  const metadataBlock = formatMetadataForPrompt(projectMeta);
  if (projectMeta.languages.length > 0) {
    console.log(chalk.gray(`  Project: ${projectMeta.languages.join(', ')}${projectMeta.framework ? ` / ${projectMeta.framework}` : ''}${projectMeta.test_runner ? ` / ${projectMeta.test_runner.name}` : ''}`));
  }

  // Auto-prune stale state on session start (includes DB ticket cleanup)
  try {
    const { pruneAllAsync: pruneAllAsyncFn, getRetentionConfig } = await import('./retention.js');
    const retentionConfig = getRetentionConfig(config);
    const pruneReport = await pruneAllAsyncFn(repoRoot, retentionConfig, adapter);
    if (pruneReport.totalPruned > 0) {
      console.log(chalk.gray(`  Pruned ${pruneReport.totalPruned} stale item(s)`));
    }
  } catch {
    // Non-fatal — prune failure shouldn't block the session
  }

  let totalPrsCreated = 0;
  let totalFailed = 0;
  let cycleCount = 0;
  const allPrUrls: string[] = [];
  const startTime = Date.now();

  // Milestone mode mutable state
  let milestoneBranch: string | undefined;
  let milestoneWorktreePath: string | undefined;
  let milestoneTicketCount = 0;
  let milestoneNumber = 0;
  let totalMilestonePrs = 0;
  const milestoneTicketSummaries: string[] = [];

  const getNextScope = (): string => {
    if (userScope) return userScope;
    if (!isContinuous) return '**';
    const scope = defaultScopes[scopeIndex % defaultScopes.length];
    scopeIndex++;
    return scope;
  };

  const shouldContinue = (): boolean => {
    if (shutdownRequested) return false;
    if (milestoneMode) {
      if (totalMilestonePrs >= maxPrs) return false;
    } else {
      if (totalPrsCreated >= maxPrs) return false;
    }
    if (endTime && Date.now() >= endTime) return false;
    if (cycleCount >= maxCycles && !options.continuous && !options.hours && !options.minutes) return false;
    return true;
  };

  const formatElapsed = (ms: number): string => {
    const hours = Math.floor(ms / 3600000);
    const minutes = Math.floor((ms % 3600000) / 60000);
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
  };

  // Track whether --parallel was explicitly provided
  const parallelExplicit = options.parallel !== undefined && options.parallel !== '3';

  try {
    const project = await projects.ensureForRepo(adapter, {
      name: path.basename(repoRoot),
      rootPath: repoRoot,
    });

    const deps = createScoutDeps(adapter, { verbose: options.verbose });

    // Instantiate backends based on --scout-backend / --execute-backend
    const { getProvider } = await import('./providers/index.js');
    let scoutBackend: ScoutBackend | undefined;
    let executionBackend: ExecutionBackend | undefined;

    const scoutBackendName = options.scoutBackend ?? 'claude';
    const execBackendName = options.executeBackend ?? 'claude';

    // Resolve model for each backend
    const modelForBackend = (name: string): string | undefined => {
      if (name === 'codex') return options.codexModel;
      if (name === 'kimi') return options.kimiModel;
      if (name === 'openai-local') return options.localModel;
      return undefined; // claude uses default
    };

    // Resolve API key for each backend
    const apiKeyForBackend = (name: string): string | undefined => {
      const provider = getProvider(name);
      return provider.apiKeyEnvVar ? process.env[provider.apiKeyEnvVar] : undefined;
    };

    // Scout backend — codexMcp is a special variant of codex
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

    // Execution backend
    if (execBackendName !== 'claude') {
      const execProvider = getProvider(execBackendName);
      executionBackend = await execProvider.createExecutionBackend({
        apiKey: apiKeyForBackend(execBackendName),
        model: modelForBackend(execBackendName),
        unsafeBypassSandbox: options.codexUnsafeFullAccess,
        baseUrl: execBackendName === 'openai-local' ? options.localUrl : undefined,
        maxIterations: options.localMaxIterations ? parseInt(options.localMaxIterations, 10) : undefined,
      });
    }

    // Detect base branch for milestone mode
    let detectedBaseBranch = 'master';
    try {
      const remoteHead = (await (await import('./solo-git.js')).gitExec(
        'git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null || echo "refs/remotes/origin/master"',
        { cwd: repoRoot }
      )).trim();
      detectedBaseBranch = remoteHead.replace('refs/remotes/origin/', '');
    } catch {
      // Fall back to master
    }

    // Initialize milestone branch if in milestone mode
    if (milestoneMode && !options.dryRun) {
      const ms = await createMilestoneBranch(repoRoot, detectedBaseBranch);
      milestoneBranch = ms.milestoneBranch;
      milestoneWorktreePath = ms.milestoneWorktreePath;
      milestoneNumber = 1;
      console.log(chalk.cyan(`Milestone branch: ${milestoneBranch}`));
      console.log();
    }

    // Helper to finalize current milestone (push + PR)
    const finalizeMilestone = async (): Promise<void> => {
      if (!milestoneMode || !milestoneBranch || !milestoneWorktreePath) return;
      if (milestoneTicketCount === 0) return;

      console.log(chalk.cyan(`\nFinalizing milestone #${milestoneNumber} (${milestoneTicketCount} tickets)...`));
      const prUrl = await pushAndPrMilestone(
        repoRoot,
        milestoneBranch,
        milestoneWorktreePath,
        milestoneNumber,
        milestoneTicketCount,
        [...milestoneTicketSummaries]
      );
      if (prUrl) {
        allPrUrls.push(prUrl);
        console.log(chalk.green(`  ✓ Milestone PR: ${prUrl}`));
      } else {
        console.log(chalk.yellow(`  ⚠ Milestone pushed but PR creation failed`));
      }
      totalMilestonePrs++;
    };

    // Helper to start a new milestone branch
    const startNewMilestone = async (): Promise<void> => {
      if (!milestoneMode) return;
      // Clean old milestone worktree
      await cleanupMilestone(repoRoot);
      milestoneTicketCount = 0;
      milestoneTicketSummaries.length = 0;
      const ms = await createMilestoneBranch(repoRoot, detectedBaseBranch);
      milestoneBranch = ms.milestoneBranch;
      milestoneWorktreePath = ms.milestoneWorktreePath;
      milestoneNumber++;
      console.log(chalk.cyan(`New milestone branch: ${milestoneBranch}`));
    };

    // Periodic pull settings
    const pullInterval = config?.auto?.pullEveryNCycles ?? 5;
    const pullPolicy: 'halt' | 'warn' = config?.auto?.pullPolicy ?? 'halt';
    let cyclesSinceLastPull = 0;

    // Scout retry/escalation state
    const MAX_SCOUT_RETRIES = 2;
    let scoutRetries = 0;
    let scoutedDirs: string[] = [];

    do {
      cycleCount++;
      const scope = getNextScope();

      // Periodic pull to stay current with team changes
      if (pullInterval > 0 && isContinuous) {
        cyclesSinceLastPull++;
        if (cyclesSinceLastPull >= pullInterval) {
          cyclesSinceLastPull = 0;
          try {
            // First fetch so we can detect divergence before attempting merge
            const fetchResult = spawnSync(
              'git', ['fetch', 'origin', detectedBaseBranch],
              { cwd: repoRoot, encoding: 'utf-8', timeout: 30000 },
            );

            if (fetchResult.status === 0) {
              // Try fast-forward merge — fails if diverged
              const mergeResult = spawnSync(
                'git', ['merge', '--ff-only', `origin/${detectedBaseBranch}`],
                { cwd: repoRoot, encoding: 'utf-8' },
              );

              if (mergeResult.status === 0) {
                const summary = mergeResult.stdout?.trim();
                if (summary && !summary.includes('Already up to date')) {
                  console.log(chalk.cyan(`  ⬇ Pulled latest from origin/${detectedBaseBranch}`));
                }
              } else {
                // Divergence detected — ff-only failed
                const errMsg = mergeResult.stderr?.trim() || 'fast-forward not possible';

                if (pullPolicy === 'halt') {
                  // Finalize any in-progress milestone before stopping
                  if (milestoneMode && milestoneTicketCount > 0) {
                    console.log(chalk.yellow(`\n⚠ Base branch diverged — finalizing current milestone before stopping...`));
                    await finalizeMilestone();
                  }

                  console.log();
                  console.log(chalk.red(`✗ HCF — Base branch has diverged from origin/${detectedBaseBranch}`));
                  console.log(chalk.gray(`  ${errMsg}`));
                  console.log();
                  console.log(chalk.bold('Resolution:'));
                  console.log(`  1. Resolve the divergence (rebase, merge, or reset)`);
                  console.log(`  2. Re-run: blockspool --hours ... --continuous`);
                  console.log();
                  console.log(chalk.gray(`  To keep going despite divergence, set pullPolicy: "warn" in config.`));

                  if (milestoneMode) await cleanupMilestone(repoRoot);
                  stopStdinListener?.();
                  await adapter.close();
                  process.exit(1);
                } else {
                  // warn policy — log and continue on stale base
                  console.log(chalk.yellow(`  ⚠ Base branch diverged from origin/${detectedBaseBranch} — continuing on stale base`));
                  console.log(chalk.gray(`    ${errMsg}`));
                  console.log(chalk.gray(`    Subsequent work may produce merge conflicts`));
                }
              }
            } else if (options.verbose) {
              console.log(chalk.yellow(`  ⚠ Fetch failed (network?): ${fetchResult.stderr?.trim()}`));
            }
          } catch {
            // Network unavailable — non-fatal, keep going
          }
        }
      }

      // Periodic guidelines refresh
      if (guidelinesRefreshInterval > 0 && cycleCount > 1 && cycleCount % guidelinesRefreshInterval === 0) {
        guidelines = loadGuidelines(repoRoot, guidelinesOpts);
        if (guidelines && options.verbose) {
          console.log(chalk.gray(`  Refreshed project guidelines (${guidelines.source})`));
        }
      }

      if (isContinuous && cycleCount > 1) {
        console.log();
        console.log(chalk.blue(`━━━ Cycle ${cycleCount} ━━━`));
        console.log(chalk.gray(`  Elapsed: ${formatElapsed(Date.now() - startTime)}`));
        if (milestoneMode) {
          console.log(chalk.gray(`  Milestone PRs: ${totalMilestonePrs}/${maxPrs} (${totalPrsCreated} tickets merged)`));
        } else {
          console.log(chalk.gray(`  PRs created: ${totalPrsCreated}/${maxPrs}`));
        }
        if (endTime) {
          const remaining = Math.max(0, endTime - Date.now());
          console.log(chalk.gray(`  Time remaining: ${formatElapsed(remaining)}`));
        }
        console.log();
      }

      const dedupContext = await getDeduplicationContext(adapter, project.id, repoRoot);

      const cycleFormula = getCycleFormula(cycleCount);
      const { allow: allowCategories, block: blockCategories } = getCycleCategories(cycleFormula);
      const isDeepCycle = cycleFormula?.name === 'deep' && cycleFormula !== activeFormula;
      const isDocsAuditCycle = cycleFormula?.name === 'docs-audit' && cycleFormula !== activeFormula;

      const cycleSuffix = isDeepCycle ? ' 🔬 deep' : isDocsAuditCycle ? ' 📄 docs-audit' : '';
      const cycleLabel = isContinuous ? `[Cycle ${cycleCount}]${cycleSuffix} ` : 'Step 1: ';
      const spinner = createSpinner(`Scouting ${scope}...`, 'stack');
      console.log(chalk.bold(`${cycleLabel}Scouting ${scope}...`));

      // Consume any pending user hints
      const hintBlock = consumePendingHints(repoRoot);
      if (hintBlock) {
        const hintCount = hintBlock.split('\n').filter(l => l.startsWith('- ')).length;
        console.log(chalk.yellow(`[Hints] Applying ${hintCount} user hint(s) to this scout cycle`));
      }

      let lastProgress = '';
      const batchProgressRef: { current: BatchProgressDisplay | null } = { current: null };
      const scoutPath = (milestoneMode && milestoneWorktreePath) ? milestoneWorktreePath : repoRoot;
      const guidelinesPrefix = guidelines ? formatGuidelinesForPrompt(guidelines) + '\n\n' : '';
      const learningsPrefix = autoConf.learningsEnabled
        ? formatLearningsForPrompt(selectRelevant(allLearnings, { paths: [scope] }), autoConf.learningsBudget)
        : '';
      const learningsSuffix = learningsPrefix ? learningsPrefix + '\n\n' : '';
      const indexPrefix = codebaseIndex ? formatIndexForPrompt(codebaseIndex, cycleCount) + '\n\n' : '';
      const metadataPrefix = metadataBlock ? metadataBlock + '\n\n' : '';
      const escalationPrefix = scoutRetries > 0
        ? buildScoutEscalation(scoutRetries, scoutedDirs, codebaseIndex) + '\n\n'
        : '';
      const dedupPrefix = formatDedupForPrompt(dedupMemory);
      const dedupBlock = dedupPrefix ? dedupPrefix + '\n\n' : '';
      const basePrompt = guidelinesPrefix + metadataPrefix + indexPrefix + dedupBlock + escalationPrefix + learningsSuffix + (cycleFormula?.prompt || '');
      const effectivePrompt = hintBlock ? (basePrompt + hintBlock) : (basePrompt || undefined);
      let scoutResult;
      try {
        scoutResult = await scoutRepo(deps, {
          path: scoutPath,
          scope,
          maxProposals: 20,
          minConfidence: Math.max((cycleFormula?.minConfidence ?? minConfidence) - 20, 30),
          model: options.scoutBackend === 'codex' ? undefined : (options.eco ? 'sonnet' : (cycleFormula?.model ?? 'opus')),
          customPrompt: effectivePrompt,
          autoApprove: false,
          backend: scoutBackend,
          protectedFiles: ['.blockspool/**', ...(options.includeClaudeMd ? [] : ['CLAUDE.md', '.claude/**'])],
          batchTokenBudget,
          timeoutMs: scoutTimeoutMs,
          maxFiles: maxScoutFiles,
          scoutConcurrency,
          onProgress: (progress: ScoutProgress) => {
            // Switch to multi-line display when batch statuses arrive
            if (progress.batchStatuses && progress.totalBatches && progress.totalBatches > 1) {
              if (!batchProgressRef.current) {
                spinner.stop(); // clear single-line spinner
                batchProgressRef.current = createBatchProgress(progress.totalBatches);
              }
              batchProgressRef.current.update(progress.batchStatuses, progress.proposalsFound ?? 0);
            } else {
              const formatted = formatProgress(progress);
              if (formatted !== lastProgress) {
                spinner.update(formatted);
                lastProgress = formatted;
              }
            }
          },
        });
      } catch (scoutErr) {
        batchProgressRef.current?.stop();
        spinner.fail('Scout failed');
        throw scoutErr;
      }

      // Clean up batch progress display
      if (batchProgressRef.current) {
        const count = scoutResult.proposals.length;
        batchProgressRef.current.stop(chalk.green(`Scouting complete — ${count} proposal${count !== 1 ? 's' : ''} found`));
      }

      const proposals = scoutResult.proposals;

      if (proposals.length === 0) {
        if (scoutResult.errors.length > 0) {
          spinner.fail('Scout encountered errors');
          for (const err of scoutResult.errors) {
            console.log(chalk.yellow(`  ⚠ ${err}`));
          }
        } else {
          spinner.stop();
        }
        scoutedDirs.push(scope);
        if (scoutRetries < MAX_SCOUT_RETRIES) {
          scoutRetries++;
          console.log(chalk.gray(`  No improvements found in ${scope} (attempt ${scoutRetries}/${MAX_SCOUT_RETRIES + 1}). Retrying with fresh approach...`));
          await sleep(1000);
          continue;
        }
        // Exhausted retries
        if (isContinuous) {
          scoutRetries = 0;
          scoutedDirs = [];
          await sleep(2000);
          continue;
        } else {
          console.log(chalk.green('✓ Your code looks great!'));
          break;
        }
      }

      spinner.succeed(`Found ${proposals.length} potential improvements`);

      // Adversarial proposal review — second-pass critique
      if (autoConf.adversarialReview && !options.eco && proposals.length > 0) {
        try {
          const reviewPrompt = buildProposalReviewPrompt(proposals);
          const reviewBackend = executionBackend ?? {
            name: 'claude-review',
            run: (opts: Parameters<ExecutionBackend['run']>[0]) => runClaude(opts),
          };
          const reviewResult = await reviewBackend.run({
            worktreePath: (milestoneMode && milestoneWorktreePath) ? milestoneWorktreePath : repoRoot,
            prompt: reviewPrompt,
            timeoutMs: 120000,
            verbose: false,
            onProgress: () => {},
          });

          if (reviewResult.success) {
            const reviewed = parseReviewedProposals(reviewResult.stdout);
            if (reviewed) {
              const before = proposals.map(p => p.confidence);
              const revised = applyReviewToProposals(proposals, reviewed);
              // Replace proposals array contents
              proposals.length = 0;
              proposals.push(...revised);

              const adjustedCount = reviewed.filter((r, i) => {
                const orig = before[i];
                return orig !== undefined && r.confidence !== orig;
              }).length;
              const rejectedCount = reviewed.filter(r => r.confidence === 0).length;
              if (adjustedCount > 0 || rejectedCount > 0) {
                console.log(chalk.gray(`  Review: ${adjustedCount} adjusted, ${rejectedCount} rejected`));
              }
            }
          }
        } catch {
          // Non-fatal — review failure falls through to original proposals
          if (options.verbose) {
            console.log(chalk.yellow(`  ⚠ Adversarial review failed, using original scores`));
          }
        }
      }

      // Re-inject deferred proposals that now match this cycle's scope
      const deferred = popDeferredForScope(repoRoot, scope);
      if (deferred.length > 0) {
        console.log(chalk.cyan(`  ♻ ${deferred.length} deferred proposal(s) now in scope`));
        for (const dp of deferred) {
          proposals.push({
            id: `deferred-${Date.now()}`,
            category: dp.category as import('@blockspool/core/scout').ProposalCategory,
            title: dp.title,
            description: dp.description,
            files: dp.files,
            allowed_paths: dp.allowed_paths,
            confidence: dp.confidence,
            impact_score: dp.impact_score,
            acceptance_criteria: [],
            verification_commands: ['npm run build'],
            rationale: `(deferred from scope ${dp.original_scope})`,
            estimated_complexity: 'simple' as const,
          });
        }
      }

      const categoryFiltered = proposals.filter((p) => {
        const category = (p.category || 'refactor').toLowerCase();
        const confidence = p.confidence || 50;

        if (blockCategories.some(blocked => category.includes(blocked))) return false;
        if (!allowCategories.some(allowed => category.includes(allowed))) return false;
        if (confidence < minConfidence) return false;
        return true;
      });

      // Scope filter — defer proposals with files outside current scope
      const normalizedScope = scope.replace(/\*\*$/, '').replace(/\*$/, '').replace(/\/$/, '');
      const scopeFiltered = normalizedScope
        ? categoryFiltered.filter(p => {
            const files = (p.files?.length ? p.files : p.allowed_paths) || [];
            const allInScope = files.length === 0 || files.every(f =>
              f.startsWith(normalizedScope) || f.startsWith(normalizedScope + '/')
            );
            if (!allInScope) {
              deferProposal(repoRoot, {
                category: p.category,
                title: p.title,
                description: p.description,
                files: p.files || [],
                allowed_paths: p.allowed_paths || [],
                confidence: p.confidence || 50,
                impact_score: p.impact_score ?? 5,
                original_scope: scope,
                deferredAt: Date.now(),
              });
              if (options.verbose) {
                console.log(chalk.gray(`  Deferred (out of scope): ${p.title}`));
              }
              return false;
            }
            return true;
          })
        : categoryFiltered;

      const approvedProposals: typeof scopeFiltered = [];
      let duplicateCount = 0;
      const rejectedDupTitles: string[] = [];
      for (const p of scopeFiltered) {
        const dupCheck = await isDuplicateProposal(
          p,
          dedupContext.existingTitles,
          dedupContext.openPrBranches
        );
        if (dupCheck.isDuplicate) {
          duplicateCount++;
          rejectedDupTitles.push(p.title);
          if (options.verbose) {
            console.log(chalk.gray(`  Skipping duplicate: ${p.title}`));
            console.log(chalk.gray(`    Reason: ${dupCheck.reason}`));
          }
        } else {
          approvedProposals.push(p);
        }
      }

      // Bump dedup memory for rejected duplicates (re-confirmation keeps them prominent)
      if (rejectedDupTitles.length > 0) {
        recordDedupEntries(repoRoot, rejectedDupTitles.map(t => ({ title: t, completed: false })));
        dedupMemory = loadDedupMemory(repoRoot);
      }

      // Balance test vs non-test proposals
      const maxTestRatio = autoConf.maxTestRatio ?? 0.4;
      const balanced = balanceProposals(approvedProposals, maxTestRatio);
      approvedProposals.length = 0;
      approvedProposals.push(...balanced);

      if (approvedProposals.length === 0) {
        const reason = duplicateCount > 0
          ? `No new proposals (${duplicateCount} duplicates filtered)`
          : 'No proposals passed trust filter';
        console.log(chalk.gray(`  ${reason}`));
        scoutedDirs.push(scope);
        if (scoutRetries < MAX_SCOUT_RETRIES) {
          scoutRetries++;
          console.log(chalk.gray(`  Retrying with fresh approach (attempt ${scoutRetries}/${MAX_SCOUT_RETRIES + 1})...`));
          await sleep(1000);
          continue;
        }
        if (isContinuous) {
          scoutRetries = 0;
          scoutedDirs = [];
          await sleep(2000);
          continue;
        } else {
          break;
        }
      }

      const prsRemaining = milestoneMode
        ? (batchSize! - milestoneTicketCount + (maxPrs - totalMilestonePrs - 1) * batchSize!)
        : (maxPrs - totalPrsCreated);
      const defaultBatch = milestoneMode ? 10 : (isContinuous ? 5 : 3);
      const toProcess = approvedProposals.slice(0, Math.min(prsRemaining, defaultBatch));

      const statsMsg = duplicateCount > 0
        ? `Auto-approved: ${approvedProposals.length} (${duplicateCount} duplicates skipped), processing: ${toProcess.length}`
        : `Auto-approved: ${approvedProposals.length}, processing: ${toProcess.length}`;
      console.log(chalk.gray(`  ${statsMsg}`));
      console.log();

      // Reset retry state on success
      scoutRetries = 0;
      scoutedDirs = [];

      if (!isContinuous || cycleCount === 1) {
        console.log(chalk.bold('Will process:'));
        for (const p of toProcess) {
          const confidenceStr = p.confidence ? `${p.confidence}%` : '?';
          const complexity = p.estimated_complexity || 'simple';
          console.log(chalk.cyan(`  • ${p.title}`));
          console.log(chalk.gray(`    ${p.category || 'refactor'} | ${complexity} | ${confidenceStr}`));
        }
        console.log();
      }

      if (options.dryRun) {
        console.log(chalk.yellow('Dry run - no changes made'));
        break;
      }

      if (cycleCount === 1 && !options.yes) {
        const readline = await import('readline');
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const confirmMsg = isContinuous
          ? `Start continuous auto? [Y/n] `
          : `Proceed with ${toProcess.length} improvement(s)? [Y/n] `;
        const answer = await new Promise<string>((resolve) => {
          rl.question(chalk.bold(confirmMsg), resolve);
        });
        rl.close();

        if (answer.toLowerCase() === 'n' || answer.toLowerCase() === 'no') {
          console.log(chalk.gray('Cancelled.'));
          await adapter.close();
          process.exit(0);
        }
        console.log();
      }

      // Step 3: Run tickets (parallel or sequential)
      currentlyProcessing = true;

      // Adaptive parallelism: if --parallel was not explicitly set, use adaptive count
      let parallelCount: number;
      if (parallelExplicit) {
        parallelCount = Math.max(1, parseInt(options.parallel!, 10));
      } else {
        parallelCount = getAdaptiveParallelCount(toProcess);
        const heavy = toProcess.filter(p => p.estimated_complexity === 'moderate' || p.estimated_complexity === 'complex').length;
        const light = toProcess.length - heavy;
        console.log(chalk.gray(`  Parallel: ${parallelCount} (adaptive — ${light} simple, ${heavy} complex)`));
      }

      // In milestone mode, reduce parallelism when near batch limit to avoid merge conflicts
      if (milestoneMode && batchSize) {
        const remaining = batchSize - milestoneTicketCount;
        if (remaining <= 3 && parallelCount > 2) {
          parallelCount = 2;
          console.log(chalk.gray(`  Parallel reduced to ${parallelCount} (milestone ${milestoneTicketCount}/${batchSize}, near full)`));
        }
      }

      const processOneProposal = async (proposal: typeof toProcess[0], slotLabel: string): Promise<{ success: boolean; prUrl?: string }> => {
        console.log(chalk.cyan(`[${slotLabel}] ${proposal.title}`));
        const ticketSpinner = createSpinner(`Setting up...`, 'spool');

        const ticket = await tickets.create(adapter, {
          projectId: project.id,
          title: proposal.title,
          description: proposal.description || proposal.title,
          priority: 2,
          allowedPaths: proposal.files,
          forbiddenPaths: ['node_modules', '.git', '.blockspool', 'dist', 'build'],
        });

        await tickets.updateStatus(adapter, ticket.id, 'in_progress');

        const run = await runs.create(adapter, {
          projectId: project.id,
          type: 'worker',
          ticketId: ticket.id,
          metadata: { auto: true },
        });

        // Build learnings context for this ticket
        const ticketLearnings = autoConf.learningsEnabled
          ? selectRelevant(allLearnings, {
              paths: ticket.allowedPaths,
              commands: ticket.verificationCommands,
            })
          : [];
        const ticketLearningsBlock = formatLearningsForPrompt(ticketLearnings, autoConf.learningsBudget);
        if (ticketLearnings.length > 0) {
          recordAccess(repoRoot, ticketLearnings.map(l => l.id));
        }

        let currentTicket = ticket;
        let currentRun = run;
        let retryCount = 0;
        const maxScopeRetries = 2;

        while (retryCount <= maxScopeRetries) {
          try {
            ticketSpinner.update(`Executing: ${proposal.title}`);
            const result = await soloRunTicket({
              ticket: currentTicket,
              repoRoot,
              config,
              adapter,
              runId: currentRun.id,
              skipQa: false,
              createPr: !milestoneMode,
              draftPr: useDraft,
              timeoutMs: 600000,
              verbose: options.verbose ?? false,
              onProgress: (msg) => {
                ticketSpinner.update(msg);
              },
              executionBackend,
              guidelinesContext: guidelines ? formatGuidelinesForPrompt(guidelines) : undefined,
              learningsContext: ticketLearningsBlock || undefined,
              metadataContext: metadataBlock || undefined,
              qaRetryWithTestFix: ['refactor', 'perf', 'types'].includes(proposal.category),
              ...(milestoneMode && milestoneBranch ? {
                baseBranch: milestoneBranch,
                skipPush: true,
                skipPr: true,
              } : {}),
            });

            if (result.success) {
              // In milestone mode, merge ticket branch into milestone
              if (milestoneMode && milestoneWorktreePath) {
                if (!result.branchName) {
                  // No changes produced (e.g. no_changes_needed) — skip silently
                  await runs.markSuccess(adapter, currentRun.id);
                  await tickets.updateStatus(adapter, currentTicket.id, 'done');
                  ticketSpinner.stop(`— No changes needed, skipping`);
                  return { success: true };
                }
                const mergeResult = await mergeTicketToMilestone(
                  repoRoot,
                  result.branchName,
                  milestoneWorktreePath
                );
                if (!mergeResult.success) {
                  await runs.markFailure(adapter, currentRun.id, 'Merge conflict with milestone branch');
                  await tickets.updateStatus(adapter, currentTicket.id, 'blocked');
                  ticketSpinner.fail('Merge conflict — ticket blocked');
                  return { success: false };
                }
                milestoneTicketCount++;
                milestoneTicketSummaries.push(currentTicket.title);
                await runs.markSuccess(adapter, currentRun.id);
                await tickets.updateStatus(adapter, currentTicket.id, 'done');
                // Confirm learnings on milestone success
                if (autoConf.learningsEnabled && ticketLearnings.length > 0) {
                  for (const l of ticketLearnings) {
                    confirmLearning(repoRoot, l.id);
                  }
                }
                ticketSpinner.succeed(`Merged to milestone (${milestoneTicketCount}/${batchSize})`);

                // Finalize mid-batch if full (prevents overflow when running in parallel)
                if (batchSize && milestoneTicketCount >= batchSize) {
                  await finalizeMilestone();
                  if (shouldContinue()) {
                    await startNewMilestone();
                  }
                }
                return { success: true };
              }

              await runs.markSuccess(adapter, currentRun.id, { prUrl: result.prUrl });
              await tickets.updateStatus(adapter, currentTicket.id, 'done');
              // Confirm learnings on success
              if (autoConf.learningsEnabled && ticketLearnings.length > 0) {
                for (const l of ticketLearnings) {
                  confirmLearning(repoRoot, l.id);
                }
              }
              ticketSpinner.succeed('PR created');
              if (result.prUrl) {
                console.log(chalk.cyan(`    ${result.prUrl}`));
              }
              return { success: true, prUrl: result.prUrl };
            } else if (result.scopeExpanded && retryCount < maxScopeRetries) {
              retryCount++;
              ticketSpinner.update(`Scope expanded, retrying (${retryCount}/${maxScopeRetries})...`);

              const updatedTicket = await tickets.getById(adapter, currentTicket.id);
              if (!updatedTicket) {
                throw new Error('Failed to fetch updated ticket after scope expansion');
              }
              currentTicket = updatedTicket;

              await runs.markFailure(adapter, currentRun.id, `Scope expanded: retry ${retryCount}`);
              currentRun = await runs.create(adapter, {
                projectId: project.id,
                type: 'worker',
                ticketId: currentTicket.id,
                metadata: { auto: true, scopeRetry: retryCount },
              });
              continue;
            } else {
              await runs.markFailure(adapter, currentRun.id, result.error || result.failureReason || 'unknown');
              await tickets.updateStatus(adapter, currentTicket.id, 'blocked');
              const failReason = result.scopeExpanded
                ? `Scope expansion failed after ${maxScopeRetries} retries`
                : (result.error || result.failureReason || 'unknown');
              // Record failure learning
              if (autoConf.learningsEnabled && result.failureReason) {
                const reason = result.error ?? result.failureReason;
                const sourceType = result.failureReason === 'qa_failed' ? 'qa_failure' as const
                  : result.failureReason === 'scope_violation' ? 'scope_violation' as const
                  : 'ticket_failure' as const;
                addLearning(repoRoot, {
                  text: `${currentTicket.title} failed: ${reason}`.slice(0, 200),
                  category: sourceType === 'qa_failure' ? 'gotcha' : 'warning',
                  source: { type: sourceType, detail: reason },
                  tags: extractTags(currentTicket.allowedPaths, currentTicket.verificationCommands),
                });
              }
              ticketSpinner.fail(`Failed: ${failReason}`);
              return { success: false };
            }
          } catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            await runs.markFailure(adapter, currentRun.id, errorMsg);
            await tickets.updateStatus(adapter, currentTicket.id, 'blocked');
            ticketSpinner.fail(`Error: ${errorMsg}`);
            return { success: false };
          }
        }

        return { success: false };
      };

      if (parallelCount <= 1) {
        for (let i = 0; i < toProcess.length && shouldContinue(); i++) {
          const result = await processOneProposal(toProcess[i], `${totalPrsCreated + 1}/${maxPrs}`);
          if (result.success) {
            totalPrsCreated++;
            if (result.prUrl) allPrUrls.push(result.prUrl);
            recordDedupEntry(repoRoot, toProcess[i].title, true);
          } else {
            totalFailed++;
            recordDedupEntry(repoRoot, toProcess[i].title, false);
          }
          console.log();
          if (i < toProcess.length - 1 && shouldContinue()) {
            await sleep(1000);
          }
        }
      } else {
        // In milestone mode, partition proposals into conflict-free waves
        // to avoid merge conflicts from overlapping file paths
        let waves: Array<typeof toProcess>;
        if (milestoneMode) {
          waves = partitionIntoWaves(toProcess);
          if (waves.length > 1) {
            console.log(chalk.gray(`  Conflict-aware scheduling: ${waves.length} waves (avoiding overlapping file paths)`));
          }
        } else {
          waves = [toProcess];
        }

        let prCounter = totalPrsCreated;

        for (const wave of waves) {
          if (!shouldContinue()) break;

          let semaphorePermits = parallelCount;
          const semaphoreWaiting: Array<() => void> = [];
          const semAcquire = async () => {
            if (semaphorePermits > 0) { semaphorePermits--; return; }
            return new Promise<void>((resolve) => { semaphoreWaiting.push(resolve); });
          };
          const semRelease = () => {
            if (semaphoreWaiting.length > 0) { semaphoreWaiting.shift()!(); } else { semaphorePermits++; }
          };

          const tasks = wave.map(async (proposal) => {
            await semAcquire();
            if (!shouldContinue()) { semRelease(); return { success: false }; }
            const label = `${++prCounter}/${maxPrs}`;
            try {
              return await processOneProposal(proposal, label);
            } finally {
              semRelease();
            }
          });

          const taskResults = await Promise.allSettled(tasks);
          for (let ri = 0; ri < taskResults.length; ri++) {
            const r = taskResults[ri];
            const proposal = wave[ri];
            if (r.status === 'fulfilled' && r.value.success) {
              totalPrsCreated++;
              if (r.value.prUrl) allPrUrls.push(r.value.prUrl);
              recordDedupEntry(repoRoot, proposal.title, true);
            } else if (r.status === 'fulfilled') {
              totalFailed++;
              recordDedupEntry(repoRoot, proposal.title, false);
            } else {
              totalFailed++;
              recordDedupEntry(repoRoot, proposal.title, false);
            }
          }
        }
        console.log();
      }

      currentlyProcessing = false;

      // Record cycle completion for cross-session tracking
      recordCycle(repoRoot);
      if (isDocsAuditCycle) {
        recordDocsAudit(repoRoot);
      }

      // Periodic learnings consolidation
      if (cycleCount % 10 === 0 && autoConf.learningsEnabled) {
        consolidateLearnings(repoRoot);
        allLearnings = loadLearnings(repoRoot, 0); // reload without decay
      }

      // Refresh codebase index if structure changed (cheap mtime check)
      if (codebaseIndex && hasStructuralChanges(codebaseIndex, repoRoot)) {
        try {
          codebaseIndex = refreshCodebaseIndex(codebaseIndex, repoRoot, excludeDirs);
          if (options.verbose) {
            console.log(chalk.gray(`  Codebase index refreshed: ${codebaseIndex.modules.length} modules`));
          }
        } catch {
          // Non-fatal
        }
      }

      // Reload dedup memory for next cycle (picks up entries recorded this cycle)
      if (isContinuous) {
        dedupMemory = loadDedupMemory(repoRoot);
      }

      if (isContinuous && shouldContinue()) {
        console.log(chalk.gray('Pausing before next cycle...'));
        await sleep(5000);
      }

    } while (isContinuous && shouldContinue());

    // Finalize any partial milestone
    if (milestoneMode && milestoneTicketCount > 0) {
      await finalizeMilestone();
    }
    if (milestoneMode) {
      await cleanupMilestone(repoRoot);
    }

    const elapsed = Date.now() - startTime;
    // Record run history
    try {
      const { appendRunHistory } = await import('./run-history.js');
      const elapsed = Date.now() - startTime;
      const stoppedReason = shutdownRequested ? 'user_shutdown'
        : totalPrsCreated >= maxPrs ? 'pr_limit'
        : (endTime && Date.now() >= endTime) ? 'time_limit'
        : 'completed';
      appendRunHistory({
        timestamp: new Date().toISOString(),
        mode: 'auto',
        scope: userScope || 'src',
        formula: activeFormula?.name,
        ticketsProposed: 0,
        ticketsApproved: totalPrsCreated + totalFailed,
        ticketsCompleted: totalPrsCreated,
        ticketsFailed: totalFailed,
        prsCreated: allPrUrls.length,
        prsMerged: 0,
        durationMs: elapsed,
        parallel: parallelExplicit ? parseInt(options.parallel!, 10) : -1,
        stoppedReason,
      }, repoRoot || undefined);
    } catch {
      // Non-fatal
    }

    console.log();
    console.log(chalk.bold('━'.repeat(50)));
    console.log(chalk.bold('Final Summary'));
    console.log();
    console.log(chalk.gray(`  Duration: ${formatElapsed(elapsed)}`));
    console.log(chalk.gray(`  Cycles: ${cycleCount}`));

    if (milestoneMode) {
      console.log(chalk.gray(`  Milestone PRs: ${totalMilestonePrs}`));
      console.log(chalk.gray(`  Total tickets merged: ${totalPrsCreated}`));
    }

    if (allPrUrls.length > 0) {
      console.log(chalk.green(`\n✓ ${allPrUrls.length} PR(s) created:`));
      for (const url of allPrUrls) {
        console.log(chalk.cyan(`  ${url}`));
      }
    }

    if (totalFailed > 0) {
      console.log(chalk.red(`\n✗ ${totalFailed} failed`));
    }

    if (allPrUrls.length > 0) {
      console.log();
      console.log(chalk.bold('Next steps:'));
      console.log('  • Review the draft PRs on GitHub');
      console.log('  • Mark as ready for review when satisfied');
      console.log('  • Merge after CI passes');
    }

    if (isContinuous) {
      console.log();
      if (shutdownRequested) {
        console.log(chalk.gray('Stopped: User requested shutdown'));
      } else if (totalPrsCreated >= maxPrs) {
        console.log(chalk.gray(`Stopped: Reached PR limit (${maxPrs})`));
      } else if (endTime && Date.now() >= endTime) {
        const exhaustedLabel = totalMinutes! < 60
          ? `${Math.round(totalMinutes!)}m`
          : totalMinutes! % 60 === 0
            ? `${totalMinutes! / 60}h`
            : `${Math.floor(totalMinutes! / 60)}h ${Math.round(totalMinutes! % 60)}m`;
        console.log(chalk.gray(`Stopped: Time budget exhausted (${exhaustedLabel})`));
      }
    }

    stopStdinListener?.();
    await adapter.close();
    process.exit(totalFailed > 0 && allPrUrls.length === 0 ? 1 : 0);

  } catch (err) {
    stopStdinListener?.();
    await adapter.close();
    throw err;
  }
}
