/**
 * Solo mode wheel execution
 */

import chalk from 'chalk';
import { projects, tickets, runs } from '@promptwheel/core/repos';
import { createGitService } from './git.js';
import {
  getAdapter,
  isInitialized,
  loadConfig,
} from './solo-config.js';
import { soloRunTicket } from './solo-ticket.js';
import type { RunTicketResult } from './solo-ticket-types.js';
import { loadGuidelines, formatGuidelinesForPrompt } from './guidelines.js';
import {
  loadLearnings, addLearning, confirmLearning, recordAccess,
  formatLearningsForPrompt, selectRelevant, extractTags,
} from './learnings.js';
import { detectProjectMetadata, formatMetadataForPrompt } from './project-metadata/index.js';
import { DEFAULT_AUTO_CONFIG } from './solo-config.js';

// Re-export so existing importers don't break
export { sleep, normalizeTitle, titleSimilarity, isDuplicateProposal, getDeduplicationContext, getAdaptiveParallelCount } from './dedup.js';
export { partitionIntoWaves, buildScoutEscalation } from './wave-scheduling.js';

// New modular imports
import { initSession, shouldContinue, type AutoModeOptions } from './solo-auto-state.js';
import { runPreCycleMaintenance, runPostCycleMaintenance } from './solo-auto-between-cycles.js';
import { runScoutPhase } from './solo-auto-scout.js';
import { filterProposals } from './solo-auto-filter.js';
import { executeProposals } from './solo-auto-execute.js';
import { finalizeSession } from './solo-auto-finalize.js';

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

  console.log(chalk.blue('🧵 PromptWheel Auto - Work Mode'));
  console.log(chalk.gray(`  Parallel workers: ${parallelCount}`));
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

  const adapter = await getAdapter(repoRoot);
  const projectList = await projects.list(adapter);

  if (projectList.length === 0) {
    console.log(chalk.yellow('No projects found.'));
    console.log(chalk.gray('  Run: promptwheel solo scout . to create proposals'));
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
    console.log(chalk.gray('  Create tickets with: promptwheel solo approve'));
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
 * Run auto mode - the full "just run it" experience.
 *
 * Defaults to planning mode: scout all → roadmap → approve → execute → done.
 * With --wheel (or --hours): wheel loop — scout, fix, repeat.
 *
 * In daemon mode, returns the exit code instead of calling process.exit().
 */
export async function runAutoMode(options: AutoModeOptions): Promise<number> {
  const state = await initSession(options);

  try {
    if (state.runMode === 'planning') {
      await runPlanningRound(state);
    } else {
      await runWheelMode(state);
    }

    const exitCode = await finalizeSession(state);
    if (!options.daemon) {
      process.exit(exitCode);
    }
    return exitCode;
  } catch (err) {
    // Best-effort finalization even on error — push milestone PRs, save state
    // finalizeSession handles its own resource cleanup in a finally block
    let exitCode = 1;
    try { exitCode = await finalizeSession(state); } catch { /* already cleaned up */ }
    if (options.daemon) return exitCode;
    throw err;
  }
}

/**
 * Wheel mode — scout, fix, repeat until stopped.
 * Runs until Ctrl+C, --hours expires, or cycle/PR limits are hit.
 */
async function runWheelMode(state: import('./solo-auto-state.js').AutoSessionState): Promise<void> {
  do {
    const preCycle = await runPreCycleMaintenance(state);
    if (preCycle.shouldSkipCycle) continue;

    const scoutResult = await runScoutPhase(state);
    if (scoutResult.shouldBreak) break;
    if (scoutResult.shouldRetry) continue;

    const filterResult = await filterProposals(state, scoutResult.proposals, scoutResult.scope, scoutResult.cycleFormula);

    if (filterResult.shouldBreak) break;
    if (filterResult.shouldRetry) continue;

    const execResult = await executeProposals(state, filterResult.toProcess);
    if (execResult.shouldBreak) break;

    await runPostCycleMaintenance(state, filterResult.scope, scoutResult.isDocsAuditCycle);
  } while (shouldContinue(state));
}

/**
 * Planning round — scout all sectors, present roadmap, execute approved set.
 * Natural bounded end: no Ctrl+C needed.
 */
async function runPlanningRound(state: import('./solo-auto-state.js').AutoSessionState): Promise<void> {
  const { scoutAllSectors, presentRoadmap } = await import('./solo-auto-planning.js');

  // Phase 1: Scout all sectors
  const { proposals, sectorsScanned } = await scoutAllSectors(state);

  if (state.shutdownRequested) return;

  state.displayAdapter.log('');
  state.displayAdapter.log(chalk.gray(`Scanned ${sectorsScanned} sector(s), found ${proposals.length} proposal(s).`));

  // Phase 2: Present roadmap and get approval
  const { approved, cancelled } = await presentRoadmap(state, proposals);

  if (cancelled || approved.length === 0) return;

  // Phase 3: Execute approved proposals
  state.displayAdapter.log('');
  state.displayAdapter.log(chalk.bold(`Executing ${approved.length} approved proposal(s)...`));
  state.displayAdapter.log('');

  await executeProposals(state, approved);
}
