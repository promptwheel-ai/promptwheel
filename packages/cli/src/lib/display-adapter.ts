/**
 * DisplayAdapter — abstraction over all UI output during auto mode.
 *
 * Two implementations:
 * - SpinnerDisplayAdapter: wraps current spinner + console.log behavior (default)
 * - TuiDisplayAdapter: drives the neo-blessed TUI (opt-in via --tui)
 */

export interface SessionInfo {
  version: string;
  deliveryMode: string;
  scope: string;
  isContinuous: boolean;
  endTime?: number;
  startTime: number;
  maxPrs: number;
}

export interface BatchStatus {
  index: number;
  status: 'waiting' | 'running' | 'done' | 'failed';
  proposals?: number;
  durationMs?: number;
  error?: string;
}

export interface DisplayAdapter {
  // Session lifecycle
  sessionStarted(info: SessionInfo): void;
  sessionEnded(): void;

  // Scout phase
  scoutStarted(scope: string, cycle: number): void;
  scoutProgress(msg: string): void;
  scoutBatchProgress(statuses: BatchStatus[], totalBatches: number, totalProposals: number): void;
  scoutCompleted(proposalCount: number): void;
  scoutFailed(error: string): void;
  scoutRawOutput(chunk: string): void;

  // Ticket execution
  ticketAdded(id: string, title: string, slotLabel: string): void;
  ticketProgress(id: string, msg: string): void;
  ticketRawOutput(id: string, chunk: string): void;
  ticketDone(id: string, success: boolean, msg: string): void;

  // Generic output (replaces console.log in pipeline)
  log(msg: string): void;

  // Lifecycle
  destroy(): void;
}
