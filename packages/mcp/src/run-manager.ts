/**
 * Run Manager — creates and manages run folders on disk.
 *
 * Each run lives at `.promptwheel/runs/<run_id>/` and contains:
 *   - state.json   — current RunState (overwritten on every change)
 *   - events.ndjson — append-only event log
 *   - diffs/        — patch files per step
 *   - artifacts/    — QA logs, scout proposals, etc.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { prefixedId, SESSION_DEFAULTS, SCOUT_DEFAULTS } from '@promptwheel/core';
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
import { buildCodebaseIndex } from './codebase-index.js';
import { loadLearnings } from './learnings.js';
import { truncateUtf8 } from './utf8-utils.js';

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

// All defaults imported from @promptwheel/core — see config/defaults.ts

// Event payload truncation: payloads larger than MAX_PERSISTED_EVENT_PAYLOAD_BYTES
// are replaced with a truncated preview. The preview may cut mid-line or mid-JSON
// (it's a byte-limited prefix, not line-aligned). Consumers must handle partial content.
const MAX_PERSISTED_EVENT_PAYLOAD_BYTES = 128 * 1024;
const MAX_PERSISTED_EVENT_PREVIEW_BYTES = 8192;

function capEventPayloadForPersistence(payload: Record<string, unknown>): Record<string, unknown> {
  let serialized: string;
  try {
    const maybeSerialized = JSON.stringify(payload);
    if (typeof maybeSerialized !== 'string') {
      return {
        _payload_truncated: true,
        _payload_original_bytes: -1,
        _payload_max_bytes: MAX_PERSISTED_EVENT_PAYLOAD_BYTES,
        _payload_preview: '[unserializable payload]',
      };
    }
    serialized = maybeSerialized;
  } catch {
    return {
      _payload_truncated: true,
      _payload_original_bytes: -1,
      _payload_max_bytes: MAX_PERSISTED_EVENT_PAYLOAD_BYTES,
      _payload_preview: '[unserializable payload]',
    };
  }
  const payloadBytes = Buffer.byteLength(serialized, 'utf8');
  if (payloadBytes <= MAX_PERSISTED_EVENT_PAYLOAD_BYTES) {
    return payload;
  }

  const preview = truncateUtf8(serialized, MAX_PERSISTED_EVENT_PREVIEW_BYTES).value;
  const compact: Record<string, unknown> = {
    _payload_truncated: true,
    _payload_original_bytes: payloadBytes,
    _payload_max_bytes: MAX_PERSISTED_EVENT_PAYLOAD_BYTES,
    _payload_preview: preview,
  };
  const ticketId = payload['ticket_id'];
  if (typeof ticketId === 'string' || (typeof ticketId === 'number' && Number.isFinite(ticketId))) {
    compact['ticket_id'] = String(ticketId);
  }
  return compact;
}

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
  private learningsDecayRate?: number;

  constructor(private readonly projectPath: string) {}

  /** The project root path */
  get rootPath(): string {
    return this.projectPath;
  }

  /** The base .promptwheel directory */
  private get bsDir(): string {
    return path.join(this.projectPath, '.promptwheel');
  }

  /** Create a new run, write initial state.json and SESSION_START event */
  create(projectId: string, config: SessionConfig): RunState {
    if (this.state) {
      throw new Error('Run already active. End it first.');
    }

    // Bootstrap .promptwheel/ directory early — fail with a clear message
    try {
      fs.mkdirSync(this.bsDir, { recursive: true });
    } catch (err) {
      throw new Error(
        `Cannot create .promptwheel directory at ${this.bsDir}: ${err instanceof Error ? err.message : String(err)}. Check file permissions.`,
        { cause: err },
      );
    }

    // Session lock — prevent concurrent sessions from corrupting state
    // Skip in test environments to avoid PID collisions with test runner
    if (!process.env.VITEST && !process.env.NODE_ENV?.includes('test')) {
      const lockPath = path.join(this.bsDir, 'session.lock');
      try {
        // Atomic lock acquisition via O_CREAT | O_EXCL — avoids TOCTOU race
        const fd = fs.openSync(lockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY);
        fs.writeSync(fd, `${process.pid}\n${new Date().toISOString()}`);
        fs.closeSync(fd);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
          // Lock file exists — check if holder is still alive
          let lockPid = NaN;
          try { lockPid = parseInt(fs.readFileSync(lockPath, 'utf8').trim(), 10); } catch { /* ignore read failure */ }
          if (!isNaN(lockPid)) {
            try {
              process.kill(lockPid, 0); // throws ESRCH if dead
              throw new Error(`Another PromptWheel session is active (PID ${lockPid}). End it first or delete .promptwheel/session.lock.`, { cause: err });
            } catch (e) {
              if (e instanceof Error && e.message.includes('Another PromptWheel session')) throw e;
              // Process dead — stale lock, overwrite atomically
              try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
              try { fs.writeFileSync(lockPath, `${process.pid}\n${new Date().toISOString()}`, { flag: 'wx' }); } catch {
                console.warn('[promptwheel] Failed to acquire session lock after stale lock removal — another session may have started concurrently');
              }
            }
          } else {
            // Unreadable/corrupt lock file (empty, non-numeric) — treat as stale
            console.warn('[promptwheel] Session lock file contains unreadable PID, treating as stale');
            try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
            try { fs.writeFileSync(lockPath, `${process.pid}\n${new Date().toISOString()}`, { flag: 'wx' }); } catch {
              console.warn('[promptwheel] Failed to acquire session lock after corrupt lock removal');
            }
          }
        }
        // Ignore other lock write failures — non-fatal advisory lock
      }
    }

    const runId = prefixedId('run');
    const sessionId = prefixedId('ses');
    const now = new Date();
    const isContinuous = config.hours !== undefined || (config.max_cycles !== undefined && config.max_cycles > 1);
    const expiresAt = config.hours
      ? new Date(now.getTime() + config.hours * 60 * 60 * 1000).toISOString()
      : null;

    // PR creation: explicit opt-in via create_prs (or legacy draft_prs)
    const createPrs = config.create_prs ?? config.draft_prs ?? false;
    const draft = config.draft ?? false;

    // PR limit only matters when creating PRs
    const effectiveMaxPrs = createPrs
      ? (config.max_prs ?? (isContinuous ? 999 : SESSION_DEFAULTS.MAX_PRS))
      : 0;

    // In hours/cycles mode, disable per-ticket step budget — session is time-bounded
    const effectiveTicketStepBudget = config.ticket_step_budget
      ?? (isContinuous ? 9999 : SESSION_DEFAULTS.TICKET_STEP_BUDGET);

    this.state = {
      run_id: runId,
      session_id: sessionId,
      project_id: projectId,

      phase: 'SCOUT',
      phase_entry_step: 0,

      step_count: 0,
      step_budget: config.step_budget ?? SESSION_DEFAULTS.STEP_BUDGET,
      ticket_step_count: 0,
      ticket_step_budget: effectiveTicketStepBudget,
      total_lines_changed: 0,
      max_lines_per_ticket: SESSION_DEFAULTS.MAX_LINES_PER_TICKET,
      total_tool_calls: 0,
      max_tool_calls_per_ticket: SESSION_DEFAULTS.MAX_TOOL_CALLS_PER_TICKET,

      tickets_completed: 0,
      tickets_failed: 0,
      tickets_blocked: 0,
      prs_created: 0,
      scout_cycles: 0,
      max_cycles: config.max_cycles ?? (isContinuous ? 999 : 1),
      max_prs: effectiveMaxPrs,

      current_ticket_id: null,
      current_ticket_plan: null,
      plan_approved: false,
      plan_rejections: 0,
      qa_retries: 0,
      scout_retries: 0,
      consecutive_barren_cycles: 0,
      last_qa_failure: null,
      last_plan_rejection_reason: null,

      started_at: now.toISOString(),
      expires_at: expiresAt,

      scope: config.scope ?? SCOUT_DEFAULTS.SCOPE,
      config_scope: config.scope ?? SCOUT_DEFAULTS.SCOPE,
      categories: config.categories ?? [...SCOUT_DEFAULTS.CATEGORIES],
      config_categories: config.categories ?? [...SCOUT_DEFAULTS.CATEGORIES],
      min_confidence: config.min_confidence ?? SCOUT_DEFAULTS.MIN_CONFIDENCE,
      max_proposals_per_scout: config.max_proposals ?? SCOUT_DEFAULTS.MAX_PROPOSALS_PER_SCOUT,
      min_impact_score: config.min_impact_score ?? SCOUT_DEFAULTS.MIN_IMPACT_SCORE,
      create_prs: createPrs,
      draft,
      hints: [],
      scout_exclude_dirs: config.scout_exclude_dirs ?? [...SCOUT_DEFAULTS.EXCLUDE_DIRS],

      parallel: Math.min(Math.max(config.parallel ?? 2, 1), 5),
      ticket_workers: {},

      sectors_scanned: 0,
      sectors_total: 0,
      files_scanned: 0,
      files_total: 0,

      spindle: emptySpindle(),
      spindle_recoveries: 0,
      scouted_dirs: [],
      deferred_proposals: [],

      project_metadata: null,
      codebase_index: null,
      codebase_index_dirty: false,

      pending_proposals: null,
      scout_exploration_log: [],

      learnings_enabled: config.learnings !== false,
      learnings_budget: config.learnings_budget ?? 2000,
      learnings_loaded: false,
      injected_learning_ids: [],
      cached_learnings: [],

      // Direct mode: edit in place without worktrees. Default true for simpler solo use.
      // Auto-disabled when creating PRs or using parallel > 1 (needs isolation).
      direct: config.direct ?? (!createPrs && (config.parallel ?? 2) <= 1),

      // Trajectory planning
      active_trajectory: null,
      trajectory_step_id: null,
      trajectory_step_title: null,

      qa_commands: config.qa_commands ?? [],

      // Acceptance criteria verification (default: true)
      criteria_verification: config.criteria_verification !== false,

      // Cost tracking
      total_cost_usd: 0,
      total_input_tokens: 0,
      total_output_tokens: 0,

      // Last ticket summary
      last_ticket_summary: null,
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

    // Seed coverage from sectors.json if it exists
    try {
      const sectorsPath = path.join(this.bsDir, 'sectors.json');
      if (fs.existsSync(sectorsPath)) {
        const sectorsData = JSON.parse(fs.readFileSync(sectorsPath, 'utf8'));
        if (sectorsData?.version === 2 && Array.isArray(sectorsData.sectors)) {
          const scoutedSet = new Set<string>();
          for (const sec of sectorsData.sectors) {
            if (sec.scanCount > 0 && sec.path) {
              scoutedSet.add(sec.path);
            }
          }
          // Add scanned sectors to scouted_dirs
          for (const dir of scoutedSet) {
            if (!this.state.scouted_dirs.includes(dir)) {
              this.state.scouted_dirs.push(dir);
            }
          }
          // Recompute coverage from codebase_index × scouted_dirs
          if (this.state.codebase_index) {
            const scoutedDirSet = new Set(this.state.scouted_dirs.map(d => d.replace(/\/$/, '')));
            let scannedSectors = 0;
            let scannedFiles = 0;
            let totalFiles = 0;
            let totalSectors = 0;
            for (const mod of this.state.codebase_index.modules) {
              if (mod.production === false) continue;
              const fc = mod.production_file_count ?? mod.file_count ?? 0;
              totalFiles += fc;
              totalSectors++;
              if (scoutedDirSet.has(mod.path) || scoutedDirSet.has(mod.path + '/')) {
                scannedSectors++;
                scannedFiles += fc;
              }
            }
            this.state.sectors_scanned = scannedSectors;
            this.state.sectors_total = totalSectors;
            this.state.files_scanned = scannedFiles;
            this.state.files_total = totalFiles;
          }
        }
      }
    } catch (err) {
      if (err instanceof Error && !('code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT')) {
        console.warn(`[promptwheel] failed to seed coverage from sectors.json: ${err.message}`);
      }
    }

    // Store decay rate for lazy loading later
    this.learningsDecayRate = config.learnings_decay_rate;

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

  /** Load a previous run from disk (crash recovery). Returns null if not found or corrupt. */
  load(runId: string): RunState | null {
    if (this.state) {
      throw new Error('Run already active. End it first.');
    }
    const runsDir = path.join(this.bsDir, 'runs');
    const runDir = path.join(runsDir, runId);
    const statePath = path.join(runDir, 'state.json');
    try {
      const raw = fs.readFileSync(statePath, 'utf8');
      const loaded = JSON.parse(raw) as RunState;
      if (!loaded.run_id || !loaded.session_id) return null;
      this.state = loaded;
      this.runDir = runDir;
      this.eventsPath = path.join(runDir, 'events.ndjson');
      this.appendEvent('SESSION_RECOVERED', { run_id: runId });
      return this.state;
    } catch {
      return null;
    }
  }

  /** Get current state or throw */
  require(): RunState {
    if (!this.state) {
      throw new Error('No active run. Call promptwheel_start_session first.');
    }
    // Backfill config_scope for sessions created before this field existed
    if (!this.state.config_scope) {
      this.state.config_scope = this.state.scope;
    }
    // Backfill config_categories for sessions created before this field existed
    if (!this.state.config_categories) {
      this.state.config_categories = [...this.state.categories];
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
    s.last_qa_failure = null;
    s.last_plan_rejection_reason = null;
    s.spindle = emptySpindle(); // Fresh spindle per ticket — prevents false positives from prior ticket
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

  /** Reset spindle and ticket state for recovery after a spindle abort */
  resetForSpindleRecovery(): void {
    const s = this.require();
    s.spindle = emptySpindle();
    s.current_ticket_id = null;
    s.current_ticket_plan = null;
    s.plan_approved = false;
    s.plan_rejections = 0;
    s.qa_retries = 0;
    s.ticket_step_count = 0;
    s.last_qa_failure = null;
    s.last_plan_rejection_reason = null;
    this.persistState();
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
    // Release session lock
    try {
      const lockPath = path.join(this.bsDir, 'session.lock');
      if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
    } catch { /* ignore cleanup failures */ }

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
  initTicketWorker(ticketId: string, _ticket: { title: string }): void {
    const s = this.require();
    s.ticket_workers[ticketId] = {
      phase: 'PLAN',
      plan: null,
      plan_approved: false,
      plan_rejections: 0,
      qa_retries: 0,
      step_count: 0,
      last_active_at_step: s.step_count,
      spindle: emptySpindle(),
      last_qa_failure: null,
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

  /**
   * Complete a ticket worker — increment counters and remove from workers.
   *
   * INVARIANT: worker.step_count tracks steps taken by the ticket worker
   * (via advanceTicketWorker), NOT via incrementStep(). The session-level
   * incrementStep() only counts orchestrator steps (from advance()).
   * Adding worker.step_count here merges the two without double-counting.
   */
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
    const boundedPayload = capEventPayloadForPersistence(payload);
    const event: RunEvent = {
      ts: new Date().toISOString(),
      step,
      type,
      payload: boundedPayload,
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
    // PR limit only applies when creating PRs
    if (s.create_prs && s.prs_created >= s.max_prs) {
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
    // Only warn about ticket step budget if it's a real limit (not effectively disabled)
    if (s.ticket_step_budget < 9999 && s.ticket_step_count >= s.ticket_step_budget * 0.8) {
      warnings.push(`ticket_step_budget: ${s.ticket_step_count}/${s.ticket_step_budget}`);
    }
    // Only warn about PR limit when creating PRs
    if (s.create_prs && s.prs_created >= s.max_prs * 0.8) {
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
    coverage: { sectors_scanned: number; sectors_total: number; files_scanned: number; files_total: number; percent: number };
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
      ticket_budget_remaining: s.ticket_step_budget >= 9999 ? -1 : s.ticket_step_budget - s.ticket_step_count,
      spindle_risk: checkSpindle(s.spindle).risk,
      time_remaining_ms: timeRemainingMs,
      coverage: {
        sectors_scanned: s.sectors_scanned,
        sectors_total: s.sectors_total,
        files_scanned: s.files_scanned,
        files_total: s.files_total,
        percent: s.files_total > 0 ? Math.round((s.files_scanned / s.files_total) * 100) : 0,
      },
    };
  }

  // -----------------------------------------------------------------------
  // Lazy learnings
  // -----------------------------------------------------------------------

  /** Lazy-load learnings from disk on first access. No-op if already loaded or disabled. */
  ensureLearningsLoaded(): void {
    const s = this.require();
    if (s.learnings_loaded || !s.learnings_enabled) return;
    try {
      s.cached_learnings = loadLearnings(this.projectPath, this.learningsDecayRate);
    } catch (err) {
      this.appendEvent('LEARNINGS_LOAD_FAILED', { error: err instanceof Error ? err.message : String(err) });
      s.cached_learnings = [];
    }
    s.learnings_loaded = true;
  }

  // -----------------------------------------------------------------------
  // Persistence
  // -----------------------------------------------------------------------

  private persistState(): void {
    if (!this.runDir || !this.state) return;
    const statePath = path.join(this.runDir, 'state.json');
    const tmpPath = statePath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(this.state, null, 2) + '\n', 'utf8');
    fs.renameSync(tmpPath, statePath);
  }
}
