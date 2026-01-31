/**
 * Solo mode commands - Zero-config local operation
 *
 * These commands work without any external infrastructure.
 * State is stored in SQLite at ~/.blockspool/data.db or .blockspool/state.sqlite
 */

import { Command } from 'commander';
import { registerLifecycleCommands } from './solo-lifecycle.js';
import { registerInspectCommands } from './solo-inspect.js';
import { registerExecCommands } from './solo-exec.js';
import { registerQaCommands } from './solo-qa.js';
import { registerAutoCommands } from './solo-auto.js';
import { registerNudgeCommands } from './solo-nudge.js';

// Re-export types from extracted modules
export type { FailureReason, CompletionOutcome, RunTicketResult } from '../lib/solo-ticket.js';
export { EXIT_CODES } from '../lib/solo-ticket.js';

export const soloCommand = new Command('solo')
  .description('Zero-config local mode - works without any external services')
  .addHelpText('after', `
Running 'blockspool solo' without a subcommand starts auto mode.

Examples:
  blockspool solo                 Run auto mode (scout → fix → PR)
  blockspool solo --codex         Full Codex mode (no Anthropic key needed)
  blockspool solo init            Initialize local state in current repo
  blockspool solo doctor          Check prerequisites and environment health
  blockspool solo ci              Fix CI failures automatically
  blockspool solo scout .         Scan for improvement opportunities
  blockspool solo approve 1-3     Convert proposals 1-3 to tickets
  blockspool solo run tkt_abc123  Execute a ticket using Claude
  blockspool solo retry tkt_abc123  Reset a blocked ticket to ready
  blockspool solo qa              Run QA commands (lint, test, etc.)
  blockspool solo status          Show local state and active tickets
  blockspool solo nudge "..."     Steer a running auto session with a hint
  blockspool solo tui             Launch interactive terminal UI
  blockspool solo reset           Clear all local state
  blockspool solo export          Export state for debugging
`);

registerLifecycleCommands(soloCommand);
registerInspectCommands(soloCommand);
registerExecCommands(soloCommand);
registerQaCommands(soloCommand);
registerAutoCommands(soloCommand);
registerNudgeCommands(soloCommand);
