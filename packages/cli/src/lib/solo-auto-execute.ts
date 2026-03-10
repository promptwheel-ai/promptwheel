/**
 * Ticket execution: processOneProposal + wave scheduling.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import chalk from 'chalk';
import { type TicketProposal, proposalToFinding, appendFixOutcome } from '@promptwheel/core/scout';
import { tickets, runs } from '@promptwheel/core/repos';
import type { AutoSessionState } from './solo-auto-state.js';
import { shouldContinue } from './solo-auto-state.js';
import { soloRunTicket, captureQaBaseline, baselineToPassFail } from './solo-ticket.js';
import { getPromptwheelDir } from './solo-config.js';
import { formatGuidelinesForPrompt } from './guidelines.js';
import { selectRelevant, formatLearningsForPrompt, extractTags, addLearning, confirmLearning, recordAccess, recordApplication, type StructuredKnowledge } from './learnings.js';
import { classifyFailure } from './failure-classifier.js';
import { analyzeFailure } from './recovery-analyzer.js';
import { computeRetryRisk, scoreStrategies, buildCriticBlock, type FailureContext } from '@promptwheel/core/critic/shared';
import { normalizeQaConfig } from './solo-utils.js';
import { computeTicketTimeout } from './solo-auto-utils.js';
import { recordDedupEntry } from './dedup-memory.js';
import { recordOutcome as recordLearningOutcome } from './learnings.js';
import { pushRecentDiff, recordQualitySignal, recordCategoryOutcome, deferProposal } from './run-state.js';
import { appendErrorLedger } from './error-ledger.js';
import { commentOnIssue } from './issue-comment.js';
import {
  mergeTicketToMilestone,
  deleteTicketBranch,
  autoMergePr,
} from './solo-git.js';
import { getAdaptiveParallelCount, sleep } from './dedup.js';
import { partitionIntoWaves } from './wave-scheduling.js';
import { getModelForStep } from '@promptwheel/core/proposals/step-classifier';
import type { TicketOutcome } from './run-history.js';
import type { ProgressSnapshot } from './display-adapter.js';

export interface ExecuteResult {
  shouldBreak: boolean;
}

export interface ProposalResult {
  success: boolean;
  prUrl?: string;
  noChanges?: boolean;
  wasRetried?: boolean;
  conflictBranch?: string;
  mergeConflictDeferred?: boolean;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  phaseTiming?: {
    executeMs?: number;
    qaMs?: number;
    gitMs?: number;
  };
  /** Learning IDs injected into this ticket — used for recordOutcome */
  injectedLearningIds?: string[];
  /** Actual failure reason from the ticket result */
  failureReason?: string;
  /** Actual files changed (from git status, scope-verified). More accurate than proposal.files. */
  actualChangedFiles?: string[];
  /** Model used for execution (from model routing) */
  modelUsed?: string;
  /** Whether recovery analysis was attempted after initial failure */
  recoveryAttempted?: boolean;
  /** Recovery action taken (retry_with_hint, narrow_scope, skip) */
  recoveryAction?: string;
  /** Whether the recovery retry succeeded */
  recoverySucceeded?: boolean;
}

/**
 * Process a single ticket proposal: create ticket, execute, handle retries.
 * Extracted from closure for testability — all state flows through parameters.
 */
export async function processOneProposal(
  state: AutoSessionState,
  proposal: TicketProposal,
  slotLabel: string,
  cycleQaBaseline: ReadonlyMap<string, boolean> | null,
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
  const injectedLearningIds = ticketLearnings.map(l => l.id);
  if (injectedLearningIds.length > 0) {
    recordAccess(state.repoRoot, injectedLearningIds);
  }

  let currentTicket = ticket;
  let currentRun = run;
  let retryCount = 0;
  let wasRetried = false;
  let lastError: string | undefined;
  let lastFailureReason: string | undefined;
  let recoveryAttempted = false;
  let recoveryHint: string | undefined;
  let recoveryAction: string | undefined;
  const maxScopeRetries = 2;

  while (retryCount <= maxScopeRetries) {
    try {
      state.displayAdapter.ticketProgress(currentTicket.id, `Executing: ${proposal.title}`);
      const executeStart = Date.now();

      // Model routing: select model based on step complexity
      let routedModel: string | undefined;
      if (state.autoConf.modelRouting?.enabled !== false && state.autoConf.modelRouting) {
        routedModel = getModelForStep(
          {
            categories: proposal.category ? [proposal.category] : [],
            allowed_paths: proposal.files ?? proposal.allowed_paths ?? [],
          },
          state.autoConf.modelRouting,
        );
      }

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
          state.displayAdapter.ticketProgress(currentTicket.id, msg);
        },
        onRawOutput: (chunk) => {
          state.displayAdapter.ticketRawOutput(currentTicket.id, chunk);
        },
        executionBackend: state.executionBackend,
        guidelinesContext: state.guidelines ? formatGuidelinesForPrompt(state.guidelines) : undefined,
        learningsContext: ticketLearningsBlock || undefined,
        metadataContext: state.metadataBlock || undefined,
        qaRetryWithTestFix: true, // All categories can retry with test files in scope
        criteriaVerification: state.autoConf.criteriaVerification,
        confidence: proposal.confidence,
        complexity: proposal.estimated_complexity,
        rationale: proposal.rationale,
        acceptanceCriteria: proposal.acceptance_criteria,
        retryContext: retryCount > 0 ? (() => {
          // Build critic block for structured retry guidance
          let criticGuidance = '';
          if (state.autoConf.learningsEnabled && ticketLearnings.length > 0) {
            const failureCtx: FailureContext = {
              failed_commands: ticket.verificationCommands ?? [],
              error_output: (lastError ?? '').slice(0, 2000),
              attempt: retryCount,
              max_attempts: maxScopeRetries,
            };
            const risk = computeRetryRisk(ticket.allowedPaths ?? [], ticket.verificationCommands ?? [], ticketLearnings, failureCtx);
            const strategies = scoreStrategies(ticket.allowedPaths ?? [], failureCtx, ticketLearnings);
            criticGuidance = buildCriticBlock(failureCtx, risk, strategies, ticketLearnings);
          }
          const baseError = recoveryHint
            ? `${(lastError ?? '').slice(0, 300)}\n\nRecovery hint: ${recoveryHint}`
            : (lastError ?? '');
          return {
            attempt: retryCount,
            previousError: criticGuidance
              ? `${baseError.slice(0, 500)}\n\n${criticGuidance}`
              : baseError.slice(0, 500),
            failureReason: lastFailureReason ?? 'unknown',
          };
        })() : undefined,
        qaBaseline: cycleQaBaseline ?? undefined,
        formulaHint: undefined,
        model: routedModel,
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

      // Extract cost and timing from trace analysis
      const traceCost = result.traceAnalysis?.total_cost_usd;
      const traceInput = result.traceAnalysis?.total_input_tokens;
      const traceOutput = result.traceAnalysis?.total_output_tokens;
      const executeDuration = Date.now() - executeStart;
      // Map step names to phase timing from trace steps
      let phaseTiming: { executeMs?: number; qaMs?: number; gitMs?: number } | undefined;
      if (result.traceAnalysis?.steps) {
        let qaMs = 0;
        let gitMs = 0;
        let execMs = 0;
        for (const step of result.traceAnalysis.steps) {
          const name = step.label?.toLowerCase() ?? '';
          if (name.includes('qa') || name.includes('test') || name.includes('verify')) {
            qaMs += step.duration_ms ?? 0;
          } else if (name.includes('git') || name.includes('push') || name.includes('pr') || name.includes('commit')) {
            gitMs += step.duration_ms ?? 0;
          } else {
            execMs += step.duration_ms ?? 0;
          }
        }
        phaseTiming = { executeMs: execMs || executeDuration, qaMs, gitMs };
      } else {
        phaseTiming = { executeMs: executeDuration };
      }

      // no_changes_needed
      if (result.success && result.completionOutcome === 'no_changes_needed') {
        await runs.markSuccess(state.adapter, currentRun.id);
        await tickets.updateStatus(state.adapter, currentTicket.id, 'done');
        state.displayAdapter.ticketDone(currentTicket.id, false, '— No changes needed');
        return { success: false, noChanges: true, injectedLearningIds };
      }

      if (result.success) {
        // Milestone mode merge
        if (state.milestoneMode && state.milestoneWorktreePath) {
          if (!result.branchName) {
            await runs.markSuccess(state.adapter, currentRun.id);
            await tickets.updateStatus(state.adapter, currentTicket.id, 'done');
            state.displayAdapter.ticketDone(currentTicket.id, false, '— No changes needed');
            return { success: false, noChanges: true, injectedLearningIds };
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
          return { success: true, wasRetried, costUsd: traceCost, inputTokens: traceInput, outputTokens: traceOutput, phaseTiming, injectedLearningIds, actualChangedFiles: result.changedFiles, modelUsed: routedModel, ...(recoveryAttempted ? { recoveryAttempted, recoveryAction, recoverySucceeded: true } : {}) };
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
              lastError = 'Merge conflict with direct branch';
              lastFailureReason = 'git_error';
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
            // Defer for next cycle instead of discarding
            await deferProposal(state.repoRoot, {
              category: proposal.category,
              title: proposal.title,
              description: proposal.description,
              files: proposal.files ?? [],
              allowed_paths: proposal.allowed_paths ?? [],
              confidence: proposal.confidence ?? 50,
              impact_score: proposal.impact_score ?? 5,
              original_scope: 'merge-conflict',
              deferredAt: Date.now(),
              deferredAtCycle: state.cycleCount,
            });
            // Reset ticket so dedup doesn't block re-attempt
            await tickets.updateStatus(state.adapter, currentTicket.id, 'ready');
            state.displayAdapter.ticketDone(currentTicket.id, false, 'Merge conflict — deferred to next cycle');
            return { success: false, mergeConflictDeferred: true };
          }
          state.completedDirectTickets.push({
            title: proposal.title,
            category: proposal.category,
            files: proposal.files ?? proposal.allowed_paths ?? [],
          });
          if (result.traceAnalysis) state.allTraceAnalyses.push(result.traceAnalysis);
          state.displayAdapter.ticketDone(currentTicket.id, true, 'Committed to direct branch');
          return { success: true, wasRetried, costUsd: traceCost, inputTokens: traceInput, outputTokens: traceOutput, phaseTiming, injectedLearningIds, actualChangedFiles: result.changedFiles, modelUsed: routedModel, ...(recoveryAttempted ? { recoveryAttempted, recoveryAction, recoverySucceeded: true } : {}) };
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
        }
        if (result.traceAnalysis) state.allTraceAnalyses.push(result.traceAnalysis);
        return { success: true, prUrl: result.prUrl, wasRetried, costUsd: traceCost, inputTokens: traceInput, outputTokens: traceOutput, phaseTiming, injectedLearningIds, actualChangedFiles: result.changedFiles, modelUsed: routedModel, ...(recoveryAttempted ? { recoveryAttempted, recoveryAction, recoverySucceeded: true } : {}) };
      } else if (result.scopeExpanded && retryCount < maxScopeRetries) {
        lastError = result.error;
        lastFailureReason = result.failureReason ?? 'scope_violation';
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
        // Recovery analysis — try to recover from failure before giving up
        if (!recoveryAttempted && retryCount < maxScopeRetries) {
          const recovery = analyzeFailure(result, proposal);
          recoveryAttempted = true;
          recoveryAction = recovery.action;

          if (recovery.action === 'retry_with_hint') {
            retryCount++;
            wasRetried = true;
            lastError = result.error;
            lastFailureReason = result.failureReason ?? 'unknown';
            state.displayAdapter.ticketProgress(currentTicket.id, `Recovery: retrying with diagnostic hint (${retryCount}/${maxScopeRetries})...`);

            await runs.markFailure(state.adapter, currentRun.id, `Recovery retry: ${recovery.action}`);
            currentRun = await runs.create(state.adapter, {
              projectId: state.project.id,
              type: 'worker',
              ticketId: currentTicket.id,
              metadata: { auto: true, recoveryRetry: retryCount, recoveryAction: recovery.action },
            });

            // Set recovery hint — will be threaded into retryContext on next iteration
            recoveryHint = recovery.hint;
            continue;
          }

          if (recovery.action === 'narrow_scope') {
            retryCount++;
            wasRetried = true;
            lastError = result.error;
            lastFailureReason = result.failureReason ?? 'unknown';
            state.displayAdapter.ticketProgress(currentTicket.id, `Recovery: narrowing scope to ${recovery.files.length} files...`);

            await runs.markFailure(state.adapter, currentRun.id, `Recovery: narrow_scope`);
            currentRun = await runs.create(state.adapter, {
              projectId: state.project.id,
              type: 'worker',
              ticketId: currentTicket.id,
              metadata: { auto: true, recoveryRetry: retryCount, recoveryAction: 'narrow_scope' },
            });
            continue;
          }

          // recovery.action === 'skip' — check if it looks like a parse/format error
          // and retry with a hint instead of giving up immediately
          if (recovery.action === 'skip' && result.failureReason === 'agent_error' &&
              result.error && /parse|json|syntax|format|unexpected token/i.test(result.error)) {
            recoveryAction = 'retry_with_hint';
            retryCount++;
            wasRetried = true;
            lastError = result.error;
            lastFailureReason = 'parse_error';
            recoveryHint = 'The previous attempt failed due to a parse/format error. Double-check JSON output format and ensure all output is valid.';
            state.displayAdapter.ticketProgress(currentTicket.id, `Recovery: retrying parse failure with hint (${retryCount}/${maxScopeRetries})...`);
            await runs.markFailure(state.adapter, currentRun.id, `Recovery retry: parse_error`);
            currentRun = await runs.create(state.adapter, {
              projectId: state.project.id,
              type: 'worker',
              ticketId: currentTicket.id,
              metadata: { auto: true, recoveryRetry: retryCount, recoveryAction: 'retry_parse_error' },
            });
            continue;
          }
          // fall through to normal failure handling
        }

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
          // Targeted criteria-failure learning: more specific than generic QA failure
          if (result.failureReason === 'qa_failed' && result.error?.includes('acceptance criteria not met')) {
            addLearning(state.repoRoot, {
              text: `Ticket '${currentTicket.title}' passed verification commands but failed acceptance criteria. ${result.error.slice(0, 150)}`.slice(0, 200),
              category: 'gotcha',
              source: { type: 'qa_failure' as const, detail: 'criteria_verification' },
              tags: [
                ...extractTags(currentTicket.allowedPaths, currentTicket.verificationCommands),
                'failureType:criteria_not_met',
              ],
            });
          }
          // Error ledger
          try {
            const phase = result.failureReason === 'qa_failed' ? 'qa' as const
              : result.failureReason === 'git_error' ? 'git' as const
              : result.failureReason === 'pr_error' ? 'pr' as const
              : 'execute' as const;
            appendErrorLedger(state.repoRoot, {
              ts: Date.now(),
              ticketId: currentTicket.id,
              ticketTitle: currentTicket.title,
              failureType: classified.failureType,
              failedCommand: classified.failedCommand,
              errorPattern: classified.errorPattern.slice(0, 100),
              errorMessage: (result.error ?? '').slice(0, 500),
              category: proposal.category,
              phase,
              sessionCycle: state.cycleCount,
            });
          } catch { /* non-fatal */ }
        }
        state.displayAdapter.ticketDone(currentTicket.id, false, `Failed: ${failReason}`);
        return {
          success: false, injectedLearningIds, failureReason: result.failureReason ?? 'agent_error',
          recoveryAttempted, recoveryAction, recoverySucceeded: false,
        };
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      await runs.markFailure(state.adapter, currentRun.id, errorMsg);
      await tickets.updateStatus(state.adapter, currentTicket.id, 'blocked');
      // Error ledger for unexpected exceptions
      try {
        appendErrorLedger(state.repoRoot, {
          ts: Date.now(),
          ticketId: currentTicket.id,
          ticketTitle: currentTicket.title,
          failureType: 'unknown',
          failedCommand: 'processOneProposal',
          errorPattern: errorMsg.slice(0, 100),
          errorMessage: errorMsg.slice(0, 500),
          category: proposal.category,
          phase: 'execute',
          sessionCycle: state.cycleCount,
        });
      } catch { /* non-fatal */ }
      state.displayAdapter.ticketDone(currentTicket.id, false, `Error: ${errorMsg}`);
      return { success: false, injectedLearningIds, failureReason: 'agent_error' };
    }
  }

  return { success: false, injectedLearningIds };
}

export async function executeProposals(state: AutoSessionState, toProcess: TicketProposal[]): Promise<ExecuteResult> {
  // Dry run check
  if (state.options.dryRun) {
    state.displayAdapter.log(chalk.yellow('Dry run - no changes made'));
    return { shouldBreak: true };
  }

  state.currentlyProcessing = true;

  // Capture QA baseline once for this cycle — shared immutably across all
  // parallel tickets within all waves. Captured before wave processing starts
  // so parallel tickets never race on baseline state.
  // Reuse cached baseline from initSession on first cycle to avoid redundant runs.
  let cycleQaBaseline: ReadonlyMap<string, boolean> | null = state.qaBaseline;
  if (!cycleQaBaseline && state.config?.qa?.commands?.length && !state.config.qa.disableBaseline) {
    if (state.options.verbose) state.displayAdapter.log(chalk.gray('  Capturing QA baseline for this cycle...'));
    const fullBaseline = await captureQaBaseline(state.repoRoot, state.config, (msg) => state.displayAdapter.log(chalk.gray(msg)));
    cycleQaBaseline = baselineToPassFail(fullBaseline);
    const preExisting = [...cycleQaBaseline.entries()].filter(([, passed]) => !passed);
    if (state.options.verbose && preExisting.length > 0) {
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
      const blTmp = baselinePath + '.tmp';
      fs.writeFileSync(blTmp, JSON.stringify({
        failures: baselineFailures,
        details: baselineDetails,
        timestamp: Date.now(),
      }));
      fs.renameSync(blTmp, baselinePath);
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

  // Build a progress snapshot from current state
  const pushProgress = () => {
    const done = state.allTicketOutcomes.filter(t => t.status === 'completed').length;
    const failed = state.allTicketOutcomes.filter(t => t.status === 'failed' || t.status === 'spindle_abort').length;
    const deferred = state.allTicketOutcomes.filter(t => t.status === 'deferred').length;
    // Update cycle progress: tickets completed this cycle vs total this cycle
    const cycleDone = state.cycleOutcomes.length;
    state._cycleProgress = { done: cycleDone, total: toProcess.length, label: 'tickets' };
    const snapshot: ProgressSnapshot = {
      phase: 'executing',
      cycleCount: state.cycleCount,
      ticketsDone: done,
      ticketsFailed: failed,
      ticketsDeferred: deferred,
      ticketsActive: 0,
      elapsedMs: Date.now() - state.startTime,
      timeBudgetMs: state.totalMinutes ? state.totalMinutes * 60_000 : undefined,
      cycleProgress: state._cycleProgress,
    };
    state.displayAdapter.progressUpdate(snapshot);
  };

  // Helper to record outcome after processing
  const recordOutcome = async (proposal: TicketProposal, result: ProposalResult, otherTitles: string[]) => {
    if (result.mergeConflictDeferred) {
      // Don't record dedup entry — we want the re-injected proposal to pass dedup
      // Don't count as failed — it will be retried next cycle
      const outcome: TicketOutcome = {
        id: '', title: proposal.title, category: proposal.category, status: 'deferred',
      };
      state.allTicketOutcomes.push(outcome);
      state.cycleOutcomes.push(outcome);
      pushProgress();
      return;
    }
    if (result.noChanges) {
      await recordDedupEntry(state.repoRoot, proposal.title, false, 'no_changes', undefined, proposal.files ?? proposal.allowed_paths);
      const outcome: TicketOutcome = { id: '', title: proposal.title, category: proposal.category, status: 'no_changes' };
      state.allTicketOutcomes.push(outcome);
      state.cycleOutcomes.push(outcome);
      pushProgress();
      return;
    }
    if (result.success) {
      state.totalPrsCreated++;
      if (result.prUrl) state.allPrUrls.push(result.prUrl);
      if (result.prUrl) state.pendingPrUrls.push(result.prUrl);
      // Comment back on GitHub issue if this ticket originated from one
      if (result.prUrl && proposal.metadata?.github_issue_number) {
        commentOnIssue({
          repoRoot: state.repoRoot,
          issueNumber: proposal.metadata.github_issue_number as number,
          prUrl: result.prUrl,
          ticketTitle: proposal.title,
        });
      }
      const verifiedFiles = result.actualChangedFiles ?? proposal.files ?? proposal.allowed_paths ?? [];
      await recordDedupEntry(state.repoRoot, proposal.title, true, undefined, otherTitles, verifiedFiles);
      recordCategoryOutcome(state.repoRoot, proposal.category, true);
      pushRecentDiff(state.repoRoot, { title: proposal.title, summary: `${verifiedFiles.length} files`, files: verifiedFiles, cycle: state.cycleCount });
      recordQualitySignal(state.repoRoot, result.wasRetried ? 'retried' : 'first_pass');
      if (state.autoConf.learningsEnabled) {
        // Prefer actual git-verified changed files over proposal's planned files
        const changedFiles = result.actualChangedFiles ?? proposal.files ?? proposal.allowed_paths ?? [];
        const structured: StructuredKnowledge | undefined = changedFiles.length > 1
          ? { cochange_files: changedFiles.filter(f => !f.includes('*')), pattern_type: 'dependency' }
          : undefined;
        addLearning(state.repoRoot, {
          text: `${proposal.category}: ${proposal.title} [${changedFiles.length} files${proposal.rationale ? ', ' + proposal.rationale.slice(0, 80) : ''}]`.slice(0, 200),
          category: 'pattern',
          source: { type: 'ticket_success', detail: proposal.category },
          tags: extractTags(changedFiles, []),
          structured,
        });
      }
      // Record learning application — track that injected learnings were actually used
      if (result.injectedLearningIds?.length) {
        recordApplication(state.repoRoot, result.injectedLearningIds);
      }
      // Record learning outcome — learnings injected into this ticket succeeded
      if (result.injectedLearningIds?.length) {
        recordLearningOutcome(state.repoRoot, result.injectedLearningIds, true);
      }
      // Record fix outcome in journal
      try {
        const finding = proposalToFinding(proposal);
        appendFixOutcome(getPromptwheelDir(state.repoRoot), {
          finding_id: finding.id,
          ticket_id: '',
          success: true,
          completed_at: new Date().toISOString(),
          files_changed: result.actualChangedFiles ?? proposal.files ?? [],
          pr_url: result.prUrl,
          duration_ms: result.phaseTiming?.executeMs,
          cost_usd: result.costUsd,
        });
      } catch { /* non-critical */ }

      const outcome: TicketOutcome = {
        id: '', title: proposal.title, category: proposal.category, status: 'completed', prUrl: result.prUrl,
        costUsd: result.costUsd, inputTokens: result.inputTokens, outputTokens: result.outputTokens,
        phaseTiming: result.phaseTiming,
      };
      state.allTicketOutcomes.push(outcome);
      state.cycleOutcomes.push(outcome);
    } else {
      state.totalFailed++;
      const failFiles = proposal.files ?? proposal.allowed_paths ?? [];
      await recordDedupEntry(state.repoRoot, proposal.title, false, (result.failureReason as any) ?? 'agent_error', undefined, failFiles);
      recordCategoryOutcome(state.repoRoot, proposal.category, false);
      // Record learning outcome — learnings injected into this ticket failed
      if (result.injectedLearningIds?.length) {
        recordLearningOutcome(state.repoRoot, result.injectedLearningIds, false);
      }
      // Record fix failure in journal
      try {
        const finding = proposalToFinding(proposal);
        appendFixOutcome(getPromptwheelDir(state.repoRoot), {
          finding_id: finding.id,
          ticket_id: '',
          success: false,
          completed_at: new Date().toISOString(),
          failure_reason: result.failureReason ?? 'agent_error',
          duration_ms: result.phaseTiming?.executeMs,
          cost_usd: result.costUsd,
        });
      } catch { /* non-critical */ }

      const outcome: TicketOutcome = { id: '', title: proposal.title, category: proposal.category, status: 'failed', failureReason: result.failureReason };
      state.allTicketOutcomes.push(outcome);
      state.cycleOutcomes.push(outcome);
    }
    pushProgress();
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
        await recordOutcome(toProcess[i], result, otherTitles);
        continue;
      }
      await recordOutcome(toProcess[i], result, otherTitles);
      if (i < toProcess.length - 1 && shouldContinue(state)) {
        await sleep(1000);
      }
    }
  } else {
    // Parallel/wave execution — conflict-aware scheduling for all delivery modes
    // Use conflict sensitivity from config (default: 'normal')
    // - 'strict': Any shared directory = conflict (safest, more sequential)
    // - 'normal': Sibling files + conflict-prone patterns (balanced)
    // - 'relaxed': Only direct file overlap (most parallel, riskier)
    const waves: Array<typeof toProcess> = partitionIntoWaves(toProcess, { sensitivity: 'normal' });
    if (state.options.verbose && waves.length > 1) {
      state.displayAdapter.log(chalk.gray(`  Conflict-aware scheduling: ${waves.length} waves`));
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
          await recordOutcome(proposal, r.value, otherTitles);
        } else {
          const reason = r.reason instanceof Error ? r.reason.message : String(r.reason);
          console.error(chalk.red(`  Ticket "${proposal.title}" rejected: ${reason}`));
          await recordOutcome(proposal, { success: false }, otherTitles);
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
        // Build symbol map once — used for merge ordering and structural resolution
        if (conflicted.length > 0) {
          if (state.options.verbose) state.displayAdapter.log(chalk.gray(`  Retrying ${conflicted.length} merge-conflicted ticket(s)...`));
          for (const { proposal, branch } of conflicted) {
            if (!shouldContinue(state)) break;
            const retryResult = await mergeTicketToMilestone(
              state.repoRoot,
              branch,
              state.milestoneWorktreePath,
            );
            if (retryResult.success) {
              state.milestoneTicketCount++;
              state.milestoneTicketSummaries.push(proposal.title);
              if (state.options.verbose) state.displayAdapter.log(chalk.green(`    ✓ ${proposal.title} — merged on retry`));
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
