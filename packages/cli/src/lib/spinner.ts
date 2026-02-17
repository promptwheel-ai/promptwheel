/**
 * Block Spinner — zero-dependency animated spinner for the terminal
 *
 * Uses a sun symbol (☀) that alternates between blue and green.
 * Shows elapsed time automatically so you always know it's alive.
 */

import chalk from 'chalk';

// Sun symbol - the PromptWheel signature
const SUN = '☀';

// Color cycle: blue → green → blue → green
const SUN_COLORS = [
  (s: string) => chalk.blue(s),
  (s: string) => chalk.cyan(s),
  (s: string) => chalk.green(s),
  (s: string) => chalk.cyan(s),
];


export type SpinnerStyle = 'block' | 'spool' | 'cube' | 'stack' | 'sun';

export interface BlockSpinner {
  /** Update the message text */
  update(message: string): void;
  /** Stop and clear the spinner line */
  stop(finalMessage?: string): void;
  /** Stop and show a success message */
  succeed(message: string): void;
  /** Stop and show a failure message */
  fail(message: string): void;
}

function formatElapsedCompact(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min < 60) return `${min}m${sec > 0 ? ` ${sec}s` : ''}`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return `${hr}h ${remMin}m`;
}

/**
 * Create and start a block spinner
 */
/**
 * Multi-line batch progress display — shows each batch on its own line
 */
export interface BatchProgressDisplay {
  /** Update batch statuses */
  update(statuses: Array<{ index: number; status: 'waiting' | 'running' | 'done' | 'failed'; proposals?: number; durationMs?: number; error?: string }>, totalProposals: number): void;
  /** Stop and clear all lines */
  stop(finalMessage?: string): void;
}

export function createBatchProgress(totalBatches: number): BatchProgressDisplay {
  const isInteractive = process.stderr.isTTY;
  let frameIndex = 0;
  let interval: ReturnType<typeof setInterval> | null = null;
  let linesRendered = 0;
  let currentStatuses: Array<{ index: number; status: string; proposals?: number; durationMs?: number; error?: string }> = [];
  let currentTotalProposals = 0;
  const startedAt = Date.now();
  const loggedBatches = new Set<number>();

  const render = () => {
    if (!isInteractive) return;

    // Move cursor up to overwrite previous lines
    if (linesRendered > 0) {
      process.stderr.write(`\x1b[${linesRendered}A`);
    }

    // Sun with color cycling
    const colorFn = SUN_COLORS[frameIndex % SUN_COLORS.length];
    const frame = colorFn(SUN);
    frameIndex++;

    const lines: string[] = [];

    // Header line
    const elapsed = formatElapsedCompact(Date.now() - startedAt);
    lines.push(`  ${frame} Scouting ${totalBatches} batches ${chalk.gray(`(${currentTotalProposals} proposals, ${elapsed})`)}`);

    // Per-batch lines
    for (let i = 0; i < totalBatches; i++) {
      const s = currentStatuses.find(b => b.index === i);
      const dur = s?.durationMs ? formatElapsedCompact(s.durationMs) : (s?.status === 'running' ? formatElapsedCompact(Date.now() - startedAt) : '');
      const durStr = dur ? chalk.gray(` (${dur})`) : '';

      if (!s || s.status === 'waiting') {
        lines.push(chalk.gray(`    ○ Batch ${i + 1}  waiting`));
      } else if (s.status === 'running') {
        lines.push(`    ${frame} Batch ${i + 1}  ${chalk.cyan('analyzing...')}${durStr}`);
      } else if (s.status === 'done') {
        const pStr = s.proposals ? `${s.proposals} proposal${s.proposals !== 1 ? 's' : ''}` : 'no proposals';
        lines.push(`    ${chalk.green(SUN)} Batch ${i + 1}  ${chalk.green(pStr)}${durStr}`);
      } else if (s.status === 'failed') {
        lines.push(`    ${chalk.red(SUN)} Batch ${i + 1}  ${chalk.red('failed')}${durStr}`);
      }
    }

    // Write all lines, clear to end of each line
    for (const line of lines) {
      process.stderr.write(`${line}\x1b[K\n`);
    }
    linesRendered = lines.length;
  };

  // Initial render
  if (isInteractive) {
    currentStatuses = Array.from({ length: totalBatches }, (_, i) => ({ index: i, status: 'waiting' }));
    render();
    interval = setInterval(render, 120);
  }

  const clear = () => {
    if (interval) {
      clearInterval(interval);
      interval = null;
    }
    if (isInteractive && linesRendered > 0) {
      process.stderr.write(`\x1b[${linesRendered}A`);
      for (let i = 0; i < linesRendered; i++) {
        process.stderr.write(`\x1b[K\n`);
      }
      process.stderr.write(`\x1b[${linesRendered}A`);
      linesRendered = 0;
    }
  };

  return {
    update(statuses, totalProposals) {
      currentStatuses = statuses;
      currentTotalProposals = totalProposals;
      if (!isInteractive) {
        // Non-interactive: log completed batches once
        for (const s of statuses) {
          if ((s.status === 'done' || s.status === 'failed') && !loggedBatches.has(s.index)) {
            loggedBatches.add(s.index);
            const dur = s.durationMs ? ` (${formatElapsedCompact(s.durationMs)})` : '';
            process.stderr.write(`  Batch ${s.index + 1}: ${s.status}${s.proposals ? ` — ${s.proposals} proposals` : ''}${dur}\n`);
          }
        }
      }
    },
    stop(finalMessage?: string) {
      clear();
      if (finalMessage) {
        process.stderr.write(`  ${finalMessage}\n`);
      }
    },
  };
}

/**
 * Create and start a spinner with sun symbol cycling blue/green
 */
export function createSpinner(message: string, _style: SpinnerStyle = 'sun'): BlockSpinner {
  let frameIndex = 0;
  let currentMessage = message;
  let interval: ReturnType<typeof setInterval> | null = null;
  const isInteractive = process.stderr.isTTY;
  const startedAt = Date.now();

  const render = () => {
    if (!isInteractive) return;
    // Sun with color cycling
    const colorFn = SUN_COLORS[frameIndex % SUN_COLORS.length];
    const frame = colorFn(SUN);
    const elapsed = chalk.gray(`(${formatElapsedCompact(Date.now() - startedAt)})`);
    const line = `  ${frame} ${currentMessage} ${elapsed}`;
    // Use wider padding for longer messages
    const padWidth = Math.max(100, line.length + 5);
    process.stderr.write(`\r${line.padEnd(padWidth)}`);
    frameIndex++;
  };

  // Start spinning
  if (isInteractive) {
    render();
    interval = setInterval(render, 120);
  } else {
    // Non-interactive: just print the message once
    process.stderr.write(`  ${currentMessage}\n`);
  }

  const clear = () => {
    if (interval) {
      clearInterval(interval);
      interval = null;
    }
    if (isInteractive) {
      process.stderr.write('\r' + ' '.repeat(120) + '\r');
    }
  };

  return {
    update(msg: string) {
      currentMessage = msg;
      if (!isInteractive) {
        process.stderr.write(`  ${msg}\n`);
      }
    },
    stop(finalMessage?: string) {
      clear();
      if (finalMessage) {
        process.stderr.write(`  ${finalMessage}\n`);
      }
    },
    succeed(msg: string) {
      const elapsed = chalk.gray(`(${formatElapsedCompact(Date.now() - startedAt)})`);
      clear();
      process.stderr.write(`  ${chalk.green(SUN)} ${msg} ${elapsed}\n`);
    },
    fail(msg: string) {
      const elapsed = chalk.gray(`(${formatElapsedCompact(Date.now() - startedAt)})`);
      clear();
      process.stderr.write(`  ${chalk.red(SUN)} ${msg} ${elapsed}\n`);
    },
  };
}
