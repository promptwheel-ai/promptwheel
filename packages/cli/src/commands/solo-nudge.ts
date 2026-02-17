/**
 * Solo nudge command: add/list/clear hints for a running auto session.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { createGitService } from '../lib/git.js';
import { addHint, readHints, clearHints } from '../lib/solo-hints.js';

export function registerNudgeCommands(solo: Command): void {
  solo
    .command('nudge [text...]')
    .description('Add a steering hint for a running auto session')
    .option('--list', 'Show pending hints')
    .option('--clear', 'Clear all hints')
    .action(async (textParts: string[], options: { list?: boolean; clear?: boolean }) => {
      const git = createGitService();
      const repoRoot = await git.findRepoRoot(process.cwd());

      if (!repoRoot) {
        console.error(chalk.red('✗ Not a git repository'));
        process.exit(1);
      }

      if (options.list) {
        const hints = readHints(repoRoot);
        const pending = hints.filter((h) => !h.consumed);
        if (pending.length === 0) {
          console.log(chalk.gray('No pending hints.'));
          return;
        }
        console.log(chalk.bold(`${pending.length} pending hint(s):`));
        for (const h of pending) {
          const age = Math.round((Date.now() - h.createdAt) / 1000);
          console.log(chalk.cyan(`  • "${h.text}"`) + chalk.gray(` (${age}s ago)`));
        }
        return;
      }

      if (options.clear) {
        clearHints(repoRoot);
        console.log(chalk.green('✓ All hints cleared.'));
        return;
      }

      const text = textParts.join(' ').trim();
      if (!text) {
        console.error(chalk.red('✗ Provide hint text: promptwheel solo nudge "focus on auth"'));
        process.exit(1);
      }

      const hint = addHint(repoRoot, text);
      console.log(chalk.green(`✓ Hint added: "${hint.text}"`));
      console.log(chalk.gray('  Will be consumed in the next scout cycle.'));
    });
}
