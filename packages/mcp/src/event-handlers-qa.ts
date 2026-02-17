import { repos } from '@blockspool/core';
import type { EventContext, ProcessResult } from './event-helpers.js';
import {
  classifyQaError,
  maxRetriesForClass,
  extractErrorSignature,
  recordSectorOutcome,
  recordTicketDedup,
} from './event-helpers.js';
import { recordCommandFailure, recordDiff } from './spindle.js';
import { recordQualitySignal } from './run-state-bridge.js';
import { recordQaCommandResult } from './qa-stats.js';
import { addLearning, confirmLearning, extractTags, type StructuredKnowledge } from './learnings.js';

export async function handleQaCommandResult(ctx: EventContext, payload: Record<string, unknown>): Promise<ProcessResult> {
  const s = ctx.run.require();

  if (s.phase !== 'QA') {
    return { processed: true, phase_changed: false, message: 'QA command result outside QA phase' };
  }

  const command = payload['command'] as string;
  const success = payload['success'] as boolean;
  const output = (payload['output'] ?? '') as string;
  const durationMs = (payload['durationMs'] ?? 0) as number;
  const timedOut = (payload['timedOut'] ?? false) as boolean;

  // Record command failure in spindle state
  if (!success) {
    recordCommandFailure(s.spindle, command, output);
  }

  // Record QA command stats for wheel tracking
  recordQaCommandResult(ctx.run.rootPath, command, {
    passed: success,
    durationMs,
    timedOut,
    skippedPreExisting: false,
  });

  // Save command output as artifact
  const cmdSlug = command.replace(/[^a-z0-9]/gi, '-').slice(0, 30);
  ctx.run.saveArtifact(
    `${s.step_count}-qa-${cmdSlug}-${success ? 'pass' : 'fail'}.log`,
    `$ ${command}\n\n${output}`,
  );

  return {
    processed: true,
    phase_changed: false,
    message: `QA command ${success ? 'passed' : 'failed'}: ${command}`,
  };
}

export async function handleQaPassed(ctx: EventContext, payload: Record<string, unknown>): Promise<ProcessResult> {
  const s = ctx.run.require();

  if (s.phase !== 'QA') {
    return { processed: true, phase_changed: false, message: 'QA passed outside QA phase' };
  }

  // Confirm injected learnings on success
  if (s.learnings_enabled && s.injected_learning_ids.length > 0) {
    for (const id of s.injected_learning_ids) {
      confirmLearning(ctx.run.rootPath, id);
    }
    s.injected_learning_ids = [];
  }

  // Record quality signal for wheel tracking
  recordQualitySignal(ctx.run.rootPath, 'qa_pass');

  // Record success learning with cochange data from the plan
  if (s.learnings_enabled && s.current_ticket_id) {
    try {
      const ticket = await repos.tickets.getById(ctx.db, s.current_ticket_id);
      if (ticket) {
        // Extract cochange files from the approved plan (files that changed together)
        const planFiles = s.current_ticket_plan?.files_to_touch?.map(f => f.path) ?? [];
        const structured: StructuredKnowledge | undefined = planFiles.length > 1
          ? { cochange_files: planFiles, pattern_type: 'dependency' }
          : undefined;
        addLearning(ctx.run.rootPath, {
          text: `${ticket.category ?? 'refactor'} succeeded: ${ticket.title}`.slice(0, 200),
          category: 'pattern',
          source: { type: 'ticket_success', detail: ticket.category ?? 'refactor' },
          tags: extractTags(ticket.allowedPaths ?? [], ticket.verificationCommands ?? []),
          structured,
        });
      }
    } catch (err) {
      console.warn(`[blockspool] record success learning: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Mark ticket done in DB
  if (s.current_ticket_id) {
    await repos.tickets.updateStatus(ctx.db, s.current_ticket_id, 'done');
  }

  // Save QA summary artifact
  ctx.run.saveArtifact(
    `${s.step_count}-qa-summary.json`,
    JSON.stringify({
      ticket_id: s.current_ticket_id,
      status: 'passed',
      attempt: s.qa_retries + 1,
      ...payload,
    }, null, 2),
  );

  // Skip PR phase when not creating PRs
  if (!s.create_prs) {
    await recordTicketDedup(ctx.db, ctx.run.rootPath, s.current_ticket_id, true);
    recordSectorOutcome(ctx.run.rootPath, s.current_sector_path, 'success');
    ctx.run.completeTicket();
    ctx.run.appendEvent('TICKET_COMPLETED_NO_PR', payload);
    ctx.run.setPhase('NEXT_TICKET');
    return {
      processed: true,
      phase_changed: true,
      new_phase: 'NEXT_TICKET',
      message: 'QA passed, PRs disabled — moving to NEXT_TICKET',
    };
  }

  // Move to PR
  ctx.run.setPhase('PR');
  return {
    processed: true,
    phase_changed: true,
    new_phase: 'PR',
    message: 'QA passed, moving to PR',
  };
}

export async function handleQaFailed(ctx: EventContext, payload: Record<string, unknown>): Promise<ProcessResult> {
  const s = ctx.run.require();

  if (s.phase !== 'QA') {
    return { processed: true, phase_changed: false, message: 'QA failed outside QA phase' };
  }

  // Record quality signal for wheel tracking
  recordQualitySignal(ctx.run.rootPath, 'qa_fail');

  // Record QA failure in spindle (for stall detection — no progress)
  recordDiff(s.spindle, null);

  // Save failure artifact
  ctx.run.saveArtifact(
    `${s.step_count}-qa-failed-attempt-${s.qa_retries + 1}.json`,
    JSON.stringify({
      ticket_id: s.current_ticket_id,
      attempt: s.qa_retries + 1,
      ...payload,
    }, null, 2),
  );

  s.qa_retries++;

  // Store failure context for critic block injection on retry
  const failedCmds = (payload['failed_commands'] ?? payload['command'] ?? '') as string | string[];
  const errorOutput = (payload['error'] ?? payload['output'] ?? '') as string;
  s.last_qa_failure = {
    failed_commands: Array.isArray(failedCmds) ? failedCmds : failedCmds ? [failedCmds] : [],
    error_output: errorOutput.slice(0, 500),
  };

  // Classify error to determine retry strategy
  const errorClass = classifyQaError(errorOutput);
  const maxRetries = maxRetriesForClass(errorClass);

  if (s.qa_retries >= maxRetries) {
    // Fetch ticket once for both learning and dedup
    const ticket = s.current_ticket_id ? await repos.tickets.getById(ctx.db, s.current_ticket_id) : null;
    // Record learning on final QA failure
    if (s.learnings_enabled) {
      const failedCmds = (payload['failed_commands'] ?? payload['command'] ?? '') as string;
      const errorOutput = (payload['error'] ?? payload['output'] ?? '') as string;
      const errorSummary = errorOutput.slice(0, 100);
      const errorSig = extractErrorSignature(errorOutput);
      const structured: StructuredKnowledge = {
        pattern_type: errorClass === 'environment' ? 'environment' : 'antipattern',
        failure_context: {
          command: failedCmds || (ticket?.verificationCommands?.[0] ?? ''),
          error_signature: errorSig ?? errorSummary.slice(0, 120),
        },
        fragile_paths: ticket?.allowedPaths?.filter(p => !p.includes('*')),
      };
      addLearning(ctx.run.rootPath, {
        text: `QA fails on ${ticket?.title ?? 'unknown'} — ${errorSummary || failedCmds}`.slice(0, 200),
        category: 'gotcha',
        source: { type: 'qa_failure', detail: failedCmds },
        tags: extractTags(ticket?.allowedPaths ?? [], ticket?.verificationCommands ?? []),
        structured,
      });
    }
    // Record failed ticket in dedup memory + sector failure
    await recordTicketDedup(ctx.db, ctx.run.rootPath, s.current_ticket_id, false, 'qa_failed', ticket);
    recordSectorOutcome(ctx.run.rootPath, s.current_sector_path, 'failure');
    // Give up on this ticket
    if (s.current_ticket_id) {
      await repos.tickets.updateStatus(ctx.db, s.current_ticket_id, 'blocked');
      ctx.run.failTicket(`QA failed ${s.qa_retries} times (${errorClass})`);
    }
    ctx.run.setPhase('NEXT_TICKET');
    return {
      processed: true,
      phase_changed: true,
      new_phase: 'NEXT_TICKET',
      message: errorClass === 'environment'
        ? `QA failed (${errorClass} error — not retryable), giving up on ticket`
        : `QA failed ${s.qa_retries}/${maxRetries} times (${errorClass}), giving up on ticket`,
    };
  }

  // Retry: go back to EXECUTE to fix
  ctx.run.setPhase('EXECUTE');
  return {
    processed: true,
    phase_changed: true,
    new_phase: 'EXECUTE',
    message: `QA failed (attempt ${s.qa_retries}/${maxRetries}, ${errorClass}), retrying execution`,
  };
}
