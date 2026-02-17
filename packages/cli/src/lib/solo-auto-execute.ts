/**
 * Ticket execution: processOneProposal + wave scheduling.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import chalk from 'chalk';
import type { TicketProposal } from '@promptwheel/core/scout';
import { tickets, runs } from '@promptwheel/core/repos';
import type { AutoSessionState } from './solo-auto-state.js';
import { shouldContinue } from './solo-auto-state.js';
import { soloRunTicket, captureQaBaseline, baselineToPassFail } from './solo-ticket.js';
import { getPromptwheelDir } from './solo-config.js';
import { formatGuidelinesForPrompt } from './guidelines.js';
import { selectRelevant, formatLearningsForPrompt, extractTags, addLearning, confirmLearning, recordAccess, type StructuredKnowledge } from './learnings.js';
import { classifyFailure } from './failure-classifier.js';
import { normalizeQaConfig } from './solo-utils.js';
import { recordPrFiles } from './file-cooldown.js';
import { recordDedupEntry } from './dedup-memory.js';
import { recordFormulaTicketOutcome, pushRecentDiff, recordQualitySignal } from './run-state.js';
import { recordTicketOutcome } from './sectors.js';
import {
  mergeTicketToMilestone,
  deleteTicketBranch,
  autoMergePr,
} from './solo-git.js';
import { getAdaptiveParallelCount, sleep } from './dedup.js';
import { partitionIntoWaves, type ConflictSensitivity } from './wave-scheduling.js';
import type { TicketOutcome } from './run-history.js';

export interface ExecuteResult {
  shouldBreak: boolean;
}

export interface ProposalResult {
  success: boolean;
  prUrl?: string;
  noChanges?: boolean;
  wasRetried?: boolean;
  conflictBranch?: string;
}

/**
 * Process a single ticket proposal: create ticket, execute, handle retries.
 * Extracted from closure for testability — all state flows through parameters.
 */
export async function processOneProposal(
  state: AutoSessionState,
  proposal: TicketProposal,
  slotLabel: string,
  cycleQaBaseline: Map<string, boolean> | null,
): Promise<ProposalResult> {
  state.displayAdapter.log(chalk.cyan(`[${slotLabel}] ${proposal.title}`));

  const ticket = await tickets.create(state.adapter, {
    projectId: state.project.id,
    title: proposal.title,
    description: proposal.description || proposal.title,
    priority: 2,
    allowedPaths: proposal.files?.length ? proposal.files : (proposal.allowed_paths ?? []),
    forbiddenPaths: ['node_modules', '.git', '.promptwheel', 'dist', 'build'],
  });

  state.displayAdapter.ticketAdded(ticket.id, proposal.title, slotLabel);
  await tickets.updateStatus(state.adapter, ticket.id, 'in_progress');

  const run = await runs.create(state.adapter, {
    projectId: state.project.id,
    type: 'worker',
    ticketId: ticket.id,
    metadata: { auto: true },
  });

  // Build learnings context
  const ticketLearnings = state.autoConf.learningsEnabled
    ? selectRelevant(state.allLearnings, {
        paths: ticket.allowedPaths,
        commands: ticket.verificationCommands,
        titleHint: proposal.title,
      })
    : [];
  const ticketLearningsBlock = formatLearningsForPrompt(ticketLearnings, state.autoConf.learningsBudget);
  if (ticketLearnings.length > 0) {
    recordAccess(state.repoRoot, ticketLearnings.map(l => l.id));
  }

  let currentTicket = ticket;
  let currentRun = run;
  let retryCount = 0;
  let wasRetried = false;
  const maxScopeRetries = 2;

  while (retryCount <= maxScopeRetries) {
    try {
      state.displayAdapter.ticketProgress(currentTicket.id, `Executing: ${proposal.title}`);
      const result = await soloRunTicket({
        ticket: currentTicket,
        repoRoot: state.repoRoot,
        config: state.config,
        adapter: state.adapter,
        runId: currentRun.id,
        skipQa: false,
        createPr: state.deliveryMode !== 'direct' && !state.milestoneMode,
        draftPr: state.useDraft,
        timeoutMs: 0,
        verbose: state.options.verbose ?? false,
        onProgress: (msg) => {
          state.displayAdapter.ticketProgress(currentTicket.id, msg);
        },
        onRawOutput: (chunk) => {
          state.displayAdapter.ticketRawOutput(currentTicket.id, chunk);
        },
        executionBackend: state.executionBackend,
        guidelinesContext: state.guidelines ? formatGuidelinesForPrompt(state.guidelines) : undefined,
        learningsContext: ticketLearningsBlock || undefined,
        metadataContext: state.metadataBlock || undefined,
        qaRetryWithTestFix: ['refactor', 'perf', 'types'].includes(proposal.category),
        confidence: proposal.confidence,
        complexity: proposal.estimated_complexity,
        qaBaseline: cycleQaBaseline ?? undefined,
        ...(state.milestoneMode && state.milestoneBranch ? {
          baseBranch: state.milestoneBranch,
          skipPush: true,
          skipPr: true,
        } : {}),
        ...(state.deliveryMode === 'direct' ? {
          baseBranch: state.directBranch,
          skipPush: true,
          skipPr: true,
        } : {}),
      });

      // no_changes_needed
      if (result.success && result.completionOutcome === 'no_changes_needed') {
        await runs.markSuccess(state.adapter, currentRun.id);
        await tickets.updateStatus(state.adapter, currentTicket.id, 'done');
        state.displayAdapter.ticketDone(currentTicket.id, false, '— No changes needed');
        return { success: false, noChanges: true };
      }

      if (result.success) {
        // Milestone mode merge
        if (state.milestoneMode && state.milestoneWorktreePath) {
          if (!result.branchName) {
            await runs.markSuccess(state.adapter, currentRun.id);
            await tickets.updateStatus(state.adapter, currentTicket.id, 'done');
            state.displayAdapter.ticketDone(currentTicket.id, false, '— No changes needed');
            return { success: false, noChanges: true };
          }
          const mergeResult = await mergeTicketToMilestone(
            state.repoRoot,
            result.branchName,
            state.milestoneWorktreePath
          );
          if (!mergeResult.success) {
            await runs.markFailure(state.adapter, currentRun.id, 'Merge conflict with milestone branch');
            await tickets.updateStatus(state.adapter, currentTicket.id, 'blocked');
            state.displayAdapter.ticketDone(currentTicket.id, false, 'Merge conflict — ticket blocked');
            return { success: false, conflictBranch: result.branchName };
          }
          state.milestoneTicketCount++;
          state.milestoneTicketSummaries.push(currentTicket.title);
          await runs.markSuccess(state.adapter, currentRun.id);
          await tickets.updateStatus(state.adapter, currentTicket.id, 'done');
          if (state.autoConf.learningsEnabled && ticketLearnings.length > 0) {
            for (const l of ticketLearnings) {
              confirmLearning(state.repoRoot, l.id);
            }
          }
          state.displayAdapter.ticketDone(currentTicket.id, true, `Merged to milestone (${state.milestoneTicketCount}/${state.batchSize})`);

          if (state.batchSize && state.milestoneTicketCount >= state.batchSize) {
            await state.finalizeMilestone();
            if (shouldContinue(state)) {
              await state.startNewMilestone();
            }
          }
          if (result.traceAnalysis) state.allTraceAnalyses.push(result.traceAnalysis);
          return { success: true, wasRetried };
        }

        await runs.markSuccess(state.adapter, currentRun.id, { prUrl: result.prUrl });
        await tickets.updateStatus(state.adapter, currentTicket.id, 'done');
        if (state.autoConf.learningsEnabled && ticketLearnings.length > 0) {
          for (const l of ticketLearnings) {
            confirmLearning(state.repoRoot, l.id);
          }
        }

        // Direct delivery — merge ticket branch into promptwheel-direct
        if (state.deliveryMode === 'direct' && result.branchName) {
          const mergeResult = await mergeTicketToMilestone(
            state.repoRoot,
            result.branchName,
            state.repoRoot, // main repo is checked out on promptwheel-direct
          );
          await deleteTicketBranch(state.repoRoot, result.branchName);
          if (!mergeResult.success) {
            // Retry against updated direct branch (another ticket changed the same files)
            if (retryCount < maxScopeRetries) {
              retryCount++;
              wasRetried = true;
              state.displayAdapter.ticketProgress(currentTicket.id, `Merge conflict, re-running against updated branch (${retryCount}/${maxScopeRetries})...`);
              await runs.markFailure(state.adapter, currentRun.id, `Merge conflict: retry ${retryCount}`);
              currentRun = await runs.create(state.adapter, {
                projectId: state.project.id,
                type: 'worker',
                ticketId: currentTicket.id,
                metadata: { auto: true, mergeConflictRetry: retryCount },
              });
              continue; // re-run soloRunTicket with fresh worktree from updated promptwheel-direct
            }
            state.displayAdapter.ticketDone(currentTicket.id, false, 'Merge conflict with direct branch');
            return { success: false };
          }
          state.completedDirectTickets.push({
            title: proposal.title,
            category: proposal.category,
            files: proposal.files ?? proposal.allowed_paths ?? [],
          });
          if (result.traceAnalysis) state.allTraceAnalyses.push(result.traceAnalysis);
          state.displayAdapter.ticketDone(currentTicket.id, true, 'Committed to direct branch');
          return { success: true, wasRetried };
        }

        // Auto-merge
        if (state.deliveryMode === 'auto-merge' && result.prUrl) {
          const merged = await autoMergePr(state.repoRoot, result.prUrl);
          state.displayAdapter.ticketDone(currentTicket.id, true, merged ? 'PR created (auto-merge enabled)' : 'PR created (auto-merge failed, manual merge needed)');
        } else {
          state.displayAdapter.ticketDone(currentTicket.id, true, 'PR created');
        }
        if (result.prUrl) {
          state.displayAdapter.log(chalk.cyan(`    ${result.prUrl}`));
          recordPrFiles(state.repoRoot, result.prUrl, proposal.files ?? proposal.allowed_paths ?? []);
        }
        if (result.traceAnalysis) state.allTraceAnalyses.push(result.traceAnalysis);
        return { success: true, prUrl: result.prUrl, wasRetried };
      } else if (result.scopeExpanded && retryCount < maxScopeRetries) {
        retryCount++;
        wasRetried = true;
        state.displayAdapter.ticketProgress(currentTicket.id, `Scope expanded, retrying (${retryCount}/${maxScopeRetries})...`);

        const updatedTicket = await tickets.getById(state.adapter, currentTicket.id);
        if (!updatedTicket) {
          throw new Error('Failed to fetch updated ticket after scope expansion');
        }
        currentTicket = updatedTicket;

        await runs.markFailure(state.adapter, currentRun.id, `Scope expanded: retry ${retryCount}`);
        currentRun = await runs.create(state.adapter, {
          projectId: state.project.id,
          type: 'worker',
          ticketId: currentTicket.id,
          metadata: { auto: true, scopeRetry: retryCount },
        });
        continue;
      } else {
        await runs.markFailure(state.adapter, currentRun.id, result.error || result.failureReason || 'unknown');
        await tickets.updateStatus(state.adapter, currentTicket.id, 'blocked');
        const failReason = result.scopeExpanded
          ? `Scope expansion failed after ${maxScopeRetries} retries`
          : (result.error || result.failureReason || 'unknown');
        // Spindle learning
        if (state.autoConf.learningsEnabled && result.failureReason === 'spindle_abort' && result.spindle) {
          addLearning(state.repoRoot, {
            text: `Spindle abort (${result.spindle.trigger}) on ${currentTicket.title}: ${result.spindle.trigger}`.slice(0, 200),
            category: 'warning',
            source: { type: 'ticket_failure', detail: `spindle:${result.spindle.trigger}` },
            tags: extractTags(currentTicket.allowedPaths, currentTicket.verificationCommands),
          });
        }
        // Failure learning with structured knowledge
        if (state.autoConf.learningsEnabled && result.failureReason) {
          const sourceType = result.failureReason === 'qa_failed' ? 'qa_failure' as const
            : result.failureReason === 'scope_violation' ? 'scope_violation' as const
            : 'ticket_failure' as const;
          const classified = classifyFailure(result.failureReason ?? 'unknown', result.error ?? '');
          const structured: StructuredKnowledge = {
            root_cause: classified.errorPattern || result.error?.slice(0, 200),
            fragile_paths: currentTicket.allowedPaths.filter(p => !p.includes('*')),
            ...(classified.failedCommand ? {
              failure_context: {
                command: classified.failedCommand,
                error_signature: classified.errorPattern?.slice(0, 120) ?? classified.failureType,
              },
            } : {}),
          };
          addLearning(state.repoRoot, {
            text: `[${classified.failureType}] ${classified.errorPattern || currentTicket.title}`.slice(0, 200),
            category: sourceType === 'qa_failure' ? 'gotcha' : 'warning',
            source: { type: sourceType, detail: classified.failedCommand },
            tags: [
              ...extractTags(currentTicket.allowedPaths, currentTicket.verificationCommands),
              `failureType:${classified.failureType}`,
            ],
            structured,
          });
        }
        state.displayAdapter.ticketDone(currentTicket.id, false, `Failed: ${failReason}`);
        return { success: false };
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      await runs.markFailure(state.adapter, currentRun.id, errorMsg);
      await tickets.updateStatus(state.adapter, currentTicket.id, 'blocked');
      state.displayAdapter.ticketDone(currentTicket.id, false, `Error: ${errorMsg}`);
      return { success: false };
    }
  }

  return { success: false };
}

export async function executeProposals(state: AutoSessionState, toProcess: TicketProposal[]): Promise<ExecuteResult> {
  // Dry run check
  if (state.options.dryRun) {
    state.displayAdapter.log(chalk.yellow('Dry run - no changes made'));
    return { shouldBreak: true };
  }

  // User confirmation on first cycle (skip in planning mode — roadmap already got approval)
  if (state.cycleCount === 1 && !state.options.yes && state.runMode !== 'wheel' && state.runMode !== 'planning' && !state.options.tui) {
    const readline = await import('readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const confirmMsg = `Proceed with ${toProcess.length} improvement(s)? [Y/n] `;
    const answer = await new Promise<string>((resolve) => {
      rl.question(chalk.bold(confirmMsg), resolve);
    });
    rl.close();

    if (answer.toLowerCase() === 'n' || answer.toLowerCase() === 'no') {
      state.displayAdapter.log(chalk.gray('Cancelled.'));
      await state.adapter.close();
      process.exit(0);
    }
    state.displayAdapter.log('');
  }

  state.currentlyProcessing = true;

  // Capture QA baseline once for this cycle — reused across all tickets.
  // Reuse cached baseline from initSession on first cycle to avoid redundant runs.
  let cycleQaBaseline: Map<string, boolean> | null = state.qaBaseline;
  if (!cycleQaBaseline && state.config?.qa?.commands?.length && !state.config.qa.disableBaseline) {
    state.displayAdapter.log(chalk.gray('  Capturing QA baseline for this cycle...'));
    const fullBaseline = await captureQaBaseline(state.repoRoot, state.config, (msg) => state.displayAdapter.log(chalk.gray(msg)), state.repoRoot);
    cycleQaBaseline = baselineToPassFail(fullBaseline);
    const preExisting = [...cycleQaBaseline.entries()].filter(([, passed]) => !passed);
    if (preExisting.length > 0) {
      state.displayAdapter.log(chalk.yellow(`  QA baseline: ${preExisting.length} pre-existing failure(s) will be skipped`));
    }

    // Persist baseline for inline prompts (plugin/MCP path)
    try {
      const baselineFailures = preExisting.map(([name]) => name);
      const qaConfig = normalizeQaConfig(state.config);
      const baselineDetails: Record<string, { cmd: string; output: string }> = {};
      for (const name of baselineFailures) {
        const result = fullBaseline.get(name);
        const cmdDef = qaConfig.commands.find(c => c.name === name);
        baselineDetails[name] = {
          cmd: cmdDef?.cmd ?? name,
          output: result?.output ?? '',
        };
      }
      const baselinePath = path.join(getPromptwheelDir(state.repoRoot), 'qa-baseline.json');
      fs.writeFileSync(baselinePath, JSON.stringify({
        failures: baselineFailures,
        details: baselineDetails,
        timestamp: Date.now(),
      }));
    } catch { /* non-fatal */ }
  }

  // Clear cached baseline so subsequent cycles capture a fresh one
  state.qaBaseline = null;

  // Adaptive parallelism
  let parallelCount: number;
  if (state.parallelExplicit) {
    const parsed = parseInt(state.options.parallel!, 10);
    parallelCount = Math.max(1, Number.isNaN(parsed) ? 1 : parsed);
  } else {
    parallelCount = getAdaptiveParallelCount(toProcess);
    const heavy = toProcess.filter(p => p.estimated_complexity === 'moderate' || p.estimated_complexity === 'complex').length;
    const light = toProcess.length - heavy;
    state.displayAdapter.log(chalk.gray(`  Parallel: ${parallelCount} (adaptive — ${light} simple, ${heavy} complex)`));
  }

  // Reduce parallelism near milestone limit
  if (state.milestoneMode && state.batchSize) {
    const remaining = state.batchSize - state.milestoneTicketCount;
    if (remaining <= 3 && parallelCount > 2) {
      parallelCount = 2;
      state.displayAdapter.log(chalk.gray(`  Parallel reduced to ${parallelCount} (milestone ${state.milestoneTicketCount}/${state.batchSize}, near full)`));
    }
  }

  // Helper to record outcome after processing
  const recordOutcome = (proposal: TicketProposal, result: ProposalResult, otherTitles: string[]) => {
    if (result.noChanges) {
      recordDedupEntry(state.repoRoot, proposal.title, false, 'no_changes');
      const outcome: TicketOutcome = { id: '', title: proposal.title, category: proposal.category, status: 'no_changes' };
      state.allTicketOutcomes.push(outcome);
      state.cycleOutcomes.push(outcome);
      return;
    }
    if (result.success) {
      state.totalPrsCreated++;
      if (result.prUrl) state.allPrUrls.push(result.prUrl);
      if (result.prUrl) state.pendingPrUrls.push(result.prUrl);
      recordDedupEntry(state.repoRoot, proposal.title, true, undefined, otherTitles);
      if (state.sectorState && state.currentSectorId) recordTicketOutcome(state.sectorState, state.currentSectorId, true, proposal.category);
      recordFormulaTicketOutcome(state.repoRoot, state.currentFormulaName, true);
      pushRecentDiff(state.repoRoot, { title: proposal.title, summary: `${(proposal.files ?? []).length} files`, files: proposal.files ?? proposal.allowed_paths ?? [], cycle: state.cycleCount });
      if (result.prUrl && state.currentSectorId) {
        state.prMetaMap.set(result.prUrl, { sectorId: state.currentSectorId, formula: state.currentFormulaName });
      }
      recordQualitySignal(state.repoRoot, result.wasRetried ? 'retried' : 'first_pass');
      if (state.autoConf.learningsEnabled) {
        // Extract cochange files — files that were modified together in this ticket
        const changedFiles = proposal.files ?? proposal.allowed_paths ?? [];
        const structured: StructuredKnowledge | undefined = changedFiles.length > 1
          ? { cochange_files: changedFiles.filter(f => !f.includes('*')), pattern_type: 'dependency' }
          : undefined;
        addLearning(state.repoRoot, {
          text: `${proposal.category} succeeded: ${proposal.title}`.slice(0, 200),
          category: 'pattern',
          source: { type: 'ticket_success', detail: proposal.category },
          tags: extractTags(changedFiles, []),
          structured,
        });
      }
      const outcome: TicketOutcome = { id: '', title: proposal.title, category: proposal.category, status: 'completed', prUrl: result.prUrl };
      state.allTicketOutcomes.push(outcome);
      state.cycleOutcomes.push(outcome);
    } else {
      state.totalFailed++;
      recordDedupEntry(state.repoRoot, proposal.title, false, 'agent_error');
      if (state.sectorState && state.currentSectorId) recordTicketOutcome(state.sectorState, state.currentSectorId, false, proposal.category);
      recordFormulaTicketOutcome(state.repoRoot, state.currentFormulaName, false);
      const outcome: TicketOutcome = { id: '', title: proposal.title, category: proposal.category, status: 'failed' };
      state.allTicketOutcomes.push(outcome);
      state.cycleOutcomes.push(outcome);
    }
  };

  // In direct mode, just show ticket number; in PR modes, show progress toward limit
  const makeLabel = (n: number) => {
    if (state.deliveryMode === 'direct' && !state.milestoneMode) {
      return `${n}`;
    }
    return `${n}/${state.maxPrs}`;
  };

  if (parallelCount <= 1) {
    // Serial execution
    for (let i = 0; i < toProcess.length && shouldContinue(state); i++) {
      const result = await processOneProposal(state, toProcess[i], makeLabel(state.totalPrsCreated + 1), cycleQaBaseline);
      const otherTitles = toProcess.filter((_, j) => j !== i).map(p => p.title);
      if (result.noChanges) {
        recordOutcome(toProcess[i], result, otherTitles);
        state.displayAdapter.log('');
        continue;
      }
      recordOutcome(toProcess[i], result, otherTitles);
      state.displayAdapter.log('');
      if (i < toProcess.length - 1 && shouldContinue(state)) {
        await sleep(1000);
      }
    }
  } else {
    // Parallel/wave execution
    let waves: Array<typeof toProcess>;
    if (state.milestoneMode) {
      // Use conflict sensitivity from config (default: 'normal')
      // - 'strict': Any shared directory = conflict (safest, more sequential)
      // - 'normal': Sibling files + conflict-prone patterns (balanced)
      // - 'relaxed': Only direct file overlap (most parallel, riskier)
      const sensitivity: ConflictSensitivity = state.autoConf.conflictSensitivity ?? 'normal';
      waves = partitionIntoWaves(toProcess, { sensitivity });
      if (waves.length > 1) {
        state.displayAdapter.log(chalk.gray(`  Conflict-aware scheduling: ${waves.length} waves (sensitivity: ${sensitivity})`));
      }
    } else {
      waves = [toProcess];
    }

    let ticketCounter = state.totalPrsCreated;

    for (const wave of waves) {
      if (!shouldContinue(state)) break;

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
        if (!shouldContinue(state)) { semRelease(); return { success: false }; }
        const label = makeLabel(++ticketCounter);
        try {
          return await processOneProposal(state, proposal, label, cycleQaBaseline);
        } finally {
          semRelease();
        }
      });

      const taskResults = await Promise.allSettled(tasks);
      for (let ri = 0; ri < taskResults.length; ri++) {
        const r = taskResults[ri];
        const proposal = wave[ri];
        const otherTitles = wave.filter((_, j) => j !== ri).map(p => p.title);
        if (r.status === 'fulfilled') {
          recordOutcome(proposal, r.value, otherTitles);
        } else {
          recordOutcome(proposal, { success: false }, otherTitles);
        }
      }

      // Retry merge-conflicted tickets sequentially after wave settles
      if (state.milestoneMode && state.milestoneWorktreePath) {
        const conflicted: Array<{ proposal: TicketProposal; branch: string; index: number }> = [];
        for (let ri = 0; ri < taskResults.length; ri++) {
          const r = taskResults[ri];
          if (r.status === 'fulfilled' && r.value.conflictBranch) {
            conflicted.push({ proposal: wave[ri], branch: r.value.conflictBranch, index: ri });
          }
        }
        if (conflicted.length > 0) {
          state.displayAdapter.log(chalk.gray(`  Retrying ${conflicted.length} merge-conflicted ticket(s)...`));
          for (const { proposal, branch } of conflicted) {
            if (!shouldContinue(state)) break;
            const retryResult = await mergeTicketToMilestone(
              state.repoRoot,
              branch,
              state.milestoneWorktreePath
            );
            if (retryResult.success) {
              state.milestoneTicketCount++;
              state.milestoneTicketSummaries.push(proposal.title);
              state.displayAdapter.log(chalk.green(`    ✓ ${proposal.title} — merged on retry`));
              // Check milestone full
              if (state.batchSize && state.milestoneTicketCount >= state.batchSize) {
                await state.finalizeMilestone();
                if (shouldContinue(state)) {
                  await state.startNewMilestone();
                }
              }
            } else {
              state.displayAdapter.log(chalk.yellow(`    ✗ ${proposal.title} — still conflicted`));
            }
          }
        }
      }
    }
    state.displayAdapter.log('');
  }

  state.currentlyProcessing = false;
  return { shouldBreak: false };
}
