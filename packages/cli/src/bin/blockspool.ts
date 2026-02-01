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
 *   blockspool solo auto           # Explicit (backwards compat)
 */

import { Command } from 'commander';
import { soloCommand } from '../commands/solo.js';

const program = new Command();

program
  .name('blockspool')
  .description('Continuous codebase improvement tool')
  .version('0.5.9');

// `blockspool solo <cmd>` — backwards compat
program.addCommand(soloCommand);

// Detect if argv[2] is a known solo subcommand name — if so, lift it.
// Otherwise, treat everything as flags for `auto`.
const knownSubs = new Set(soloCommand.commands.map(c => c.name()));
const firstArg = process.argv[2];
const isSubcommand = firstArg && knownSubs.has(firstArg) && firstArg !== 'solo';

if (isSubcommand) {
  // `blockspool scout .` → delegate to `solo scout .`
  // Insert 'solo' so Commander routes correctly
  process.argv.splice(2, 0, 'solo');
  program.parse();
} else if (firstArg === 'solo' || firstArg === '--help' || firstArg === '-h' || firstArg === '--version' || firstArg === '-V') {
  // Explicit `blockspool solo ...` or help/version
  program.parse();
} else {
  // `blockspool [flags...]` → `solo auto [flags...]`
  // Insert 'solo auto' before the flags
  process.argv.splice(2, 0, 'solo', 'auto');
  program.parse();
}
