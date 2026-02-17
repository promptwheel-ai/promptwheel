/**
 * Logger implementation for CLI
 */

import chalk from 'chalk';
import type { Logger } from '@promptwheel/core/services';

export interface LoggerOptions {
  verbose?: boolean;
  quiet?: boolean;
}

/**
 * Create a logger instance
 */
export function createLogger(opts: LoggerOptions = {}): Logger {
  const { verbose = false, quiet = false } = opts;

  return {
    debug(msg: string, data?: Record<string, unknown>) {
      if (verbose && !quiet) {
        const dataStr = data ? ` ${JSON.stringify(data)}` : '';
        console.log(chalk.gray(`[debug] ${msg}${dataStr}`));
      }
    },

    info(msg: string, data?: Record<string, unknown>) {
      if (!quiet) {
        const dataStr = data && verbose ? ` ${JSON.stringify(data)}` : '';
        console.log(chalk.blue(`[info] ${msg}${dataStr}`));
      }
    },

    warn(msg: string, data?: Record<string, unknown>) {
      const dataStr = data ? ` ${JSON.stringify(data)}` : '';
      console.log(chalk.yellow(`[warn] ${msg}${dataStr}`));
    },

    error(msg: string, data?: Record<string, unknown>) {
      const dataStr = data ? ` ${JSON.stringify(data)}` : '';
      console.error(chalk.red(`[error] ${msg}${dataStr}`));
    },
  };
}

/**
 * Silent logger (for tests or quiet mode)
 */
export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};
