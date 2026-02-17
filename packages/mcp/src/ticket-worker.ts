/**
 * Ticket Worker — self-contained mini state machine for one ticket in parallel mode.
 *
 * Each ticket worker follows: PLAN → EXECUTE → QA → PR → DONE
 * State is stored in RunState.ticket_workers[ticketId].
 */

import type { DatabaseAdapter } from '@blockspool/core';
import { repos, EXECUTION_DEFAULTS } from '@blockspool/core';
import type { Project } from '@blockspool/core';
import { RunManager } from './run-manager.js';
import type {
  AdvanceConstraints,
  CommitPlan,
  EventType,
} from './types.js';
import { deriveScopePolicy, validatePlanScope, serializeScopePolicy } from './scope-policy.js';
import { getRegistry } from './tool-registry.js';
import { checkSpindle, recordDiff, recordCommandFailure, recordPlanHash } from './spindle.js';
import { loadGuidelines, formatGuidelinesForPrompt } from './guidelines.js';
import {
  computeRetryRisk,
  scoreStrategies,
  buildCriticBlock,
} from '@blockspool/core/critic/shared';
import type { Learning } from '@blockspool/core/learnings/shared';
import * as fs from 'node:fs';
import * as path from 'node:path';

const MAX_PLAN_REJECTIONS = 3;
const MAX_QA_RETRIES = EXECUTION_DEFAULTS.MAX_QA_RETRIES;

export interface TicketWorkerContext {
  run: RunManager;
  db: DatabaseAdapter;
  project: Project;
}

export interface TicketWorkerResponse {
  action: 'PROMPT' | 'DONE' | 'FAILED';
  phase: string;
  prompt: string | null;
  constraints: AdvanceConstraints | null;
  ticket_id: string;
  reason: string;
}

/**
 * Advance a single ticket worker through its lifecycle.
 * Called by the blockspool_advance_ticket MCP tool.
 */
export async function advanceTicketWorker(
  ctx: TicketWorkerContext,
  ticketId: string,
): Promise<TicketWorkerResponse> {
  const { run, db } = ctx;
  const s = run.require();
  run.ensureLearningsLoaded();
  const worker = run.getTicketWorker(ticketId);

  if (!worker) {
    return {
      action: 'FAILED',
      phase: 'FAILED',
      prompt: null,
      constraints: null,
      ticket_id: ticketId,
      reason: `No worker state for ticket ${ticketId}`,
    };
  }

  // Increment worker step count and mark as active
  worker.step_count++;
  run.updateTicketWorker(ticketId, { step_count: worker.step_count, last_active_at_step: s.step_count });

  // Budget check per ticket
  if (worker.step_count > s.ticket_step_budget) {
    await repos.tickets.updateStatus(db, ticketId, 'blocked');
    run.failTicketWorker(ticketId, 'Ticket step budget exhausted');
    return {
      action: 'FAILED',
      phase: 'FAILED',
      prompt: null,
      constraints: null,
      ticket_id: ticketId,
      reason: `Ticket step budget exhausted (${worker.step_count}/${s.ticket_step_budget})`,
    };
  }

  // Spindle check (EXECUTE/QA/CROSS_QA phases)
  if (worker.phase === 'EXECUTE' || worker.phase === 'QA' || worker.phase === 'CROSS_QA') {
    const spindleResult = checkSpindle(worker.spindle);
    if (spindleResult.shouldAbort) {
      await repos.tickets.updateStatus(db, ticketId, 'blocked');
      run.failTicketWorker(ticketId, `Spindle abort: ${spindleResult.reason}`);
      return {
        action: 'FAILED',
        phase: 'FAILED',
        prompt: null,
        constraints: null,
        ticket_id: ticketId,
        reason: `Spindle loop detected: ${spindleResult.reason}`,
      };
    }
  }

  // Terminal states
  if (worker.phase === 'DONE' || worker.phase === 'FAILED') {
    return {
      action: worker.phase === 'DONE' ? 'DONE' : 'FAILED',
      phase: worker.phase,
      prompt: null,
      constraints: null,
      ticket_id: ticketId,
      reason: worker.phase === 'DONE' ? 'Ticket completed' : 'Ticket failed',
    };
  }

  const ticket = await repos.tickets.getById(db, ticketId);
  if (!ticket) {
    run.failTicketWorker(ticketId, 'Ticket not found');
    return {
      action: 'FAILED',
      phase: 'FAILED',
      prompt: null,
      constraints: null,
      ticket_id: ticketId,
      reason: 'Ticket not found in database',
    };
  }

  const worktreePath = `.blockspool/worktrees/${ticketId}`;
  const policy = deriveScopePolicy({
    allowedPaths: ticket.allowedPaths ?? [],
    category: ticket.category ?? 'refactor',
    maxLinesPerTicket: s.max_lines_per_ticket,
    worktreeRoot: s.direct ? undefined : worktreePath,
    learnings: s.cached_learnings,
  });

  const constraints: AdvanceConstraints = {
    allowed_paths: policy.allowed_paths,
    denied_paths: policy.denied_paths,
    denied_patterns: policy.denied_patterns.map(r => r.source),
    max_files: policy.max_files,
    max_lines: policy.max_lines,
    required_commands: ticket.verificationCommands ?? [],
    plan_required: policy.plan_required,
    auto_approve_patterns: getRegistry(ctx.project.rootPath).getAutoApprovePatterns({
      phase: worker.phase === 'QA' || worker.phase === 'CROSS_QA' ? 'QA' : worker.phase as 'PLAN' | 'EXECUTE' | 'PR',
      category: ticket.category ?? null,
    }),
  };

  // Write per-ticket scope policy
  writeScopePolicy(ctx.project.rootPath, ticketId, policy);

  switch (worker.phase) {
    case 'PLAN': {
      if (!policy.plan_required) {
        run.updateTicketWorker(ticketId, { plan_approved: true, phase: 'EXECUTE' });
        return advanceTicketWorker(ctx, ticketId);
      }

      if (worker.plan_approved) {
        run.updateTicketWorker(ticketId, { phase: 'EXECUTE' });
        return advanceTicketWorker(ctx, ticketId);
      }

      if (worker.plan_rejections >= MAX_PLAN_REJECTIONS) {
        await repos.tickets.updateStatus(db, ticketId, 'blocked');
        run.failTicketWorker(ticketId, `Plan rejected ${MAX_PLAN_REJECTIONS} times`);
        return {
          action: 'FAILED',
          phase: 'FAILED',
          prompt: null,
          constraints: null,
          ticket_id: ticketId,
          reason: `Commit plan rejected ${MAX_PLAN_REJECTIONS} times`,
        };
      }

      const prompt = buildTicketPlanPrompt(ticket, worktreePath, worker.plan_rejections > 0);
      return {
        action: 'PROMPT',
        phase: 'PLAN',
        prompt,
        constraints,
        ticket_id: ticketId,
        reason: worker.plan_rejections > 0
          ? `Re-planning (attempt ${worker.plan_rejections + 1}/${MAX_PLAN_REJECTIONS})`
          : `Planning ticket: ${ticket.title}`,
      };
    }

    case 'EXECUTE': {
      const guidelines = loadGuidelines(ctx.project.rootPath);
      const guidelinesBlock = guidelines ? formatGuidelinesForPrompt(guidelines) + '\n\n' : '';

      // Build critic block for QA retries
      let criticBlock = '';
      if (worker.qa_retries > 0 && worker.last_qa_failure) {
        const cachedLearnings: Learning[] = run.require().cached_learnings ?? [];
        const failureContext = {
          failed_commands: worker.last_qa_failure.failed_commands,
          error_output: worker.last_qa_failure.error_output,
          attempt: worker.qa_retries + 1,
          max_attempts: MAX_QA_RETRIES,
        };
        const risk = computeRetryRisk(ticket.allowedPaths ?? [], ticket.verificationCommands ?? [], cachedLearnings, failureContext);
        const strategies = scoreStrategies(ticket.allowedPaths ?? [], failureContext, cachedLearnings);
        criticBlock = buildCriticBlock(failureContext, risk, strategies, cachedLearnings);
        if (criticBlock) criticBlock += '\n\n';
      }

      const prompt = guidelinesBlock + criticBlock + buildTicketExecutePrompt(ticket, worker.plan, worktreePath);
      return {
        action: 'PROMPT',
        phase: 'EXECUTE',
        prompt,
        constraints,
        ticket_id: ticketId,
        reason: `Executing ticket: ${ticket.title}`,
      };
    }

    case 'QA': {
      if (worker.qa_retries >= MAX_QA_RETRIES) {
        await repos.tickets.updateStatus(db, ticketId, 'blocked');
        run.failTicketWorker(ticketId, `QA failed ${MAX_QA_RETRIES} times`);
        return {
          action: 'FAILED',
          phase: 'FAILED',
          prompt: null,
          constraints: null,
          ticket_id: ticketId,
          reason: `QA failed ${MAX_QA_RETRIES} times`,
        };
      }

      const prompt = buildTicketQaPrompt(ticket, worktreePath);
      return {
        action: 'PROMPT',
        phase: 'QA',
        prompt,
        constraints,
        ticket_id: ticketId,
        reason: `Running QA for: ${ticket.title} (attempt ${worker.qa_retries + 1}/${MAX_QA_RETRIES})`,
      };
    }

    case 'CROSS_QA': {
      if (worker.qa_retries >= MAX_QA_RETRIES) {
        await repos.tickets.updateStatus(db, ticketId, 'blocked');
        run.failTicketWorker(ticketId, `Cross-verify QA failed ${MAX_QA_RETRIES} times`);
        return {
          action: 'FAILED',
          phase: 'FAILED',
          prompt: null,
          constraints: null,
          ticket_id: ticketId,
          reason: `Cross-verify QA failed ${MAX_QA_RETRIES} times`,
        };
      }

      const prompt = buildCrossQaPrompt(ticket, worktreePath);
      return {
        action: 'PROMPT',
        phase: 'CROSS_QA',
        prompt,
        constraints,
        ticket_id: ticketId,
        reason: `Cross-verifying: ${ticket.title} (attempt ${worker.qa_retries + 1}/${MAX_QA_RETRIES})`,
      };
    }

    case 'PR': {
      const prompt = buildTicketPrPrompt(ticket, s.draft, worktreePath);
      return {
        action: 'PROMPT',
        phase: 'PR',
        prompt,
        constraints: null,
        ticket_id: ticketId,
        reason: `Creating PR for: ${ticket.title}`,
      };
    }

    default:
      return {
        action: 'FAILED',
        phase: 'FAILED',
        prompt: null,
        constraints: null,
        ticket_id: ticketId,
        reason: `Unknown worker phase: ${worker.phase}`,
      };
  }
}

/**
 * Ingest an event for a specific ticket worker.
 * Mirrors event-processor.ts logic but scoped to one ticket.
 */
export async function ingestTicketEvent(
  ctx: TicketWorkerContext,
  ticketId: string,
  type: string,
  payload: Record<string, unknown>,
): Promise<{ processed: boolean; message: string }> {
  const { run, db } = ctx;
  const worker = run.getTicketWorker(ticketId);
  if (!worker) {
    return { processed: false, message: `No worker for ticket ${ticketId}` };
  }

  run.appendEvent(type as EventType, { ...payload, ticket_id: ticketId, parallel: true });

  switch (type) {
    case 'PLAN_SUBMITTED': {
      if (worker.phase !== 'PLAN') {
        return { processed: true, message: 'Plan submitted outside PLAN phase' };
      }

      const raw = payload;
      const rawFiles = Array.isArray(raw.files_to_touch) ? raw.files_to_touch
        : Array.isArray(raw.files) ? raw.files
        : Array.isArray(raw.touched_files) ? raw.touched_files : [];
      const files_to_touch = rawFiles.map((f: unknown) => {
        if (typeof f === 'string') return { path: f, action: 'modify' as const, reason: '' };
        if (f && typeof f === 'object' && 'path' in f) return f as { path: string; action: 'create' | 'modify' | 'delete'; reason: string };
        return { path: String(f), action: 'modify' as const, reason: '' };
      });
      const plan: CommitPlan = {
        ticket_id: ticketId,
        files_to_touch,
        expected_tests: Array.isArray(raw.expected_tests) ? raw.expected_tests.map(String) : [],
        risk_level: (raw.risk_level === 'low' || raw.risk_level === 'medium' || raw.risk_level === 'high')
          ? raw.risk_level : 'low',
        estimated_lines: typeof raw.estimated_lines === 'number' ? raw.estimated_lines : 50,
      };

      const ticket = await repos.tickets.getById(db, ticketId);
      const worktreeRoot = run.require().direct ? undefined : `.blockspool/worktrees/${ticketId}`;
      const policy = deriveScopePolicy({
        allowedPaths: ticket?.allowedPaths ?? [],
        category: ticket?.category ?? 'refactor',
        maxLinesPerTicket: run.require().max_lines_per_ticket,
        worktreeRoot,
        learnings: run.require().cached_learnings,
      });

      const scopeResult = validatePlanScope(plan.files_to_touch, plan.estimated_lines, plan.risk_level, policy);
      if (!scopeResult.valid) {
        worker.plan_rejections++;
        run.updateTicketWorker(ticketId, { plan_rejections: worker.plan_rejections });
        return { processed: true, message: `Plan rejected: ${scopeResult.reason}` };
      }

      if (plan.risk_level === 'high') {
        await repos.tickets.updateStatus(db, ticketId, 'blocked');
        run.failTicketWorker(ticketId, 'High-risk plan requires human approval');
        return { processed: true, message: 'High-risk plan requires human approval' };
      }

      recordPlanHash(worker.spindle, plan);
      run.updateTicketWorker(ticketId, {
        plan,
        plan_approved: true,
        phase: 'EXECUTE',
      });
      return { processed: true, message: 'Plan approved, moving to EXECUTE' };
    }

    case 'TICKET_RESULT': {
      // Accept TICKET_RESULT in any phase — inline prompts (Task subagents) don't
      // call back at each step, so worker.phase may still be 'PLAN'.
      const status = payload['status'] as string;
      if (status === 'done' || status === 'success') {
        // For inline prompts, 'success' means the subagent completed everything
        // including QA, commit, push. If PR_CREATED follows, that's the final step.
        // If not, treat this as ticket complete (e.g., direct commit without PR).
        if (payload['pr_url']) {
          // PR was created — mark complete
          if (run.require().create_prs) {
            run.require().prs_created++;
          }
          run.completeTicketWorker(ticketId);
          return { processed: true, message: 'Ticket complete with PR' };
        }
        // No PR URL — move to QA if in traditional flow, or complete if inline
        if (worker.phase === 'EXECUTE') {
          const diff = (payload['diff'] ?? null) as string | null;
          const changedFiles = (payload['changed_files'] ?? []) as string[];
          recordDiff(worker.spindle, diff ?? (changedFiles.length > 0 ? changedFiles.join('\n') : null));
          const nextPhase = run.require().cross_verify ? 'CROSS_QA' : 'QA';
          run.updateTicketWorker(ticketId, { phase: nextPhase, spindle: worker.spindle });
          return { processed: true, message: run.require().cross_verify ? 'Moving to CROSS_QA (independent verification)' : 'Moving to QA' };
        }
        // Inline prompt completed without PR — mark complete
        run.completeTicketWorker(ticketId);
        return { processed: true, message: 'Ticket complete (no PR)' };
      }
      if (status === 'failed') {
        await repos.tickets.updateStatus(db, ticketId, 'blocked');
        run.failTicketWorker(ticketId, (payload['reason'] as string) ?? 'Execution failed');
        return { processed: true, message: 'Ticket failed' };
      }
      return { processed: true, message: `Ticket result: ${status}` };
    }

    case 'QA_COMMAND_RESULT': {
      const success = payload['success'] as boolean;
      if (!success) {
        recordCommandFailure(worker.spindle, payload['command'] as string, (payload['output'] ?? '') as string);
        run.updateTicketWorker(ticketId, { spindle: worker.spindle });
      }
      return { processed: true, message: `QA command ${success ? 'passed' : 'failed'}` };
    }

    case 'QA_PASSED': {
      if (worker.phase !== 'QA' && worker.phase !== 'CROSS_QA') {
        return { processed: true, message: 'QA passed outside QA/CROSS_QA phase' };
      }
      await repos.tickets.updateStatus(db, ticketId, 'done');

      // Skip PR phase when not creating PRs
      if (!run.require().create_prs) {
        run.completeTicketWorker(ticketId);
        return { processed: true, message: 'QA passed, PRs disabled — ticket complete' };
      }

      run.updateTicketWorker(ticketId, { phase: 'PR' });
      return { processed: true, message: 'QA passed, moving to PR' };
    }

    case 'QA_FAILED': {
      if (worker.phase !== 'QA' && worker.phase !== 'CROSS_QA') {
        return { processed: true, message: 'QA failed outside QA/CROSS_QA phase' };
      }
      recordDiff(worker.spindle, null);
      worker.qa_retries++;
      // Store failure context for critic block injection on retry
      {
        const failedCmds = (payload['failed_commands'] ?? payload['command'] ?? '') as string | string[];
        const errorOutput = (payload['error'] ?? payload['output'] ?? '') as string;
        worker.last_qa_failure = {
          failed_commands: Array.isArray(failedCmds) ? failedCmds : failedCmds ? [failedCmds] : [],
          error_output: errorOutput.slice(0, 500),
        };
      }
      if (worker.qa_retries >= MAX_QA_RETRIES) {
        await repos.tickets.updateStatus(db, ticketId, 'blocked');
        run.failTicketWorker(ticketId, `QA failed ${worker.qa_retries} times`);
        return { processed: true, message: `QA failed ${worker.qa_retries} times, giving up` };
      }
      // On CROSS_QA failure, send back to EXECUTE (implementer re-tries), not CROSS_QA
      run.updateTicketWorker(ticketId, { phase: 'EXECUTE', qa_retries: worker.qa_retries, spindle: worker.spindle });
      return { processed: true, message: `QA failed (attempt ${worker.qa_retries}/${MAX_QA_RETRIES}), retrying from EXECUTE` };
    }

    case 'PR_CREATED': {
      // Accept PR_CREATED in any phase — inline prompts (Task subagents) don't
      // call back at each step, so worker.phase may still be 'PLAN'.
      // The session-level phase is PARALLEL_EXECUTE which is what matters.
      if (run.require().create_prs) {
        run.require().prs_created++;
      }
      run.completeTicketWorker(ticketId);
      return { processed: true, message: 'PR created, ticket complete' };
    }

    default:
      return { processed: true, message: `Event ${type} recorded for ticket ${ticketId}` };
  }
}

// ---------------------------------------------------------------------------
// Per-ticket scope policy writer
// ---------------------------------------------------------------------------

function writeScopePolicy(
  projectRoot: string,
  ticketId: string,
  policy: ReturnType<typeof deriveScopePolicy>,
): void {
  const dir = path.join(projectRoot, '.blockspool', 'scope-policies');
  fs.mkdirSync(dir, { recursive: true });
  const policyPath = path.join(dir, `${ticketId}.json`);
  fs.writeFileSync(policyPath, JSON.stringify(serializeScopePolicy(policy), null, 2), 'utf8');
}

// ---------------------------------------------------------------------------
// Prompt builders (ticket-scoped, with worktree instructions)
// ---------------------------------------------------------------------------

function buildTicketPlanPrompt(
  ticket: { id: string; title: string; description: string | null; allowedPaths: string[]; verificationCommands: string[] },
  worktreePath: string,
  isRetry: boolean,
): string {
  const parts = [
    '# Commit Plan Required',
    '',
    `**Ticket:** ${ticket.title}`,
    '',
    ticket.description ?? '',
    '',
    `**Working directory:** \`${worktreePath}\``,
    'Ensure you are working in the git worktree above. If it does not exist, create it:',
    '```bash',
    `git worktree add ${worktreePath} -b blockspool/${ticket.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 50)}`,
    '```',
    '',
  ];

  if (isRetry) {
    parts.unshift('Your previous commit plan was rejected. Please revise.\n');
  }

  parts.push(
    'Output a `<commit-plan>` XML block with:',
    '```json',
    '{',
    `  "ticket_id": "${ticket.id}",`,
    '  "files_to_touch": [{"path": "...", "action": "create|modify|delete", "reason": "..."}],',
    '  "expected_tests": ["npm test -- --grep ..."],',
    '  "estimated_lines": <number>,',
    '  "risk_level": "low|medium|high"',
    '}',
    '```',
    '',
    `**Allowed paths:** ${ticket.allowedPaths.length > 0 ? ticket.allowedPaths.join(', ') : 'any'}`,
    `**Verification commands:** ${ticket.verificationCommands.join(', ') || 'none specified'}`,
    '',
    'Then call `blockspool_ticket_event` with the ticket_id, type `PLAN_SUBMITTED`, and the plan as payload.',
  );

  return parts.join('\n');
}

function buildTicketExecutePrompt(
  ticket: { id: string; title: string; description: string | null; allowedPaths: string[]; verificationCommands: string[] },
  plan: CommitPlan | null,
  worktreePath: string,
): string {
  const parts = [
    `# Execute: ${ticket.title}`,
    '',
    ticket.description ?? '',
    '',
    `**Working directory:** \`${worktreePath}\``,
    'All file modifications MUST be made inside this worktree directory.',
    '',
  ];

  if (plan) {
    parts.push('## Approved Commit Plan');
    parts.push('```json');
    parts.push(JSON.stringify(plan, null, 2));
    parts.push('```');
    parts.push('');
    parts.push('Follow the plan above. Only touch the files listed.');
    parts.push('');
  }

  parts.push(
    '## Constraints',
    `- Only modify files in: ${ticket.allowedPaths.length > 0 ? ticket.allowedPaths.join(', ') : 'any'}`,
    '- Make minimal, focused changes',
    '',
    '## When done',
    'Output a `<ticket-result>` block with status, changed_files, summary, lines_added, lines_removed.',
    `Then call \`blockspool_ticket_event\` with ticket_id="${ticket.id}", type \`TICKET_RESULT\`, and the result as payload.`,
  );

  return parts.join('\n');
}

function buildTicketQaPrompt(
  ticket: { title: string; verificationCommands: string[] },
  worktreePath: string,
): string {
  return [
    `# QA: ${ticket.title}`,
    '',
    `**Working directory:** \`${worktreePath}\``,
    'Run all commands from within the worktree.',
    '',
    'Run the following verification commands and report results:',
    '',
    ...ticket.verificationCommands.map(c => `\`\`\`bash\ncd ${worktreePath} && ${c}\n\`\`\``),
    '',
    'For each command, call `blockspool_ticket_event` with type `QA_COMMAND_RESULT` and:',
    '`{ "command": "...", "success": true/false, "output": "stdout+stderr" }`',
    '',
    'After all commands, call `blockspool_ticket_event` with type `QA_PASSED` if all pass, or `QA_FAILED` with failure details.',
  ].join('\n');
}

function buildCrossQaPrompt(
  ticket: { title: string; verificationCommands: string[] },
  worktreePath: string,
): string {
  return [
    `# Independent Cross-Verification: ${ticket.title}`,
    '',
    '## IMPORTANT — You are an INDEPENDENT VERIFIER',
    '',
    'You are verifying work done by a DIFFERENT agent. Do NOT trust any claims of success.',
    'You must run ALL verification commands yourself and report results honestly.',
    'If something is broken, report it — even if the implementing agent claimed it works.',
    '',
    `**Working directory:** \`${worktreePath}\``,
    'Run all commands from within the worktree.',
    '',
    '## Verification Commands',
    '',
    ...ticket.verificationCommands.map(c => `\`\`\`bash\ncd ${worktreePath} && ${c}\n\`\`\``),
    '',
    '## Steps',
    '',
    '1. Read the changed files to understand what was modified',
    '2. Run ALL verification commands listed above',
    '3. Check for any obvious issues the implementer may have missed',
    '4. Report results honestly',
    '',
    'For each command, call `blockspool_ticket_event` with type `QA_COMMAND_RESULT` and:',
    '`{ "command": "...", "success": true/false, "output": "stdout+stderr" }`',
    '',
    'After all commands, call `blockspool_ticket_event` with type `QA_PASSED` if all pass, or `QA_FAILED` with failure details.',
  ].join('\n');
}

function buildTicketPrPrompt(
  ticket: { title: string; description: string | null },
  draftPr: boolean,
  worktreePath: string,
): string {
  return [
    '# Create PR',
    '',
    `**Working directory:** \`${worktreePath}\``,
    '',
    `Create a ${draftPr ? 'draft ' : ''}pull request for the changes.`,
    '',
    `**Title:** ${ticket.title}`,
    ticket.description ? `**Description:** ${ticket.description.slice(0, 200)}` : '',
    '',
    '## Steps',
    '',
    `1. \`cd ${worktreePath}\``,
    '2. Stage changes: `git add <files>`',
    '3. Create commit: `git commit -m "..."`',
    '4. Push to remote: `git push -u origin <branch>`',
    `5. Create ${draftPr ? 'draft ' : ''}PR: \`gh pr create${draftPr ? ' --draft' : ''}\``,
    '',
    'Call `blockspool_ticket_event` with type `PR_CREATED` and `{ "url": "<pr-url>", "branch": "<branch-name>" }` as payload.',
  ].join('\n');
}
