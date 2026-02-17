/**
 * LogDisplayAdapter — plain-text timestamped output for daemon/non-TTY use.
 *
 * No ANSI codes, no spinners, no TTY assumptions. Writes timestamped
 * lines to a logger function (which can write to a file or stdout).
 */

import type { DisplayAdapter, SessionInfo, BatchStatus } from './display-adapter.js';

function ts(): string {
  return new Date().toISOString();
}

export class LogDisplayAdapter implements DisplayAdapter {
  private logger: (msg: string) => void;

  constructor(logger?: (msg: string) => void) {
    this.logger = logger ?? ((msg: string) => console.log(msg));
  }

  sessionStarted(info: SessionInfo): void {
    this.logger(`[${ts()}] session started: version=${info.version} delivery=${info.deliveryMode} scope=${info.scope}`);
  }

  sessionEnded(): void {
    this.logger(`[${ts()}] session ended`);
  }

  scoutStarted(scope: string, cycle: number): void {
    this.logger(`[${ts()}] scout started: scope=${scope} cycle=${cycle}`);
  }

  scoutProgress(msg: string): void {
    this.logger(`[${ts()}] scout: ${msg}`);
  }

  scoutBatchProgress(statuses: BatchStatus[], _totalBatches: number, totalProposals: number): void {
    const done = statuses.filter(s => s.status === 'done').length;
    const running = statuses.filter(s => s.status === 'running').length;
    this.logger(`[${ts()}] scout batch: ${done}/${statuses.length} done, ${running} running, ${totalProposals} proposals`);
  }

  scoutCompleted(proposalCount: number): void {
    this.logger(`[${ts()}] scout completed: ${proposalCount} proposals`);
  }

  scoutFailed(error: string): void {
    this.logger(`[${ts()}] scout failed: ${error}`);
  }

  scoutRawOutput(_chunk: string): void {
    // Omit raw output in log mode to avoid noise
  }

  ticketAdded(id: string, title: string, slotLabel: string): void {
    this.logger(`[${ts()}] ticket added: ${id} "${title}" [${slotLabel}]`);
  }

  ticketProgress(id: string, msg: string): void {
    this.logger(`[${ts()}] ticket ${id}: ${msg}`);
  }

  ticketRawOutput(_id: string, _chunk: string): void {
    // Omit raw output in log mode
  }

  ticketDone(id: string, success: boolean, msg: string): void {
    this.logger(`[${ts()}] ticket ${id} ${success ? 'succeeded' : 'failed'}: ${msg}`);
  }

  log(msg: string): void {
    // Strip ANSI codes for clean log output
    // eslint-disable-next-line no-control-regex
    const clean = msg.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');
    this.logger(`[${ts()}] ${clean}`);
  }

  destroy(): void {
    // No resources to clean up
  }
}
