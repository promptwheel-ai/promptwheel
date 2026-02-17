/**
 * TUI Auto Screen — unified log with ticket bookmarks.
 *
 * Layout:
 * ┌─ Header ──────────────────────────────────────────────────────┐
 * │ PromptWheel v0.5.63 │ direct │ 12m │ Cycle 2 │ 3 done         │
 * ├───────────────────────────────────────────────────────────────┤
 * │ > Fix auth  ✓ Add tests  ✗ Refactor  ○ Update docs           │
 * ├───────────────────────────────────────────────────────────────┤
 * │ [scout] Scouting packages/core/**...                          │
 * │ [scout] Complete: 3 proposals                                 │
 * │                                                               │
 * │ ═══ [1] Fix auth validation ═══                               │
 * │ Reading src/auth/login.ts...                                  │
 * │ Found validateToken function on line 42.                      │
 * │ Writing src/auth/login.ts...                                  │
 * │ --- DONE: Committed to direct branch ---                      │
 * │                                                               │
 * │ ═══ [2] Add tests ═══                                         │
 * │ Reading src/auth/login.test.ts...                             │
 * │                                                               │
 * ├───────────────────────────────────────────────────────────────┤
 * │ >                                                             │
 * └───────────────────────────────────────────────────────────────┘
 */

import blessed from 'neo-blessed';
import type { Widgets } from 'neo-blessed';
import { createWriteStream, mkdirSync } from 'node:fs';
import type { WriteStream } from 'node:fs';
import { join } from 'node:path';
import { TicketOutputBuffer } from '../ticket-output-buffer.js';

export type TicketStatus = 'running' | 'done' | 'failed' | 'pending';

interface TicketEntry {
  id: string;
  title: string;
  slotLabel: string;
  status: TicketStatus;
  bookmarkLine: number; // line in unified log where this ticket starts
}

export interface AutoScreenOptions {
  version: string;
  deliveryMode: string;
  repoRoot?: string;
  onInput?: (text: string) => void;
  onQuit?: () => void;
}

const STATUS_ICONS: Record<TicketStatus, string> = {
  running: '{yellow-fg}>{/yellow-fg}',
  done: '{green-fg}✓{/green-fg}',
  failed: '{red-fg}✗{/red-fg}',
  pending: '{gray-fg}○{/gray-fg}',
};

export class AutoScreen {
  private screen: Widgets.Screen;
  private header: Widgets.BoxElement;
  private ticketBar: Widgets.BoxElement;
  private mainPane: Widgets.BoxElement;
  private inputBar: Widgets.BoxElement;

  private tickets: TicketEntry[] = [];
  private selectedIndex = -1;
  private following = true;
  private unifiedLog: TicketOutputBuffer;
  private batchProgressStart = -1; // line where batch progress block starts
  private lastStatusLine = -1;     // line of last status update (for in-place replace)
  private lastRawChunk = '';        // dedup consecutive identical raw output

  // Session info for header
  private cycleCount = 0;
  private doneCount = 0;
  private failedCount = 0;
  private startTime = Date.now();
  private endTime: number | undefined;

  private headerTimer: ReturnType<typeof setInterval> | null = null;
  private destroyed = false;
  private logStream: WriteStream | null = null;

  constructor(private opts: AutoScreenOptions) {
    this.unifiedLog = new TicketOutputBuffer(50_000);

    this.screen = blessed.screen({
      smartCSR: true,
      title: `PromptWheel v${opts.version}`,
      fullUnicode: true,
      tags: true,
    });

    // Log file for reviewing output outside TUI
    if (opts.repoRoot) {
      try {
        const logDir = join(opts.repoRoot, '.promptwheel');
        mkdirSync(logDir, { recursive: true });
        this.logStream = createWriteStream(join(logDir, 'tui.log'), { flags: 'w' });
        this.writeLog(`PromptWheel v${opts.version} — TUI session started at ${new Date().toISOString()}\n`);
      } catch {
        // Non-fatal
      }
    }

    // Header bar (row 0)
    this.header = blessed.box({
      parent: this.screen,
      top: 0,
      left: 0,
      width: '100%',
      height: 1,
      tags: true,
      style: { fg: 'white', bg: 'blue', bold: true },
    });

    // Ticket bar (rows 1-2, bordered)
    this.ticketBar = blessed.box({
      parent: this.screen,
      top: 1,
      left: 0,
      width: '100%',
      height: 3,
      border: { type: 'line' },
      tags: true,
      style: {
        border: { fg: 'gray' },
        fg: 'white',
      },
    });

    // Main output pane (full width, tags disabled for raw output)
    this.mainPane = blessed.box({
      parent: this.screen,
      top: 4,
      left: 0,
      width: '100%',
      height: '100%-7', // header(1) + ticketBar(3) + inputBar(3)
      border: { type: 'line' },
      tags: false,
      scrollable: true,
      alwaysScroll: true,
      mouse: true,
      keys: true,
      scrollbar: {
        ch: '│',
        style: { bg: 'blue' },
      },
      style: {
        border: { fg: 'gray' },
      },
    });

    // Input bar at bottom
    this.inputBar = blessed.box({
      parent: this.screen,
      bottom: 0,
      left: 0,
      width: '100%',
      height: 3,
      border: { type: 'line' },
      tags: true,
      style: {
        border: { fg: 'cyan' },
        fg: 'white',
      },
      content: ' {cyan-fg}>{/cyan-fg}',
    });

    this.setupKeys();
    this.updateHeader();
    this.updateTicketBar();

    // Refresh header every second
    this.headerTimer = setInterval(() => {
      if (this.destroyed) return;
      this.updateHeader();
    }, 1000);

    // Handle resize
    this.screen.on('resize', () => {
      this.updateTicketBar();
      this.screen.render();
    });

    this.screen.render();
  }

  private setupKeys(): void {
    // Tab: cycle through tickets (jump to bookmark)
    this.screen.key('tab', () => {
      if (this.tickets.length === 0) return;
      this.selectedIndex = (this.selectedIndex + 1) % this.tickets.length;
      this.jumpToTicket(this.selectedIndex);
    });

    // j/k: navigate tickets
    this.screen.key('j', () => {
      if (this.tickets.length === 0) return;
      this.selectedIndex = Math.min(this.selectedIndex + 1, this.tickets.length - 1);
      this.jumpToTicket(this.selectedIndex);
    });
    this.screen.key('k', () => {
      if (this.tickets.length === 0) return;
      this.selectedIndex = Math.max(this.selectedIndex - 1, 0);
      this.jumpToTicket(this.selectedIndex);
    });

    // Scroll output pane
    this.screen.key(['up'], () => {
      this.following = false;
      this.mainPane.scroll(-1);
      this.screen.render();
    });
    this.screen.key(['down'], () => {
      this.mainPane.scroll(1);
      this.screen.render();
    });
    this.screen.key(['pageup', 'S-up'], () => {
      this.following = false;
      this.mainPane.scroll(-10);
      this.screen.render();
    });
    this.screen.key(['pagedown', 'S-down'], () => {
      this.mainPane.scroll(10);
      this.screen.render();
    });

    // G or End: resume auto-scroll
    this.screen.key(['G', 'end'], () => {
      this.following = true;
      this.mainPane.setScrollPerc(100);
      this.screen.render();
    });

    // Ctrl+C: first graceful, second force-quit
    let ctrlCCount = 0;
    this.screen.key(['C-c'], () => {
      ctrlCCount++;
      if (ctrlCCount >= 2) {
        this.destroy();
        process.exit(1);
      }
      this.inputBar.setContent(' {red-fg}Shutdown requested. Press Ctrl+C again to force quit.{/red-fg}');
      this.screen.render();
      this.opts.onQuit?.();
    });
  }

  private updateHeader(): void {
    if (this.destroyed) return;
    const elapsed = this.formatElapsed(Date.now() - this.startTime);
    const timeLeft = this.endTime
      ? ` │ ${this.formatElapsed(Math.max(0, this.endTime - Date.now()))} left`
      : '';
    const cycle = this.cycleCount > 0 ? ` │ Cycle ${this.cycleCount}` : '';
    const counts = ` │ ${this.doneCount} done${this.failedCount > 0 ? ` · ${this.failedCount} failed` : ''}`;

    const content = ` {bold}PromptWheel v${this.opts.version}{/bold} │ ${this.opts.deliveryMode} │ ${elapsed}${timeLeft}${cycle}${counts}`;
    this.header.setContent(content);
    this.screen.render();
  }

  private updateTicketBar(): void {
    if (this.tickets.length === 0) {
      this.ticketBar.setContent(' {gray-fg}Waiting for scout...{/gray-fg}');
      return;
    }

    const screenWidth = (this.screen.width as number) - 4; // borders + padding
    const parts: string[] = [];

    for (let i = 0; i < this.tickets.length; i++) {
      const t = this.tickets[i];
      const icon = STATUS_ICONS[t.status];
      const selected = i === this.selectedIndex;
      const maxTitleLen = Math.floor(screenWidth / Math.min(this.tickets.length, 5)) - 6;
      const title = t.title.length > maxTitleLen
        ? t.title.slice(0, maxTitleLen - 2) + '..'
        : t.title;

      if (selected) {
        parts.push(`${icon} {bold}{underline}${title}{/underline}{/bold}`);
      } else {
        parts.push(`${icon} ${title}`);
      }
    }

    this.ticketBar.setContent(' ' + parts.join(' {gray-fg}│{/gray-fg} '));
  }

  private formatElapsed(ms: number): string {
    const totalSec = Math.floor(ms / 1000);
    if (totalSec < 60) return `${totalSec}s`;
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    if (min < 60) return `${min}m${sec > 0 ? `${sec}s` : ''}`;
    const hr = Math.floor(min / 60);
    const remMin = min % 60;
    return `${hr}h${remMin}m`;
  }

  private appendToUnifiedLog(text: string): void {
    this.unifiedLog.append(text);
    this.mainPane.setContent(this.unifiedLog.getContent());
    if (this.following) this.mainPane.setScrollPerc(100);
    this.screen.render();
  }

  private jumpToTicket(index: number): void {
    if (index < 0 || index >= this.tickets.length) return;
    this.selectedIndex = index;
    this.following = false;
    const ticket = this.tickets[index];

    // Scroll to the bookmark line
    const targetLine = ticket.bookmarkLine;
    this.mainPane.setContent(this.unifiedLog.getContent());
    this.mainPane.scrollTo(targetLine);

    this.updateTicketBar();
    this.screen.render();
  }

  // Public API

  setSessionInfo(info: { startTime: number; endTime?: number; cycleCount: number }): void {
    this.startTime = info.startTime;
    this.endTime = info.endTime;
    this.cycleCount = info.cycleCount;
    this.updateHeader();
  }

  addTicket(id: string, title: string, slotLabel: string): void {
    this.lastStatusLine = -1;
    this.lastRawChunk = '';
    this.writeLog(`\n=== TICKET [${id}] ${title} (${slotLabel}) ===\n`);
    const bookmarkLine = this.unifiedLog.lineCount;
    this.appendToUnifiedLog(`\n═══ [${slotLabel}] ${title} ═══\n`);
    const entry: TicketEntry = {
      id,
      title,
      slotLabel,
      status: 'running',
      bookmarkLine,
    };
    this.tickets.push(entry);
    this.selectedIndex = this.tickets.length - 1;
    this.updateTicketBar();
    this.screen.render();
  }

  updateTicketStatus(id: string, msg: string): void {
    const entry = this.tickets.find(t => t.id === id);
    if (!entry) return;
    // Replace previous status line in-place (avoids "Running... (4m9s)" spam)
    if (this.lastStatusLine >= 0) {
      this.unifiedLog.truncateTo(this.lastStatusLine);
    }
    this.lastStatusLine = this.unifiedLog.lineCount;
    this.appendToUnifiedLog(`[${entry.slotLabel}] ${msg}\n`);
  }

  appendOutput(id: string, chunk: string): void {
    const entry = this.tickets.find(t => t.id === id);
    if (!entry) return;
    // Dedup consecutive identical chunks (codex emits same thinking block multiple times)
    if (chunk === this.lastRawChunk && chunk.length > 20) return;
    this.lastRawChunk = chunk;
    this.lastStatusLine = -1; // real output arrived, stop replacing status line
    this.writeLog(chunk);
    this.appendToUnifiedLog(chunk);
  }

  markTicketDone(id: string, success: boolean, msg: string): void {
    const entry = this.tickets.find(t => t.id === id);
    if (!entry) return;
    this.lastStatusLine = -1;
    this.lastRawChunk = '';
    entry.status = success ? 'done' : 'failed';
    const marker = success ? 'DONE' : 'FAILED';
    this.writeLog(`\n--- ${marker} [${id}]: ${msg} ---\n`);
    this.appendToUnifiedLog(`\n--- ${marker} [${entry.slotLabel}]: ${msg} ---\n`);

    if (success) this.doneCount++;
    else this.failedCount++;

    this.updateTicketBar();
    this.updateHeader();
    this.screen.render();
  }

  showScoutProgress(msg: string): void {
    this.writeLog(`[scout] ${msg}\n`);
    if (msg.toLowerCase().includes('complete')) {
      this.resetBatchProgress();
    }
    this.appendToUnifiedLog(`[scout] ${msg}\n`);
  }

  appendScoutOutput(chunk: string): void {
    this.writeLog(chunk);
    // Filter out JSONL telemetry lines and strip ANSI from remaining text
    const lines = chunk.split('\n');
    const filtered: string[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      // Skip JSONL telemetry (lines that parse as JSON objects)
      if (trimmed.startsWith('{')) {
        try { JSON.parse(trimmed); continue; } catch { /* not JSON, keep it */ }
      }
      // Skip empty lines that are just ANSI escape sequences
      // eslint-disable-next-line no-control-regex
      const clean = line.replace(/\x1b\[[0-9;]*m/g, '');
      if (clean.trim() || line === '') {
        filtered.push(clean);
      }
    }
    const output = filtered.join('\n');
    if (output.trim()) {
      this.appendToUnifiedLog(output);
    }
  }

  showScoutBatchProgress(statuses: Array<{ index: number; status: string; proposals?: number }>, totalBatches: number, totalProposals: number): void {
    const lines: string[] = [];
    lines.push(`Scouting ${totalBatches} batches (${totalProposals} proposals found)`);
    for (let i = 0; i < totalBatches; i++) {
      const s = statuses.find(b => b.index === i);
      if (!s || s.status === 'waiting') {
        lines.push(`  ○ Batch ${i + 1}  waiting`);
      } else if (s.status === 'running') {
        lines.push(`  > Batch ${i + 1}  analyzing...`);
      } else if (s.status === 'done') {
        const pStr = s.proposals ? `${s.proposals} proposal${s.proposals !== 1 ? 's' : ''}` : 'no proposals';
        lines.push(`  ✓ Batch ${i + 1}  ${pStr}`);
      } else if (s.status === 'failed') {
        lines.push(`  ✗ Batch ${i + 1}  failed`);
      }
    }
    this.writeLog(`[scout] ${lines.join(' | ')}\n`);

    // Replace previous batch block in-place instead of appending
    if (this.batchProgressStart >= 0) {
      this.unifiedLog.truncateTo(this.batchProgressStart);
    } else {
      this.batchProgressStart = this.unifiedLog.lineCount;
    }
    this.appendToUnifiedLog(lines.join('\n') + '\n');
  }

  /** Reset batch progress tracker (call when scout finishes) */
  private resetBatchProgress(): void {
    this.batchProgressStart = -1;
  }

  showLog(msg: string): void {
    this.writeLog(`[log] ${msg}\n`);
    // Strip ANSI escape codes — mainPane has tags:false so they render as literal text
    // eslint-disable-next-line no-control-regex
    const clean = msg.replace(/\x1b\[[0-9;]*m/g, '');
    this.appendToUnifiedLog(clean + '\n');
  }

  private writeLog(msg: string): void {
    // eslint-disable-next-line no-control-regex
    this.logStream?.write(msg.replace(/\x1b\[[0-9;]*m/g, ''));
  }

  destroy(): void {
    this.destroyed = true;
    if (this.headerTimer) {
      clearInterval(this.headerTimer);
      this.headerTimer = null;
    }
    this.writeLog(`\nSession ended at ${new Date().toISOString()}\n`);
    this.logStream?.end();
    this.logStream = null;
    this.screen.destroy();
  }
}
