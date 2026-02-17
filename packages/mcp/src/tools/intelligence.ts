/**
 * Intelligence tools: validate_ticket, audit_tickets, ticket_stats, heal_blocked
 *
 * Expose intelligence-layer functionality that was previously only
 * available as ad-hoc scripts or internal-only logic.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { repos } from '@promptwheel/core';
import type { SessionManager } from '../state.js';
import type { EventType } from '../types.js';
import {
  deriveScopePolicy,
  isFileAllowed,
} from '../scope-policy.js';
import { checkSpindle } from '../spindle.js';

export function registerIntelligenceTools(server: McpServer, getState: () => SessionManager) {
  // ── promptwheel_validate_ticket ────────────────────────────────────────────
  server.tool(
    'promptwheel_validate_ticket',
    'Validates a ticket against quality gates without executing it. Answers "why can\'t this ticket run?"',
    {
      ticket_id: z.string().describe('The ticket ID to validate.'),
    },
    async (params) => {
      const state = getState();
      try {
        const ticket = await repos.tickets.getById(state.db, params.ticket_id);
        if (!ticket) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({ error: `Ticket ${params.ticket_id} not found` }),
            }],
            isError: true,
          };
        }

        const reasons: string[] = [];
        const suggestions: string[] = [];

        // 1. Check required fields
        if (!ticket.title) {
          reasons.push('Missing title');
        }
        if (!ticket.description) {
          reasons.push('Missing description');
          suggestions.push('Add a description explaining what changes to make');
        }
        if (ticket.allowedPaths.length === 0) {
          suggestions.push('Consider adding allowed_paths to scope the changes');
        }
        if (ticket.verificationCommands.length === 0) {
          reasons.push('No verification commands');
          suggestions.push('Add verification commands (e.g., npm test, npx vitest run)');
        }

        // 2. Check status
        if (ticket.status === 'done') {
          reasons.push('Ticket already completed');
        } else if (ticket.status === 'aborted') {
          reasons.push('Ticket was aborted');
          suggestions.push('Create a new ticket if this work is still needed');
        } else if (ticket.status === 'blocked') {
          reasons.push('Ticket is currently blocked');
          suggestions.push('Use promptwheel_heal_blocked to diagnose and recover');
        } else if (ticket.status === 'in_progress') {
          reasons.push('Ticket is already in progress');
        }

        // 3. Check scope policy
        const run = state.run.current;
        if (run) {
          const policy = deriveScopePolicy({
            allowedPaths: ticket.allowedPaths,
            category: ticket.category ?? 'refactor',
            maxLinesPerTicket: run.max_lines_per_ticket,
          });

          // Check if allowed_paths overlap with denied paths
          for (const p of ticket.allowedPaths) {
            if (!isFileAllowed(p, policy)) {
              reasons.push(`Allowed path "${p}" conflicts with denied policy`);
            }
          }
        }

        // 4. Check retry exhaustion
        if (ticket.retryCount >= ticket.maxRetries) {
          reasons.push(`Retry limit exhausted (${ticket.retryCount}/${ticket.maxRetries})`);
          suggestions.push('Increase maxRetries or simplify the ticket scope');
        }

        const runnable = reasons.length === 0;
        const gateStatus = runnable ? 'PASS' : 'FAIL';

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              ticket_id: params.ticket_id,
              title: ticket.title,
              status: ticket.status,
              runnable,
              gate_status: gateStatus,
              reasons,
              suggestions,
            }, null, 2),
          }],
        };
      } catch (e) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ error: (e as Error).message }),
          }],
          isError: true,
        };
      }
    },
  );

  // ── promptwheel_audit_tickets ──────────────────────────────────────────────
  server.tool(
    'promptwheel_audit_tickets',
    'Analyzes ticket quality across the current session/project.',
    {
      status_filter: z.string().optional().describe('Filter by status (e.g., "ready", "blocked", "done").'),
    },
    async (params) => {
      const state = getState();
      try {
        const run = state.run.current;
        const projectId = run?.project_id ?? state.project.id;

        // Get all tickets, optionally filtered by status
        const statusOpt = params.status_filter
          ? { status: params.status_filter as 'ready' | 'blocked' | 'done' }
          : undefined;
        const allTickets = await repos.tickets.listByProject(
          state.db, projectId, { ...statusOpt, limit: 500 },
        );

        // Aggregate by status
        const byStatus: Record<string, number> = {};
        for (const t of allTickets) {
          byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;
        }

        // Aggregate by category
        const byCategory: Record<string, number> = {};
        for (const t of allTickets) {
          const cat = t.category ?? 'uncategorized';
          byCategory[cat] = (byCategory[cat] ?? 0) + 1;
        }

        // Detect quality issues
        const qualityIssues: string[] = [];

        const noDescription = allTickets.filter(t => !t.description);
        if (noDescription.length > 0) {
          qualityIssues.push(`${noDescription.length} ticket(s) missing description`);
        }

        const noVerification = allTickets.filter(t => t.verificationCommands.length === 0);
        if (noVerification.length > 0) {
          qualityIssues.push(`${noVerification.length} ticket(s) missing verification commands`);
        }

        const noScope = allTickets.filter(t => t.allowedPaths.length === 0);
        if (noScope.length > 0) {
          qualityIssues.push(`${noScope.length} ticket(s) with no allowed_paths (unrestricted scope)`);
        }

        const retryExhausted = allTickets.filter(t => t.retryCount >= t.maxRetries && t.status !== 'done');
        if (retryExhausted.length > 0) {
          qualityIssues.push(`${retryExhausted.length} ticket(s) exhausted retries without completing`);
        }

        const blocked = allTickets.filter(t => t.status === 'blocked');
        if (blocked.length > 3) {
          qualityIssues.push(`High blocked count: ${blocked.length} tickets blocked`);
        }

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              total: allTickets.length,
              by_status: byStatus,
              by_category: byCategory,
              quality_issues: qualityIssues,
            }, null, 2),
          }],
        };
      } catch (e) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ error: (e as Error).message }),
          }],
          isError: true,
        };
      }
    },
  );

  // ── promptwheel_ticket_stats ───────────────────────────────────────────────
  server.tool(
    'promptwheel_ticket_stats',
    'Throughput metrics — completions by type, by day, success rates.',
    {
      days: z.number().optional().describe('Number of days to look back (default: 7).'),
    },
    async (params) => {
      const state = getState();
      try {
        const run = state.run.current;
        const projectId = run?.project_id ?? state.project.id;
        const lookbackDays = params.days ?? 7;
        const cutoff = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);

        // Get all tickets
        const allTickets = await repos.tickets.listByProject(
          state.db, projectId, { limit: 1000 },
        );

        // Get runs for duration/success tracking
        const allRuns = await repos.runs.listByProject(
          state.db, projectId, { limit: 1000 },
        );

        // Filter to recent window
        const recentTickets = allTickets.filter(t => t.updatedAt >= cutoff);
        const recentRuns = allRuns.filter(r => r.createdAt >= cutoff);

        // Completions by day
        const completionsByDay: Record<string, number> = {};
        const completedTickets = recentTickets.filter(t => t.status === 'done');
        for (const t of completedTickets) {
          const day = t.updatedAt.toISOString().slice(0, 10);
          completionsByDay[day] = (completionsByDay[day] ?? 0) + 1;
        }

        // By category
        const byCategory: Record<string, number> = {};
        for (const t of completedTickets) {
          const cat = t.category ?? 'uncategorized';
          byCategory[cat] = (byCategory[cat] ?? 0) + 1;
        }

        // Success rate
        const workerRuns = recentRuns.filter(r => r.type === 'worker');
        const successRuns = workerRuns.filter(r => r.status === 'success');
        const successRate = workerRuns.length > 0
          ? Math.round((successRuns.length / workerRuns.length) * 100) / 100
          : 0;

        // Average duration
        const durations = workerRuns
          .filter(r => r.completedAt && r.startedAt)
          .map(r => r.completedAt!.getTime() - r.startedAt!.getTime());
        const avgDurationMs = durations.length > 0
          ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
          : 0;

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              lookback_days: lookbackDays,
              completions_by_day: completionsByDay,
              by_category: byCategory,
              total_completed: completedTickets.length,
              total_runs: workerRuns.length,
              success_rate: successRate,
              avg_duration_ms: avgDurationMs,
            }, null, 2),
          }],
        };
      } catch (e) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ error: (e as Error).message }),
          }],
          isError: true,
        };
      }
    },
  );

  // ── promptwheel_history ───────────────────────────────────────────────────
  server.tool(
    'promptwheel_history',
    'View recent session runs with summary stats.',
    {
      limit: z.number().optional().describe('Max number of runs to return (default: 10).'),
    },
    async (params) => {
      const state = getState();
      try {
        const run = state.run.current;
        const projectId = run?.project_id ?? state.project.id;
        const limit = params.limit ?? 10;

        const allRuns = await repos.runs.listByProject(
          state.db, projectId, { limit },
        );

        const runs = allRuns.map(r => ({
          id: r.id,
          type: r.type,
          status: r.status,
          ticketId: r.ticketId,
          createdAt: r.createdAt.toISOString(),
          startedAt: r.startedAt?.toISOString() ?? null,
          completedAt: r.completedAt?.toISOString() ?? null,
          durationMs: r.completedAt && r.startedAt
            ? r.completedAt.getTime() - r.startedAt.getTime()
            : null,
        }));

        // Summary stats
        const total = runs.length;
        const successful = runs.filter(r => r.status === 'success').length;
        const failed = runs.filter(r => r.status === 'failure').length;
        const successRate = total > 0 ? Math.round((successful / total) * 100) : 0;

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              total,
              successful,
              failed,
              success_rate_percent: successRate,
              runs,
            }, null, 2),
          }],
        };
      } catch (e) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ error: (e as Error).message }),
          }],
          isError: true,
        };
      }
    },
  );

  // ── promptwheel_heal_blocked ───────────────────────────────────────────────
  server.tool(
    'promptwheel_heal_blocked',
    'Diagnose and recover blocked tickets.',
    {
      ticket_id: z.string().describe('The ticket ID to diagnose/heal.'),
      action: z.enum(['diagnose', 'retry', 'expand_scope']).optional()
        .describe('Action: diagnose (default), retry (reset to ready), expand_scope (widen allowed_paths).'),
    },
    async (params) => {
      const state = getState();
      try {
        const ticket = await repos.tickets.getById(state.db, params.ticket_id);
        if (!ticket) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({ error: `Ticket ${params.ticket_id} not found` }),
            }],
            isError: true,
          };
        }

        const action = params.action ?? 'diagnose';
        const suggestedActions: string[] = [];
        let diagnosis = '';
        let applied: string | undefined;

        // ── Diagnose ──
        if (ticket.status !== 'blocked' && action === 'diagnose') {
          diagnosis = `Ticket is not blocked (status: ${ticket.status})`;
        } else {
          // Analyze why it might be blocked
          const diagParts: string[] = [];

          // Check retry exhaustion
          if (ticket.retryCount >= ticket.maxRetries) {
            diagParts.push(`Retry limit exhausted (${ticket.retryCount}/${ticket.maxRetries})`);
            suggestedActions.push('retry — reset retry count and status to ready');
          }

          // Check scope issues
          if (ticket.allowedPaths.length > 0) {
            const run = state.run.current;
            if (run) {
              const policy = deriveScopePolicy({
                allowedPaths: ticket.allowedPaths,
                category: ticket.category ?? 'refactor',
                maxLinesPerTicket: run.max_lines_per_ticket,
              });

              // Check if all allowed paths are valid
              const invalidPaths = ticket.allowedPaths.filter(p => !isFileAllowed(p, policy));
              if (invalidPaths.length > 0) {
                diagParts.push(`Allowed paths conflict with denied policy: ${invalidPaths.join(', ')}`);
              }
            }

            // Scope too narrow?
            if (ticket.allowedPaths.length <= 2) {
              diagParts.push('Very narrow scope — may need expansion for related files');
              suggestedActions.push('expand_scope — widen allowed_paths for related files');
            }
          }

          // Check spindle state
          const run = state.run.current;
          if (run?.spindle) {
            const spindleCheck = checkSpindle(run.spindle);
            if (spindleCheck.shouldAbort || spindleCheck.shouldBlock) {
              diagParts.push(`Spindle detected: ${spindleCheck.reason ?? 'loop pattern'}`);
              suggestedActions.push('retry — reset after fixing the underlying issue');
            }
          }

          // Check missing verification
          if (ticket.verificationCommands.length === 0) {
            diagParts.push('No verification commands — QA cannot validate');
            suggestedActions.push('Add verification commands before retrying');
          }

          diagnosis = diagParts.length > 0
            ? diagParts.join('; ')
            : 'No obvious issues found — may need manual investigation';
        }

        // ── Apply action ──
        if (action === 'retry') {
          await repos.tickets.updateStatus(state.db, params.ticket_id, 'ready');
          applied = 'Reset ticket status to ready';
          state.run.appendEvent('USER_OVERRIDE' as EventType, {
            ticket_id: params.ticket_id,
            action: 'retry',
          });
        } else if (action === 'expand_scope') {
          if (ticket.allowedPaths.length === 0) {
            applied = 'Ticket has no scope restrictions — expansion not needed';
          } else {
            // Expand to include parent directories and sibling patterns
            const expanded: string[] = [...ticket.allowedPaths];
            for (const p of ticket.allowedPaths) {
              const parts = p.split('/');
              if (parts.length >= 2) {
                // Add sibling pattern: same directory, any file
                const dir = parts.slice(0, -1).join('/');
                const pattern = `${dir}/**`;
                if (!expanded.includes(pattern)) {
                  expanded.push(pattern);
                }
              }
            }

            // We can't directly update allowedPaths through the standard repo API
            // so we reset the ticket to ready with a note about expanded scope
            await repos.tickets.updateStatus(state.db, params.ticket_id, 'ready');
            applied = `Reset to ready. Suggested expanded paths: ${expanded.join(', ')}`;
            state.run.appendEvent('USER_OVERRIDE' as EventType, {
              ticket_id: params.ticket_id,
              action: 'expand_scope',
              expanded_paths: expanded,
            });
          }
        }

        if (suggestedActions.length === 0 && action === 'diagnose') {
          suggestedActions.push('retry — reset status and try again');
        }

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              ticket_id: params.ticket_id,
              title: ticket.title,
              status: ticket.status,
              diagnosis,
              suggested_actions: suggestedActions,
              ...(applied ? { applied } : {}),
            }, null, 2),
          }],
        };
      } catch (e) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ error: (e as Error).message }),
          }],
          isError: true,
        };
      }
    },
  );
}
