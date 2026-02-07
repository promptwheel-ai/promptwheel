#!/usr/bin/env node
/**
 * BlockSpool CLI entry point
 *
 * `blockspool` with no subcommand runs auto mode.
 * All solo subcommands are available at the top level:
 *
 *   blockspool                     # auto mode (scout → fix → PR)
 *   blockspool --codex             # Full Codex (no Anthropic key)
 *   blockspool ci                  # Fix CI failures
 *   blockspool scout .             # Scan for improvements
 *   blockspool status              # Show local state
 *   blockspool update              # Self-update to latest version
 *   blockspool solo auto           # Explicit (backwards compat)
 */

import { Command } from 'commander';
import { soloCommand } from '../commands/solo.js';
import {
  checkForUpdateInBackground,
  printUpdateNotification,
  runSelfUpdate,
} from '../lib/update-check.js';

const CURRENT_VERSION = '0.5.62';

const program = new Command();

program
  .name('blockspool')
  .description('Continuous codebase improvement tool')
  .version(CURRENT_VERSION);

// `blockspool update` — self-update command
program
  .command('update')
  .description('Update blockspool to the latest version')
  .action(async () => {
    const success = await runSelfUpdate();
    process.exit(success ? 0 : 1);
  });

// `blockspool solo <cmd>` — backwards compat
program.addCommand(soloCommand);

// Detect if argv[2] is a known solo subcommand name — if so, lift it.
// Otherwise, treat everything as flags for `auto`.
const knownSubs = new Set(soloCommand.commands.flatMap(c => [c.name(), ...c.aliases()]));
const firstArg = process.argv[2];
const isSubcommand = firstArg && knownSubs.has(firstArg) && firstArg !== 'solo';

// Skip update check in CI or when explicitly disabled
const skipUpdateCheck = process.env.CI === 'true' ||
  process.env.BLOCKSPOOL_SKIP_UPDATE_CHECK === '1' ||
  process.argv.includes('--skip-update-check');

// Check for updates in background (non-blocking)
const updateCheck = (!skipUpdateCheck && firstArg !== 'update' && firstArg !== '--version' && firstArg !== '-V')
  ? checkForUpdateInBackground(CURRENT_VERSION)
  : Promise.resolve(null);

async function main() {
  if (isSubcommand) {
    // `blockspool scout .` → delegate to `solo scout .`
    // Insert 'solo' so Commander routes correctly
    process.argv.splice(2, 0, 'solo');
    await program.parseAsync();
  } else if (firstArg === 'update') {
    // Explicit update command
    await program.parseAsync();
  } else if (firstArg === 'solo' || firstArg === '--help' || firstArg === '-h' || firstArg === '--version' || firstArg === '-V') {
    // Explicit `blockspool solo ...` or help/version
    await program.parseAsync();
  } else {
    // `blockspool [flags...]` → `solo auto [flags...]`
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
  console.error(err);
  process.exit(1);
});
