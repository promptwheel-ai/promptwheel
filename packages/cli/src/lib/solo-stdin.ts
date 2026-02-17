/**
 * Interactive Console — Claude-like input bar at the bottom.
 *
 * Uses ANSI escape codes to maintain a persistent input line at the
 * bottom of the terminal while output scrolls above it.
 *
 * Features:
 * - Input bar always visible at bottom
 * - Output scrolls above without interrupting typing
 * - Proper line editing (backspace, arrows)
 * - Special commands (?, s, p, q)
 */

import chalk from 'chalk';
import { addHint, readHints, clearHints } from './solo-hints.js';

export interface ConsoleOptions {
  repoRoot: string;
  onQuit?: () => void;
  onStatus?: () => void;
}

export interface InteractiveConsole {
  stop: () => void;
  pause: () => void;
  resume: () => void;
  log: (message: string) => void;
}

// ANSI escape sequences
const ESC = '\x1b';
const CSI = ESC + '[';
const SAVE_CURSOR = CSI + 's';
const RESTORE_CURSOR = CSI + 'u';
const CLEAR_LINE = CSI + '2K';
const CURSOR_TO = (row: number, col: number) => CSI + row + ';' + col + 'H';

/**
 * Start the interactive console with a persistent input bar.
 */
export function startInteractiveConsole(opts: ConsoleOptions): InteractiveConsole {
  const { repoRoot, onQuit, onStatus } = opts;

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return startPipedInput(repoRoot);
  }

  let isPaused = false;
  let stopped = false;
  let quitRequested = false;
  let inputBuffer = '';
  let cursorPos = 0;

  // Get terminal dimensions
  const getHeight = () => process.stdout.rows || 24;

  // Set raw mode for character-by-character input
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');

  const inputRow = () => getHeight(); // Bottom line
  const promptStr = chalk.cyan('☀') + ' ';
  const promptLen = 2; // "☀ "

  // Draw the input bar
  function drawInputBar() {
    if (stopped || isPaused) return;
    const row = inputRow();
    // Move to input row, clear it, draw prompt and current input
    process.stdout.write(
      SAVE_CURSOR +
      CURSOR_TO(row, 1) +
      CLEAR_LINE +
      promptStr +
      inputBuffer +
      CURSOR_TO(row, promptLen + 1 + cursorPos) +
      RESTORE_CURSOR
    );
  }

  // Write output above the input bar
  function log(message: string) {
    if (stopped) {
      console.log(message);
      return;
    }

    const row = inputRow();
    // Save cursor, move to row above input, print, restore
    process.stdout.write(
      SAVE_CURSOR +
      CURSOR_TO(row - 1, 1) +  // Line above input bar
      '\n' +                    // Scroll everything up
      CURSOR_TO(row - 1, 1) +  // Back to that line
      CLEAR_LINE +
      message +
      RESTORE_CURSOR
    );
    drawInputBar();
  }

  // Process a completed line
  function processLine(line: string) {
    const text = line.trim();
    if (!text) return;

    const lower = text.toLowerCase();

    // Slash commands
    if (lower === '/help' || lower === '/') {
      log(chalk.cyan('  ☀ Commands:'));
      log(chalk.gray('    /help     Show this help'));
      log(chalk.gray('    /status   Show session status'));
      log(chalk.gray('    /pending  Show pending guidance'));
      log(chalk.gray('    /clear    Clear pending guidance'));
      log(chalk.gray('    /quit     Stop gracefully'));
      log(chalk.gray('    <text>    Add guidance for next scout'));
    } else if (lower === '/status' || lower === '/s') {
      if (onStatus) {
        onStatus();
      } else {
        log(chalk.gray('  Status not available'));
      }
    } else if (lower === '/pending' || lower === '/p') {
      const hints = readHints(repoRoot).filter(h => !h.consumed);
      if (hints.length === 0) {
        log(chalk.gray('  No pending guidance'));
      } else {
        log(chalk.cyan(`  ☀ Pending (${hints.length}):`));
        for (const h of hints) {
          log(chalk.gray(`    • ${h.text}`));
        }
      }
    } else if (lower === '/clear' || lower === '/c') {
      clearHints(repoRoot);
      log(chalk.green('  ✓ Cleared pending guidance'));
    } else if (lower === '/quit' || lower === '/q' || lower === '/exit') {
      log(chalk.yellow('  ⏹  Stopping after current operation...'));
      if (onQuit) onQuit();
    } else if (lower.startsWith('/')) {
      log(chalk.yellow(`  Unknown command: ${text}`));
      log(chalk.gray('  Type /help for available commands'));
    } else {
      // Add as guidance
      const hint = addHint(repoRoot, text);
      log(chalk.green('  ✓ ') + chalk.gray(`"${hint.text}"`));
    }
  }

  // Handle keypress
  function onData(key: string) {
    if (stopped || isPaused) return;

    // Ctrl+C — first graceful, second force-quit
    if (key === '\x03') {
      if (quitRequested) {
        // Second Ctrl+C — force quit immediately
        stop();
        console.log(chalk.red('\nForce quit. Exiting immediately.'));
        process.exit(1);
      }
      quitRequested = true;
      if (onQuit) {
        log(chalk.yellow('  ⏹  Stopping after current operation... (Ctrl+C again to force quit)'));
        onQuit();
      } else {
        stop();
        process.exit(0);
      }
      return;
    }

    // Ctrl+D
    if (key === '\x04') {
      if (onQuit) {
        log(chalk.yellow('  ⏹  Stopping...'));
        onQuit();
      }
      return;
    }

    // Enter
    if (key === '\r' || key === '\n') {
      const line = inputBuffer;
      inputBuffer = '';
      cursorPos = 0;
      drawInputBar();
      processLine(line);
      return;
    }

    // Backspace
    if (key === '\x7f' || key === '\b') {
      if (cursorPos > 0) {
        inputBuffer = inputBuffer.slice(0, cursorPos - 1) + inputBuffer.slice(cursorPos);
        cursorPos--;
        drawInputBar();
      }
      return;
    }

    // Escape sequences (arrows, etc.)
    if (key.startsWith(ESC)) {
      if (key === CSI + 'D') { // Left arrow
        if (cursorPos > 0) cursorPos--;
        drawInputBar();
      } else if (key === CSI + 'C') { // Right arrow
        if (cursorPos < inputBuffer.length) cursorPos++;
        drawInputBar();
      } else if (key === CSI + 'H' || key === '\x01') { // Home or Ctrl+A
        cursorPos = 0;
        drawInputBar();
      } else if (key === CSI + 'F' || key === '\x05') { // End or Ctrl+E
        cursorPos = inputBuffer.length;
        drawInputBar();
      }
      // Ignore other escape sequences
      return;
    }

    // Ctrl+A (start of line)
    if (key === '\x01') {
      cursorPos = 0;
      drawInputBar();
      return;
    }

    // Ctrl+E (end of line)
    if (key === '\x05') {
      cursorPos = inputBuffer.length;
      drawInputBar();
      return;
    }

    // Ctrl+U (clear line)
    if (key === '\x15') {
      inputBuffer = '';
      cursorPos = 0;
      drawInputBar();
      return;
    }

    // Regular character
    if (key.length === 1 && key >= ' ') {
      inputBuffer = inputBuffer.slice(0, cursorPos) + key + inputBuffer.slice(cursorPos);
      cursorPos++;
      drawInputBar();
    }
  }

  process.stdin.on('data', onData);

  // Initial draw
  setTimeout(() => {
    if (!stopped) {
      log(chalk.gray('  ☀ Type anytime to guide the session (/help for commands)'));
      drawInputBar();
    }
  }, 1000);

  function stop() {
    if (stopped) return;
    stopped = true;
    process.stdin.removeListener('data', onData);
    try {
      process.stdin.setRawMode(false);
    } catch { /* ignore */ }
    // Clear input bar area
    process.stdout.write(CURSOR_TO(inputRow(), 1) + CLEAR_LINE);
  }

  return {
    stop,
    pause: () => {
      isPaused = true;
      try {
        process.stdin.setRawMode(false);
      } catch { /* ignore */ }
    },
    resume: () => {
      isPaused = false;
      try {
        process.stdin.setRawMode(true);
      } catch { /* ignore */ }
      drawInputBar();
    },
    log,
  };
}

/**
 * Simple piped input handler for non-TTY environments.
 */
function startPipedInput(repoRoot: string): InteractiveConsole {
  const onData = (data: Buffer) => {
    const lines = data.toString().split('\n');
    for (const line of lines) {
      const text = line.trim();
      if (!text) continue;
      addHint(repoRoot, text);
    }
  };

  process.stdin.on('data', onData);

  return {
    stop: () => {
      process.stdin.removeListener('data', onData);
    },
    pause: () => {},
    resume: () => {},
    log: (message: string) => console.log(message),
  };
}

/**
 * Legacy API — starts stdin listener and returns cleanup function.
 * @deprecated Use startInteractiveConsole instead
 */
export function startStdinListener(repoRoot: string): () => void {
  const console = startInteractiveConsole({ repoRoot });
  return () => console.stop();
}
