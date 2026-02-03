/**
 * Execution tools: next_ticket, validate_scope, complete_ticket, fail_ticket
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { repos } from '@blockspool/core';
import type { Ticket } from '@blockspool/core';
import { execSync } from 'node:child_process';
import type { SessionManager } from '../state.js';

/**
 * Allowlist of safe command prefixes for verification commands.
 * Defense in depth: prevents arbitrary command execution if the trust boundary is compromised.
 */
const ALLOWED_COMMAND_PREFIXES = [
  // Node.js / JavaScript
  'npm test',
  'npm run',
  'npx vitest',
  'npx jest',
  'npx mocha',
  'npx playwright',
  'npx cypress',
  'npx eslint',
  'npx tsc',
  'npx tsx',
  'yarn test',
  'yarn run',
  'pnpm test',
  'pnpm run',
  'bun test',
  'bun run',
  'vitest',
  'jest',
  'mocha',
  // Python
  'pytest',
  'python -m pytest',
  'python3 -m pytest',
  'python -m unittest',
  'python3 -m unittest',
  'mypy',
  'ruff',
  'flake8',
  'pylint',
  // Go
  'go test',
  'go vet',
  'go build',
  'golangci-lint',
  // Rust
  'cargo test',
  'cargo check',
  'cargo clippy',
  'cargo build',
  // Ruby
  'bundle exec rspec',
  'bundle exec rake',
  'rspec',
  'rake test',
  'rails test',
  // Java / JVM
  'mvn test',
  'mvn verify',
  'gradle test',
  './gradlew test',
  // C# / .NET
  'dotnet test',
  'dotnet build',
  // PHP
  'phpunit',
  'vendor/bin/phpunit',
  './vendor/bin/phpunit',
  'composer test',
  // Elixir
  'mix test',
  'mix compile',
  // Swift
  'swift test',
  'swift build',
  // Make (common wrapper)
  'make test',
  'make check',
  'make build',
];

/**
 * Validates a verification command against the allowlist.
 * Returns { valid: true } if the command is allowed, or { valid: false, reason: string } if not.
 */
export function validateVerificationCommand(command: string): { valid: true } | { valid: false; reason: string } {
  const trimmedCommand = command.trim();

  // Empty commands are not allowed
  if (!trimmedCommand) {
    return { valid: false, reason: 'Empty command is not allowed' };
  }

  // Check for shell injection patterns
  const dangerousPatterns = [
    /[;&|`$]/, // Shell operators and command substitution
    /\$\(/, // Command substitution
    /\$\{/, // Variable expansion
    />|>>|</, // Redirection
    /\n/, // Newlines (could inject commands)
  ];

  for (const pattern of dangerousPatterns) {
    if (pattern.test(trimmedCommand)) {
      return { valid: false, reason: `Command contains potentially dangerous pattern: ${pattern.source}` };
    }
  }

  // Check if command starts with an allowed prefix
  const isAllowed = ALLOWED_COMMAND_PREFIXES.some(prefix =>
    trimmedCommand === prefix || trimmedCommand.startsWith(prefix + ' ')
  );

  if (!isAllowed) {
    return {
      valid: false,
      reason: `Command "${trimmedCommand.slice(0, 50)}${trimmedCommand.length > 50 ? '...' : ''}" does not match any allowed command prefix. Allowed prefixes: npm test, npm run, vitest, jest, pytest, go test, cargo test, etc.`
    };
  }

  return { valid: true };
}

export function registerExecuteTools(server: McpServer, getState: () => SessionManager) {
  server.tool(
    'blockspool_next_ticket',
    'Returns the next ticket to work on: title, description, allowed_paths, and execution instructions.',
    {},
    async () => {
      const state = getState();
      const run = state.requireActive();

      // Find next ready ticket
      const readyTickets = await repos.tickets.listByProject(
        state.db, run.project_id, { status: 'ready', limit: 1 }
      );

      if (readyTickets.length === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              message: 'No tickets ready for execution. Call blockspool_advance to scout for more work.',
              tickets_completed: run.tickets_completed,
              tickets_failed: run.tickets_failed,
            }),
          }],
        };
      }

      const ticket = readyTickets[0];

      // Mark as in_progress
      await repos.tickets.updateStatus(state.db, ticket.id, 'in_progress');
      state.run.assignTicket(ticket.id);

      // Create a worker run record
      const dbRun = await repos.runs.create(state.db, {
        projectId: run.project_id,
        type: 'worker',
        ticketId: ticket.id,
      });

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            ticketId: ticket.id,
            runId: dbRun.id,
            title: ticket.title,
            description: ticket.description,
            allowedPaths: ticket.allowedPaths,
            verificationCommands: ticket.verificationCommands,
            category: ticket.category,
            instructions: buildExecutionPrompt(ticket),
          }, null, 2),
        }],
      };
    },
  );

  server.tool(
    'blockspool_validate_scope',
    'Before committing, send the list of changed files. BlockSpool checks scope enforcement.',
    {
      ticketId: z.string().optional().describe('The ticket ID being worked on.'),
      ticket_id: z.string().optional().describe('Alias for ticketId.'),
      changedFiles: z.array(z.string()).optional().describe('List of file paths that were modified.'),
      changed_files: z.array(z.string()).optional().describe('Alias for changedFiles.'),
    },
    async (raw) => {
      const params = {
        ticketId: (raw.ticketId ?? raw.ticket_id)!,
        changedFiles: (raw.changedFiles ?? raw.changed_files)!,
      };
      const state = getState();
      state.requireActive();

      const ticket = await repos.tickets.getById(state.db, params.ticketId);
      if (!ticket) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Ticket not found.' }) }],
          isError: true,
        };
      }

      // If no allowed_paths, everything is allowed
      if (ticket.allowedPaths.length === 0) {
        state.run.appendEvent('SCOPE_ALLOWED', { ticket_id: params.ticketId, files: params.changedFiles });
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ valid: true, message: 'No scope restrictions.' }),
          }],
        };
      }

      const violations: string[] = [];
      for (const file of params.changedFiles) {
        const allowed = ticket.allowedPaths.some(pattern => {
          if (file === pattern) return true;
          if (file.startsWith(pattern.replace(/\*\*$/, '').replace(/\*$/, ''))) return true;
          if (pattern.endsWith('/**') && file.startsWith(pattern.slice(0, -3))) return true;
          return false;
        });
        if (!allowed) {
          violations.push(file);
        }
      }

      if (violations.length > 0) {
        state.run.appendEvent('SCOPE_BLOCKED', {
          ticket_id: params.ticketId,
          violations,
          allowed_paths: ticket.allowedPaths,
        });
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              valid: false,
              violations,
              allowedPaths: ticket.allowedPaths,
              message: 'Some changed files are outside the allowed scope. Revert those changes before completing.',
            }, null, 2),
          }],
        };
      }

      state.run.appendEvent('SCOPE_ALLOWED', { ticket_id: params.ticketId, files: params.changedFiles });
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ valid: true, message: 'All changes within allowed scope.' }),
        }],
      };
    },
  );

  server.tool(
    'blockspool_complete_ticket',
    'Mark a ticket as done. BlockSpool runs QA commands to verify, then records success.',
    {
      ticketId: z.string().optional().describe('The ticket ID to complete.'),
      ticket_id: z.string().optional().describe('Alias for ticketId.'),
      runId: z.string().optional().describe('The run ID from next_ticket.'),
      run_id: z.string().optional().describe('Alias for runId.'),
      summary: z.string().optional().describe('Brief summary of changes made.'),
    },
    async (raw) => {
      const params = {
        ticketId: (raw.ticketId ?? raw.ticket_id)!,
        runId: (raw.runId ?? raw.run_id)!,
        summary: raw.summary,
      };
      const state = getState();
      state.requireActive();

      const ticket = await repos.tickets.getById(state.db, params.ticketId);
      if (!ticket) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Ticket not found.' }) }],
          isError: true,
        };
      }

      state.run.appendEvent('QA_STARTED', { ticket_id: params.ticketId });

      // Validate all verification commands before executing any
      const invalidCommands: Array<{ command: string; reason: string }> = [];
      for (const cmd of ticket.verificationCommands) {
        const validation = validateVerificationCommand(cmd);
        if (!validation.valid) {
          invalidCommands.push({ command: cmd, reason: validation.reason });
        }
      }

      if (invalidCommands.length > 0) {
        state.run.appendEvent('QA_FAILED', {
          ticket_id: params.ticketId,
          reason: 'Verification command validation failed',
          invalid_commands: invalidCommands,
        });
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              ticketId: params.ticketId,
              error: 'Verification command validation failed',
              invalidCommands,
              message: 'One or more verification commands were rejected for security reasons. Only standard test runners are allowed (npm test, vitest, jest, pytest, go test, cargo test, etc.).',
            }, null, 2),
          }],
          isError: true,
        };
      }

      // Run QA commands
      const qaResults: Array<{ command: string; success: boolean; output: string }> = [];
      for (const cmd of ticket.verificationCommands) {
        try {
          const output = execSync(cmd, {
            cwd: state.project.rootPath,
            timeout: 120_000,
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
          });
          qaResults.push({ command: cmd, success: true, output: output.slice(-2000) });
          state.run.appendEvent('QA_COMMAND_RESULT', { command: cmd, success: true });
        } catch (e: unknown) {
          const err = e as { stdout?: string; stderr?: string; message: string };
          const output = (err.stderr || err.stdout || err.message).slice(-2000);
          qaResults.push({ command: cmd, success: false, output });
          state.run.appendEvent('QA_COMMAND_RESULT', { command: cmd, success: false });
        }
      }

      const allPassed = qaResults.every(r => r.success);

      if (allPassed) {
        await repos.tickets.updateStatus(state.db, params.ticketId, 'done');
        await repos.runs.markSuccess(state.db, params.runId, {
          summary: params.summary,
          qaResults,
        });
        state.run.appendEvent('QA_PASSED', { ticket_id: params.ticketId });
        state.run.setPhase('PR');

        // Save QA artifact
        state.run.saveArtifact(
          `${state.run.require().step_count}-qa-stdout.log`,
          qaResults.map(r => `$ ${r.command}\n${r.output}`).join('\n\n'),
        );

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              ticketId: params.ticketId,
              qaResults: qaResults.map(r => ({ command: r.command, success: r.success })),
              message: 'QA passed. Call blockspool_advance to create a PR for this ticket.',
            }, null, 2),
          }],
        };
      } else {
        state.run.appendEvent('QA_FAILED', { ticket_id: params.ticketId, results: qaResults });
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              ticketId: params.ticketId,
              qaResults,
              message: 'QA failed. Fix the issues and try again, or call blockspool_fail_ticket.',
            }, null, 2),
          }],
        };
      }
    },
  );

  server.tool(
    'blockspool_fail_ticket',
    'Mark a ticket as failed with a reason.',
    {
      ticketId: z.string().optional().describe('The ticket ID that failed.'),
      ticket_id: z.string().optional().describe('Alias for ticketId.'),
      runId: z.string().optional().describe('The run ID from next_ticket.'),
      run_id: z.string().optional().describe('Alias for runId.'),
      reason: z.string().optional().describe('Why the ticket failed.'),
    },
    async (raw) => {
      const params = {
        ticketId: (raw.ticketId ?? raw.ticket_id)!,
        runId: (raw.runId ?? raw.run_id)!,
        reason: raw.reason ?? 'Unknown failure',
      };
      const state = getState();
      state.requireActive();

      await repos.tickets.updateStatus(state.db, params.ticketId, 'blocked');
      await repos.runs.markFailure(state.db, params.runId, params.reason);
      state.run.failTicket(params.reason);

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            ticketId: params.ticketId,
            status: 'blocked',
            reason: params.reason,
            message: 'Ticket marked as failed. Use blockspool_next_ticket for the next one.',
          }, null, 2),
        }],
      };
    },
  );
}

function buildExecutionPrompt(ticket: Ticket): string {
  const parts = [
    `# Task: ${ticket.title}`,
    '',
    ticket.description ?? '',
    '',
    '## Constraints',
    '',
    `- Only modify files in: ${ticket.allowedPaths.length > 0 ? ticket.allowedPaths.join(', ') : 'any files'}`,
    '- Make minimal, focused changes',
    '- Do not introduce new dependencies unless necessary',
    '',
    '## Verification',
    '',
    'After making changes, these commands must pass:',
    ...ticket.verificationCommands.map(c => `- \`${c}\``),
    '',
    '## Workflow',
    '',
    '1. Read the relevant files',
    '2. Make the changes described above',
    '3. Call blockspool_validate_scope with the list of changed files',
    '4. If valid, call blockspool_complete_ticket',
    '5. If QA fails, fix and retry or call blockspool_fail_ticket',
  ];

  return parts.join('\n');
}
