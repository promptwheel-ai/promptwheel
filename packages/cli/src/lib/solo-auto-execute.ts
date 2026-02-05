/**
 * Ticket execution: processOneProposal + wave scheduling.
 */

import chalk from 'chalk';
import type { TicketProposal } from '@blockspool/core/scout';
import { tickets, runs } from '@blockspool/core/repos';
import type { AutoSessionState } from './solo-auto-state.js';
import { shouldContinue } from './solo-auto-state.js';
import { soloRunTicket, captureQaBaseline } from './solo-ticket.js';
import { computeTicketTimeout } from './solo-auto-utils.js';
import { createSpinner } from './spinner.js';
import { formatGuidelinesForPrompt } from './guidelines.js';
import { selectRelevant, formatLearningsForPrompt, extractTags, addLearning, confirmLearning, recordAccess } from './learnings.js';
import { classifyFailure } from './failure-classifier.js';
import { autoTuneQaConfig } from './qa-stats.js';
import { normalizeQaConfig } from './solo-utils.js';
import { recordPrFiles } from './file-cooldown.js';
import { recordDedupEntry } from './dedup-memory.js';
import { recordFormulaTicketOutcome, pushRecentDiff, recordQualitySignal } from './run-state.js';
import { recordTicketOutcome } from './sectors.js';
import {
  mergeTicketToMilestone,
  autoMergePr,
} from './solo-git.js';
import { getAdaptiveParallelCount, sleep } from './dedup.js';
import { partitionIntoWaves, type ConflictSensitivity } from './wave-scheduling.js';
import type { TicketOutcome } from './run-history.js';

export interface ExecuteResult {
  shouldBreak: boolean;
}

export async function executeProposals(state: AutoSessionState, toProcess: TicketProposal[]): Promise<ExecuteResult> {
  // Dry run check
  if (state.options.dryRun) {
    console.log(chalk.yellow('Dry run - no changes made'));
    return { shouldBreak: true };
  }

  // User confirmation on first cycle
  if (state.cycleCount === 1 && !state.options.yes && !state.isContinuous) {
    const readline = await import('readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const confirmMsg = state.isContinuous
      ? `Start continuous auto? [Y/n] `
      : `Proceed with ${toProcess.length} improvement(s)? [Y/n] `;
    const answer = await new Promise<string>((resolve) => {
      rl.question(chalk.bold(confirmMsg), resolve);
    });
    rl.close();

    if (answer.toLowerCase() === 'n' || answer.toLowerCase() === 'no') {
      console.log(chalk.gray('Cancelled.'));
      await state.adapter.close();
      process.exit(0);
    }
    console.log();
  }

  state.currentlyProcessing = true;

  // Auto-tune QA config before baseline capture
  if (state.config?.qa?.commands?.length) {
    try {
      const tuneResult = autoTuneQaConfig(state.repoRoot, normalizeQaConfig(state.config));
      if (tuneResult.reEnabled.length > 0) {
        for (const name of tuneResult.reEnabled) {
          console.log(chalk.green(`  QA auto-tune: re-enabled ${name} (recent baselines passing)`));
        }
      }
      if (tuneResult.disabled.length > 0) {
        for (const d of tuneResult.disabled) {
          console.log(chalk.yellow(`  QA auto-tune: disabled ${d.name} — ${d.reason}`));
        }
      }
      if (tuneResult.disabled.length > 0 || tuneResult.reEnabled.length > 0) {
        // Update config commands in-memory (shallow copy, not persisted to disk)
        state.config = {
          ...state.config,
          qa: {
            ...state.config.qa,
            commands: tuneResult.config.commands.map(c => ({
              name: c.name,
              cmd: c.cmd,
              cwd: c.cwd,
              timeoutMs: c.timeoutMs,
            })),
          },
        };
      }
    } catch {
      // Non-fatal — continue with existing config
    }
  }

  // Capture QA baseline once for this cycle — reused across all tickets.
  // All tickets in a cycle share the same base branch, so baseline is identical.
  let cycleQaBaseline: Map<string, boolean> | null = null;
  if (state.config?.qa?.commands?.length && !state.config.qa.disableBaseline) {
    console.log(chalk.gray('  Capturing QA baseline for this cycle...'));
    cycleQaBaseline = await captureQaBaseline(state.repoRoot, state.config, (msg) => console.log(chalk.gray(msg)), state.repoRoot);
    const preExisting = [...cycleQaBaseline.entries()].filter(([, passed]) => !passed);
    if (preExisting.length > 0) {
      console.log(chalk.yellow(`  QA baseline: ${preExisting.length} pre-existing failure(s) will be skipped`));
    }
  }

  // Adaptive parallelism
  let parallelCount: number;
  if (state.parallelExplicit) {
    const parsed = parseInt(state.options.parallel!, 10);
    parallelCount = Math.max(1, Number.isNaN(parsed) ? 1 : parsed);
  } else {
    parallelCount = getAdaptiveParallelCount(toProcess);
    const heavy = toProcess.filter(p => p.estimated_complexity === 'moderate' || p.estimated_complexity === 'complex').length;
    const light = toProcess.length - heavy;
    console.log(chalk.gray(`  Parallel: ${parallelCount} (adaptive — ${light} simple, ${heavy} complex)`));
  }

  // Reduce parallelism near milestone limit
  if (state.milestoneMode && state.batchSize) {
    const remaining = state.batchSize - state.milestoneTicketCount;
    if (remaining <= 3 && parallelCount > 2) {
      parallelCount = 2;
      console.log(chalk.gray(`  Parallel reduced to ${parallelCount} (milestone ${state.milestoneTicketCount}/${state.batchSize}, near full)`));
    }
  }

  const processOneProposal = async (proposal: TicketProposal, slotLabel: string): Promise<{ success: boolean; prUrl?: string; noChanges?: boolean; wasRetried?: boolean; conflictBranch?: string }> => {
    console.log(chalk.cyan(`[${slotLabel}] ${proposal.title}`));
    const ticketSpinner = createSpinner(`Setting up...`, 'spool');

    const ticket = await tickets.create(state.adapter, {
      projectId: state.project.id,
      title: proposal.title,
      description: proposal.description || proposal.title,
      priority: 2,
      allowedPaths: proposal.files,
      forbiddenPaths: ['node_modules', '.git', '.blockspool', 'dist', 'build'],
    });

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
        ticketSpinner.update(`Executing: ${proposal.title}`);
        const result = await soloRunTicket({
          ticket: currentTicket,
          repoRoot: state.repoRoot,
          config: state.config,
          adapter: state.adapter,
          runId: currentRun.id,
          skipQa: false,
          createPr: state.deliveryMode !== 'direct' && !state.milestoneMode,
          draftPr: state.useDraft,
          timeoutMs: computeTicketTimeout(proposal, state.autoConf),
          verbose: state.options.verbose ?? false,
          onProgress: (msg) => {
            ticketSpinner.update(msg);
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
            skipPush: true,
            skipPr: true,
          } : {}),
        });

        // no_changes_needed
        if (result.success && result.completionOutcome === 'no_changes_needed') {
          await runs.markSuccess(state.adapter, currentRun.id);
          await tickets.updateStatus(state.adapter, currentTicket.id, 'done');
          ticketSpinner.stop(`— No changes needed`);
          return { success: false, noChanges: true };
        }

        if (result.success) {
          // Milestone mode merge
          if (state.milestoneMode && state.milestoneWorktreePath) {
            if (!result.branchName) {
              await runs.markSuccess(state.adapter, currentRun.id);
              await tickets.updateStatus(state.adapter, currentTicket.id, 'done');
              ticketSpinner.stop(`— No changes needed`);
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
              ticketSpinner.fail('Merge conflict — ticket blocked');
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
            ticketSpinner.succeed(`Merged to milestone (${state.milestoneTicketCount}/${state.batchSize})`);

            if (state.batchSize && state.milestoneTicketCount >= state.batchSize) {
              await state.finalizeMilestone();
              if (shouldContinue(state)) {
                await state.startNewMilestone();
              }
            }
            return { success: true, wasRetried };
          }

          await runs.markSuccess(state.adapter, currentRun.id, { prUrl: result.prUrl });
          await tickets.updateStatus(state.adapter, currentTicket.id, 'done');
          if (state.autoConf.learningsEnabled && ticketLearnings.length > 0) {
            for (const l of ticketLearnings) {
              confirmLearning(state.repoRoot, l.id);
            }
          }

          // Direct delivery
          if (state.deliveryMode === 'direct') {
            state.completedDirectTickets.push({
              title: proposal.title,
              category: proposal.category,
              files: proposal.files ?? proposal.allowed_paths ?? [],
            });
            ticketSpinner.succeed('Committed to direct branch');
            return { success: true, wasRetried };
          }

          // Auto-merge
          if (state.deliveryMode === 'auto-merge' && result.prUrl) {
            const merged = await autoMergePr(state.repoRoot, result.prUrl);
            ticketSpinner.succeed(merged ? 'PR created (auto-merge enabled)' : 'PR created (auto-merge failed, manual merge needed)');
          } else {
            ticketSpinner.succeed('PR created');
          }
          if (result.prUrl) {
            console.log(chalk.cyan(`    ${result.prUrl}`));
            recordPrFiles(state.repoRoot, result.prUrl, proposal.files ?? proposal.allowed_paths ?? []);
          }
          return { success: true, prUrl: result.prUrl, wasRetried };
        } else if (result.scopeExpanded && retryCount < maxScopeRetries) {
          retryCount++;
          wasRetried = true;
          ticketSpinner.update(`Scope expanded, retrying (${retryCount}/${maxScopeRetries})...`);

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
          // Failure learning
          if (state.autoConf.learningsEnabled && result.failureReason) {
            const sourceType = result.failureReason === 'qa_failed' ? 'qa_failure' as const
              : result.failureReason === 'scope_violation' ? 'scope_violation' as const
              : 'ticket_failure' as const;
            const classified = classifyFailure(result.failureReason ?? 'unknown', result.error ?? '');
            addLearning(state.repoRoot, {
              text: `[${classified.failureType}] ${classified.errorPattern || currentTicket.title}`.slice(0, 200),
              category: sourceType === 'qa_failure' ? 'gotcha' : 'warning',
              source: { type: sourceType, detail: classified.failedCommand },
              tags: [
                ...extractTags(currentTicket.allowedPaths, currentTicket.verificationCommands),
                `failureType:${classified.failureType}`,
              ],
            });
          }
          ticketSpinner.fail(`Failed: ${failReason}`);
          return { success: false };
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        await runs.markFailure(state.adapter, currentRun.id, errorMsg);
        await tickets.updateStatus(state.adapter, currentTicket.id, 'blocked');
        ticketSpinner.fail(`Error: ${errorMsg}`);
        return { success: false };
      }
    }

    return { success: false };
  };

  // Helper to record outcome after processing
  const recordOutcome = (proposal: TicketProposal, result: { success: boolean; prUrl?: string; noChanges?: boolean; wasRetried?: boolean; conflictBranch?: string }, otherTitles: string[]) => {
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
        addLearning(state.repoRoot, {
          text: `${proposal.category} succeeded: ${proposal.title}`.slice(0, 200),
          category: 'pattern',
          source: { type: 'ticket_success', detail: proposal.category },
          tags: extractTags(proposal.files ?? proposal.allowed_paths ?? [], []),
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
      const result = await processOneProposal(toProcess[i], makeLabel(state.totalPrsCreated + 1));
      const otherTitles = toProcess.filter((_, j) => j !== i).map(p => p.title);
      if (result.noChanges) {
        recordOutcome(toProcess[i], result, otherTitles);
        console.log();
        continue;
      }
      recordOutcome(toProcess[i], result, otherTitles);
      console.log();
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
        console.log(chalk.gray(`  Conflict-aware scheduling: ${waves.length} waves (sensitivity: ${sensitivity})`));
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
          return await processOneProposal(proposal, label);
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
          console.log(chalk.gray(`  Retrying ${conflicted.length} merge-conflicted ticket(s)...`));
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
              console.log(chalk.green(`    ✓ ${proposal.title} — merged on retry`));
              // Check milestone full
              if (state.batchSize && state.milestoneTicketCount >= state.batchSize) {
                await state.finalizeMilestone();
                if (shouldContinue(state)) {
                  await state.startNewMilestone();
                }
              }
            } else {
              console.log(chalk.yellow(`    ✗ ${proposal.title} — still conflicted`));
            }
          }
        }
      }
    }
    console.log();
  }

  state.currentlyProcessing = false;
  return { shouldBreak: false };
}
