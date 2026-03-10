/**
 * Ticket Worker — self-contained mini state machine for one ticket in parallel mode.
 *
 * Each ticket worker follows: PLAN → EXECUTE → QA → PR → DONE
 * State is stored in RunState.ticket_workers[ticketId].
 */

import type { DatabaseAdapter } from '@promptwheel/core';
import { repos, EXECUTION_DEFAULTS } from '@promptwheel/core';
import type { Project } from '@promptwheel/core';
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
import { validateTicketResultPayload } from './event-handlers-ticket.js';
import { recordTicketDedup, toBooleanOrUndefined, toStringOrUndefined, toStringArrayOrUndefined, classifyQaError, extractErrorSignature } from './event-helpers.js';
import { addLearning, extractTags, type StructuredKnowledge } from './learnings.js';
import {
  computeRetryRisk,
  scoreStrategies,
  buildCriticBlock,
} from '@promptwheel/core/critic/shared';
import type { Learning } from '@promptwheel/core/learnings/shared';
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
 * Called by the promptwheel_advance_ticket MCP tool.
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

  // Increment worker step count once per orchestrator call and mark as active
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

  // Spindle check (EXECUTE/QA phases)
  if (worker.phase === 'EXECUTE' || worker.phase === 'QA') {
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

  // Phase loop: handles phase forwarding (e.g. PLAN → EXECUTE) without
  // recursion so that step_count is only incremented once per orchestrator call.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const worktreePath = `.promptwheel/worktrees/${ticketId}`;
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
        phase: worker.phase === 'QA' ? 'QA' : worker.phase as 'PLAN' | 'EXECUTE' | 'PR',
        category: ticket.category ?? null,
      }),
    };

    // Write per-ticket scope policy
    writeScopePolicy(ctx.project.rootPath, ticketId, policy);

    switch (worker.phase) {
      case 'PLAN': {
        if (!policy.plan_required) {
          run.updateTicketWorker(ticketId, { plan_approved: true, phase: 'EXECUTE' });
          continue; // Forward to EXECUTE without re-incrementing step_count
        }

        if (worker.plan_approved) {
          run.updateTicketWorker(ticketId, { phase: 'EXECUTE' });
          continue; // Forward to EXECUTE without re-incrementing step_count
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

        // Merge session-level qa_commands with ticket verification commands
        const sessionQaCommands = s.qa_commands ?? [];
        const qaTicket = sessionQaCommands.length > 0
          ? { ...ticket, verificationCommands: [...new Set([...(ticket.verificationCommands ?? []), ...sessionQaCommands])] }
          : ticket;

        const prompt = buildTicketQaPrompt(qaTicket, worktreePath);
        return {
          action: 'PROMPT',
          phase: 'QA',
          prompt,
          constraints,
          ticket_id: ticketId,
          reason: `Running QA for: ${ticket.title} (attempt ${worker.qa_retries + 1}/${MAX_QA_RETRIES})`,
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
      const worktreeRoot = run.require().direct ? undefined : `.promptwheel/worktrees/${ticketId}`;
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
      const validation = validateTicketResultPayload({
        payload,
        currentPlan: worker.plan,
        maxLinesPerTicket: run.require().max_lines_per_ticket,
      });

      if (validation.isCompletion) {
        const inline = validateInlineCompletionContract(payload, ticketId, 'TICKET_RESULT');

        // Explicit inline-completion contract allows intentional phase bypass.
        if (inline.valid) {
          const prUrl = typeof payload['pr_url'] === 'string' && payload['pr_url'].trim().length > 0
            ? payload['pr_url']
            : null;
          if (run.require().create_prs && !prUrl) {
            return { processed: true, message: 'Inline completion requires pr_url when PR creation is enabled' };
          }
          if (prUrl && run.require().create_prs) {
            run.require().prs_created++;
          }
          await repos.tickets.updateStatus(db, ticketId, 'done');
          await recordTicketDedup(db, run.rootPath, ticketId, true);
          run.completeTicketWorker(ticketId);
          return { processed: true, message: prUrl ? 'Ticket complete with PR (inline contract)' : 'Ticket complete (inline contract)' };
        }

        if (worker.phase !== 'EXECUTE') {
          return { processed: true, message: 'Ticket result outside EXECUTE phase (missing/invalid inline_completion contract)' };
        }

        if (validation.rejectionKind === 'scope') {
          run.appendEvent('SCOPE_BLOCKED', {
            ticket_id: ticketId,
            surprise_files: validation.surpriseFiles,
            planned_files: validation.plannedFiles,
            parallel: true,
          });
        }
        if (validation.rejectionMessage) {
          return { processed: true, message: validation.rejectionMessage };
        }

        const diff = (payload['diff'] ?? null) as string | null;
        const changedFiles = validation.changedFiles;
        recordDiff(worker.spindle, diff ?? (changedFiles.length > 0 ? changedFiles.join('\n') : null));
        run.updateTicketWorker(ticketId, { phase: 'QA', spindle: worker.spindle });
        return { processed: true, message: 'Moving to QA' };
      }
      if (validation.isFailure) {
        await recordTicketDedup(db, run.rootPath, ticketId, false, 'agent_error');
        await repos.tickets.updateStatus(db, ticketId, 'blocked');
        run.failTicketWorker(ticketId, (payload['reason'] as string) ?? 'Execution failed');
        return { processed: true, message: 'Ticket failed' };
      }
      return { processed: true, message: `Ticket result: ${validation.status}` };
    }

    case 'QA_COMMAND_RESULT': {
      const success = toBooleanOrUndefined(payload['success']) ?? false;
      if (!success) {
        recordCommandFailure(worker.spindle, toStringOrUndefined(payload['command']) ?? '', toStringOrUndefined(payload['output']) ?? '');
        run.updateTicketWorker(ticketId, { spindle: worker.spindle });
      }
      return { processed: true, message: `QA command ${success ? 'passed' : 'failed'}` };
    }

    case 'QA_PASSED': {
      if (worker.phase !== 'QA') {
        return { processed: true, message: 'QA passed outside QA phase' };
      }

      await repos.tickets.updateStatus(db, ticketId, 'done');

      // Skip PR phase when not creating PRs
      if (!run.require().create_prs) {
        await recordTicketDedup(db, run.rootPath, ticketId, true);
        run.completeTicketWorker(ticketId);
        return { processed: true, message: 'QA passed, PRs disabled — ticket complete' };
      }

      run.updateTicketWorker(ticketId, { phase: 'PR' });
      return { processed: true, message: 'QA passed, moving to PR' };
    }

    case 'QA_FAILED': {
      if (worker.phase !== 'QA') {
        return { processed: true, message: 'QA failed outside QA phase' };
      }
      recordDiff(worker.spindle, null);
      worker.qa_retries++;
      // Store failure context for critic block injection on retry
      {
        const failedCmdsRaw = toStringArrayOrUndefined(payload['failed_commands'])
          ?? (toStringOrUndefined(payload['command']) ? [toStringOrUndefined(payload['command'])!] : []);
        const failedCmds: string[] = failedCmdsRaw;
        let errorOutput = toStringOrUndefined(payload['error']) ?? toStringOrUndefined(payload['output']) ?? '';
        // Include failed criteria in error context for targeted retry
        const failedCriteria = Array.isArray(payload['criteria_results'])
          ? (payload['criteria_results'] as Array<{ criterion?: string; passed?: boolean; evidence?: string }>)
              .filter(r => r.passed === false)
          : [];
        if (failedCriteria.length > 0) {
          const criteriaMsg = failedCriteria
            .map(r => `Criterion not met: "${r.criterion ?? '?'}" — ${r.evidence ?? 'no evidence'}`)
            .join('; ');
          errorOutput = errorOutput ? `${errorOutput}\n${criteriaMsg}` : criteriaMsg;
        }
        worker.last_qa_failure = {
          failed_commands: failedCmds,
          error_output: errorOutput.slice(0, 500),
        };
      }
      if (worker.qa_retries >= MAX_QA_RETRIES) {
        // Record learning on final QA failure (mirrors event-handlers-qa.ts logic)
        const s = run.require();
        if (s.learnings_enabled) {
          const ticket = await repos.tickets.getById(db, ticketId);
          const errorOutput = worker.last_qa_failure?.error_output ?? '';
          const primaryFailedCommand = worker.last_qa_failure?.failed_commands?.[0] ?? '';
          const errorClass = classifyQaError(errorOutput);
          const errorSig = extractErrorSignature(errorOutput);
          const errorSummary = errorOutput.slice(0, 100);
          const structured: StructuredKnowledge = {
            pattern_type: errorClass === 'environment' ? 'environment' : 'antipattern',
            failure_context: {
              command: primaryFailedCommand || (ticket?.verificationCommands?.[0] ?? ''),
              error_signature: errorSig ?? errorSummary.slice(0, 120),
            },
            fragile_paths: ticket?.allowedPaths?.filter(p => !p.includes('*')),
          };
          addLearning(run.rootPath, {
            text: `QA fails on ${ticket?.title ?? 'unknown'} — ${errorSummary || primaryFailedCommand}`.slice(0, 200),
            category: 'gotcha',
            source: { type: 'qa_failure', detail: primaryFailedCommand },
            tags: extractTags(ticket?.allowedPaths ?? [], ticket?.verificationCommands ?? []),
            structured,
          });
        }
        await recordTicketDedup(db, run.rootPath, ticketId, false, 'qa_failed');
        await repos.tickets.updateStatus(db, ticketId, 'blocked');
        run.failTicketWorker(ticketId, `QA failed ${worker.qa_retries} times`);
        return { processed: true, message: `QA failed ${worker.qa_retries} times, giving up` };
      }
      run.updateTicketWorker(ticketId, { phase: 'EXECUTE', qa_retries: worker.qa_retries, spindle: worker.spindle });
      return { processed: true, message: `QA failed (attempt ${worker.qa_retries}/${MAX_QA_RETRIES}), retrying from EXECUTE` };
    }

    case 'PR_CREATED': {
      if (worker.phase !== 'PR') {
        // If worker is already DONE (e.g. TICKET_RESULT with inline contract already
        // completed it and counted the PR), skip to avoid double-counting prs_created.
        if (worker.phase === 'DONE') {
          return { processed: true, message: 'PR_CREATED for already-completed ticket, skipping (PR already counted)' };
        }
        const inline = validateInlineCompletionContract(payload, ticketId, 'PR_CREATED');
        if (!inline.valid) {
          return { processed: true, message: 'PR created outside PR phase (missing/invalid inline_completion contract)' };
        }
      }

      if (typeof payload['url'] !== 'string' || payload['url'].trim().length === 0) {
        return { processed: true, message: 'PR_CREATED missing url' };
      }

      if (run.require().create_prs) {
        run.require().prs_created++;
      }
      await recordTicketDedup(db, run.rootPath, ticketId, true);
      run.completeTicketWorker(ticketId);
      return { processed: true, message: 'PR created, ticket complete' };
    }

    default:
      return { processed: true, message: `Event ${type} recorded for ticket ${ticketId}` };
  }
}

type InlineCompletionEvent = 'TICKET_RESULT' | 'PR_CREATED';

function validateInlineCompletionContract(
  payload: Record<string, unknown>,
  ticketId: string,
  eventType: InlineCompletionEvent,
): { valid: boolean; reason?: string } {
  const raw = payload['inline_completion'];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { valid: false, reason: 'missing inline_completion' };
  }

  const contract = raw as Record<string, unknown>;
  if (Number(contract['contract_version']) !== 1) {
    return { valid: false, reason: 'invalid contract_version' };
  }
  if (contract['mode'] !== 'full') {
    return { valid: false, reason: 'invalid mode' };
  }
  if (contract['ticket_id'] !== ticketId) {
    return { valid: false, reason: 'ticket_id mismatch' };
  }
  if (contract['event_type'] !== eventType) {
    return { valid: false, reason: 'event_type mismatch' };
  }

  return { valid: true };
}

// ---------------------------------------------------------------------------
// Per-ticket scope policy writer
// ---------------------------------------------------------------------------

function writeScopePolicy(
  projectRoot: string,
  ticketId: string,
  policy: ReturnType<typeof deriveScopePolicy>,
): void {
  const dir = path.join(projectRoot, '.promptwheel', 'scope-policies');
  fs.mkdirSync(dir, { recursive: true });
  const policyPath = path.join(dir, `${ticketId}.json`);
  const tmpPath = policyPath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(serializeScopePolicy(policy), null, 2), 'utf8');
  fs.renameSync(tmpPath, policyPath);
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
    `git worktree add ${worktreePath} -b promptwheel/${ticket.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 50)}`,
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
    'Then call `promptwheel_ticket_event` with the ticket_id, type `PLAN_SUBMITTED`, and the plan as payload.',
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
    `Then call \`promptwheel_ticket_event\` with ticket_id="${ticket.id}", type \`TICKET_RESULT\`, and the result as payload.`,
  );

  return parts.join('\n');
}

function buildTicketQaPrompt(
  ticket: { title: string; verificationCommands: string[]; metadata?: Record<string, unknown> | null },
  worktreePath: string,
): string {
  const criteria = extractTicketCriteria(ticket.metadata);
  const parts = [
    `# QA: ${ticket.title}`,
    '',
    `**Working directory:** \`${worktreePath}\``,
    'Run all commands from within the worktree.',
    '',
    'Run the following verification commands and report results:',
    '',
    ...ticket.verificationCommands.map(c => `\`\`\`bash\ncd ${worktreePath} && ${c}\n\`\`\``),
    '',
    'For each command, call `promptwheel_ticket_event` with type `QA_COMMAND_RESULT` and:',
    '`{ "command": "...", "success": true/false, "output": "stdout+stderr" }`',
    '',
  ];

  if (criteria.length > 0) {
    parts.push(
      '## Criteria Verification',
      '',
      'After all commands pass, verify each acceptance criterion against `git diff HEAD~1`:',
      '',
      ...criteria.map((c, i) => `${i + 1}. ${c}`),
      '',
      'Include `criteria_results` in your QA_PASSED/QA_FAILED payload:',
      '`[{ "criterion": "...", "passed": true/false, "evidence": "..." }]`',
      '',
      'If any criterion fails, report QA_FAILED even if all commands passed.',
      '',
    );
  }

  parts.push(
    'After all commands, call `promptwheel_ticket_event` with type `QA_PASSED` if all pass, or `QA_FAILED` with failure details.',
  );

  return parts.join('\n');
}

/** Extract acceptance_criteria from ticket metadata */
function extractTicketCriteria(metadata: Record<string, unknown> | null | undefined): string[] {
  if (!metadata) return [];
  const raw = metadata['acceptance_criteria'];
  if (!Array.isArray(raw)) return [];
  return raw.filter((c): c is string => typeof c === 'string');
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
    'Call `promptwheel_ticket_event` with type `PR_CREATED` and `{ "url": "<pr-url>", "branch": "<branch-name>" }` as payload.',
  ].join('\n');
}
