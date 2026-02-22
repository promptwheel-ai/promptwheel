/**
 * Solo mode commands - Zero-config local operation
 *
 * These commands work without any external infrastructure.
 * State is stored in SQLite at ~/.promptwheel/data.db or .promptwheel/state.sqlite
 */

import { Command } from 'commander';
import { registerLifecycleCommands } from './solo-lifecycle.js';
import { registerInspectCommands } from './solo-inspect.js';
import { registerExecCommands } from './solo-exec.js';
import { registerQaCommands } from './solo-qa.js';
import { registerAutoCommands } from './solo-auto.js';
import { registerNudgeCommands } from './solo-nudge.js';
import { registerAnalyticsCommands } from './solo-analytics.js';
import { registerDaemonCommands } from './solo-daemon.js';
import { registerTrajectoryCommands } from './solo-trajectory.js';

// Re-export types from extracted modules
export type { FailureReason, CompletionOutcome, RunTicketResult } from '../lib/solo-ticket-types.js';
export { EXIT_CODES } from '../lib/solo-ticket-types.js';

export const soloCommand = new Command('solo')
  .description('Zero-config local mode - works without any external services')
  .addHelpText('after', `
Running 'promptwheel solo' without a subcommand starts auto mode.

Examples:
  promptwheel solo                 Spin mode with drill (default)
  promptwheel solo --plan          Planning mode (scout → approve → execute)
  promptwheel --claude             Use Claude backend (needs ANTHROPIC_API_KEY)
  promptwheel solo init            Initialize local state in current repo
  promptwheel solo doctor          Check prerequisites and environment health
  promptwheel solo ci              Fix CI failures automatically
  promptwheel solo scout .         Scan for improvement opportunities
  promptwheel solo approve 1-3     Convert proposals 1-3 to tickets
  promptwheel solo run tkt_abc123  Execute a ticket using Claude
  promptwheel solo retry tkt_abc123  Reset a blocked ticket to ready
  promptwheel solo qa              Run QA commands (lint, test, etc.)
  promptwheel solo status          Show local state and active tickets
  promptwheel solo nudge "..."     Steer a running auto session with a hint
  promptwheel solo nudge --drill-pause   Pause drill during a running session
  promptwheel solo nudge --drill-resume  Resume paused drill
  promptwheel solo daemon start    Start background daemon for continuous improvement
  promptwheel solo daemon stop     Stop the running daemon
  promptwheel solo daemon status   Show daemon status and stats
  promptwheel solo trajectory list     List all trajectories and status
  promptwheel solo trajectory show <n> Show trajectory details
  promptwheel solo trajectory generate "goal" Generate a trajectory from a goal
  promptwheel solo tui             Launch interactive terminal UI
  promptwheel solo reset           Clear all local state
  promptwheel solo export          Export state for debugging
`);

registerLifecycleCommands(soloCommand);
registerInspectCommands(soloCommand);
registerExecCommands(soloCommand);
registerQaCommands(soloCommand);
registerAutoCommands(soloCommand);
registerNudgeCommands(soloCommand);
registerAnalyticsCommands(soloCommand);
registerDaemonCommands(soloCommand);
registerTrajectoryCommands(soloCommand);
