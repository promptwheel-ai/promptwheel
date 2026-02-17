/**
 * TuiDisplayAdapter — drives the neo-blessed TUI for live agent output streaming.
 *
 * Activated by --tui flag. Shows a sidebar with ticket list and a main pane
 * with live scrolling output from the currently selected ticket.
 */

import { createRequire } from 'node:module';

const _require = createRequire(import.meta.url);
const CLI_VERSION: string = _require('../../package.json').version;

import { AutoScreen } from '../tui/screens/auto.js';
import type { DisplayAdapter, SessionInfo, BatchStatus } from './display-adapter.js';

export interface TuiDisplayAdapterOptions {
  repoRoot: string;
  onQuit: () => void;
  onStatus?: () => void;
}

export class TuiDisplayAdapter implements DisplayAdapter {
  private autoScreen: AutoScreen;
  private sessionInfo: SessionInfo | null = null;

  constructor(opts: TuiDisplayAdapterOptions) {
    this.autoScreen = new AutoScreen({
      version: CLI_VERSION,
      deliveryMode: 'direct',
      repoRoot: opts.repoRoot,
      onQuit: opts.onQuit,
    });
  }

  sessionStarted(info: SessionInfo): void {
    this.sessionInfo = info;
    this.autoScreen.setSessionInfo({
      startTime: info.startTime,
      endTime: info.endTime,
      cycleCount: 0,
    });
  }

  sessionEnded(): void {
    // No-op: screen stays up until destroy()
  }

  scoutStarted(scope: string, cycle: number): void {
    if (this.sessionInfo) {
      this.autoScreen.setSessionInfo({
        startTime: this.sessionInfo.startTime,
        endTime: this.sessionInfo.endTime,
        cycleCount: cycle,
      });
    }
    this.autoScreen.showScoutProgress(`Scouting ${scope}...`);
  }

  scoutProgress(msg: string): void {
    this.autoScreen.showScoutProgress(msg);
  }

  scoutBatchProgress(statuses: BatchStatus[], totalBatches: number, totalProposals: number): void {
    this.autoScreen.showScoutBatchProgress(statuses, totalBatches, totalProposals);
  }

  scoutCompleted(proposalCount: number): void {
    this.autoScreen.showScoutProgress(`Scouting complete — ${proposalCount} proposal${proposalCount !== 1 ? 's' : ''} found`);
  }

  scoutFailed(error: string): void {
    this.autoScreen.showScoutProgress(`Scout failed: ${error}`);
  }

  scoutRawOutput(chunk: string): void {
    this.autoScreen.appendScoutOutput(chunk);
  }

  ticketAdded(id: string, title: string, slotLabel: string): void {
    this.autoScreen.addTicket(id, title, slotLabel);
  }

  ticketProgress(id: string, msg: string): void {
    this.autoScreen.updateTicketStatus(id, msg);
  }

  ticketRawOutput(id: string, chunk: string): void {
    this.autoScreen.appendOutput(id, chunk);
  }

  ticketDone(id: string, success: boolean, msg: string): void {
    this.autoScreen.markTicketDone(id, success, msg);
  }

  log(msg: string): void {
    this.autoScreen.showLog(msg);
  }

  destroy(): void {
    this.autoScreen.destroy();
  }
}
