#!/usr/bin/env node
/**
 * PromptWheel CLI entry point
 *
 * `promptwheel` with no subcommand runs auto mode.
 * All solo subcommands are available at the top level:
 *
 *   promptwheel                     # auto mode (scout → fix → PR)
 *   promptwheel --claude             # Use Claude (needs ANTHROPIC_API_KEY)
 *   promptwheel ci                  # Fix CI failures
 *   promptwheel scout .             # Scan for improvements
 *   promptwheel status              # Show local state
 *   promptwheel update              # Self-update to latest version
 *   promptwheel solo auto           # Explicit (backwards compat)
 */

import { Command } from 'commander';
import { soloCommand } from '../commands/solo.js';
import {
  checkForUpdateInBackground,
  printUpdateNotification,
  runSelfUpdate,
} from '../lib/update-check.js';

const CURRENT_VERSION = '0.7.0';

const program = new Command();

program
  .name('promptwheel')
  .description('Continuous codebase improvement tool')
  .version(CURRENT_VERSION);

// `promptwheel update` — self-update command
program
  .command('update')
  .description('Update promptwheel to the latest version')
  .action(async () => {
    const success = await runSelfUpdate();
    process.exit(success ? 0 : 1);
  });

// `promptwheel solo <cmd>` — backwards compat
program.addCommand(soloCommand);

// Detect if argv[2] is a known solo subcommand name — if so, lift it.
// Otherwise, treat everything as flags for `auto`.
const knownSubs = new Set(soloCommand.commands.flatMap(c => [c.name(), ...c.aliases()]));
const firstArg = process.argv[2];
const isSubcommand = firstArg && knownSubs.has(firstArg) && firstArg !== 'solo';

// Skip update check in CI or when explicitly disabled
const skipUpdateCheck = process.env.CI === 'true' ||
  process.env.PROMPTWHEEL_SKIP_UPDATE_CHECK === '1' ||
  process.argv.includes('--skip-update-check');

// Check for updates in background (non-blocking)
const updateCheck = (!skipUpdateCheck && firstArg !== 'update' && firstArg !== '--version' && firstArg !== '-V')
  ? checkForUpdateInBackground(CURRENT_VERSION)
  : Promise.resolve(null);

async function main() {
  if (isSubcommand) {
    // `promptwheel scout .` → delegate to `solo scout .`
    // Insert 'solo' so Commander routes correctly
    process.argv.splice(2, 0, 'solo');
    await program.parseAsync();
  } else if (firstArg === 'update') {
    // Explicit update command
    await program.parseAsync();
  } else if (firstArg === 'solo' || firstArg === '--help' || firstArg === '-h' || firstArg === '--version' || firstArg === '-V') {
    // Explicit `promptwheel solo ...` or help/version
    await program.parseAsync();
  } else {
    // `promptwheel [flags...]` → `solo auto [flags...]`
    // Insert 'solo auto' before the flags
    process.argv.splice(2, 0, 'solo', 'auto');
    await program.parseAsync();
  }

  // Show update notification after command completes (if available)
  const latestVersion = await updateCheck;
  if (latestVersion) {
    printUpdateNotification(CURRENT_VERSION, latestVersion);
  }
}

main().catch((err) => {
  if (err instanceof Error) {
    // User-friendly error: message only, no stack trace
    const prefix = '\x1b[31m✗\x1b[0m';
    console.error(`${prefix} ${err.message}`);
    // Show stack in verbose/debug mode
    if (process.env.DEBUG || process.argv.includes('--verbose') || process.argv.includes('-v')) {
      console.error(err.stack);
    }
  } else {
    console.error(err);
  }
  process.exit(1);
});
