/**
 * Run Manager — creates and manages run folders on disk.
 *
 * Each run lives at `.blockspool/runs/<run_id>/` and contains:
 *   - state.json   — current RunState (overwritten on every change)
 *   - events.ndjson — append-only event log
 *   - diffs/        — patch files per step
 *   - artifacts/    — QA logs, scout proposals, etc.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { prefixedId } from '@blockspool/core';
import type {
  RunState,
  RunEvent,
  EventType,
  Phase,
  SpindleState,
  SessionConfig,
  TicketWorkerState,
} from './types.js';
import { checkSpindle } from './spindle.js';
import { detectProjectMetadata } from './project-metadata.js';
import type { ProjectMetadata } from './project-metadata.js';
import { buildCodebaseIndex } from './codebase-index.js';
import { loadLearnings } from './learnings.js';

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_STEP_BUDGET = 200;
const DEFAULT_TICKET_STEP_BUDGET = 12;
const DEFAULT_MAX_LINES_PER_TICKET = 500;
const DEFAULT_MAX_TOOL_CALLS_PER_TICKET = 50;
const DEFAULT_MAX_PRS = 5;
const DEFAULT_MIN_CONFIDENCE = 55;
const DEFAULT_MIN_IMPACT_SCORE = 3;
const DEFAULT_MAX_PROPOSALS_PER_SCOUT = 5;
const DEFAULT_SCOPE = '**';
const DEFAULT_CATEGORIES = ['refactor', 'docs', 'test', 'perf', 'security'];
const DEFAULT_SCOUT_EXCLUDE_DIRS = [
  'node_modules',
  'dist',
  'build',
  '.next',
  'coverage',
  'assets',
  'public/static',
  'vendor',
  '.git',
];

function emptySpindle(): SpindleState {
  return {
    output_hashes: [],
    diff_hashes: [],
    iterations_since_change: 0,
    total_output_chars: 0,
    total_change_chars: 0,
    failing_command_signatures: [],
    plan_hashes: [],
  };
}

// ---------------------------------------------------------------------------
// RunManager
// ---------------------------------------------------------------------------

export class RunManager {
  private state: RunState | null = null;
  private runDir: string | null = null;
  private eventsPath: string | null = null;

  constructor(private readonly projectPath: string) {}

  /** The project root path */
  get rootPath(): string {
    return this.projectPath;
  }

  /** The base .blockspool directory */
  private get bsDir(): string {
    return path.join(this.projectPath, '.blockspool');
  }

  /** Create a new run, write initial state.json and SESSION_START event */
  create(projectId: string, config: SessionConfig): RunState {
    if (this.state) {
      throw new Error('Run already active. End it first.');
    }

    const runId = prefixedId('run');
    const sessionId = prefixedId('ses');
    const now = new Date();
    const expiresAt = config.hours
      ? new Date(now.getTime() + config.hours * 60 * 60 * 1000).toISOString()
      : null;

    this.state = {
      run_id: runId,
      session_id: sessionId,
      project_id: projectId,

      phase: 'SCOUT',
      phase_entry_step: 0,

      step_count: 0,
      step_budget: config.step_budget ?? DEFAULT_STEP_BUDGET,
      ticket_step_count: 0,
      ticket_step_budget: config.ticket_step_budget ?? DEFAULT_TICKET_STEP_BUDGET,
      total_lines_changed: 0,
      max_lines_per_ticket: DEFAULT_MAX_LINES_PER_TICKET,
      total_tool_calls: 0,
      max_tool_calls_per_ticket: DEFAULT_MAX_TOOL_CALLS_PER_TICKET,

      tickets_completed: 0,
      tickets_failed: 0,
      tickets_blocked: 0,
      prs_created: 0,
      scout_cycles: 0,
      max_cycles: config.max_cycles ?? 1,
      max_prs: config.max_prs ?? DEFAULT_MAX_PRS,

      current_ticket_id: null,
      current_ticket_plan: null,
      plan_approved: false,
      plan_rejections: 0,
      qa_retries: 0,
      scout_retries: 0,

      started_at: now.toISOString(),
      expires_at: expiresAt,

      scope: config.scope ?? DEFAULT_SCOPE,
      formula: config.formula ?? null,
      categories: config.categories ?? DEFAULT_CATEGORIES,
      min_confidence: config.min_confidence ?? DEFAULT_MIN_CONFIDENCE,
      max_proposals_per_scout: config.max_proposals ?? DEFAULT_MAX_PROPOSALS_PER_SCOUT,
      min_impact_score: config.min_impact_score ?? DEFAULT_MIN_IMPACT_SCORE,
      draft_prs: config.draft_prs ?? true,
      eco: config.eco ?? false,
      hints: [],
      scout_exclude_dirs: config.scout_exclude_dirs ?? DEFAULT_SCOUT_EXCLUDE_DIRS,

      parallel: Math.min(Math.max(config.parallel ?? 2, 1), 5),
      ticket_workers: {},

      spindle: emptySpindle(),
      recent_intent_hashes: [],
      scouted_dirs: [],
      deferred_proposals: [],

      project_metadata: null,
      codebase_index: null,
      codebase_index_dirty: false,

      pending_proposals: null,
      scout_exploration_log: [],

      learnings_enabled: config.learnings !== false,
      injected_learning_ids: [],
    };

    // Detect project metadata (test runner, framework, etc.)
    const detectedMeta = detectProjectMetadata(this.projectPath);
    this.state.project_metadata = {
      languages: detectedMeta.languages,
      package_manager: detectedMeta.package_manager,
      test_runner_name: detectedMeta.test_runner?.name ?? null,
      test_run_command: detectedMeta.test_runner?.run_command ?? null,
      test_filter_syntax: detectedMeta.test_runner?.filter_syntax ?? null,
      framework: detectedMeta.framework,
      linter: detectedMeta.linter,
      type_checker: detectedMeta.type_checker,
      monorepo_tool: detectedMeta.monorepo_tool,
    };

    // Build codebase structural index
    this.state.codebase_index = buildCodebaseIndex(
      this.projectPath,
      this.state.scout_exclude_dirs,
    );

    // Apply decay to cross-run learnings (if enabled)
    if (this.state.learnings_enabled) {
      loadLearnings(this.projectPath, config.learnings_decay_rate);
    }

    // Create run folder
    const runsDir = path.join(this.bsDir, 'runs');
    this.runDir = path.join(runsDir, runId);
    this.eventsPath = path.join(this.runDir, 'events.ndjson');

    fs.mkdirSync(path.join(this.runDir, 'diffs'), { recursive: true });
    fs.mkdirSync(path.join(this.runDir, 'artifacts'), { recursive: true });

    // Write initial state
    this.persistState();

    // Log session start
    this.appendEvent('SESSION_START', {
      config,
      project_id: projectId,
    });

    return this.state;
  }

  /** Get current state or throw */
  require(): RunState {
    if (!this.state) {
      throw new Error('No active run. Call blockspool_start_session first.');
    }
    return this.state;
  }

  /** Get current state (may be null) */
  get current(): RunState | null {
    return this.state;
  }

  /** Get run directory path */
  get dir(): string | null {
    return this.runDir;
  }

  // -----------------------------------------------------------------------
  // State mutations (all persist + log)
  // -----------------------------------------------------------------------

  /** Transition to a new phase */
  setPhase(phase: Phase): void {
    const s = this.require();
    const oldPhase = s.phase;
    s.phase = phase;
    s.phase_entry_step = s.step_count;
    this.persistState();
    this.appendEvent('ADVANCE_RETURNED', {
      old_phase: oldPhase,
      new_phase: phase,
    });
  }

  /** Increment step counter (called on each advance) */
  incrementStep(): void {
    const s = this.require();
    s.step_count++;
    s.ticket_step_count++;
    s.total_tool_calls++;
    this.persistState();
  }

  /** Assign a ticket as current work */
  assignTicket(ticketId: string): void {
    const s = this.require();
    s.current_ticket_id = ticketId;
    s.ticket_step_count = 0;
    s.plan_approved = false;
    s.current_ticket_plan = null;
    s.plan_rejections = 0;
    s.qa_retries = 0;
    this.persistState();
    this.appendEvent('TICKET_ASSIGNED', { ticket_id: ticketId });
  }

  /** Mark current ticket completed */
  completeTicket(): void {
    const s = this.require();
    s.tickets_completed++;
    s.codebase_index_dirty = true;
    const ticketId = s.current_ticket_id;
    s.current_ticket_id = null;
    s.current_ticket_plan = null;
    s.plan_approved = false;
    s.ticket_step_count = 0;
    this.persistState();
    this.appendEvent('TICKET_COMPLETED', { ticket_id: ticketId });
  }

  /** Mark current ticket failed */
  failTicket(reason: string): void {
    const s = this.require();
    s.tickets_failed++;
    s.codebase_index_dirty = true;
    const ticketId = s.current_ticket_id;
    s.current_ticket_id = null;
    s.current_ticket_plan = null;
    s.plan_approved = false;
    s.ticket_step_count = 0;
    this.persistState();
    this.appendEvent('TICKET_FAILED', { ticket_id: ticketId, reason });
  }

  /** Add a hint */
  addHint(hint: string): void {
    const s = this.require();
    s.hints.push(hint);
    this.persistState();
    this.appendEvent('USER_OVERRIDE', { hint });
  }

  /** Consume and return all pending hints */
  consumeHints(): string[] {
    const s = this.require();
    const hints = [...s.hints];
    s.hints = [];
    this.persistState();
    for (const h of hints) {
      this.appendEvent('HINT_CONSUMED', { hint: h });
    }
    return hints;
  }

  /** End the run */
  end(): RunState {
    const s = this.require();
    this.appendEvent('SESSION_END', {
      tickets_completed: s.tickets_completed,
      tickets_failed: s.tickets_failed,
      prs_created: s.prs_created,
      step_count: s.step_count,
    });
    const finalState = { ...s };
    this.state = null;
    this.runDir = null;
    this.eventsPath = null;
    return finalState;
  }

  // -----------------------------------------------------------------------
  // Ticket worker lifecycle (parallel mode)
  // -----------------------------------------------------------------------

  /** Initialize a ticket worker entry */
  initTicketWorker(ticketId: string, ticket: { title: string }): void {
    const s = this.require();
    s.ticket_workers[ticketId] = {
      phase: 'PLAN',
      plan: null,
      plan_approved: false,
      plan_rejections: 0,
      qa_retries: 0,
      step_count: 0,
      spindle: emptySpindle(),
    };
    this.persistState();
    this.appendEvent('TICKET_ASSIGNED', { ticket_id: ticketId, parallel: true });
  }

  /** Get a ticket worker state */
  getTicketWorker(ticketId: string): TicketWorkerState | null {
    const s = this.require();
    return s.ticket_workers[ticketId] ?? null;
  }

  /** Update a ticket worker state */
  updateTicketWorker(ticketId: string, updates: Partial<TicketWorkerState>): void {
    const s = this.require();
    const worker = s.ticket_workers[ticketId];
    if (!worker) throw new Error(`No worker for ticket ${ticketId}`);
    Object.assign(worker, updates);
    this.persistState();
  }

  /** Complete a ticket worker — increment counters and remove from workers */
  completeTicketWorker(ticketId: string): void {
    const s = this.require();
    const worker = s.ticket_workers[ticketId];
    if (worker) {
      s.step_count += worker.step_count;
      s.tickets_completed++;
      s.codebase_index_dirty = true;
      delete s.ticket_workers[ticketId];
      this.persistState();
      this.appendEvent('TICKET_COMPLETED', { ticket_id: ticketId, parallel: true });
    }
  }

  /** Fail a ticket worker — increment counters and remove from workers */
  failTicketWorker(ticketId: string, reason: string): void {
    const s = this.require();
    const worker = s.ticket_workers[ticketId];
    if (worker) {
      s.step_count += worker.step_count;
      s.tickets_failed++;
      s.codebase_index_dirty = true;
      delete s.ticket_workers[ticketId];
      this.persistState();
      this.appendEvent('TICKET_FAILED', { ticket_id: ticketId, reason, parallel: true });
    }
  }

  /** Check if all ticket workers are done */
  allWorkersComplete(): boolean {
    const s = this.require();
    return Object.keys(s.ticket_workers).length === 0;
  }

  // -----------------------------------------------------------------------
  // Event logging
  // -----------------------------------------------------------------------

  /** Append an event to events.ndjson */
  appendEvent(type: EventType, payload: Record<string, unknown>): void {
    const step = this.state?.step_count ?? 0;
    const event: RunEvent = {
      ts: new Date().toISOString(),
      step,
      type,
      payload,
    };

    if (this.eventsPath) {
      fs.appendFileSync(this.eventsPath, JSON.stringify(event) + '\n', 'utf8');
    }
  }

  /** Save an artifact file */
  saveArtifact(filename: string, content: string): void {
    if (!this.runDir) return;
    const artifactPath = path.join(this.runDir, 'artifacts', filename);
    fs.writeFileSync(artifactPath, content, 'utf8');
  }

  /** Save a diff/patch file */
  saveDiff(step: number, ticketId: string, patch: string): void {
    if (!this.runDir) return;
    const diffPath = path.join(this.runDir, 'diffs', `${step}-${ticketId}.patch`);
    fs.writeFileSync(diffPath, patch, 'utf8');
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  /** Check if any budget is exhausted */
  isBudgetExhausted(): { exhausted: boolean; which?: string } {
    const s = this.require();

    if (s.step_count >= s.step_budget) {
      return { exhausted: true, which: 'step_budget' };
    }
    if (s.ticket_step_count >= s.ticket_step_budget) {
      return { exhausted: true, which: 'ticket_step_budget' };
    }
    if (s.prs_created >= s.max_prs) {
      return { exhausted: true, which: 'max_prs' };
    }
    if (s.expires_at && new Date() > new Date(s.expires_at)) {
      return { exhausted: true, which: 'time_budget' };
    }
    return { exhausted: false };
  }

  /** Check if approaching budget limits (80%) */
  getBudgetWarnings(): string[] {
    const s = this.require();
    const warnings: string[] = [];
    if (s.step_count >= s.step_budget * 0.8) {
      warnings.push(`step_budget: ${s.step_count}/${s.step_budget}`);
    }
    if (s.ticket_step_count >= s.ticket_step_budget * 0.8) {
      warnings.push(`ticket_step_budget: ${s.ticket_step_count}/${s.ticket_step_budget}`);
    }
    if (s.prs_created >= s.max_prs * 0.8) {
      warnings.push(`max_prs: ${s.prs_created}/${s.max_prs}`);
    }
    return warnings;
  }

  /** Build the digest for advance responses */
  buildDigest(): {
    step: number;
    phase: string;
    tickets_completed: number;
    tickets_failed: number;
    budget_remaining: number;
    ticket_budget_remaining: number;
    spindle_risk: 'none' | 'low' | 'medium' | 'high';
    time_remaining_ms: number | null;
  } {
    const s = this.require();
    const timeRemainingMs = s.expires_at
      ? Math.max(0, new Date(s.expires_at).getTime() - Date.now())
      : null;

    return {
      step: s.step_count,
      phase: s.phase,
      tickets_completed: s.tickets_completed,
      tickets_failed: s.tickets_failed,
      budget_remaining: s.step_budget - s.step_count,
      ticket_budget_remaining: s.ticket_step_budget - s.ticket_step_count,
      spindle_risk: checkSpindle(s.spindle).risk,
      time_remaining_ms: timeRemainingMs,
    };
  }

  // -----------------------------------------------------------------------
  // Persistence
  // -----------------------------------------------------------------------

  private persistState(): void {
    if (!this.runDir || !this.state) return;
    const statePath = path.join(this.runDir, 'state.json');
    fs.writeFileSync(statePath, JSON.stringify(this.state, null, 2) + '\n', 'utf8');
  }
}
