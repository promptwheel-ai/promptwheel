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
import { registerTrajectoryCommands } from './solo-trajectory.js';
import { registerExportMetricsCommand } from './solo-export-metrics.js';
import { registerPortfolioCommands } from './solo-portfolio.js';

// Re-export types from extracted modules
export type { FailureReason, CompletionOutcome, RunTicketResult } from '../lib/solo-ticket-types.js';
export { EXIT_CODES } from '../lib/solo-ticket-types.js';

export const soloCommand = new Command('solo')
  .description('Repo intelligence engine — find issues, track trends, auto-fix')
  .addHelpText('after', `
Running 'promptwheel' without a subcommand runs scan.

Scan (intelligence):
  promptwheel                      Scan for issues (default)
  promptwheel scan --diff          Delta from last scan (new/fixed/changed)
  promptwheel scan --history       Show finding trends over time
  promptwheel scan --fix           Auto-fix top blocking/degrading findings
  promptwheel scan --stats         Show fix success rates alongside findings
  promptwheel scan --format sarif  SARIF output for GitHub Code Scanning
  promptwheel scan --fail-on blocking  Exit 1 if blocking findings (CI gate)

Finding management:
  promptwheel ingest <file.sarif>  Import findings from external tools
  promptwheel ingest <f> --fix     Import + create tickets for auto-fix
  promptwheel baseline show        List suppressed findings
  promptwheel suppress <id> --expires 90d  Suppress with auto-expiration
  promptwheel unsuppress <id>      Re-activate a suppressed finding
  promptwheel rules list           Show custom semantic rules

Orchestration:
  promptwheel auto                 Spin mode with drill
  promptwheel auto --plan          Planning mode (scout → approve → execute)
  promptwheel run tkt_abc123       Execute a specific ticket
  promptwheel nudge "..."          Steer a running session with a hint

Other:
  promptwheel init                 Initialize local state in current repo
  promptwheel status               Show local state and active tickets
  promptwheel trajectory list      List trajectories
  promptwheel qa                   Run QA commands (lint, test, etc.)
  promptwheel update               Self-update to latest version
`);

registerLifecycleCommands(soloCommand);
registerInspectCommands(soloCommand);
registerExecCommands(soloCommand);
registerQaCommands(soloCommand);
registerAutoCommands(soloCommand);
registerNudgeCommands(soloCommand);
registerTrajectoryCommands(soloCommand);
registerPortfolioCommands(soloCommand);
registerExportMetricsCommand(soloCommand);
