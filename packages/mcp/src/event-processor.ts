/**
 * Event Processor — handles ingested events and triggers state transitions.
 *
 * When the client calls `blockspool_ingest_event`, this module processes
 * the event and updates RunState accordingly (phase transitions, counters, etc).
 */

import type { DatabaseAdapter } from '@blockspool/core';
import type { Project } from '@blockspool/core';
import { RunManager } from './run-manager.js';
import type { EventType } from './types.js';
import { filterAndCreateTickets } from './proposals.js';
import { ingestTicketEvent } from './ticket-worker.js';
import type { EventContext } from './event-helpers.js';

// Re-export public types for backward compatibility
export type { ProcessResult, QaErrorClass } from './event-helpers.js';
export { classifyQaError } from './event-helpers.js';

import type { ProcessResult } from './event-helpers.js';
import { handleScoutOutput, handleProposalsReviewed, handleProposalsFiltered } from './event-handlers-scout.js';
import { handlePlanSubmitted, handleTicketResult, handlePrCreated } from './event-handlers-ticket.js';
import { handleQaCommandResult, handleQaPassed, handleQaFailed } from './event-handlers-qa.js';

export async function processEvent(
  run: RunManager,
  db: DatabaseAdapter,
  type: EventType,
  payload: Record<string, unknown>,
  project?: Project,
): Promise<ProcessResult> {
  const s = run.require();

  // Ensure learnings loaded for any event handler that might need them
  run.ensureLearningsLoaded();

  // ---------------------------------------------------------------------------
  // Parallel execution: forward ticket-specific events to ticket workers
  // ---------------------------------------------------------------------------
  // When in PARALLEL_EXECUTE phase, events like PR_CREATED, TICKET_RESULT, etc.
  // should be routed to the ticket worker, not processed at session level.
  // This handles the case where the user calls blockspool_ingest_event instead
  // of blockspool_ticket_event for ticket completion.
  const TICKET_WORKER_EVENTS = new Set([
    'PR_CREATED', 'TICKET_RESULT', 'PLAN_SUBMITTED', 'QA_PASSED', 'QA_FAILED', 'QA_COMMAND_RESULT',
  ]);

  if (s.phase === 'PARALLEL_EXECUTE' && TICKET_WORKER_EVENTS.has(type)) {
    const ticketId = payload['ticket_id'] as string | undefined;
    if (ticketId && run.getTicketWorker(ticketId)) {
      // Forward to ticket worker
      const ctx = { run, db, project: project ?? { id: s.project_id, rootPath: run.rootPath } as Project };
      const result = await ingestTicketEvent(ctx, ticketId, type, payload);
      return {
        processed: result.processed,
        phase_changed: false,
        message: result.message,
      };
    }
  }

  const ctx: EventContext = { run, db, project };

  switch (type) {
    // -----------------------------------------------------------------
    // Scout events
    // -----------------------------------------------------------------
    case 'SCOUT_OUTPUT': return handleScoutOutput(ctx, payload);
    case 'PROPOSALS_REVIEWED': return handleProposalsReviewed(ctx, payload);
    case 'PROPOSALS_FILTERED': return handleProposalsFiltered(ctx, payload);

    // -----------------------------------------------------------------
    // Plan events
    // -----------------------------------------------------------------
    case 'PLAN_SUBMITTED': return handlePlanSubmitted(ctx, payload);

    // -----------------------------------------------------------------
    // Execution events
    // -----------------------------------------------------------------
    case 'TICKET_RESULT': return handleTicketResult(ctx, payload);

    // -----------------------------------------------------------------
    // QA events
    // -----------------------------------------------------------------
    case 'QA_COMMAND_RESULT': return handleQaCommandResult(ctx, payload);
    case 'QA_PASSED': return handleQaPassed(ctx, payload);
    case 'QA_FAILED': return handleQaFailed(ctx, payload);

    // -----------------------------------------------------------------
    // PR events
    // -----------------------------------------------------------------
    case 'PR_CREATED': return handlePrCreated(ctx, payload);

    // -----------------------------------------------------------------
    // User overrides
    // -----------------------------------------------------------------
    case 'USER_OVERRIDE': {
      if (typeof payload['hint'] === 'string') {
        run.addHint(payload['hint'] as string);
        return { processed: true, phase_changed: false, message: 'Hint added' };
      }
      if (payload['cancel'] === true) {
        run.setPhase('DONE');
        return {
          processed: true,
          phase_changed: true,
          new_phase: 'DONE',
          message: 'Session cancelled by user',
        };
      }
      if (payload['skip_review'] === true) {
        s.skip_review = true;
        // If there are pending proposals waiting for review, create tickets immediately
        if (s.pending_proposals && s.pending_proposals.length > 0) {
          const pendingProposals = s.pending_proposals;
          s.pending_proposals = null;
          const result = await filterAndCreateTickets(run, db, pendingProposals);
          if (result.created_ticket_ids.length > 0) {
            run.setPhase('NEXT_TICKET');
            return {
              processed: true,
              phase_changed: true,
              new_phase: 'NEXT_TICKET',
              message: `skip_review enabled, created ${result.created_ticket_ids.length} tickets from pending proposals`,
            };
          }
        }
        return { processed: true, phase_changed: false, message: 'skip_review enabled' };
      }
      return { processed: true, phase_changed: false, message: 'User override recorded' };
    }

    // -----------------------------------------------------------------
    // Default: just record
    // -----------------------------------------------------------------
    default:
      return { processed: true, phase_changed: false, message: `Event ${type} recorded` };
  }
}
