/**
 * Advance Engine — the deterministic state machine.
 *
 * `advance()` is called by the client on every loop iteration.
 * It returns what to do next (prompt + constraints) or STOP.
 *
 * State machine transitions (from docs/PLUGIN_ROADMAP.md):
 *
 *   SCOUT       → NEXT_TICKET | DONE | FAILED_BUDGET
 *   NEXT_TICKET → PLAN | SCOUT | DONE
 *   PLAN        → EXECUTE | PLAN | BLOCKED_NEEDS_HUMAN | FAILED_BUDGET
 *   EXECUTE     → QA | NEXT_TICKET | BLOCKED_NEEDS_HUMAN | FAILED_BUDGET | FAILED_SPINDLE
 *   QA          → PR | EXECUTE | NEXT_TICKET | FAILED_BUDGET
 *   PR          → NEXT_TICKET | FAILED_VALIDATION
 */

import type { DatabaseAdapter } from '@blockspool/core';
import { repos } from '@blockspool/core';
import type { Project } from '@blockspool/core';
import { RunManager } from './run-manager.js';
import type {
  AdvanceResponse,
  AdvanceConstraints,
  Phase,
  ParallelTicketInfo,
} from './types.js';
import { TERMINAL_PHASES } from './types.js';
import { deriveScopePolicy } from './scope-policy.js';
import { checkSpindle, getFileEditWarnings } from './spindle.js';
import { loadFormula } from './formulas.js';
import type { Formula } from './formulas.js';
import { loadGuidelines, formatGuidelinesForPrompt } from './guidelines.js';
import { detectProjectMetadata, formatMetadataForPrompt } from './project-metadata.js';

const MAX_PLAN_REJECTIONS = 3;
const MAX_QA_RETRIES = 3;

export interface AdvanceContext {
  run: RunManager;
  db: DatabaseAdapter;
  project: Project;
}

/**
 * Core advance function. Called once per loop iteration.
 * Returns the next action for the client to perform.
 */
export async function advance(ctx: AdvanceContext): Promise<AdvanceResponse> {
  const { run, db, project } = ctx;
  const s = run.require();

  // Increment step
  run.incrementStep();
  run.appendEvent('ADVANCE_CALLED', { phase: s.phase, step: s.step_count });

  // -----------------------------------------------------------------------
  // Budget checks (run before any phase logic)
  // -----------------------------------------------------------------------
  const budgetResult = checkBudgets(run);
  if (budgetResult) {
    return budgetResult;
  }

  // -----------------------------------------------------------------------
  // Fire budget warnings at 80%
  // -----------------------------------------------------------------------
  const warnings = run.getBudgetWarnings();
  if (warnings.length > 0) {
    run.appendEvent('BUDGET_WARNING', { warnings });
  }

  // -----------------------------------------------------------------------
  // Spindle check (only in EXECUTE/QA — active work phases)
  // -----------------------------------------------------------------------
  if (s.phase === 'EXECUTE' || s.phase === 'QA') {
    const spindleResult = checkSpindle(s.spindle);

    // File edit frequency warnings
    const fileWarnings = getFileEditWarnings(s.spindle);
    if (fileWarnings.length > 0) {
      run.appendEvent('SPINDLE_WARNING', { file_edit_warnings: fileWarnings });
    }

    if (spindleResult.shouldAbort) {
      run.appendEvent('SPINDLE_ABORT', {
        reason: spindleResult.reason,
        confidence: spindleResult.confidence,
        diagnostics: spindleResult.diagnostics,
      });
      if (s.current_ticket_id) {
        await repos.tickets.updateStatus(db, s.current_ticket_id, 'blocked');
        run.failTicket(`Spindle abort: ${spindleResult.reason}`);
      }
      run.setPhase('FAILED_SPINDLE');
      return stopResponse(run, 'FAILED_SPINDLE',
        `Spindle loop detected: ${spindleResult.reason} (confidence: ${(spindleResult.confidence * 100).toFixed(0)}%)`);
    }

    if (spindleResult.shouldBlock) {
      run.appendEvent('SPINDLE_WARNING', {
        reason: spindleResult.reason,
        diagnostics: spindleResult.diagnostics,
        action: 'BLOCKED_NEEDS_HUMAN',
      });
      if (s.current_ticket_id) {
        await repos.tickets.updateStatus(db, s.current_ticket_id, 'blocked');
        run.failTicket(`Spindle block: ${spindleResult.reason}`);
      }
      run.setPhase('BLOCKED_NEEDS_HUMAN');
      return stopResponse(run, 'BLOCKED_NEEDS_HUMAN',
        `Spindle: ${spindleResult.reason}. Needs human intervention.`);
    }
  }

  // -----------------------------------------------------------------------
  // Terminal state check
  // -----------------------------------------------------------------------
  if (TERMINAL_PHASES.has(s.phase)) {
    return stopResponse(run, s.phase, terminalReason(s.phase));
  }

  // -----------------------------------------------------------------------
  // Phase dispatch
  // -----------------------------------------------------------------------
  switch (s.phase) {
    case 'SCOUT':
      return advanceScout(ctx);
    case 'NEXT_TICKET':
      return advanceNextTicket(ctx);
    case 'PLAN':
      return advancePlan(ctx);
    case 'EXECUTE':
      return advanceExecute(ctx);
    case 'QA':
      return advanceQa(ctx);
    case 'PR':
      return advancePr(ctx);
    case 'PARALLEL_EXECUTE':
      return advanceParallelExecute(ctx);
    default:
      return stopResponse(run, 'FAILED_VALIDATION', `Unknown phase: ${s.phase}`);
  }
}

// ---------------------------------------------------------------------------
// Phase handlers
// ---------------------------------------------------------------------------

async function advanceScout(ctx: AdvanceContext): Promise<AdvanceResponse> {
  const { run, db } = ctx;
  const s = run.require();

  // Check if we already have ready tickets in backlog
  const readyTickets = await repos.tickets.listByProject(
    db, s.project_id, { status: 'ready', limit: 1 }
  );

  if (readyTickets.length > 0) {
    // Tickets exist, move to assignment
    run.setPhase('NEXT_TICKET');
    return advance(ctx);
  }

  // No ready tickets — return scout prompt for client to execute
  const recentTickets = await repos.tickets.getRecentlyCompleted(db, s.project_id, 20);
  const dedupContext = recentTickets.map(t => t.title);

  const hints = run.consumeHints();

  // Load formula if specified
  const formula = s.formula ? loadFormula(s.formula, ctx.project.rootPath) : null;

  const guidelines = loadGuidelines(ctx.project.rootPath);
  const guidelinesBlock = guidelines ? formatGuidelinesForPrompt(guidelines) + '\n\n' : '';

  // Detect project metadata for tooling context
  const projectMeta = detectProjectMetadata(ctx.project.rootPath);
  const metadataBlock = formatMetadataForPrompt(projectMeta) + '\n\n';

  const prompt = guidelinesBlock + metadataBlock + buildScoutPrompt(s.scope, s.categories, s.min_confidence,
    s.max_proposals_per_scout, dedupContext, formula, hints, s.eco, s.min_impact_score);

  s.scout_cycles++;
  run.appendEvent('ADVANCE_RETURNED', { phase: 'SCOUT', has_prompt: true });

  return promptResponse(run, 'SCOUT', prompt, 'Scouting for improvements', {
    allowed_paths: [s.scope],
    denied_paths: [],
    denied_patterns: [],
    max_files: 100,
    max_lines: 0,
    required_commands: [],
    plan_required: false,
  });
}

async function advanceNextTicket(ctx: AdvanceContext): Promise<AdvanceResponse> {
  const { run, db } = ctx;
  const s = run.require();

  // Check if we've hit PR limit
  if (s.prs_created >= s.max_prs) {
    run.setPhase('DONE');
    return stopResponse(run, 'DONE', `PR limit reached (${s.prs_created}/${s.max_prs})`);
  }

  const prBudget = s.max_prs - s.prs_created;
  const parallelCount = Math.min(s.parallel, prBudget);

  // Find ready tickets
  const readyTickets = await repos.tickets.listByProject(
    db, s.project_id, { status: 'ready', limit: parallelCount }
  );

  if (readyTickets.length === 0) {
    // No more tickets — scout again if cycles remain, otherwise finish
    if (s.scout_cycles < s.max_cycles) {
      run.setPhase('SCOUT');
      return advance(ctx);
    }
    run.setPhase('DONE');
    return stopResponse(run, 'DONE', 'No more tickets to process');
  }

  // If parallel > 1 and multiple tickets ready → dispatch batch
  if (parallelCount > 1 && readyTickets.length > 1) {
    const parallelTickets: ParallelTicketInfo[] = [];

    for (const ticket of readyTickets) {
      await repos.tickets.updateStatus(db, ticket.id, 'in_progress');
      run.initTicketWorker(ticket.id, ticket);

      await repos.runs.create(db, {
        projectId: s.project_id,
        type: 'worker',
        ticketId: ticket.id,
      });

      const policy = deriveScopePolicy({
        allowedPaths: ticket.allowedPaths ?? [],
        category: ticket.category ?? 'refactor',
        maxLinesPerTicket: s.max_lines_per_ticket,
      });

      parallelTickets.push({
        ticket_id: ticket.id,
        title: ticket.title,
        description: ticket.description ?? '',
        constraints: {
          allowed_paths: policy.allowed_paths,
          denied_paths: policy.denied_paths,
          denied_patterns: policy.denied_patterns.map(r => r.source),
          max_files: policy.max_files,
          max_lines: policy.max_lines,
          required_commands: ticket.verificationCommands ?? [],
          plan_required: policy.plan_required,
        },
      });
    }

    run.setPhase('PARALLEL_EXECUTE');
    return {
      next_action: 'PARALLEL_EXECUTE',
      phase: 'PARALLEL_EXECUTE',
      prompt: null,
      reason: `Dispatching ${readyTickets.length} tickets for parallel execution`,
      constraints: emptyConstraints(),
      digest: run.buildDigest(),
      parallel_tickets: parallelTickets,
    };
  }

  // Sequential flow (parallel=1 or only 1 ticket)
  const ticket = readyTickets[0];

  // Assign ticket
  await repos.tickets.updateStatus(db, ticket.id, 'in_progress');
  run.assignTicket(ticket.id);

  // Create worker run record
  await repos.runs.create(db, {
    projectId: s.project_id,
    type: 'worker',
    ticketId: ticket.id,
  });

  // Derive scope policy for this ticket
  const policy = deriveScopePolicy({
    allowedPaths: ticket.allowedPaths ?? [],
    category: ticket.category ?? 'refactor',
    maxLinesPerTicket: s.max_lines_per_ticket,
  });

  const constraints: AdvanceConstraints = {
    allowed_paths: policy.allowed_paths,
    denied_paths: policy.denied_paths,
    denied_patterns: policy.denied_patterns.map(r => r.source),
    max_files: policy.max_files,
    max_lines: policy.max_lines,
    required_commands: ticket.verificationCommands ?? [],
    plan_required: policy.plan_required,
  };

  // Docs category: skip plan, go straight to execute
  if (!policy.plan_required) {
    s.plan_approved = true;
    run.setPhase('EXECUTE');
    return advanceExecute(ctx);
  }

  // Move to PLAN phase — require commit plan before execution
  run.setPhase('PLAN');

  const prompt = buildPlanPrompt(ticket);

  return promptResponse(run, 'PLAN', prompt,
    `Planning ticket: ${ticket.title}`, constraints);
}

async function advancePlan(ctx: AdvanceContext): Promise<AdvanceResponse> {
  const { run, db } = ctx;
  const s = run.require();

  // If plan is already approved, move to execute
  if (s.plan_approved) {
    run.setPhase('EXECUTE');
    return advanceExecute(ctx);
  }

  // If too many rejections, block the ticket
  if (s.plan_rejections >= MAX_PLAN_REJECTIONS) {
    run.appendEvent('TICKET_FAILED', {
      ticket_id: s.current_ticket_id,
      reason: 'Plan rejected too many times',
    });
    if (s.current_ticket_id) {
      await repos.tickets.updateStatus(db, s.current_ticket_id, 'blocked');
    }
    s.tickets_blocked++;
    s.current_ticket_id = null;
    s.current_ticket_plan = null;
    run.setPhase('BLOCKED_NEEDS_HUMAN');
    return stopResponse(run, 'BLOCKED_NEEDS_HUMAN',
      `Commit plan rejected ${MAX_PLAN_REJECTIONS} times. Needs human review.`);
  }

  // Request a commit plan from the client
  const ticket = s.current_ticket_id
    ? await repos.tickets.getById(db, s.current_ticket_id)
    : null;

  if (!ticket) {
    run.setPhase('NEXT_TICKET');
    return advance(ctx);
  }

  const policy = deriveScopePolicy({
    allowedPaths: ticket.allowedPaths ?? [],
    category: ticket.category ?? 'refactor',
    maxLinesPerTicket: s.max_lines_per_ticket,
  });

  const prompt = s.plan_rejections > 0
    ? `Your previous commit plan was rejected. Please revise.\n\n${buildPlanPrompt(ticket)}`
    : buildPlanPrompt(ticket);

  return promptResponse(run, 'PLAN', prompt,
    s.plan_rejections > 0
      ? `Re-planning (attempt ${s.plan_rejections + 1}/${MAX_PLAN_REJECTIONS})`
      : `Awaiting commit plan for: ${ticket.title}`,
    {
      allowed_paths: policy.allowed_paths,
      denied_paths: policy.denied_paths,
      denied_patterns: policy.denied_patterns.map(r => r.source),
      max_files: policy.max_files,
      max_lines: policy.max_lines,
      required_commands: ticket.verificationCommands ?? [],
      plan_required: policy.plan_required,
    });
}

async function advanceExecute(ctx: AdvanceContext): Promise<AdvanceResponse> {
  const { run, db } = ctx;
  const s = run.require();

  // Check ticket step budget
  if (s.ticket_step_count >= s.ticket_step_budget) {
    if (s.current_ticket_id) {
      await repos.tickets.updateStatus(db, s.current_ticket_id, 'blocked');
      run.failTicket('Ticket step budget exhausted');
    }
    run.setPhase('BLOCKED_NEEDS_HUMAN');
    return stopResponse(run, 'BLOCKED_NEEDS_HUMAN',
      `Ticket step budget exhausted (${s.ticket_step_count}/${s.ticket_step_budget})`);
  }

  const ticket = s.current_ticket_id
    ? await repos.tickets.getById(db, s.current_ticket_id)
    : null;

  if (!ticket) {
    run.setPhase('NEXT_TICKET');
    return advance(ctx);
  }

  const policy = deriveScopePolicy({
    allowedPaths: ticket.allowedPaths ?? [],
    category: ticket.category ?? 'refactor',
    maxLinesPerTicket: s.max_lines_per_ticket,
  });

  const guidelines = loadGuidelines(ctx.project.rootPath);
  const guidelinesBlock = guidelines ? formatGuidelinesForPrompt(guidelines) + '\n\n' : '';

  const prompt = guidelinesBlock + buildExecutePrompt(ticket, s.current_ticket_plan);

  return promptResponse(run, 'EXECUTE', prompt,
    `Executing ticket: ${ticket.title}`, {
      allowed_paths: policy.allowed_paths,
      denied_paths: policy.denied_paths,
      denied_patterns: policy.denied_patterns.map(r => r.source),
      max_files: policy.max_files,
      max_lines: policy.max_lines,
      required_commands: ticket.verificationCommands ?? [],
      plan_required: false,
    });
}

async function advanceQa(ctx: AdvanceContext): Promise<AdvanceResponse> {
  const { run, db } = ctx;
  const s = run.require();

  // If QA retries exceeded, give up on this ticket
  if (s.qa_retries >= MAX_QA_RETRIES) {
    if (s.current_ticket_id) {
      await repos.tickets.updateStatus(db, s.current_ticket_id, 'blocked');
      run.failTicket(`QA failed ${MAX_QA_RETRIES} times`);
    }
    run.setPhase('NEXT_TICKET');
    return advance(ctx);
  }

  const ticket = s.current_ticket_id
    ? await repos.tickets.getById(db, s.current_ticket_id)
    : null;

  if (!ticket) {
    run.setPhase('NEXT_TICKET');
    return advance(ctx);
  }

  const prompt = buildQaPrompt(ticket);

  return promptResponse(run, 'QA', prompt,
    `Running QA for: ${ticket.title} (attempt ${s.qa_retries + 1}/${MAX_QA_RETRIES})`, {
      allowed_paths: ticket.allowedPaths ?? [],
      denied_paths: [],
      denied_patterns: [],
      max_files: 0,
      max_lines: 0,
      required_commands: ticket.verificationCommands ?? [],
      plan_required: false,
    });
}

async function advancePr(ctx: AdvanceContext): Promise<AdvanceResponse> {
  const { run } = ctx;
  const s = run.require();

  const ticket = s.current_ticket_id
    ? await repos.tickets.getById(ctx.db, s.current_ticket_id)
    : null;

  const prompt = buildPrPrompt(ticket, s.draft_prs);

  return promptResponse(run, 'PR', prompt,
    'Creating PR', {
      allowed_paths: [],
      denied_paths: [],
      denied_patterns: [],
      max_files: 0,
      max_lines: 0,
      required_commands: [],
      plan_required: false,
    });
}

async function advanceParallelExecute(ctx: AdvanceContext): Promise<AdvanceResponse> {
  const { run } = ctx;

  // Check if all ticket workers are done
  if (run.allWorkersComplete()) {
    run.setPhase('NEXT_TICKET');
    return advance(ctx);
  }

  // Workers still active — return status (shouldn't happen if plugin waits properly)
  const s = run.require();
  const activeWorkers = Object.entries(s.ticket_workers).map(([id, w]) => ({
    ticket_id: id,
    phase: w.phase,
    step_count: w.step_count,
  }));

  return {
    next_action: 'PROMPT',
    phase: 'PARALLEL_EXECUTE',
    prompt: `Parallel execution still in progress. ${activeWorkers.length} ticket(s) still active. Wait for all subagents to complete, then call blockspool_advance again.`,
    reason: `${activeWorkers.length} ticket workers still active`,
    constraints: emptyConstraints(),
    digest: run.buildDigest(),
  };
}

// ---------------------------------------------------------------------------
// Budget checks
// ---------------------------------------------------------------------------

function checkBudgets(run: RunManager): AdvanceResponse | null {
  const s = run.require();

  if (s.step_count >= s.step_budget) {
    run.appendEvent('BUDGET_EXHAUSTED', { which: 'step_budget', value: s.step_count });
    run.setPhase('FAILED_BUDGET');
    return stopResponse(run, 'FAILED_BUDGET',
      `Step budget exhausted (${s.step_count}/${s.step_budget})`);
  }

  if (s.expires_at && new Date() >= new Date(s.expires_at)) {
    run.appendEvent('BUDGET_EXHAUSTED', { which: 'time_budget' });
    run.setPhase('FAILED_BUDGET');
    return stopResponse(run, 'FAILED_BUDGET', 'Time budget exhausted');
  }

  return null;
}

// ---------------------------------------------------------------------------
// Response builders
// ---------------------------------------------------------------------------

function stopResponse(run: RunManager, phase: Phase, reason: string): AdvanceResponse {
  return {
    next_action: 'STOP',
    phase,
    prompt: null,
    reason,
    constraints: emptyConstraints(),
    digest: run.buildDigest(),
  };
}

function promptResponse(
  run: RunManager,
  phase: Phase,
  prompt: string,
  reason: string,
  constraints: AdvanceConstraints,
): AdvanceResponse {
  return {
    next_action: 'PROMPT',
    phase,
    prompt,
    reason,
    constraints,
    digest: run.buildDigest(),
  };
}

function emptyConstraints(): AdvanceConstraints {
  return {
    allowed_paths: [],
    denied_paths: [],
    denied_patterns: [],
    max_files: 0,
    max_lines: 0,
    required_commands: [],
    plan_required: false,
  };
}

function terminalReason(phase: Phase): string {
  switch (phase) {
    case 'DONE': return 'Session completed successfully';
    case 'BLOCKED_NEEDS_HUMAN': return 'Ticket blocked, needs human review';
    case 'FAILED_BUDGET': return 'Budget exhausted';
    case 'FAILED_VALIDATION': return 'Validation failed';
    case 'FAILED_SPINDLE': return 'Loop detected by spindle';
    default: return 'Terminal state';
  }
}

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

function buildScoutPrompt(
  scope: string,
  categories: string[],
  minConfidence: number,
  maxProposals: number,
  dedupContext: string[],
  formula: Formula | null,
  hints: string[],
  eco: boolean,
  minImpactScore: number = 3,
): string {
  const parts = [
    '# Scout Phase',
    '',
    'Scan the codebase and identify improvements. Return proposals in a `<proposals>` XML block containing a JSON array.',
    '',
    ...(!eco ? ['**IMPORTANT:** Do not use the Task or Explore tools. Read files directly using Read, Glob, and Grep. Do not delegate to subagents.', ''] : []),
    `**Scope:** \`${scope}\``,
    `**Categories:** ${categories.join(', ')}`,
    `**Min confidence:** ${minConfidence}`,
    `**Min impact score:** ${minImpactScore} (proposals below this will be rejected)`,
    `**Max proposals:** ${maxProposals}`,
    '',
    '**DO NOT propose changes to these files** (read-only context): CLAUDE.md, .claude/**',
    '',
    '## Quality Bar',
    '',
    '- Proposals must have **real user or developer impact** — not just lint cleanup or style nits.',
    '- Do NOT propose fixes for lint warnings, unused variables, or cosmetic issues unless they cause actual bugs or test failures.',
    '- If project guidelines are provided above, **respect them**. Do NOT propose changes the guidelines explicitly discourage (e.g., "avoid over-engineering", "don\'t change code you didn\'t touch").',
    '- Focus on: bugs, missing tests, security issues, performance problems, correctness, and meaningful refactors.',
    '',
  ];

  if (dedupContext.length > 0) {
    parts.push('**Already completed (do not duplicate):**');
    for (const title of dedupContext) {
      parts.push(`- ${title}`);
    }
    parts.push('');
  }

  if (formula) {
    parts.push(`**Formula:** ${formula.name} — ${formula.description}`);
    if (formula.prompt) {
      parts.push('');
      parts.push('**Formula instructions:**');
      parts.push(formula.prompt);
    }
    if (formula.risk_tolerance) {
      parts.push(`**Risk tolerance:** ${formula.risk_tolerance}`);
    }
    parts.push('');
  }

  if (hints.length > 0) {
    parts.push('**Hints from user:**');
    for (const hint of hints) {
      parts.push(`- ${hint}`);
    }
    parts.push('');
  }

  parts.push(
    '## Required Fields',
    '',
    'Each proposal in the JSON array MUST include ALL of these fields:',
    '- `category` (string): one of the categories listed above',
    '- `title` (string): concise, unique title',
    '- `description` (string): what needs to change and why',
    '- `acceptance_criteria` (string[]): how to verify the change is correct',
    '- `verification_commands` (string[]): commands to run (e.g. `npm test`)',
    '- `allowed_paths` (string[]): file paths/globs this change may touch',
    '- `files` (string[]): specific files to modify',
    '- `confidence` (number 0-100): how confident you are this is correct',
    '- `impact_score` (number 1-10): how much this matters',
    '- `risk` (string): "low", "medium", or "high"',
    '- `touched_files_estimate` (number): expected number of files changed',
    '- `rollback_note` (string): how to revert if something goes wrong',
    '',
    '## Scoring',
    '',
    'Proposals are ranked by `impact_score × confidence`. Prefer low-risk proposals.',
    '',
    '## Output',
    '',
    'Wrap the JSON array in a `<proposals>` XML block:',
    '```',
    '<proposals>',
    '[{ ... }, { ... }]',
    '</proposals>',
    '```',
    '',
    'Then call `blockspool_ingest_event` with type `SCOUT_OUTPUT` and `{ "proposals": [...] }` as payload.',
  );

  return parts.join('\n');
}

function buildPlanPrompt(ticket: { title: string; description: string | null; allowedPaths: string[]; verificationCommands: string[] }): string {
  return [
    '# Commit Plan Required',
    '',
    `**Ticket:** ${ticket.title}`,
    '',
    ticket.description ?? '',
    '',
    'Before making changes, output a `<commit-plan>` XML block with:',
    '```json',
    '{',
    `  "ticket_id": "<ticket-id>",`,
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
    'Then call `blockspool_ingest_event` with type `PLAN_SUBMITTED` and the plan as payload.',
  ].join('\n');
}

function buildExecutePrompt(
  ticket: { title: string; description: string | null; allowedPaths: string[]; verificationCommands: string[] },
  plan: unknown,
): string {
  const parts = [
    `# Execute: ${ticket.title}`,
    '',
    ticket.description ?? '',
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
    'Then call `blockspool_ingest_event` with type `TICKET_RESULT` and the result as payload.',
  );

  return parts.join('\n');
}

function buildQaPrompt(ticket: { title: string; verificationCommands: string[] }): string {
  return [
    `# QA: ${ticket.title}`,
    '',
    'Run the following verification commands and report results:',
    '',
    ...ticket.verificationCommands.map(c => `\`\`\`bash\n${c}\n\`\`\``),
    '',
    'For each command, call `blockspool_ingest_event` with type `QA_COMMAND_RESULT` and:',
    '`{ "command": "...", "success": true/false, "output": "stdout+stderr" }`',
    '',
    'After all commands, call `blockspool_ingest_event` with type `QA_PASSED` if all pass, or `QA_FAILED` with failure details.',
  ].join('\n');
}

function buildPrPrompt(
  ticket: { title: string; description: string | null } | null,
  draftPr: boolean,
): string {
  const title = ticket?.title ?? 'BlockSpool changes';
  return [
    '# Create PR',
    '',
    `Create a ${draftPr ? 'draft ' : ''}pull request for the changes.`,
    '',
    `**Title:** ${title}`,
    ticket?.description ? `**Description:** ${ticket.description.slice(0, 200)}` : '',
    '',
    '## Dry-run first',
    '',
    '1. Stage changes: `git add <files>`',
    '2. Create commit: `git commit -m "..."`',
    '3. Verify the commit looks correct: `git diff HEAD~1 --stat`',
    '4. Push to remote: `git push -u origin <branch>`',
    `5. Create ${draftPr ? 'draft ' : ''}PR: \`gh pr create${draftPr ? ' --draft' : ''}\``,
    '',
    'Call `blockspool_ingest_event` with type `PR_CREATED` and `{ "url": "<pr-url>", "branch": "<branch-name>" }` as payload.',
  ].join('\n');
}
