#!/usr/bin/env node
/**
 * BlockSpool CLI entry point
 *
 * Usage:
 *   blockspool solo scout .        # Zero-config: scan and create tickets
 *   blockspool solo status         # Show local state
 *   blockspool solo reset          # Clear local state
 */

import { Command } from 'commander';
import { soloCommand } from '../commands/solo.js';

const program = new Command();

program
  .name('blockspool')
  .description('Autonomous coding swarm for your codebase')
  .version('0.2.0');

// Solo mode (zero-config)
program.addCommand(soloCommand);

// Parse and run
program.parse();
