/**
 * Session management tools: start_session, session_status, end_session, advance, ingest_event
 */

import { join, resolve } from 'node:path';
import { unlinkSync, existsSync, readdirSync, statSync, rmSync, readFileSync, appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { loadGuidelines } from '../guidelines.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { SessionManager } from '../state.js';
import { advance } from '../advance.js';
import { processEvent } from '../event-processor.js';
import { advanceTicketWorker, ingestTicketEvent } from '../ticket-worker.js';
import type { EventType, SessionConfig } from '../types.js';
import { deriveScopePolicy, isFileAllowed, serializeScopePolicy } from '../scope-policy.js';
import { repos } from '@blockspool/core';
import { loadFormula, applyFormula, listFormulas } from '../formulas.js';

export function registerSessionTools(server: McpServer, getState: () => SessionManager) {
  server.tool(
    'blockspool_start_session',
    'Initialize an improvement session. Creates a run folder with state.json and event log. Call this first.',
    {
      hours: z.number().optional().describe('Session duration in hours. Omit for unlimited.'),
      formula: z.string().optional().describe('Formula name (e.g., security-audit, test-coverage).'),
      deep: z.boolean().optional().describe('Enable deep architectural review mode.'),
      continuous: z.boolean().optional().describe('Run until manually stopped.'),
      scope: z.string().optional().describe('Glob pattern for files to scan (default: ** i.e. entire project).'),
      categories: z.array(z.string()).optional().describe('Trust ladder categories.'),
      min_confidence: z.number().optional().describe('Minimum confidence threshold (default: 70).'),
      max_proposals: z.number().optional().describe('Max proposals per scout (default: 5).'),
      step_budget: z.number().optional().describe('Max advance() calls (default: 200).'),
      ticket_step_budget: z.number().optional().describe('Max steps per ticket (default: 12).'),
      max_prs: z.number().optional().describe('Max PRs to create (default: 5, unlimited when hours is set).'),
      max_cycles: z.number().optional().describe('Max scout→execute cycles (default: 1). Use with hours for multi-cycle runs.'),
      draft_prs: z.boolean().optional().describe('Deprecated: use create_prs + draft instead.'),
      create_prs: z.boolean().optional().describe('Create PRs for completed tickets (default: false). Without this, commits directly.'),
      draft: z.boolean().optional().describe('When creating PRs, make them drafts (default: false).'),
      eco: z.boolean().optional().describe('Eco mode: allow subagent delegation during scout for lower cost (default: false).'),
      parallel: z.number().optional().describe('Number of tickets to execute in parallel (default: 2, max: 5). Set to 1 for sequential mode.'),
      min_impact_score: z.number().optional().describe('Minimum impact score (1-10) for proposals to be accepted (default: 3). Filters out low-value lint/cleanup.'),
      learnings: z.boolean().optional().describe('Enable cross-run learnings (default: true). Set false to disable.'),
      learnings_budget: z.number().optional().describe('Max chars for learnings injected into prompts (default: 2000).'),
      learnings_decay_rate: z.number().optional().describe('Weight decay per session load (default: 3).'),
      direct: z.boolean().optional().describe('Direct mode: edit in place without worktrees/branches (default: true for simple solo use). Auto-disabled when create_prs=true or parallel>1.'),
      cross_verify: z.boolean().optional().describe('Cross-verify: use a separate verifier agent for QA instead of self-verification (default: false).'),
      skip_review: z.boolean().optional().describe('Skip adversarial review: create tickets directly from scout proposals without a second review pass (default: false).'),
      dry_run: z.boolean().optional().describe('Dry-run mode: scout only, no ticket creation or execution (default: false).'),
      qa_commands: z.array(z.string()).optional().describe('QA commands to always run after every ticket (e.g. ["pytest", "cargo test"]).'),
    },
    async (params) => {
      const state = getState();

      // Load and apply formula if specified
      let config: SessionConfig = {
        hours: params.hours,
        formula: params.formula,
        deep: params.deep,
        continuous: params.continuous,
        scope: params.scope,
        categories: params.categories,
        min_confidence: params.min_confidence,
        max_proposals: params.max_proposals,
        step_budget: params.step_budget,
        ticket_step_budget: params.ticket_step_budget,
        max_prs: params.max_prs,
        max_cycles: params.max_cycles,
        draft_prs: params.draft_prs,
        create_prs: params.create_prs,
        draft: params.draft,
        eco: params.eco,
        parallel: params.parallel,
        min_impact_score: params.min_impact_score,
        learnings: params.learnings,
        learnings_budget: params.learnings_budget,
        learnings_decay_rate: params.learnings_decay_rate,
        direct: params.direct,
        cross_verify: params.cross_verify,
        skip_review: params.skip_review,
        dry_run: params.dry_run,
        qa_commands: params.qa_commands,
      };

      let formulaInfo: { name: string; description: string } | undefined;
      if (params.formula) {
        const formula = loadFormula(params.formula, state.projectPath);
        if (formula) {
          config = applyFormula(formula, config);
          formulaInfo = { name: formula.name, description: formula.description };
        }
      }

      // Pre-start validation: detect environment and adjust config
      const warnings: string[] = [];

      // Git repo check — force direct mode if not a git repo
      const isGitRepo = existsSync(join(state.projectPath, '.git'));
      if (!isGitRepo) {
        config = { ...config, direct: true, create_prs: false };
        warnings.push('Not a git repository — PR creation disabled, using direct mode.');
      } else {
        // Check for uncommitted changes
        const gitStatus = spawnSync('git', ['status', '--porcelain'], {
          cwd: state.projectPath, encoding: 'utf-8', timeout: 5000,
        });
        if (gitStatus.stdout && gitStatus.stdout.trim().length > 0) {
          const changedCount = gitStatus.stdout.trim().split('\n').length;
          warnings.push(`${changedCount} uncommitted change(s) detected. Consider committing or stashing before running BlockSpool.`);
        }

        // Ensure .blockspool/ is in .gitignore
        const gitignorePath = join(state.projectPath, '.gitignore');
        try {
          const gitignore = existsSync(gitignorePath) ? readFileSync(gitignorePath, 'utf8') : '';
          if (!gitignore.includes('.blockspool')) {
            appendFileSync(gitignorePath, `${gitignore.endsWith('\n') || gitignore === '' ? '' : '\n'}# BlockSpool session data\n.blockspool/\n`);
            warnings.push('Added .blockspool/ to .gitignore.');
          }
        } catch (err) {
          warnings.push(`Could not update .gitignore: ${err instanceof Error ? err.message : 'unknown error'}. Please add .blockspool/ to .gitignore manually.`);
        }
      }

      // Guidelines awareness
      const guidelines = loadGuidelines(state.projectPath);
      if (guidelines) {
        warnings.push(`Using project guidelines from ${guidelines.source}.`);
      } else {
        warnings.push('No CLAUDE.md found — consider adding project guidelines for better results.');
      }

      // Scope suggestion for large repos
      if (!config.scope || config.scope === '**') {
        const sourceDirs = ['src', 'lib', 'app', 'packages'].filter(
          d => existsSync(join(state.projectPath, d)),
        );
        if (sourceDirs.length > 0) {
          try {
            const topEntries = readdirSync(state.projectPath).filter(
              e => !e.startsWith('.') && e !== 'node_modules',
            );
            if (topEntries.length > 50) {
              warnings.push(
                `Large project (${topEntries.length}+ top-level entries). Consider narrowing scope: ${sourceDirs.map(d => `${d}/**`).join(', ')}`,
              );
            }
          } catch { /* ignore readdir failures */ }
        }
      }

      const runState = state.start(config);

      // Test runner info
      if (!runState.project_metadata?.test_run_command) {
        warnings.push('No test runner detected — QA will rely on commands from scout proposals. Consider adding a test script (e.g. package.json scripts.test, pytest.ini, Makefile test target).');
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            run_id: runState.run_id,
            session_id: runState.session_id,
            project_id: runState.project_id,
            phase: runState.phase,
            step_budget: runState.step_budget,
            expires_at: runState.expires_at,
            run_dir: state.run.dir,
            formula: formulaInfo,
            warnings: warnings.length > 0 ? warnings : undefined,
            detected: {
              languages: runState.project_metadata?.languages ?? [],
              test_runner: runState.project_metadata?.test_runner_name ?? null,
              framework: runState.project_metadata?.framework ?? null,
              linter: runState.project_metadata?.linter ?? null,
            },
            message: 'Session started. Call blockspool_advance to begin.',
          }, null, 2),
        }],
      };
    },
  );

  server.tool(
    'blockspool_advance',
    'Get the next action to perform. This is the main loop driver. Call repeatedly until it returns STOP.',
    {},
    async () => {
      const state = getState();
      try {
        const response = await advance({
          run: state.run,
          db: state.db,
          project: state.project,
        });

        // Clean up loop-state.json on terminal responses so stop hook doesn't deadlock
        if (response.next_action === 'STOP') {
          try {
            unlinkSync(join(state.projectPath, '.blockspool', 'loop-state.json'));
          } catch (err) {
            if (err instanceof Error && !('code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT')) {
              console.warn(`[blockspool] failed to clean up loop-state.json: ${err.message}`);
            }
          }
        }

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(response, null, 2),
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

  server.tool(
    'blockspool_ingest_event',
    'Report an event back to BlockSpool. Used after executing an action from advance(). Triggers state transitions.',
    {
      type: z.string().describe('Event type (e.g., SCOUT_OUTPUT, PLAN_SUBMITTED, TICKET_RESULT, QA_PASSED, QA_FAILED, PR_CREATED, USER_OVERRIDE).'),
      payload: z.record(z.string(), z.unknown()).describe('Event payload data.'),
    },
    async (params) => {
      const state = getState();
      try {
        state.run.require();

        // Log the raw event
        state.run.appendEvent(params.type as EventType, params.payload as Record<string, unknown>);

        // Process the event (may trigger state transitions)
        const result = await processEvent(
          state.run,
          state.db,
          params.type as EventType,
          params.payload as Record<string, unknown>,
          state.project,
        );

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              ...result,
              step: state.run.require().step_count,
              current_phase: state.run.require().phase,
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

  server.tool(
    'blockspool_session_status',
    'Get current session state: phase, budgets, tickets completed/failed, time remaining.',
    {},
    async () => {
      const state = getState();
      try {
        const status = state.getStatus();
        const digest = state.run.buildDigest();
        const warnings = state.run.getBudgetWarnings();
        const s = state.run.require();

        // Surface last QA failure details if any tickets have failed
        const lastFailure = s.last_qa_failure ? {
          failed_commands: s.last_qa_failure.failed_commands,
          error_snippet: s.last_qa_failure.error_output.slice(0, 200),
        } : undefined;

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              ...status,
              digest,
              budget_warnings: warnings.length > 0 ? warnings : undefined,
              last_qa_failure: lastFailure,
              last_plan_rejection: s.last_plan_rejection_reason ?? undefined,
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

  server.tool(
    'blockspool_end_session',
    'Finalize the current session. Returns summary.',
    {},
    async () => {
      const state = getState();
      try {
        const finalState = state.end();
        const durationMs = Date.now() - new Date(finalState.started_at).getTime();

        // Clean up loop-state.json so the stop hook doesn't block exit
        try {
          unlinkSync(join(state.projectPath, '.blockspool', 'loop-state.json'));
        } catch (err) {
          if (err instanceof Error && !('code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT')) {
            console.warn(`[blockspool] failed to clean up loop-state.json on end: ${err.message}`);
          }
        }

        // Clean up orphaned worktrees
        const worktreesRemoved = pruneWorktrees(state.projectPath);
        if (worktreesRemoved > 0) {
          spawnSync('git', ['worktree', 'prune'], {
            cwd: state.projectPath,
            encoding: 'utf-8',
          });
        }

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              run_id: finalState.run_id,
              session_id: finalState.session_id,
              duration_ms: durationMs,
              step_count: finalState.step_count,
              tickets_completed: finalState.tickets_completed,
              tickets_failed: finalState.tickets_failed,
              tickets_blocked: finalState.tickets_blocked,
              prs_created: finalState.prs_created,
              scout_cycles: finalState.scout_cycles,
              final_phase: finalState.phase,
              coverage_percent: finalState.files_total > 0 ? Math.round((finalState.files_scanned / finalState.files_total) * 100) : 0,
              sectors_scanned: finalState.sectors_scanned,
              sectors_total: finalState.sectors_total,
              worktrees_removed: worktreesRemoved,
              message: (() => {
                const pct = finalState.files_total > 0 ? Math.round((finalState.files_scanned / finalState.files_total) * 100) : 0;
                return pct >= 100
                  ? 'Session ended. Full coverage achieved.'
                  : `Session ended. ${pct}% of codebase scanned — run longer for full coverage.`;
              })(),
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

  server.tool(
    'blockspool_get_scope_policy',
    'Get the scope policy for the current ticket. Used by PreToolUse hooks to check if a file path is allowed before writes.',
    {
      file_path: z.string().optional().describe('Optional file path to check. If provided, returns whether this specific file is allowed.'),
    },
    async (params) => {
      const state = getState();
      try {
        const s = state.run.require();

        if (!s.current_ticket_id) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({ error: 'No active ticket' }),
            }],
            isError: true,
          };
        }

        const ticket = await repos.tickets.getById(state.db, s.current_ticket_id);
        if (!ticket) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({ error: 'Ticket not found' }),
            }],
            isError: true,
          };
        }

        const policy = deriveScopePolicy({
          allowedPaths: ticket.allowedPaths ?? [],
          category: ticket.category ?? 'refactor',
          maxLinesPerTicket: s.max_lines_per_ticket,
        });

        const result: Record<string, unknown> = {
          ticket_id: s.current_ticket_id,
          policy: serializeScopePolicy(policy),
        };

        // If a file path is provided, check it
        if (params.file_path) {
          const allowed = isFileAllowed(params.file_path, policy);
          result.file_check = {
            path: params.file_path,
            allowed,
          };

          // Log the scope check event
          state.run.appendEvent(
            allowed ? 'SCOPE_ALLOWED' : 'SCOPE_BLOCKED',
            { path: params.file_path, ticket_id: s.current_ticket_id },
          );
        }

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(result, null, 2),
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

  server.tool(
    'blockspool_nudge',
    'Add a hint to guide the running session. Hints are consumed in the next scout cycle and appended to the scout prompt.',
    {
      hint: z.string().describe('Guidance for the scout (e.g., "focus on auth module", "skip test files").'),
    },
    async (params) => {
      const state = getState();
      try {
        state.run.addHint(params.hint);
        const s = state.run.require();
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              hint: params.hint,
              pending_hints: s.hints.length,
              message: 'Hint added. Will be consumed in next scout cycle.',
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

  server.tool(
    'blockspool_advance_ticket',
    'Advance a single ticket through its PLAN→EXECUTE→QA→PR lifecycle (parallel mode). Called by subagents working on individual tickets.',
    {
      ticket_id: z.string().describe('The ticket ID to advance.'),
    },
    async (params) => {
      const state = getState();
      try {
        const response = await advanceTicketWorker(
          { run: state.run, db: state.db, project: state.project },
          params.ticket_id,
        );
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(response, null, 2),
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

  server.tool(
    'blockspool_ticket_event',
    'Report an event for a specific ticket (parallel mode). Used by subagents to report plan submissions, QA results, PR creation, etc.',
    {
      ticket_id: z.string().describe('The ticket ID this event belongs to.'),
      type: z.string().describe('Event type (e.g., PLAN_SUBMITTED, TICKET_RESULT, QA_PASSED, QA_FAILED, QA_COMMAND_RESULT, PR_CREATED).'),
      payload: z.record(z.string(), z.unknown()).describe('Event payload data.'),
    },
    async (params) => {
      const state = getState();
      try {
        const result = await ingestTicketEvent(
          { run: state.run, db: state.db, project: state.project },
          params.ticket_id,
          params.type,
          params.payload as Record<string, unknown>,
        );
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(result, null, 2),
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

  server.tool(
    'blockspool_list_formulas',
    'List all available formulas (built-in + custom from .blockspool/formulas/).',
    {},
    async () => {
      const state = getState();
      const formulas = listFormulas(state.projectPath);
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            formulas: formulas.map(f => ({
              name: f.name,
              version: f.version,
              description: f.description,
              categories: f.categories,
              risk_tolerance: f.risk_tolerance,
              tags: f.tags,
            })),
          }, null, 2),
        }],
      };
    },
  );
}

// ── Worktree cleanup ──────────────────────────────────────────────────────────

function pruneWorktrees(repoRoot: string): number {
  try {
    const worktreesDir = join(repoRoot, '.blockspool', 'worktrees');
    if (!existsSync(worktreesDir)) return 0;

    const entries = readdirSync(worktreesDir).filter(e => {
      try { return statSync(join(worktreesDir, e)).isDirectory(); } catch { return false; }
    });
    if (entries.length === 0) return 0;

    // Get worktrees git knows about
    const listResult = spawnSync('git', ['worktree', 'list', '--porcelain'], {
      cwd: repoRoot, encoding: 'utf-8',
    });
    const gitWorktrees = new Set(
      (listResult.stdout ?? '').split('\n')
        .filter(l => l.startsWith('worktree '))
        .map(l => l.replace('worktree ', '').trim()),
    );

    let removed = 0;
    for (const entry of entries) {
      if (entry === '_milestone') continue;
      const worktreePath = join(worktreesDir, entry);
      const isTracked = gitWorktrees.has(resolve(worktreePath));
      try {
        if (isTracked) {
          spawnSync('git', ['worktree', 'remove', '--force', worktreePath], {
            cwd: repoRoot, encoding: 'utf-8',
          });
        } else {
          rmSync(worktreePath, { recursive: true, force: true });
        }
        removed++;
      } catch (err) {
        console.warn(`[blockspool] failed to remove worktree ${entry}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return removed;
  } catch (err) {
    console.warn(`[blockspool] failed to prune worktrees: ${err instanceof Error ? err.message : String(err)}`);
    return 0;
  }
}
