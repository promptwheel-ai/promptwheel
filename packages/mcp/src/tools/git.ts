/**
 * Git operations tool: git_setup
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { repos } from '@blockspool/core';
import { execFileSync } from 'node:child_process';
import type { SessionManager } from '../state.js';

/**
 * Validates a git branch name to prevent command injection.
 * Only allows alphanumeric characters, hyphens, underscores, forward slashes, and dots.
 * Must not start with a hyphen (to prevent option injection).
 */
function validateBranchName(branch: string): boolean {
  // Git branch name rules:
  // - Cannot start with a hyphen (prevents option injection like --delete)
  // - Only alphanumeric, hyphens, underscores, forward slashes, and dots allowed
  // - Cannot contain shell metacharacters like ; | & $ ` etc.
  const validPattern = /^[a-zA-Z0-9][a-zA-Z0-9\-_./]*$/;
  return validPattern.test(branch);
}

export function registerGitTools(server: McpServer, getState: () => SessionManager) {
  server.tool(
    'blockspool_git_setup',
    'Create/checkout a branch for the current ticket. Returns branch name. Use after completing a ticket to prepare for PR creation.',
    {
      ticketId: z.string().optional().describe('The ticket ID to create a branch for.'),
      ticket_id: z.string().optional().describe('Alias for ticketId.'),
      baseBranch: z.string().optional().describe('Base branch to branch from (default: main).'),
      base_branch: z.string().optional().describe('Alias for baseBranch.'),
    },
    async (raw) => {
      const params = {
        ticketId: (raw.ticketId ?? raw.ticket_id)!,
        baseBranch: raw.baseBranch ?? raw.base_branch,
      };
      const state = getState();
      state.requireActive(); // ensure session is active

      const ticket = await repos.tickets.getById(state.db, params.ticketId);
      if (!ticket) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Ticket not found.' }) }],
          isError: true,
        };
      }

      const baseBranch = params.baseBranch ?? 'main';

      // Validate baseBranch to prevent command injection
      if (!validateBranchName(baseBranch)) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              error: `Invalid base branch name: "${baseBranch}". Branch names must start with an alphanumeric character and contain only alphanumeric characters, hyphens, underscores, forward slashes, and dots.`,
            }),
          }],
          isError: true,
        };
      }

      // Create branch name from ticket
      const slug = ticket.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 50);
      const branchName = `blockspool/${ticket.id}/${slug}`;

      const cwd = state.project.rootPath;

      try {
        // Check if branch exists
        try {
          execFileSync('git', ['rev-parse', '--verify', branchName], { cwd, stdio: 'pipe' });
          // Branch exists, just checkout
          execFileSync('git', ['checkout', branchName], { cwd, stdio: 'pipe' });
        } catch {
          // Branch doesn't exist, create from base
          execFileSync('git', ['checkout', '-b', branchName, baseBranch], { cwd, stdio: 'pipe' });
        }

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              branchName,
              baseBranch,
              ticketId: ticket.id,
              message: `Branch ${branchName} ready. Make your changes, then commit and push.`,
            }, null, 2),
          }],
        };
      } catch (e) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              error: `Git operation failed: ${(e as Error).message}`,
              branchName,
            }),
          }],
          isError: true,
        };
      }
    },
  );
}
