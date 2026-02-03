/**
 * Solo execution commands: run, retry, pr
 */

import { Command } from 'commander';
import * as path from 'node:path';
import chalk from 'chalk';
import { tickets, runs } from '@blockspool/core/repos';
import { createGitService } from '../lib/git.js';
import {
  isInitialized,
  initSolo,
  loadConfig,
  getAdapter,
} from '../lib/solo-config.js';
import {
  formatDuration,
  findConflictingTickets,
  regenerateAllowedPaths,
  runPreflightChecks,
} from '../lib/solo-utils.js';
import { cleanupWorktree } from '../lib/solo-git.js';
import { soloRunTicket } from '../lib/solo-ticket.js';
import { EXIT_CODES } from '../lib/solo-ticket-types.js';

export function registerExecCommands(solo: Command): void {
  /**
   * solo run - Execute a ticket using Claude
   */
  solo
    .command('run <ticketId>')
    .description('Execute a ticket using Claude Code CLI')
    .addHelpText('after', `
This command:
1. Creates an isolated git worktree
2. Runs Claude Code CLI with the ticket prompt
3. Validates changes with QA commands
4. Creates a PR (or commits to a feature branch)

Rerun behavior:
- ready/blocked tickets: runs normally
- in_progress tickets: warns about possible crashed run, continues
- done/in_review tickets: skips (use --force to override)

Examples:
  blockspool solo run tkt_abc123         # Run ticket
  blockspool solo run tkt_abc123 --pr    # Create PR after success
  blockspool solo run tkt_abc123 --force # Force rerun of completed ticket
`)
    .option('-v, --verbose', 'Show detailed output')
    .option('--json', 'Output as JSON')
    .option('--pr', 'Create PR after successful run')
    .option('--no-qa', 'Skip QA validation')
    .option('--timeout <ms>', 'Claude execution timeout', '600000')
    .option('-f, --force', 'Force rerun of done/in_review tickets')
    .action(async (ticketId: string, options: {
      verbose?: boolean;
      json?: boolean;
      pr?: boolean;
      qa?: boolean;
      timeout?: string;
      force?: boolean;
    }) => {
      const isJsonMode = options.json;
      const skipQa = options.qa === false;
      const createPr = options.pr ?? false;
      const timeoutMs = parseInt(options.timeout ?? '600000', 10);
      const forceRerun = options.force ?? false;

      if (!isJsonMode) {
        console.log(chalk.blue('🚀 BlockSpool Solo Run'));
        console.log();
      }

      const git = createGitService();
      const repoRoot = await git.findRepoRoot(process.cwd());

      if (!repoRoot) {
        if (isJsonMode) {
          console.log(JSON.stringify({ success: false, error: 'Not a git repository' }));
        } else {
          console.error(chalk.red('✗ Not a git repository'));
        }
        process.exit(1);
      }

      const preflight = await runPreflightChecks(repoRoot, { needsPr: createPr });
      if (!preflight.ok) {
        if (isJsonMode) {
          console.log(JSON.stringify({ success: false, error: preflight.error }));
        } else {
          console.error(chalk.red(`✗ ${preflight.error}`));
        }
        process.exit(1);
      }

      for (const warning of preflight.warnings) {
        if (!isJsonMode) {
          console.log(chalk.yellow(`⚠ ${warning}`));
        }
      }

      if (!isInitialized(repoRoot)) {
        if (!isJsonMode) {
          console.log(chalk.gray('Initializing local state...'));
        }
        await initSolo(repoRoot);
      }

      const config = loadConfig(repoRoot);

      const adapter = await getAdapter(repoRoot);

      let currentRunId: string | null = null;
      let interrupted = false;

      const sigintHandler = async () => {
        if (interrupted) {
          process.exit(1);
        }
        interrupted = true;

        if (!isJsonMode) {
          console.log(chalk.yellow('\n\nInterrupted. Cleaning up...'));
        }

        const worktreePath = path.join(repoRoot, '.blockspool', 'worktrees', ticketId);
        await cleanupWorktree(repoRoot, worktreePath);

        try {
          await tickets.updateStatus(adapter, ticketId, 'ready');
          if (currentRunId) {
            await runs.markFailure(adapter, currentRunId, 'Interrupted by user (SIGINT)');
          }
        } catch {
          // Ignore cleanup errors
        }

        if (!isJsonMode) {
          console.log(chalk.gray('Ticket reset to ready. You can retry with: blockspool solo run ' + ticketId));
        }

        await adapter.close();
        process.exit(130);
      };

      process.on('SIGINT', sigintHandler);

      try {
        const ticket = await tickets.getById(adapter, ticketId);

        if (!ticket) {
          if (isJsonMode) {
            console.log(JSON.stringify({ success: false, error: `Ticket not found: ${ticketId}` }));
          } else {
            console.error(chalk.red(`✗ Ticket not found: ${ticketId}`));
          }
          process.exit(1);
        }

        if (!isJsonMode) {
          console.log(`Ticket: ${chalk.bold(ticket.title)}`);
          console.log(chalk.gray(`  ID: ${ticket.id}`));
          console.log(chalk.gray(`  Status: ${ticket.status}`));
          console.log();
        }

        if (ticket.status === 'done' || ticket.status === 'in_review') {
          if (!forceRerun) {
            if (isJsonMode) {
              console.log(JSON.stringify({
                success: false,
                error: `Ticket already ${ticket.status}. Use --force to rerun.`,
              }));
            } else {
              console.log(chalk.yellow(`Ticket already ${ticket.status}. Use --force to rerun.`));
            }
            return;
          }
          if (!isJsonMode) {
            console.log(chalk.yellow(`⚠ Force rerunning ${ticket.status} ticket`));
          }
        }

        if (ticket.status === 'in_progress') {
          if (!isJsonMode) {
            console.log(chalk.yellow('⚠ Ticket was in_progress (previous run may have crashed)'));
            console.log(chalk.gray('  Cleaning up and retrying...'));
            console.log();
          }
          const worktreePath = path.join(repoRoot, '.blockspool', 'worktrees', ticketId);
          await cleanupWorktree(repoRoot, worktreePath);
        }

        const conflicts = await findConflictingTickets(adapter, ticket);
        if (conflicts.length > 0 && !forceRerun) {
          if (isJsonMode) {
            console.log(JSON.stringify({
              success: false,
              error: 'Conflicting tickets detected with overlapping paths',
              conflicts: conflicts.map(c => ({
                ticketId: c.ticket.id,
                title: c.ticket.title,
                overlappingPaths: c.overlappingPaths,
              })),
            }));
          } else {
            console.log(chalk.yellow('⚠ Conflicting tickets detected with overlapping paths:'));
            console.log();
            for (const conflict of conflicts) {
              console.log(chalk.yellow(`  • ${conflict.ticket.id}: ${conflict.ticket.title}`));
              console.log(chalk.gray(`    Status: ${conflict.ticket.status}`));
              console.log(chalk.gray(`    Overlapping paths:`));
              for (const overlap of conflict.overlappingPaths.slice(0, 5)) {
                console.log(chalk.gray(`      - ${overlap}`));
              }
              if (conflict.overlappingPaths.length > 5) {
                console.log(chalk.gray(`      ... and ${conflict.overlappingPaths.length - 5} more`));
              }
            }
            console.log();
            console.log(chalk.yellow('Running tickets that modify the same files may cause merge conflicts.'));
            console.log(chalk.gray('Use --force to run anyway.'));
          }
          process.exit(1);
        } else if (conflicts.length > 0 && !isJsonMode) {
          console.log(chalk.yellow('⚠ Running despite conflicting tickets (--force):'));
          for (const conflict of conflicts) {
            console.log(chalk.gray(`  • ${conflict.ticket.id}: ${conflict.ticket.title}`));
          }
          console.log();
        }

        await tickets.updateStatus(adapter, ticketId, 'in_progress');

        const run = await runs.create(adapter, {
          projectId: ticket.projectId,
          type: 'worker',
          ticketId: ticket.id,
          metadata: {
            skipQa,
            createPr,
            timeoutMs,
          },
        });
        currentRunId = run.id;

        if (!isJsonMode) {
          console.log(chalk.gray(`Run: ${run.id}`));
          console.log();
        }

        const result = await soloRunTicket({
          ticket,
          repoRoot,
          config,
          adapter,
          runId: run.id,
          skipQa,
          createPr,
          timeoutMs,
          verbose: options.verbose ?? false,
          onProgress: (msg) => {
            if (!isJsonMode && !interrupted) {
              console.log(chalk.gray(`  ${msg}`));
            }
          },
        });

        if (interrupted) {
          return;
        }

        if (result.success) {
          await runs.markSuccess(adapter, run.id, {
            branchName: result.branchName,
            prUrl: result.prUrl,
            durationMs: result.durationMs,
            completionOutcome: result.completionOutcome,
          });
          await tickets.updateStatus(adapter, ticketId, result.prUrl ? 'in_review' : 'done');
        } else {
          await runs.markFailure(adapter, run.id, result.error ?? 'Unknown error', {
            durationMs: result.durationMs,
            branchName: result.branchName,
          });
          await tickets.updateStatus(adapter, ticketId, 'blocked');
        }

        if (isJsonMode) {
          const jsonOutput: Record<string, unknown> = {
            success: result.success,
            runId: run.id,
            ticketId: ticket.id,
            branchName: result.branchName,
            prUrl: result.prUrl,
            durationMs: result.durationMs,
            error: result.error,
            failureReason: result.failureReason,
            completionOutcome: result.completionOutcome,
            artifacts: result.artifacts,
          };

          if (result.failureReason === 'spindle_abort' && result.spindle) {
            jsonOutput.spindle = {
              trigger: result.spindle.trigger,
              estimatedTokens: result.spindle.estimatedTokens,
              threshold: result.spindle.thresholds.tokenBudgetAbort,
              iteration: result.spindle.iteration,
              confidence: result.spindle.confidence,
            };
          }

          console.log(JSON.stringify(jsonOutput, null, 2));
        } else {
          console.log();
          if (result.success && result.completionOutcome === 'no_changes_needed') {
            console.log(chalk.green('✓ Ticket completed - no changes needed'));
            console.log(chalk.gray('  Claude reviewed the ticket and determined no code changes were required'));
          } else if (result.success) {
            console.log(chalk.green('✓ Ticket completed successfully'));
            if (result.branchName) {
              console.log(chalk.gray(`  Branch: ${result.branchName}`));
            }
            if (result.prUrl) {
              console.log(chalk.cyan(`  PR: ${result.prUrl}`));
            }
          } else if (result.failureReason === 'spindle_abort' && result.spindle) {
            console.log(chalk.yellow('⚠ Execution stopped by Spindle (loop protection)'));
            console.log();
            console.log(chalk.bold('What happened:'));
            console.log(`  Stopped execution to prevent ${result.spindle.trigger}`);
            console.log();
            console.log(chalk.bold('Why:'));
            if (result.spindle.trigger === 'token_budget') {
              console.log(`  Token estimate ~${result.spindle.estimatedTokens.toLocaleString()} > abort limit ${result.spindle.thresholds.tokenBudgetAbort.toLocaleString()}`);
            } else if (result.spindle.trigger === 'stalling') {
              console.log(`  ${result.spindle.metrics.iterationsWithoutChange} iterations without meaningful changes`);
            } else if (result.spindle.trigger === 'oscillation') {
              console.log(`  Detected flip-flopping: ${result.spindle.metrics.oscillationPattern ?? 'add→remove→add pattern'}`);
            } else if (result.spindle.trigger === 'repetition') {
              console.log(`  Similar outputs detected (${(result.spindle.confidence * 100).toFixed(0)}% similarity)`);
            }
            console.log();
            console.log(chalk.bold('What to do:'));
            for (const rec of result.spindle.recommendations.slice(0, 3)) {
              console.log(chalk.gray(`  • ${rec}`));
            }
            console.log();
            console.log(chalk.gray(`  Artifacts: ${result.spindle.artifactPath}`));
          } else {
            console.log(chalk.red(`✗ Ticket failed: ${result.error}`));
            if (result.branchName) {
              console.log(chalk.gray(`  Branch preserved: ${result.branchName}`));
              console.log(chalk.gray('  Inspect with: git checkout ' + result.branchName));
            }
            console.log(chalk.gray('  Retry with: blockspool solo run ' + ticketId));
          }
          console.log(chalk.gray(`  Duration: ${formatDuration(result.durationMs)}`));
        }

        if (!result.success) {
          if (result.failureReason === 'spindle_abort') {
            process.exitCode = EXIT_CODES.SPINDLE_ABORT;
          } else {
            process.exitCode = EXIT_CODES.FAILURE;
          }
        }

      } finally {
        process.removeListener('SIGINT', sigintHandler);
        await adapter.close();
      }
    });

  /**
   * solo retry - Reset a blocked ticket to ready status
   */
  solo
    .command('retry <ticketId>')
    .description('Reset a blocked ticket to ready status and regenerate allowed_paths')
    .addHelpText('after', `
This command resets a blocked ticket so it can be run again.

What it does:
1. Resets the ticket status to 'ready'
2. Regenerates allowed_paths using current scope expansion logic
3. Optionally allows updating the ticket description

Use this when:
- A ticket failed and is now blocked
- You want to retry with regenerated scope
- You want to update the ticket description before retrying

Examples:
  blockspool solo retry tkt_abc123                    # Reset blocked ticket
  blockspool solo retry tkt_abc123 -d "New desc"     # Reset with new description
  blockspool solo retry tkt_abc123 --force           # Reset even if not blocked
`)
    .option('-v, --verbose', 'Show detailed output')
    .option('--json', 'Output as JSON')
    .option('-d, --description <text>', 'Update the ticket description')
    .option('-f, --force', 'Force reset even if ticket is not blocked')
    .action(async (ticketId: string, options: {
      verbose?: boolean;
      json?: boolean;
      description?: string;
      force?: boolean;
    }) => {
      const isJsonMode = options.json;
      const forceReset = options.force ?? false;
      const newDescription = options.description;

      if (!isJsonMode) {
        console.log(chalk.blue('🔄 BlockSpool Solo Retry'));
        console.log();
      }

      const git = createGitService();
      const repoRoot = await git.findRepoRoot(process.cwd());

      if (!repoRoot) {
        if (isJsonMode) {
          console.log(JSON.stringify({ success: false, error: 'Not a git repository' }));
        } else {
          console.error(chalk.red('✗ Not a git repository'));
        }
        process.exit(1);
      }

      if (!isInitialized(repoRoot)) {
        if (isJsonMode) {
          console.log(JSON.stringify({ success: false, error: 'Not initialized. Run: blockspool solo init' }));
        } else {
          console.error(chalk.red('✗ Not initialized'));
          console.log(chalk.gray('  Run: blockspool solo init'));
        }
        process.exit(1);
      }

      const adapter = await getAdapter(repoRoot);

      try {
        const ticket = await tickets.getById(adapter, ticketId);

        if (!ticket) {
          if (isJsonMode) {
            console.log(JSON.stringify({ success: false, error: `Ticket not found: ${ticketId}` }));
          } else {
            console.error(chalk.red(`✗ Ticket not found: ${ticketId}`));
          }
          process.exit(1);
        }

        if (options.verbose) {
          console.log(chalk.gray(`  Ticket: ${ticket.title}`));
          console.log(chalk.gray(`  Current status: ${ticket.status}`));
          console.log(chalk.gray(`  Category: ${ticket.category ?? 'none'}`));
        }

        if (ticket.status !== 'blocked' && !forceReset) {
          if (isJsonMode) {
            console.log(JSON.stringify({
              success: false,
              error: `Ticket is ${ticket.status}, not blocked. Use --force to reset anyway.`,
            }));
          } else {
            console.error(chalk.yellow(`⚠ Ticket is ${ticket.status}, not blocked`));
            console.log(chalk.gray('  Use --force to reset anyway'));
          }
          process.exit(1);
        }

        const newAllowedPaths = regenerateAllowedPaths(ticket);

        const updates: string[] = [];
        const params: unknown[] = [];
        let paramIndex = 1;

        updates.push(`status = $${paramIndex++}`);
        params.push('ready');

        updates.push(`allowed_paths = $${paramIndex++}`);
        params.push(JSON.stringify(newAllowedPaths));

        if (newDescription !== undefined) {
          updates.push(`description = $${paramIndex++}`);
          params.push(newDescription);
        }

        updates.push(`updated_at = datetime('now')`);

        params.push(ticketId);

        await adapter.query(
          `UPDATE tickets SET ${updates.join(', ')} WHERE id = $${paramIndex}`,
          params
        );

        const updatedTicket = await tickets.getById(adapter, ticketId);

        if (isJsonMode) {
          console.log(JSON.stringify({
            success: true,
            ticket: {
              id: updatedTicket!.id,
              title: updatedTicket!.title,
              status: updatedTicket!.status,
              allowedPaths: updatedTicket!.allowedPaths,
              description: updatedTicket!.description,
            },
            changes: {
              statusFrom: ticket.status,
              statusTo: 'ready',
              allowedPathsCount: newAllowedPaths.length,
              descriptionUpdated: newDescription !== undefined,
            },
          }));
        } else {
          console.log(chalk.green('✓ Ticket reset successfully'));
          console.log();
          console.log(chalk.gray(`  ID: ${updatedTicket!.id}`));
          console.log(chalk.gray(`  Title: ${updatedTicket!.title}`));
          console.log(chalk.gray(`  Status: ${ticket.status} → ready`));
          console.log(chalk.gray(`  Allowed paths: ${newAllowedPaths.length} paths`));
          if (options.verbose && newAllowedPaths.length > 0) {
            for (const p of newAllowedPaths.slice(0, 5)) {
              console.log(chalk.gray(`    - ${p}`));
            }
            if (newAllowedPaths.length > 5) {
              console.log(chalk.gray(`    ... and ${newAllowedPaths.length - 5} more`));
            }
          }
          if (newDescription !== undefined) {
            console.log(chalk.gray(`  Description: updated`));
          }
          console.log();
          console.log(chalk.blue('Next step:'));
          console.log(`  blockspool solo run ${ticketId}`);
        }

      } finally {
        await adapter.close();
      }
    });

  /**
   * solo pr - Create PR for completed ticket
   */
  solo
    .command('pr <ticketId>')
    .description('Create a PR for a completed ticket branch')
    .addHelpText('after', `
This command creates a PR for a ticket that was completed without --pr.

Use this when:
- A ticket ran successfully but --pr was not specified
- The branch was pushed but PR creation was skipped

Examples:
  blockspool solo pr tkt_abc123         # Create PR for ticket's branch
`)
    .option('-v, --verbose', 'Show detailed output')
    .option('--json', 'Output as JSON')
    .action(async (ticketId: string, options: {
      verbose?: boolean;
      json?: boolean;
    }) => {
      const isJsonMode = options.json;

      if (!isJsonMode) {
        console.log(chalk.blue('🔗 BlockSpool Solo PR'));
        console.log();
      }

      const git = createGitService();
      const repoRoot = await git.findRepoRoot(process.cwd());

      if (!repoRoot) {
        if (isJsonMode) {
          console.log(JSON.stringify({ success: false, error: 'Not a git repository' }));
        } else {
          console.error(chalk.red('✗ Not a git repository'));
        }
        process.exit(1);
      }

      const preflightResult = await runPreflightChecks(repoRoot, { needsPr: true });
      if (!preflightResult.ok) {
        if (isJsonMode) {
          console.log(JSON.stringify({ success: false, error: preflightResult.error }));
        } else {
          console.error(chalk.red(`✗ ${preflightResult.error}`));
        }
        process.exit(1);
      }

      if (!isInitialized(repoRoot)) {
        if (isJsonMode) {
          console.log(JSON.stringify({ success: false, error: 'Solo mode not initialized. Run: blockspool solo init' }));
        } else {
          console.error(chalk.red('✗ Solo mode not initialized. Run: blockspool solo init'));
        }
        process.exit(1);
      }

      const adapter = await getAdapter(repoRoot);

      try {
        const ticket = await tickets.getById(adapter, ticketId);

        if (!ticket) {
          if (isJsonMode) {
            console.log(JSON.stringify({ success: false, error: `Ticket not found: ${ticketId}` }));
          } else {
            console.error(chalk.red(`✗ Ticket not found: ${ticketId}`));
          }
          process.exit(1);
        }

        if (!isJsonMode) {
          console.log(`Ticket: ${chalk.bold(ticket.title)}`);
          console.log(chalk.gray(`  ID: ${ticket.id}`));
          console.log(chalk.gray(`  Status: ${ticket.status}`));
          console.log();
        }

        const result = await adapter.query<{
          id: string;
          metadata: string | null;
        }>(
          `SELECT id, metadata FROM runs
           WHERE ticket_id = $1 AND status = 'success' AND type = 'worker'
           ORDER BY completed_at DESC
           LIMIT 1`,
          [ticketId]
        );

        const runRow = result.rows[0];
        if (!runRow) {
          if (isJsonMode) {
            console.log(JSON.stringify({ success: false, error: 'No successful run found for this ticket' }));
          } else {
            console.error(chalk.red('✗ No successful run found for this ticket'));
            console.log(chalk.gray('  The ticket must have completed successfully before creating a PR.'));
          }
          process.exit(1);
        }

        const metadata = runRow.metadata ? JSON.parse(runRow.metadata) : {};
        const branchName = metadata.branchName as string | undefined;

        if (!branchName) {
          if (isJsonMode) {
            console.log(JSON.stringify({ success: false, error: 'No branch name found in run metadata' }));
          } else {
            console.error(chalk.red('✗ No branch name found in run metadata'));
          }
          process.exit(1);
        }

        if (metadata.prUrl) {
          if (isJsonMode) {
            console.log(JSON.stringify({ success: true, prUrl: metadata.prUrl, alreadyExists: true }));
          } else {
            console.log(chalk.yellow(`PR already exists: ${metadata.prUrl}`));
          }
          return;
        }

        if (!isJsonMode) {
          console.log(chalk.gray(`Branch: ${branchName}`));
          console.log(chalk.gray('Creating PR...'));
        }

        const { execFileSync } = await import('child_process');
        try {
          execFileSync('git', ['ls-remote', '--heads', 'origin', branchName], { cwd: repoRoot, encoding: 'utf-8', stdio: 'pipe' });
        } catch {
          if (isJsonMode) {
            console.log(JSON.stringify({ success: false, error: `Branch not found on remote: ${branchName}` }));
          } else {
            console.error(chalk.red(`✗ Branch not found on remote: ${branchName}`));
            console.log(chalk.gray('  The branch must be pushed to the remote before creating a PR.'));
          }
          process.exit(1);
        }

        try {
          const prBody = `## Summary\n\n${ticket.description ?? ticket.title}\n\n---\n_Created by BlockSpool_`;

          const prOutput = execFileSync(
            'gh', ['pr', 'create', '--title', ticket.title, '--body', prBody, '--head', branchName],
            { cwd: repoRoot, encoding: 'utf-8' }
          ).trim();

          const urlMatch = prOutput.match(/https:\/\/github\.com\/[^\s]+/);
          const prUrl = urlMatch ? urlMatch[0] : undefined;

          if (prUrl) {
            const existingMetadata = runRow.metadata ? JSON.parse(runRow.metadata) : {};
            const updatedMetadata = { ...existingMetadata, prUrl };
            await adapter.query(
              `UPDATE runs SET metadata = $1 WHERE id = $2`,
              [JSON.stringify(updatedMetadata), runRow.id]
            );

            await tickets.updateStatus(adapter, ticketId, 'in_review');

            if (isJsonMode) {
              console.log(JSON.stringify({ success: true, prUrl, branchName }));
            } else {
              console.log();
              console.log(chalk.green('✓ PR created successfully'));
              console.log(chalk.cyan(`  ${prUrl}`));
            }
          } else {
            if (isJsonMode) {
              console.log(JSON.stringify({ success: false, error: 'PR created but could not parse URL' }));
            } else {
              console.log(chalk.yellow('⚠ PR created but could not parse URL'));
              console.log(chalk.gray(`  Output: ${prOutput}`));
            }
          }
        } catch (prError) {
          if (isJsonMode) {
            console.log(JSON.stringify({ success: false, error: prError instanceof Error ? prError.message : String(prError) }));
          } else {
            console.error(chalk.red(`✗ Failed to create PR: ${prError instanceof Error ? prError.message : prError}`));
          }
          process.exit(1);
        }

      } finally {
        await adapter.close();
      }
    });
}
