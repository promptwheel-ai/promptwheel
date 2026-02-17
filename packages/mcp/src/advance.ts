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
import type { DatabaseAdapter } from '@blockspool/core';
import { repos, EXECUTION_DEFAULTS } from '@blockspool/core';
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
import { getRegistry } from './tool-registry.js';
import { checkSpindle, getFileEditWarnings } from './spindle.js';
import { loadFormula } from './formulas.js';
import type { Formula } from './formulas.js';
import { loadGuidelines, formatGuidelinesForPrompt } from './guidelines.js';
import { detectProjectMetadata, formatMetadataForPrompt } from './project-metadata.js';
import { formatIndexForPrompt, refreshCodebaseIndex, hasStructuralChanges } from './codebase-index.js';
import { buildProposalReviewPrompt, type ValidatedProposal } from './proposals.js';
import {
  selectRelevant,
  formatLearningsForPrompt,
  recordAccess,
} from './learnings.js';
import { loadDedupMemory, formatDedupForPrompt } from './dedup-memory.js';
import {
  computeRetryRisk,
  scoreStrategies,
  buildCriticBlock,
  buildPlanRejectionCriticBlock,
} from '@blockspool/core/critic/shared';
import type { AdaptiveRiskAssessment } from '@blockspool/core/learnings/shared';
import {
  pickNextSector as pickNextSectorCore,
  computeCoverage as computeCoverageCore,
  buildSectorSummary as buildSectorSummaryCore,
} from '@blockspool/core/sectors/shared';
import type { SectorState } from '@blockspool/core/sectors/shared';
import {
  type Trajectory,
  type TrajectoryState,
  parseTrajectoryYaml,
  getNextStep as getTrajectoryNextStep,
  formatTrajectoryForPrompt,
} from '@blockspool/core/trajectory/shared';

const MAX_PLAN_REJECTIONS = 3;
const MAX_QA_RETRIES = EXECUTION_DEFAULTS.MAX_QA_RETRIES;
const MAX_SPINDLE_RECOVERIES = 3;
const DEFAULT_LEARNINGS_BUDGET = 2000;

/** Load trajectory state from project root — returns null if missing/invalid. */
function loadTrajectoryData(rootPath: string): { trajectory: Trajectory; state: TrajectoryState } | null {
  try {
    const statePath = path.join(rootPath, '.blockspool', 'trajectory-state.json');
    if (!fs.existsSync(statePath)) return null;
    const trajState: TrajectoryState = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    if (trajState.paused) return null;

    const trajDir = path.join(rootPath, '.blockspool', 'trajectories');
    if (!fs.existsSync(trajDir)) return null;

    const files = fs.readdirSync(trajDir).filter(f => f.endsWith('.yaml') || f.endsWith('.yml'));
    for (const file of files) {
      const content = fs.readFileSync(path.join(trajDir, file), 'utf8');
      const traj = parseTrajectoryYaml(content);
      if (traj.name === trajState.trajectoryName && traj.steps.length > 0) {
        return { trajectory: traj, state: trajState };
      }
    }
  } catch {
    // Non-fatal
  }
  return null;
}

/** Load sectors.json from project root — returns null if missing/invalid. */
function loadSectorsState(rootPath: string): SectorState | null {
  try {
    const filePath = path.join(rootPath, '.blockspool', 'sectors.json');
    if (!fs.existsSync(filePath)) return null;
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (data?.version !== 2 || !Array.isArray(data.sectors)) return null;
    return data as SectorState;
  } catch {
    return null;
  }
}

/**
 * Build a learnings block for prompt injection. Tracks injected IDs in state.
 * Uses cached learnings from RunState (loaded at session start) to avoid redundant file I/O.
 */
function buildLearningsBlock(
  run: RunManager,
  contextPaths: string[],
  contextCommands: string[],
): string {
  const s = run.require();
  if (!s.learnings_enabled) return '';

  const projectPath = run.rootPath;

  // Use cached learnings from session start (decay already applied)
  const allLearnings = s.cached_learnings;
  if (allLearnings.length === 0) return '';

  const relevant = selectRelevant(allLearnings, { paths: contextPaths, commands: contextCommands });
  const budget = DEFAULT_LEARNINGS_BUDGET;
  const block = formatLearningsForPrompt(relevant, budget);
  if (!block) return '';

  // Track which learnings were injected
  const injectedIds = relevant
    .filter(l => block.includes(l.text))
    .map(l => l.id);
  s.injected_learning_ids = [...new Set([...s.injected_learning_ids, ...injectedIds])];

  // Record access
  if (injectedIds.length > 0) {
    recordAccess(projectPath, injectedIds);
  }

  return block + '\n\n';
}

/**
 * Build a risk context block for prompts when adaptive trust detects elevated/high risk.
 * Returns empty string for low/normal risk.
 */
function buildRiskContextBlock(riskAssessment: AdaptiveRiskAssessment | undefined): string {
  if (!riskAssessment) return '';
  if (riskAssessment.level === 'low' || riskAssessment.level === 'normal') return '';

  const lines = [
    '<risk-context>',
    `## Adaptive Risk: ${riskAssessment.level.toUpperCase()} (score: ${riskAssessment.score})`,
    '',
  ];

  if (riskAssessment.fragile_paths.length > 0) {
    lines.push('### Known Fragile Paths');
    for (const fp of riskAssessment.fragile_paths.slice(0, 5)) {
      lines.push(`- \`${fp}\``);
    }
    lines.push('');
  }

  if (riskAssessment.known_issues.length > 0) {
    lines.push('### Known Issues in These Files');
    for (const issue of riskAssessment.known_issues) {
      lines.push(`- ${issue}`);
    }
    lines.push('');
  }

  lines.push('**Be extra careful** — these files have a history of failures. Consider smaller changes and more thorough testing.');
  lines.push('</risk-context>');
  return lines.join('\n') + '\n\n';
}

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

// Auto-approve patterns are now served by the ToolRegistry.
// Legacy arrays removed — use getRegistry().getAutoApprovePatterns() instead.

function getScoutAutoApprove(): string[] {
  return getRegistry().getAutoApprovePatterns({ phase: 'SCOUT', category: null });
}

function getExecuteAutoApprove(category: string | null): string[] {
  return getRegistry().getAutoApprovePatterns({ phase: 'EXECUTE', category });
}

function getQaAutoApprove(): string[] {
  return getRegistry().getAutoApprovePatterns({ phase: 'QA', category: null });
}

function getPrAutoApprove(): string[] {
  return getRegistry().getAutoApprovePatterns({ phase: 'PR', category: null });
}

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
  try {
    const sectorsState = loadSectorsState(ctx.project.rootPath);
    if (sectorsState) {
      const picked = pickNextSectorCore(sectorsState, s.scout_cycles);
      if (picked) {
        s.scope = picked.scope;
        s.selected_sector_path = picked.sector.path;
      }
    }
  } catch {
    // Non-fatal — fall through to existing scope
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
  } catch {
    // Non-fatal
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
  } catch {
    // Non-fatal
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

    // Read project setup command and QA baseline from .blockspool/
    let setupCommand: string | undefined;
    let baselineFailures: string[] = [];
    try {
      const configPath = path.join(ctx.project.rootPath, '.blockspool', 'config.json');
      if (fs.existsSync(configPath)) {
        const configData = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        setupCommand = configData.setup;
      }
    } catch { /* non-fatal */ }
    try {
      const baselinePath = path.join(ctx.project.rootPath, '.blockspool', 'qa-baseline.json');
      if (fs.existsSync(baselinePath)) {
        const data = JSON.parse(fs.readFileSync(baselinePath, 'utf-8'));
        baselineFailures = data.failures ?? [];
      }
    } catch { /* non-fatal */ }

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
      'For each subagent result, call `blockspool_ticket_event` to record the outcome:',
      ...(s.create_prs
        ? ['- Success: `type: "PR_CREATED"`, `payload: { ticket_id, url, branch }`']
        : ['- Success: `type: "TICKET_RESULT"`, `payload: { ticket_id, status: "success", changed_files: [...] }`']),
      '- Failure: `type: "TICKET_RESULT"`, `payload: { ticket_id, status: "failed", reason: "..." }`',
      '',
      'Then call `blockspool_advance` to continue.',
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

  const learningsBlock = buildLearningsBlock(run, [], ticket.verificationCommands ?? []);
  const crossVerifyPreamble = s.cross_verify
    ? '## IMPORTANT — Independent Verification\n\nYou are verifying work as an INDEPENDENT verifier. Do NOT trust any prior claims of success. Run ALL commands yourself and report results honestly.\n\n'
    : '';
  const prompt = crossVerifyPreamble + learningsBlock + buildQaPrompt(ticket);

  return promptResponse(run, 'QA', prompt,
    `Running QA for: ${ticket.title} (attempt ${s.qa_retries + 1}/${MAX_QA_RETRIES})`, {
      allowed_paths: ticket.allowedPaths ?? [],
      denied_paths: [],
      denied_patterns: [],
      max_files: 0,
      max_lines: 0,
      required_commands: ticket.verificationCommands ?? [],
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

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

function buildScoutEscalation(
  retryCount: number,
  explorationLog: string[],
  scoutedDirs: string[],
  codebaseIndex: import('./codebase-index.js').CodebaseIndex | null,
): string {
  const parts = [
    '## Previous Attempts Found Nothing — Fresh Approach Required',
    '',
  ];

  if (explorationLog.length > 0) {
    parts.push('### What Was Already Tried');
    for (const entry of explorationLog) {
      parts.push(entry);
    }
    parts.push('');
  }

  // Suggest unexplored modules from codebase index
  const exploredSet = new Set(scoutedDirs.map(d => d.replace(/\/$/, '')));
  const unexplored: string[] = [];
  if (codebaseIndex) {
    for (const mod of codebaseIndex.modules) {
      if (!exploredSet.has(mod.path) && !exploredSet.has(mod.path + '/')) {
        unexplored.push(mod.path);
      }
    }
  }

  parts.push('### What to Do Differently');
  parts.push('');
  parts.push('Knowing everything from the attempts above, take a completely different angle:');
  parts.push('- Do NOT re-read the directories listed above.');
  if (unexplored.length > 0) {
    parts.push(`- Try unexplored areas: ${unexplored.slice(0, 8).map(d => `\`${d}\``).join(', ')}`);
  }
  parts.push('- Switch categories: if you looked for bugs, look for tests. If tests, try security.');
  parts.push('- Read at least 15 NEW source files.');
  parts.push('- If genuinely nothing to improve, explain your analysis across all attempts.');

  return parts.join('\n');
}

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
  scoutedDirs: string[] = [],
  excludeDirs: string[] = [],
  coverageContext?: { scannedSectors: number; totalSectors: number; percent: number; sectorPercent?: number; sectorSummary?: string },
): string {
  const parts = [
    '# Scout Phase',
    '',
    'Identify improvements by reading source code. Return proposals in a `<proposals>` XML block containing a JSON array.',
    '',
    ...(!eco ? ['**IMPORTANT:** Do not use the Task or Explore tools. Read files directly using Read, Glob, and Grep. Do not delegate to subagents.', ''] : []),
    '## How to Scout',
    '',
    'STEP 1 — Discover: Use Glob to list all files in scope. Group them by directory or module (e.g. `src/auth/`, `src/api/`, `lib/utils/`). Identify entry points, core logic, and test directories.',
    '',
    'STEP 2 — Pick a Partition: Choose one or two directories/modules to analyze deeply this cycle. Do NOT try to skim everything — go deep on a focused slice. On future cycles, different partitions will be explored.',
    '',
    'STEP 3 — Read & Analyze: Use Read to open 10-15 source files within your chosen partition(s). Read related files together (e.g. a module and its tests, a handler and its helpers). For each file, look for:',
    '  - Bugs, incorrect logic, off-by-one errors',
    '  - Missing error handling or edge cases',
    '  - Missing or inadequate tests for the code you read',
    '  - Security issues (injection, auth bypass, secrets in code)',
    '  - Performance problems (N+1 queries, unnecessary re-renders, blocking I/O)',
    '  - Dead code, unreachable branches',
    '  - Meaningful refactoring opportunities (not cosmetic)',
    '',
    'STEP 4 — Propose: Only after reading source files, write proposals with specific file paths and line-level detail.',
    '',
    'DO NOT run lint or typecheck commands as a substitute for reading code.',
    'DO NOT propose changes unless you have READ the files you are proposing to change.',
    '',
    `**Scope:** \`${scope}\``,
    `**Categories:** ${categories.join(', ')}`,
    `**Min confidence:** ${minConfidence}`,
    `**Min impact score:** ${minImpactScore} (proposals below this will be rejected)`,
    `**Max proposals:** ${maxProposals}`,
    '',
    '**DO NOT propose changes to these files** (read-only context): CLAUDE.md, .claude/**',
    ...(excludeDirs.length > 0 ? [
      `**Skip these directories when scouting** (build artifacts, vendor, generated): ${excludeDirs.map(d => `\`${d}\``).join(', ')}`,
    ] : []),
    '',
    ...(coverageContext ? [
      `## Coverage Context`,
      '',
      `Overall codebase coverage: ${coverageContext.scannedSectors}/${coverageContext.totalSectors} sectors scanned (${coverageContext.sectorPercent ?? coverageContext.percent}% of sectors, ${coverageContext.percent}% of files).`,
      ...(coverageContext.percent < 50 ? ['Many sectors remain unscanned. Focus on high-impact issues rather than minor cleanups.'] : []),
      ...(coverageContext.sectorSummary ? ['', coverageContext.sectorSummary] : []),
      '',
    ] : []),
    '## Quality Bar',
    '',
    '- Proposals must have **real user or developer impact** — not just lint cleanup or style nits.',
    '- Do NOT propose fixes for lint warnings, unused variables, or cosmetic issues unless they cause actual bugs or test failures.',
    '- If project guidelines are provided above, **respect them**. Do NOT propose changes the guidelines explicitly discourage (e.g., "avoid over-engineering", "don\'t change code you didn\'t touch").',
    '- Focus on: bugs, security issues, performance problems, correctness, and meaningful refactors.',
    '',
    '## Category Rules',
    '',
    '- Any proposal that creates new test files (.test.ts, .spec.ts) or adds test coverage MUST use category "test" — NEVER label test-writing as "fix", "refactor", or any other category.',
    '- If "test" is not in the categories list above, do NOT propose writing new tests. Focus on the allowed categories only.',
    '- If "test" IS allowed, you may generate test proposals freely.',
    '',
  ];

  if (scoutedDirs.length > 0) {
    parts.push('## Already Explored (prefer unexplored directories)');
    parts.push('');
    parts.push('These directories were analyzed in previous scout cycles. Prefer exploring different areas first:');
    for (const dir of scoutedDirs) {
      parts.push(`- \`${dir}\``);
    }
    parts.push('');
  }

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
    'Then call `blockspool_ingest_event` with type `SCOUT_OUTPUT` and payload:',
    '`{ "proposals": [...], "explored_dirs": ["src/auth/", "src/api/"] }`',
    '',
    'The `explored_dirs` field should list the top-level directories you analyzed (e.g. `src/services/`, `lib/utils/`). This is used to rotate to unexplored areas in future cycles.',
  );

  if (coverageContext) {
    parts.push('');
    parts.push('If this sector appears misclassified (e.g., labeled as production but contains only tests/config/generated code, or vice versa), include in the SCOUT_OUTPUT payload:');
    parts.push('`"sector_reclassification": { "production": true/false, "confidence": "medium"|"high" }`');
  }

  return parts.join('\n');
}

function buildPlanPrompt(ticket: { title: string; description: string | null; allowedPaths: string[]; verificationCommands: string[]; category?: string | null }): string {
  const constraintNote = getRegistry().getConstraintNote({ phase: 'EXECUTE', category: ticket.category ?? null });
  const toolRestrictionLines = constraintNote
    ? ['', '## Tool Restrictions', '', constraintNote, '']
    : [''];

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
    ...toolRestrictionLines,
    'Then call `blockspool_ingest_event` with type `PLAN_SUBMITTED` and the plan as payload.',
  ].join('\n');
}

function buildExecutePrompt(
  ticket: { title: string; description: string | null; allowedPaths: string[]; verificationCommands: string[]; category?: string | null },
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
  );

  const constraintNote = getRegistry().getConstraintNote({ phase: 'EXECUTE', category: ticket.category ?? null });
  if (constraintNote) {
    parts.push('## Tool Restrictions', '', constraintNote, '');
  }

  parts.push(
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

function buildPlanningPreamble(ticket: { metadata?: Record<string, unknown> | null }): string {
  const meta = ticket.metadata as Record<string, unknown> | null | undefined;
  const confidence = typeof meta?.scoutConfidence === 'number' ? meta.scoutConfidence : undefined;
  const complexity = typeof meta?.estimatedComplexity === 'string' ? meta.estimatedComplexity : undefined;
  if ((confidence !== undefined && confidence < 50) || complexity === 'moderate' || complexity === 'complex') {
    return [
      '## Approach — This is a complex change',
      '',
      `The automated analysis flagged this as uncertain (confidence: ${confidence ?? '?'}%). Before writing code:`,
      '1. Read all relevant files to understand the full context',
      '2. Identify all touch points and potential side effects',
      '3. Write out your implementation plan before making changes',
      '4. Implement incrementally, verifying at each step',
      '',
    ].join('\n') + '\n';
  }
  return '';
}

/** Escape a string for use inside double-quoted shell arguments */
function shellEscape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$').replace(/`/g, '\\`');
}

function buildInlineTicketPrompt(
  ticket: { id: string; title: string; description: string | null; allowedPaths: string[]; verificationCommands: string[]; metadata?: Record<string, unknown> | null; category?: string | null },
  constraints: AdvanceConstraints,
  guidelinesBlock: string,
  metadataBlock: string,
  createPrs: boolean,
  draft: boolean,
  direct: boolean,
  setupCommand?: string,
  baselineFailures: string[] = [],
): string {
  const slug = ticket.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
  const branch = `blockspool/${ticket.id}/${slug}`;
  const worktree = `.blockspool/worktrees/${ticket.id}`;

  const verifyBlock = constraints.required_commands.length > 0
    ? constraints.required_commands.map(c => `\`\`\`bash\n${c}\n\`\`\``).join('\n')
    : '```bash\nnpm test\n```';

  const planningPreamble = buildPlanningPreamble(ticket);

  // Build tool restriction block from registry
  const inlineConstraintNote = getRegistry().getConstraintNote({ phase: 'EXECUTE', category: ticket.category ?? null });
  const toolRestrictionBlock = inlineConstraintNote
    ? ['## Tool Restrictions', '', inlineConstraintNote, '']
    : [];

  // Direct mode: simpler flow, edit in place, no worktrees
  if (direct) {
    return [
      `# BlockSpool Ticket: ${ticket.title}`,
      '',
      planningPreamble,
      guidelinesBlock,
      metadataBlock,
      ticket.description ?? '',
      '',
      '## Constraints',
      '',
      `- **Allowed paths:** ${constraints.allowed_paths.length > 0 ? constraints.allowed_paths.join(', ') : 'any'}`,
      `- **Denied paths:** ${constraints.denied_paths.length > 0 ? constraints.denied_paths.join(', ') : 'none'}`,
      `- **Max files:** ${constraints.max_files || 'unlimited'}`,
      `- **Max lines:** ${constraints.max_lines || 'unlimited'}`,
      '',
      ...toolRestrictionBlock,
      '## Step 1 — Implement the change',
      '',
      '- Read the relevant files first to understand the current state.',
      '- Make minimal, focused changes that match the ticket description.',
      '- Only modify files within the allowed paths.',
      '- Follow any project guidelines provided above.',
      '',
      '## Step 2 — Verify',
      '',
      verifyBlock,
      '',
      ...(baselineFailures.length > 0 ? [
        `**Pre-existing failures (IGNORE these — they were failing before your changes):** ${baselineFailures.join(', ')}`,
        '',
        'Only fix failures that are NEW — caused by your changes. If a command was already failing, do not try to fix it.',
      ] : [
        'If tests fail due to your changes, fix the issues and re-run.',
      ]),
      '',
      '## Step 3 — Commit',
      '',
      '```bash',
      'git add -A',
      `git commit -m "${shellEscape(ticket.title)}"`,
      '```',
      '',
      '## Output',
      '',
      'When done, output a summary in this exact format:',
      '',
      '```',
      `TICKET_ID: ${ticket.id}`,
      'STATUS: success | failed',
      'PR_URL: none',
      'BRANCH: (current)',
      'SUMMARY: <one line summary of what was done>',
      '```',
      '',
      'If anything goes wrong and you cannot complete the ticket, output STATUS: failed with a reason.',
    ].join('\n');
  }

  // Worktree mode: isolated branches for parallel execution or PR workflow
  return [
    `# BlockSpool Ticket: ${ticket.title}`,
    '',
    planningPreamble,
    guidelinesBlock,
    metadataBlock,
    ticket.description ?? '',
    '',
    '## Constraints',
    '',
    `- **Allowed paths:** ${constraints.allowed_paths.length > 0 ? constraints.allowed_paths.join(', ') : 'any'}`,
    `- **Denied paths:** ${constraints.denied_paths.length > 0 ? constraints.denied_paths.join(', ') : 'none'}`,
    `- **Max files:** ${constraints.max_files || 'unlimited'}`,
    `- **Max lines:** ${constraints.max_lines || 'unlimited'}`,
    '',
    ...toolRestrictionBlock,
    '## Step 1 — Set up worktree',
    '',
    '```bash',
    `git worktree add ${worktree} -b ${branch}`,
    '```',
    '',
    `All work MUST happen inside \`${worktree}/\`. Do NOT modify files in the main working tree.`,
    '',
    ...(setupCommand ? [
      '```bash',
      `cd ${worktree}`,
      setupCommand,
      '```',
      '',
      'Wait for setup to complete before proceeding. If setup fails, try to continue anyway.',
      '',
    ] : []),
    '## Step 2 — Implement the change',
    '',
    '- Read the relevant files first to understand the current state.',
    '- Make minimal, focused changes that match the ticket description.',
    '- Only modify files within the allowed paths.',
    '- Follow any project guidelines provided above.',
    '',
    '## Step 3 — Verify',
    '',
    'Run verification commands inside the worktree:',
    '',
    '```bash',
    `cd ${worktree}`,
    '```',
    '',
    verifyBlock,
    '',
    ...(baselineFailures.length > 0 ? [
      `**Pre-existing failures (IGNORE these — they were failing before your changes):** ${baselineFailures.join(', ')}`,
      '',
      'Only fix failures that are NEW — caused by your changes. If a command was already failing, do not try to fix it.',
    ] : [
      'If tests fail due to your changes, fix the issues and re-run.',
    ]),
    '',
    '## Step 4 — Commit and push',
    '',
    '```bash',
    `cd ${worktree}`,
    'git add -A',
    `git commit -m "${shellEscape(ticket.title)}"`,
    ...(createPrs ? [`git push -u origin ${branch}`] : []),
    '```',
    '',
    ...(createPrs ? [
      '## Step 5 — Create PR',
      '',
      `Create a ${draft ? 'draft ' : ''}pull request:`,
      '',
      '```bash',
      `cd ${worktree}`,
      `gh pr create --title "${shellEscape(ticket.title)}"${draft ? ' --draft' : ''} --body "$(cat <<'BLOCKSPOOL_BODY_EOF'`,
      ticket.description?.slice(0, 500) ?? ticket.title,
      '',
      'Generated by BlockSpool',
      `BLOCKSPOOL_BODY_EOF`,
      `)"`,
      '```',
      '',
    ] : []),
    '## Output',
    '',
    'When done, output a summary in this exact format:',
    '',
    '```',
    `TICKET_ID: ${ticket.id}`,
    'STATUS: success | failed',
    `PR_URL: <url or "none">`,
    `BRANCH: ${branch}`,
    'SUMMARY: <one line summary of what was done>',
    '```',
    '',
    'If anything goes wrong and you cannot complete the ticket, output STATUS: failed with a reason.',
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
