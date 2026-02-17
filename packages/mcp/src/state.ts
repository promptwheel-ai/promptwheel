/**
 * Session state manager (v2)
 *
 * Thin wrapper around RunManager + database.
 * Each MCP server instance has at most one active run.
 */

import type { DatabaseAdapter } from '@promptwheel/core';
import type { Project } from '@promptwheel/core';
import { RunManager } from './run-manager.js';
import type { RunState, SessionConfig } from './types.js';

export class SessionManager {
  readonly run: RunManager;

  constructor(
    readonly db: DatabaseAdapter,
    readonly project: Project,
    readonly projectPath: string,
  ) {
    this.run = new RunManager(projectPath);
  }

  /** Start a new session/run */
  start(config: SessionConfig): RunState {
    return this.run.create(this.project.id, config);
  }

  /** Get active run state or throw */
  requireActive(): RunState {
    return this.run.require();
  }

  /** End the session */
  end(): RunState {
    return this.run.end();
  }

  /** Get current status summary */
  getStatus(): {
    sessionId: string;
    runId: string;
    phase: string;
    stepCount: number;
    budgetRemaining: number;
    ticketsCompleted: number;
    ticketsFailed: number;
    currentTicketId: string | null;
    timeRemainingMs: number | null;
  } {
    const s = this.run.require();
    const timeRemainingMs = s.expires_at
      ? Math.max(0, new Date(s.expires_at).getTime() - Date.now())
      : null;

    return {
      sessionId: s.session_id,
      runId: s.run_id,
      phase: s.phase,
      stepCount: s.step_count,
      budgetRemaining: s.step_budget - s.step_count,
      ticketsCompleted: s.tickets_completed,
      ticketsFailed: s.tickets_failed,
      currentTicketId: s.current_ticket_id,
      timeRemainingMs,
    };
  }
}
