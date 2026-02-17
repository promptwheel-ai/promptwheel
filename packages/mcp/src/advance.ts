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

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DatabaseAdapter } from '@promptwheel/core';
import { repos, EXECUTION_DEFAULTS } from '@promptwheel/core';
import type { Project } from '@promptwheel/core';
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
import { loadGuidelines, formatGuidelinesForPrompt } from './guidelines.js';
import { detectProjectMetadata, formatMetadataForPrompt } from './project-metadata.js';
import { formatIndexForPrompt, refreshCodebaseIndex, hasStructuralChanges } from './codebase-index.js';
import { buildProposalReviewPrompt, type ValidatedProposal } from './proposals.js';
import { loadDedupMemory, formatDedupForPrompt } from './dedup-memory.js';
import {
  computeRetryRisk,
  scoreStrategies,
  buildCriticBlock,
  buildPlanRejectionCriticBlock,
} from '@promptwheel/core/critic/shared';
import {
  pickNextSector as pickNextSectorCore,
  computeCoverage as computeCoverageCore,
  buildSectorSummary as buildSectorSummaryCore,
} from '@promptwheel/core/sectors/shared';
import {
  getNextStep as getTrajectoryNextStep,
  formatTrajectoryForPrompt,
} from '@promptwheel/core/trajectory/shared';
import {
  buildScoutPrompt,
  buildScoutEscalation,
  buildPlanPrompt,
  buildExecutePrompt,
  buildQaPrompt,
  buildPrPrompt,
  buildInlineTicketPrompt,
} from './advance-prompts.js';
import {
  loadTrajectoryData,
  loadSectorsState,
  buildLearningsBlock,
  buildRiskContextBlock,
  getScoutAutoApprove,
  getExecuteAutoApprove,
  getQaAutoApprove,
  getPrAutoApprove,
} from './advance-helpers.js';

const MAX_PLAN_REJECTIONS = 3;
const MAX_QA_RETRIES = EXECUTION_DEFAULTS.MAX_QA_RETRIES;
const MAX_SPINDLE_RECOVERIES = 3;

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
  const { run, db } = ctx;
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
      s.spindle_recoveries++;
      if (s.spindle_recoveries >= MAX_SPINDLE_RECOVERIES) {
        run.setPhase('FAILED_SPINDLE');
        return stopResponse(run, 'FAILED_SPINDLE',
          `Spindle loop detected: ${spindleResult.reason} (confidence: ${(spindleResult.confidence * 100).toFixed(0)}%) — recovery cap reached (${s.spindle_recoveries}/${MAX_SPINDLE_RECOVERIES})`);
      }
      run.resetForSpindleRecovery();
      run.setPhase('NEXT_TICKET');
      return advance(ctx);
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
      s.spindle_recoveries++;
      if (s.spindle_recoveries >= MAX_SPINDLE_RECOVERIES) {
        run.setPhase('BLOCKED_NEEDS_HUMAN');
        return stopResponse(run, 'BLOCKED_NEEDS_HUMAN',
          `Spindle: ${spindleResult.reason} — recovery cap reached (${s.spindle_recoveries}/${MAX_SPINDLE_RECOVERIES}). Needs human intervention.`);
      }
      run.resetForSpindleRecovery();
      run.setPhase('NEXT_TICKET');
      return advance(ctx);
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

  // If skip_review is on and stale pending_proposals exist, clear them
  if (s.skip_review && s.pending_proposals !== null) {
    s.pending_proposals = null;
  }

  // If pending proposals exist, return adversarial review prompt
  if (!s.skip_review && s.pending_proposals !== null) {
    // Convert raw proposals to ValidatedProposal shape for the review prompt
    const forReview: ValidatedProposal[] = s.pending_proposals.map(p => ({
      category: p.category ?? 'unknown',
      title: p.title ?? 'Untitled',
      description: p.description ?? '',
      acceptance_criteria: p.acceptance_criteria ?? [],
      verification_commands: p.verification_commands ?? [],
      allowed_paths: p.allowed_paths ?? [],
      files: p.files ?? [],
      confidence: p.confidence ?? 0,
      impact_score: p.impact_score ?? 5,
      rationale: p.rationale ?? '',
      estimated_complexity: p.estimated_complexity ?? 'moderate',
      risk: p.risk ?? 'medium',
      touched_files_estimate: p.touched_files_estimate ?? 0,
      rollback_note: p.rollback_note ?? '',
    }));

    const reviewPrompt = buildProposalReviewPrompt(forReview);
    return promptResponse(run, 'SCOUT', reviewPrompt, 'Reviewing proposals adversarially', {
      allowed_paths: [s.scope],
      denied_paths: [],
      denied_patterns: [],
      max_files: 0,
      max_lines: 0,
      required_commands: [],
      plan_required: false,
      auto_approve_patterns: getScoutAutoApprove(),
    });
  }

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

  // Load dedup memory (with decay) — weighted, persistent awareness of completed work
  const dedupMemory = loadDedupMemory(ctx.project.rootPath);
  const dedupMemoryBlock = formatDedupForPrompt(dedupMemory);
  const dedupBlock = dedupMemoryBlock ? dedupMemoryBlock + '\n\n' : '';

  const hints = run.consumeHints();

  // Load formula if specified
  const formula = s.formula ? loadFormula(s.formula, ctx.project.rootPath) : null;

  const guidelines = loadGuidelines(ctx.project.rootPath);
  const guidelinesBlock = guidelines ? formatGuidelinesForPrompt(guidelines) + '\n\n' : '';

  // Detect project metadata for tooling context
  const projectMeta = detectProjectMetadata(ctx.project.rootPath);
  const metadataBlock = formatMetadataForPrompt(projectMeta) + '\n\n';

  // Refresh codebase index if structure changed (dirty flag from tickets, or external mtime check)
  if (s.codebase_index) {
    const needsRefresh = s.codebase_index_dirty
      || hasStructuralChanges(s.codebase_index, ctx.project.rootPath);
    if (needsRefresh) {
      s.codebase_index = refreshCodebaseIndex(
        s.codebase_index, ctx.project.rootPath, s.scout_exclude_dirs,
      );
      s.codebase_index_dirty = false;
    }
  }

  // Sector rotation: use core pickNextSector for full 9-tiebreaker sort
  // Skip when a trajectory is active — trajectory scope takes priority
  if (!s.active_trajectory) {
    try {
      const sectorsState = loadSectorsState(ctx.project.rootPath);
      if (sectorsState) {
        const picked = pickNextSectorCore(sectorsState, s.scout_cycles);
        if (picked) {
          s.scope = picked.scope;
          s.selected_sector_path = picked.sector.path;
        }
      }
    } catch (err) {
      run.appendEvent('SECTOR_ROTATION_FAILED', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  // Build codebase index block — use cycles + retries so retries advance the chunk
  const chunkOffset = s.scout_cycles + s.scout_retries;
  const indexBlock = s.codebase_index ? formatIndexForPrompt(s.codebase_index, chunkOffset) + '\n\n' : '';

  // Build escalation block if retrying after 0 proposals
  const escalationBlock = s.scout_retries > 0
    ? buildScoutEscalation(s.scout_retries, s.scout_exploration_log, s.scouted_dirs, s.codebase_index) + '\n\n'
    : '';

  const learningsBlock = buildLearningsBlock(run, [s.scope, ...s.scouted_dirs], []);

  const cov = run.buildDigest().coverage;
  let sectorSummary: string | undefined;
  let sectorPercent: number | undefined;
  try {
    const sectorsState = loadSectorsState(ctx.project.rootPath);
    if (sectorsState) {
      const metrics = computeCoverageCore(sectorsState);
      sectorPercent = metrics.sectorPercent;
      sectorSummary = buildSectorSummaryCore(sectorsState, s.selected_sector_path ?? '');
    }
  } catch (err) {
    console.warn(`[promptwheel] Sector summary failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  const coverageCtx = cov.sectors_total > 0
    ? { scannedSectors: cov.sectors_scanned, totalSectors: cov.sectors_total, percent: cov.percent, sectorPercent, sectorSummary }
    : undefined;

  // Trajectory context
  let trajectoryBlock = '';
  try {
    const trajData = loadTrajectoryData(ctx.project.rootPath);
    if (trajData) {
      const currentStep = getTrajectoryNextStep(trajData.trajectory, trajData.state.stepStates);
      if (currentStep) {
        trajectoryBlock = formatTrajectoryForPrompt(trajData.trajectory, trajData.state.stepStates, currentStep) + '\n\n';
        s.active_trajectory = trajData.trajectory.name;
        s.trajectory_step_id = currentStep.id;
        s.trajectory_step_title = currentStep.title;
        // Override scope and categories from step
        if (currentStep.scope) s.scope = currentStep.scope;
        if (currentStep.categories && currentStep.categories.length > 0) {
          s.categories = currentStep.categories;
        }
      }
    }
  } catch (err) {
    console.warn(`[promptwheel] Trajectory load failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const prompt = guidelinesBlock + metadataBlock + indexBlock + dedupBlock + trajectoryBlock + learningsBlock + escalationBlock + buildScoutPrompt(s.scope, s.categories, s.min_confidence,
    s.max_proposals_per_scout, dedupContext, formula, hints, s.eco, s.min_impact_score, s.scouted_dirs, s.scout_exclude_dirs, coverageCtx);

  // Reset scout_retries at the start of a fresh cycle (non-retry entry)
  if (s.scout_retries === 0) {
    s.scout_cycles++;
  }
  run.appendEvent('ADVANCE_RETURNED', { phase: 'SCOUT', has_prompt: true });

  return promptResponse(run, 'SCOUT', prompt, 'Scouting for improvements', {
    allowed_paths: [s.scope],
    denied_paths: [],
    denied_patterns: [],
    max_files: 100,
    max_lines: 0,
    required_commands: [],
    plan_required: false,
    auto_approve_patterns: getScoutAutoApprove(),
  });
}

async function advanceNextTicket(ctx: AdvanceContext): Promise<AdvanceResponse> {
  const { run, db } = ctx;
  const s = run.require();

  // Dry-run mode — stop after scouting, don't execute tickets
  if (s.dry_run) {
    run.setPhase('DONE');
    return stopResponse(run, 'DONE', 'Dry-run mode — scout complete, no tickets executed.');
  }

  // Ensure learnings are loaded for scope policy derivation
  run.ensureLearningsLoaded();

  // Check if we've hit PR limit (only when creating PRs)
  if (s.create_prs && s.prs_created >= s.max_prs) {
    run.setPhase('DONE');
    return stopResponse(run, 'DONE', `PR limit reached (${s.prs_created}/${s.max_prs})`);
  }

  const parallelCount = s.create_prs
    ? Math.min(s.parallel, s.max_prs - s.prs_created)
    : s.parallel;

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
    const cov = run.buildDigest().coverage;
    const covSuffix = cov.sectors_total > 0
      ? ` (${cov.sectors_scanned}/${cov.sectors_total} sectors scanned, ${cov.percent}% coverage)`
      : '';
    return stopResponse(run, 'DONE', `No more tickets to process${covSuffix}`);
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
        learnings: s.cached_learnings,
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
          auto_approve_patterns: getExecuteAutoApprove(ticket.category ?? null),
        },
        inline_prompt: '', // filled below
      });
    }

    run.setPhase('PARALLEL_EXECUTE');

    // Build inline prompts for each ticket — subagents are self-contained
    const guidelines = loadGuidelines(ctx.project.rootPath);
    const guidelinesBlock = guidelines ? formatGuidelinesForPrompt(guidelines) + '\n\n' : '';
    const projectMeta = detectProjectMetadata(ctx.project.rootPath);
    const metadataBlock = formatMetadataForPrompt(projectMeta) + '\n\n';

    // Read project setup command and QA baseline from .promptwheel/
    let setupCommand: string | undefined;
    let baselineFailures: string[] = [];
    try {
      const configPath = path.join(ctx.project.rootPath, '.promptwheel', 'config.json');
      if (fs.existsSync(configPath)) {
        const configData = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        setupCommand = configData.setup;
      }
    } catch (err) {
      console.warn(`[promptwheel] Failed to read config.json: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      const baselinePath = path.join(ctx.project.rootPath, '.promptwheel', 'qa-baseline.json');
      if (fs.existsSync(baselinePath)) {
        const data = JSON.parse(fs.readFileSync(baselinePath, 'utf-8'));
        baselineFailures = data.failures ?? [];
      }
    } catch (err) {
      console.warn(`[promptwheel] Failed to read qa-baseline.json: ${err instanceof Error ? err.message : String(err)}`);
    }

    for (const pt of parallelTickets) {
      const ticket = readyTickets.find(t => t.id === pt.ticket_id)!;
      pt.inline_prompt = buildInlineTicketPrompt(
        ticket, pt.constraints, guidelinesBlock, metadataBlock, s.create_prs, s.draft, s.direct, setupCommand, baselineFailures,
      );
    }

    // Build orchestration prompt for the main agent
    const ticketList = parallelTickets.map((t, i) =>
      `${i + 1}. **${t.title}** (ID: \`${t.ticket_id}\`)`
    ).join('\n');

    const orchestrationPrompt = [
      `# Parallel Execution — ${parallelTickets.length} tickets`,
      '',
      ticketList,
      '',
      '## Instructions',
      '',
      'Use the **Task tool** to spawn one subagent per ticket. Send ALL Task calls in a **single message** for concurrency.',
      '',
      'For each ticket in `parallel_tickets`:',
      '```',
      'Task({',
      '  subagent_type: "general-purpose",',
      '  description: "Ticket: <title>",',
      '  prompt: parallel_tickets[i].inline_prompt',
      '})',
      '```',
      '',
      'The `inline_prompt` field contains everything the subagent needs — no MCP tools required.',
      'Subagents will edit code, run tests, commit, push, and create PRs independently.',
      '',
      '## After All Subagents Return',
      '',
      'For each subagent result, call `promptwheel_ticket_event` to record the outcome:',
      ...(s.create_prs
        ? ['- Success: `type: "PR_CREATED"`, `payload: { ticket_id, url, branch }`']
        : ['- Success: `type: "TICKET_RESULT"`, `payload: { ticket_id, status: "success", changed_files: [...] }`']),
      '- Failure: `type: "TICKET_RESULT"`, `payload: { ticket_id, status: "failed", reason: "..." }`',
      '',
      'Then call `promptwheel_advance` to continue.',
    ].join('\n');

    return {
      next_action: 'PARALLEL_EXECUTE',
      phase: 'PARALLEL_EXECUTE',
      prompt: orchestrationPrompt,
      reason: `Dispatching ${parallelTickets.length} tickets for parallel execution`,
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
    auto_approve_patterns: getScoutAutoApprove(),
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
    `Planning ticket: ${ticket.title}`, { ...constraints, auto_approve_patterns: getScoutAutoApprove() });
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
    learnings: s.cached_learnings,
  });

  const learningsBlock = buildLearningsBlock(run, ticket.allowedPaths ?? [], ticket.verificationCommands ?? []);
  const riskBlock = buildRiskContextBlock(policy.risk_assessment);

  let basePlanPrompt: string;
  if (s.plan_rejections > 0) {
    const planCriticBlock = buildPlanRejectionCriticBlock(
      {
        rejection_reason: s.last_plan_rejection_reason ?? 'Plan did not pass scope validation',
        attempt: s.plan_rejections + 1,
        max_attempts: MAX_PLAN_REJECTIONS,
      },
      s.cached_learnings,
      ticket.allowedPaths ?? [],
    );
    const preamble = planCriticBlock
      ? `${planCriticBlock}\n\n`
      : `Your previous commit plan was rejected: ${s.last_plan_rejection_reason ?? 'scope violation'}. Please revise.\n\n`;
    basePlanPrompt = preamble + buildPlanPrompt(ticket);
  } else {
    basePlanPrompt = buildPlanPrompt(ticket);
  }
  const prompt = learningsBlock + riskBlock + basePlanPrompt;

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
      auto_approve_patterns: getScoutAutoApprove(),
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
    learnings: s.cached_learnings,
  });

  const guidelines = loadGuidelines(ctx.project.rootPath);
  const guidelinesBlock = guidelines ? formatGuidelinesForPrompt(guidelines) + '\n\n' : '';
  const learningsBlock = buildLearningsBlock(run, ticket.allowedPaths ?? [], ticket.verificationCommands ?? []);
  const riskBlock = buildRiskContextBlock(policy.risk_assessment);

  // Build critic block for QA retries
  let criticBlock = '';
  if (s.qa_retries > 0 && s.last_qa_failure) {
    const failureContext = {
      failed_commands: s.last_qa_failure.failed_commands,
      error_output: s.last_qa_failure.error_output,
      attempt: s.qa_retries + 1,
      max_attempts: MAX_QA_RETRIES,
    };
    const risk = computeRetryRisk(ticket.allowedPaths ?? [], ticket.verificationCommands ?? [], s.cached_learnings, failureContext);
    const strategies = scoreStrategies(ticket.allowedPaths ?? [], failureContext, s.cached_learnings);
    criticBlock = buildCriticBlock(failureContext, risk, strategies, s.cached_learnings);
    if (criticBlock) criticBlock += '\n\n';
  }

  const prompt = guidelinesBlock + learningsBlock + riskBlock + criticBlock + buildExecutePrompt(ticket, s.current_ticket_plan);

  return promptResponse(run, 'EXECUTE', prompt,
    `Executing ticket: ${ticket.title}`, {
      allowed_paths: policy.allowed_paths,
      denied_paths: policy.denied_paths,
      denied_patterns: policy.denied_patterns.map(r => r.source),
      max_files: policy.max_files,
      max_lines: policy.max_lines,
      required_commands: ticket.verificationCommands ?? [],
      plan_required: false,
      auto_approve_patterns: getExecuteAutoApprove(ticket.category ?? null),
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

  // Merge session-level qa_commands with ticket verification commands
  const ticketCommands = ticket.verificationCommands ?? [];
  const sessionQaCommands = s.qa_commands ?? [];
  const allCommands = [...new Set([...ticketCommands, ...sessionQaCommands])];
  const qaTicket = allCommands.length !== ticketCommands.length
    ? { ...ticket, verificationCommands: allCommands }
    : ticket;

  const learningsBlock = buildLearningsBlock(run, [], allCommands);
  const crossVerifyPreamble = s.cross_verify
    ? '## IMPORTANT — Independent Verification\n\nYou are verifying work as an INDEPENDENT verifier. Do NOT trust any prior claims of success. Run ALL commands yourself and report results honestly.\n\n'
    : '';
  const prompt = crossVerifyPreamble + learningsBlock + buildQaPrompt(qaTicket);

  return promptResponse(run, 'QA', prompt,
    `Running QA for: ${ticket.title} (attempt ${s.qa_retries + 1}/${MAX_QA_RETRIES})`, {
      allowed_paths: ticket.allowedPaths ?? [],
      denied_paths: [],
      denied_patterns: [],
      max_files: 0,
      max_lines: 0,
      required_commands: allCommands,
      plan_required: false,
      auto_approve_patterns: getQaAutoApprove(),
    });
}

async function advancePr(ctx: AdvanceContext): Promise<AdvanceResponse> {
  const { run } = ctx;
  const s = run.require();

  const ticket = s.current_ticket_id
    ? await repos.tickets.getById(ctx.db, s.current_ticket_id)
    : null;

  const prompt = buildPrPrompt(ticket, s.draft);

  return promptResponse(run, 'PR', prompt,
    'Creating PR', {
      allowed_paths: [],
      denied_paths: [],
      denied_patterns: [],
      max_files: 0,
      max_lines: 0,
      required_commands: [],
      plan_required: false,
      auto_approve_patterns: getPrAutoApprove(),
    });
}

/** Max session-level steps a worker can go without progress before timeout */
const WORKER_STALL_THRESHOLD = 50;

async function advanceParallelExecute(ctx: AdvanceContext): Promise<AdvanceResponse> {
  const { run } = ctx;
  const s = run.require();

  // Timeout check: fail workers that haven't made progress
  for (const [id, w] of Object.entries(s.ticket_workers)) {
    const stalledFor = s.step_count - (w.last_active_at_step ?? 0);
    if (stalledFor >= WORKER_STALL_THRESHOLD) {
      run.appendEvent('WORKER_TIMEOUT', { ticket_id: id, stalled_for: stalledFor });
      run.failTicketWorker(id, `Worker timeout: no progress for ${stalledFor} steps`);
    }
  }

  // Check if all ticket workers are done
  if (run.allWorkersComplete()) {
    run.setPhase('NEXT_TICKET');
    return advance(ctx);
  }

  // Workers still active — return status
  const activeWorkers = Object.entries(s.ticket_workers).map(([id, w]) => ({
    ticket_id: id,
    phase: w.phase,
    step_count: w.step_count,
  }));

  return {
    next_action: 'PROMPT',
    phase: 'PARALLEL_EXECUTE',
    prompt: `Parallel execution still in progress. ${activeWorkers.length} ticket(s) still active. Wait for all subagents to complete, then call promptwheel_advance again.`,
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
    auto_approve_patterns: [],
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
