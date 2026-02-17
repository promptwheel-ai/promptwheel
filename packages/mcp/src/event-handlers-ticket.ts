import { repos } from '@promptwheel/core';
import type { EventContext, ProcessResult } from './event-helpers.js';
import { recordSectorOutcome, recordTicketDedup } from './event-helpers.js';
import type { CommitPlan } from './types.js';
import { deriveScopePolicy, validatePlanScope } from './scope-policy.js';
import { recordDiff, recordCommandFailure, recordPlanHash } from './spindle.js';
import { addLearning, extractTags, type StructuredKnowledge } from './learnings.js';
import { isStreamJsonOutput, analyzeTrace } from '@promptwheel/core/trace/shared';

export async function handlePlanSubmitted(ctx: EventContext, payload: Record<string, unknown>): Promise<ProcessResult> {
  const s = ctx.run.require();

  if (s.phase !== 'PLAN') {
    return { processed: true, phase_changed: false, message: 'Plan submitted outside PLAN phase, ignored' };
  }

  const raw = payload as Record<string, unknown>;
  // Coerce files_to_touch — accept files/touched_files as fallback names
  const rawFiles = Array.isArray(raw.files_to_touch) ? raw.files_to_touch
    : Array.isArray(raw.files) ? raw.files
    : Array.isArray(raw.touched_files) ? raw.touched_files : [];
  const files_to_touch = rawFiles.map((f: unknown) => {
    if (typeof f === 'string') return { path: f, action: 'modify' as const, reason: '' };
    if (f && typeof f === 'object' && 'path' in f) return f as { path: string; action: 'create' | 'modify' | 'delete'; reason: string };
    return { path: String(f), action: 'modify' as const, reason: '' };
  });
  const plan: CommitPlan = {
    ticket_id: String(raw.ticket_id ?? s.current_ticket_id ?? ''),
    files_to_touch,
    expected_tests: Array.isArray(raw.expected_tests) ? raw.expected_tests.map(String) : [],
    risk_level: (raw.risk_level === 'low' || raw.risk_level === 'medium' || raw.risk_level === 'high')
      ? raw.risk_level : 'low',
    estimated_lines: typeof raw.estimated_lines === 'number' ? raw.estimated_lines : 50,
  };

  // Derive scope policy for the current ticket
  const ticket = s.current_ticket_id
    ? await repos.tickets.getById(ctx.db, s.current_ticket_id)
    : null;

  const policy = deriveScopePolicy({
    allowedPaths: ticket?.allowedPaths ?? [],
    category: ticket?.category ?? 'refactor',
    maxLinesPerTicket: s.max_lines_per_ticket,
    learnings: s.cached_learnings,
  });

  // Validate plan against scope policy
  const scopeResult = validatePlanScope(
    plan.files_to_touch,
    plan.estimated_lines,
    plan.risk_level,
    policy,
  );

  if (!scopeResult.valid) {
    s.plan_rejections++;
    s.last_plan_rejection_reason = scopeResult.reason ?? null;
    ctx.run.appendEvent('PLAN_REJECTED', { reason: scopeResult.reason, attempt: s.plan_rejections });
    // Record learning on plan rejection
    if (s.learnings_enabled) {
      const structured: StructuredKnowledge = {
        root_cause: scopeResult.reason ?? 'scope violation',
        pattern_type: 'convention',
        applies_to: ticket?.allowedPaths?.[0],
      };
      addLearning(ctx.run.rootPath, {
        text: `Plan rejected: ${scopeResult.reason}`.slice(0, 200),
        category: 'gotcha',
        source: { type: 'plan_rejection', detail: scopeResult.reason ?? undefined },
        tags: extractTags(plan.files_to_touch.map(f => f.path), []),
        structured,
      });
    }
    return {
      processed: true,
      phase_changed: false,
      message: `Plan rejected: ${scopeResult.reason} (attempt ${s.plan_rejections}/${3})`,
    };
  }

  // Plan passed validation
  s.current_ticket_plan = plan;
  recordPlanHash(s.spindle, plan);

  // High-risk plans → BLOCKED_NEEDS_HUMAN
  if (plan.risk_level === 'high') {
    ctx.run.appendEvent('PLAN_REJECTED', { reason: 'High-risk plan requires human approval', risk_level: 'high' });
    ctx.run.setPhase('BLOCKED_NEEDS_HUMAN');
    return {
      processed: true,
      phase_changed: true,
      new_phase: 'BLOCKED_NEEDS_HUMAN',
      message: 'High-risk plan requires human approval',
    };
  }

  // Low/medium risk — auto-approve
  s.plan_approved = true;
  ctx.run.appendEvent('PLAN_APPROVED', { risk_level: plan.risk_level, auto: true });
  ctx.run.setPhase('EXECUTE');
  return {
    processed: true,
    phase_changed: true,
    new_phase: 'EXECUTE',
    message: `${plan.risk_level}-risk plan auto-approved, moving to EXECUTE`,
  };
}

export async function handleTicketResult(ctx: EventContext, payload: Record<string, unknown>): Promise<ProcessResult> {
  const s = ctx.run.require();

  if (s.phase !== 'EXECUTE') {
    return { processed: true, phase_changed: false, message: 'Ticket result outside EXECUTE phase' };
  }

  const status = payload['status'] as string;

  // Accept both 'done' and 'success' as completion status
  if (status === 'done' || status === 'success') {
    // Validate changed_files against plan (if plan exists)
    const changedFiles = (payload['changed_files'] ?? []) as string[];
    const linesAdded = (payload['lines_added'] ?? 0) as number;
    const linesRemoved = (payload['lines_removed'] ?? 0) as number;
    const totalLines = linesAdded + linesRemoved;

    // Save ticket result artifact
    ctx.run.saveArtifact(
      `${s.step_count}-ticket-result.json`,
      JSON.stringify({
        status,
        changed_files: changedFiles,
        lines_added: linesAdded,
        lines_removed: linesRemoved,
        summary: payload['summary'],
      }, null, 2),
    );

    // Validate changed files against approved plan
    if (s.current_ticket_plan) {
      const plannedPaths = new Set(s.current_ticket_plan.files_to_touch.map(f => f.path));
      const surpriseFiles = changedFiles.filter(f => !plannedPaths.has(f));

      if (surpriseFiles.length > 0) {
        ctx.run.appendEvent('SCOPE_BLOCKED', {
          ticket_id: s.current_ticket_id,
          surprise_files: surpriseFiles,
          planned_files: [...plannedPaths],
        });
        return {
          processed: true,
          phase_changed: false,
          message: `Changed files not in plan: ${surpriseFiles.join(', ')}. Revert those changes and re-submit.`,
        };
      }

      // Validate lines against budget
      if (totalLines > s.max_lines_per_ticket) {
        return {
          processed: true,
          phase_changed: false,
          message: `Lines changed (${totalLines}) exceeds budget (${s.max_lines_per_ticket}). Reduce changes.`,
        };
      }
    }

    // Track lines
    s.total_lines_changed += totalLines;

    // Update spindle state with diff info
    const diff = (payload['diff'] ?? null) as string | null;
    recordDiff(s.spindle, diff ?? (changedFiles.length > 0 ? changedFiles.join('\n') : null));

    // Opportunistic trace analysis: if stdout is in payload, check for stream-json
    const stdout = payload['stdout'] as string | undefined;
    if (stdout && isStreamJsonOutput(stdout.split('\n')[0] ?? '')) {
      try {
        const traceAnalysis = analyzeTrace(stdout);
        ctx.run.appendEvent('TRACE_ANALYSIS', {
          ticket_id: s.current_ticket_id,
          is_stream_json: traceAnalysis.is_stream_json,
          compaction_count: traceAnalysis.compactions.length,
          total_tokens: traceAnalysis.total_input_tokens + traceAnalysis.total_output_tokens,
          tool_count: traceAnalysis.tool_profiles.length,
        });
      } catch (err) {
        console.warn(`[promptwheel] trace analysis: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Move to QA
    ctx.run.setPhase('QA');
    return {
      processed: true,
      phase_changed: true,
      new_phase: 'QA',
      message: `Ticket result accepted (${changedFiles.length} files, ${totalLines} lines), moving to QA`,
    };
  }

  if (status === 'failed') {
    // Fetch ticket once for both learning and dedup
    const ticket = s.current_ticket_id ? await repos.tickets.getById(ctx.db, s.current_ticket_id) : null;
    // Record learning on ticket failure
    if (s.learnings_enabled) {
      const reason = (payload['reason'] as string) ?? 'Execution failed';
      const structured: StructuredKnowledge = {
        root_cause: reason.slice(0, 200),
        fragile_paths: ticket?.allowedPaths?.filter(p => !p.includes('*')),
      };
      addLearning(ctx.run.rootPath, {
        text: `Ticket failed on ${ticket?.title ?? 'unknown'} — ${reason}`.slice(0, 200),
        category: 'warning',
        source: { type: 'ticket_failure', detail: reason },
        tags: extractTags(ticket?.allowedPaths ?? [], ticket?.verificationCommands ?? []),
        structured,
      });
    }
    // Record failed ticket in dedup memory + sector failure
    await recordTicketDedup(ctx.db, ctx.run.rootPath, s.current_ticket_id, false, 'agent_error', ticket);
    recordSectorOutcome(ctx.run.rootPath, s.current_sector_path, 'failure');
    // Fail the ticket, move to next
    if (s.current_ticket_id) {
      await repos.tickets.updateStatus(ctx.db, s.current_ticket_id, 'blocked');
      ctx.run.failTicket(payload['reason'] as string ?? 'Execution failed');
    }
    ctx.run.setPhase('NEXT_TICKET');
    return {
      processed: true,
      phase_changed: true,
      new_phase: 'NEXT_TICKET',
      message: 'Ticket failed, moving to NEXT_TICKET',
    };
  }

  return { processed: true, phase_changed: false, message: `Ticket result: ${status}` };
}

export async function handlePrCreated(ctx: EventContext, payload: Record<string, unknown>): Promise<ProcessResult> {
  const s = ctx.run.require();

  if (s.phase !== 'PR') {
    return { processed: true, phase_changed: false, message: 'PR created outside PR phase' };
  }

  // Record completed ticket in dedup memory + sector success (before completeTicket clears current_ticket_id)
  await recordTicketDedup(ctx.db, ctx.run.rootPath, s.current_ticket_id, true);
  recordSectorOutcome(ctx.run.rootPath, s.current_sector_path, 'success');

  // Save PR artifact
  ctx.run.saveArtifact(
    `${s.step_count}-pr-created.json`,
    JSON.stringify({
      ticket_id: s.current_ticket_id,
      pr_number: s.prs_created + 1,
      ...payload,
    }, null, 2),
  );

  s.prs_created++;
  ctx.run.completeTicket();
  ctx.run.appendEvent('PR_CREATED', payload);
  ctx.run.setPhase('NEXT_TICKET');
  return {
    processed: true,
    phase_changed: true,
    new_phase: 'NEXT_TICKET',
    message: `PR created (${s.prs_created}/${s.max_prs}), moving to NEXT_TICKET`,
  };
}
