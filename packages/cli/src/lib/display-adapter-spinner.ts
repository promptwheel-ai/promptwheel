/**
 * SpinnerDisplayAdapter — wraps existing spinner + console.log behavior.
 *
 * This is the default adapter used when --tui is not passed.
 * It preserves the exact current behavior: spinners for ticket progress,
 * batch progress for scout, and console.log for everything else.
 */

import chalk from 'chalk';
import {
  createSpinner,
  createBatchProgress,
  type BlockSpinner,
  type BatchProgressDisplay,
} from './spinner.js';
import type { DisplayAdapter, SessionInfo, BatchStatus } from './display-adapter.js';

export class SpinnerDisplayAdapter implements DisplayAdapter {
  private ticketSpinners = new Map<string, BlockSpinner>();
  private scoutSpinner: BlockSpinner | null = null;
  private batchProgress: BatchProgressDisplay | null = null;

  sessionStarted(_info: SessionInfo): void {
    // Banner is already printed by initSession — no-op here
  }

  sessionEnded(): void {
    // Cleanup is handled elsewhere
  }

  scoutStarted(scope: string, _cycle: number): void {
    this.scoutSpinner = createSpinner(`Scouting ${scope}...`, 'stack');
  }

  scoutProgress(msg: string): void {
    this.scoutSpinner?.update(msg);
  }

  scoutBatchProgress(statuses: BatchStatus[], totalBatches: number, totalProposals: number): void {
    if (!this.batchProgress) {
      // Stop the scout spinner and switch to batch progress display
      this.scoutSpinner?.stop();
      this.scoutSpinner = null;
      this.batchProgress = createBatchProgress(totalBatches);
    }
    this.batchProgress.update(statuses, totalProposals);
  }

  scoutCompleted(proposalCount: number): void {
    if (this.batchProgress) {
      this.batchProgress.stop(
        chalk.green(`Scouting complete — ${proposalCount} proposal${proposalCount !== 1 ? 's' : ''} found`)
      );
      this.batchProgress = null;
    } else {
      this.scoutSpinner?.succeed(`Found ${proposalCount} potential improvements`);
      this.scoutSpinner = null;
    }
  }

  scoutFailed(error: string): void {
    if (this.batchProgress) {
      this.batchProgress.stop();
      this.batchProgress = null;
    }
    this.scoutSpinner?.fail(error);
    this.scoutSpinner = null;
  }

  scoutRawOutput(_chunk: string): void {
    // Spinner mode doesn't show raw scout output
  }

  ticketAdded(id: string, _title: string, _slotLabel: string): void {
    const spinner = createSpinner('Setting up...', 'spool');
    this.ticketSpinners.set(id, spinner);
  }

  ticketProgress(id: string, msg: string): void {
    this.ticketSpinners.get(id)?.update(msg);
  }

  ticketRawOutput(_id: string, _chunk: string): void {
    // Spinner mode doesn't show raw output — no-op
  }

  ticketDone(id: string, success: boolean, msg: string): void {
    const spinner = this.ticketSpinners.get(id);
    if (spinner) {
      if (success) {
        spinner.succeed(msg);
      } else {
        spinner.fail(msg);
      }
      this.ticketSpinners.delete(id);
    }
  }

  log(msg: string): void {
    console.log(msg);
  }

  destroy(): void {
    // Clean up any lingering spinners
    for (const spinner of this.ticketSpinners.values()) {
      spinner.stop();
    }
    this.ticketSpinners.clear();
    this.scoutSpinner?.stop();
    this.scoutSpinner = null;
    this.batchProgress?.stop();
    this.batchProgress = null;
  }
}
