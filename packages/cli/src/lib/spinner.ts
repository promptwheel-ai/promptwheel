/**
 * Block Spinner — zero-dependency animated spinner for the terminal
 *
 * Uses Unicode block characters that rotate to create a "spinning block" effect.
 * Shows elapsed time automatically so you always know it's alive.
 */

import chalk from 'chalk';

// Block characters that create a rotating cube illusion
const BLOCK_FRAMES = [
  '▖', '▘', '▝', '▗',  // quarter blocks rotating clockwise
];

const SPOOL_FRAMES = [
  '◐', '◓', '◑', '◒',  // half-circle rotating
];

const CUBE_FRAMES = [
  '⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏',
];

// BlockSpool signature: stacked blocks assembling
const STACK_FRAMES = [
  '░', '▒', '▓', '█', '▓', '▒',
];

export type SpinnerStyle = 'block' | 'spool' | 'cube' | 'stack';

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

const FRAME_SETS: Record<SpinnerStyle, string[]> = {
  block: BLOCK_FRAMES,
  spool: SPOOL_FRAMES,
  cube: CUBE_FRAMES,
  stack: STACK_FRAMES,
};

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
export function createSpinner(message: string, style: SpinnerStyle = 'stack'): BlockSpinner {
  const frames = FRAME_SETS[style];
  let frameIndex = 0;
  let currentMessage = message;
  let interval: ReturnType<typeof setInterval> | null = null;
  const isInteractive = process.stderr.isTTY;
  const startedAt = Date.now();

  const render = () => {
    if (!isInteractive) return;
    const frame = chalk.cyan(frames[frameIndex % frames.length]);
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
      process.stderr.write(`  ${chalk.green('█')} ${msg} ${elapsed}\n`);
    },
    fail(msg: string) {
      const elapsed = chalk.gray(`(${formatElapsedCompact(Date.now() - startedAt)})`);
      clear();
      process.stderr.write(`  ${chalk.red('█')} ${msg} ${elapsed}\n`);
    },
  };
}
