/**
 * PromptWheel v2 types — Run state, events, phases, and response contracts.
 *
 * These match the schemas defined in docs/PLUGIN_ROADMAP.md.
 */

// Re-export codebase index types for convenience
export type { CodebaseIndex, ModuleEntry, LargeFileEntry } from './codebase-index.js';

// ---------------------------------------------------------------------------
// Phases
// ---------------------------------------------------------------------------

export type Phase =
  | 'SCOUT'
  | 'PLAN'
  | 'EXECUTE'
  | 'QA'
  | 'PR'
  | 'NEXT_TICKET'
  | 'PARALLEL_EXECUTE'
  // terminal
  | 'DONE'
  | 'BLOCKED_NEEDS_HUMAN'
  | 'FAILED_BUDGET'
  | 'FAILED_VALIDATION'
  | 'FAILED_SPINDLE';

export const TERMINAL_PHASES: ReadonlySet<Phase> = new Set([
  'DONE',
  'BLOCKED_NEEDS_HUMAN',
  'FAILED_BUDGET',
  'FAILED_VALIDATION',
  'FAILED_SPINDLE',
]);

// ---------------------------------------------------------------------------
// Commit Plan
// ---------------------------------------------------------------------------

export interface CommitPlan {
  ticket_id: string;
  files_to_touch: Array<{
    path: string;
    reason: string;
    action: 'create' | 'modify' | 'delete';
  }>;
  expected_tests: string[];
  risk_level: 'low' | 'medium' | 'high';
  estimated_lines: number;
}

// ---------------------------------------------------------------------------
// Spindle State
// ---------------------------------------------------------------------------

export interface SpindleState {
  output_hashes: string[];
  diff_hashes: string[];
  iterations_since_change: number;
  total_output_chars: number;
  total_change_chars: number;
  failing_command_signatures: string[];
  plan_hashes: string[];
  file_edit_counts?: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Run State (persisted to state.json)
// ---------------------------------------------------------------------------

export interface RunState {
  // Identity
  run_id: string;
  session_id: string;
  project_id: string;

  // Phase state machine
  phase: Phase;
  phase_entry_step: number;

  // Budgets
  step_count: number;
  step_budget: number;
  ticket_step_count: number;
  ticket_step_budget: number;
  total_lines_changed: number;
  max_lines_per_ticket: number;
  total_tool_calls: number;
  max_tool_calls_per_ticket: number;

  // Counters
  tickets_completed: number;
  tickets_failed: number;
  tickets_blocked: number;
  prs_created: number;
  scout_cycles: number;
  max_cycles: number;
  max_prs: number;

  // Current work
  current_ticket_id: string | null;
  current_ticket_plan: CommitPlan | null;
  plan_approved: boolean;
  plan_rejections: number;
  qa_retries: number;
  scout_retries: number;

  // Critic: last failure context for retry guidance
  last_qa_failure: { failed_commands: string[]; error_output: string } | null;
  last_plan_rejection_reason: string | null;

  // Time
  started_at: string;
  expires_at: string | null;

  // Config
  scope: string;
  formula: string | null;
  categories: string[];
  min_confidence: number;
  max_proposals_per_scout: number;
  min_impact_score: number;
  create_prs: boolean;
  draft: boolean;
  eco: boolean;
  hints: string[];
  scout_exclude_dirs: string[];

  // Parallel execution
  parallel: number;
  ticket_workers: Record<string, TicketWorkerState>;

  // Direct mode: edit in place without worktrees/branches
  direct: boolean;

  // Cross-verify: use separate verifier agent for QA
  cross_verify: boolean;

  // Coverage
  sectors_scanned: number;
  sectors_total: number;
  files_scanned: number;
  files_total: number;

  // Spindle
  spindle: SpindleState;
  spindle_recoveries: number;

  // Directories already explored by scout (for rotation across cycles)
  scouted_dirs: string[];

  // Deferred proposals (out-of-scope, retried when scope matches)
  deferred_proposals: DeferredProposal[];

  // Project metadata (detected at session start)
  project_metadata: ProjectMetadataSnapshot | null;

  // Codebase structural index (built at session start)
  codebase_index: import('./codebase-index.js').CodebaseIndex | null;

  // Set true when code changes (ticket complete/fail) — triggers reindex on next scout cycle
  codebase_index_dirty: boolean;

  // Pending proposals awaiting adversarial review before ticket creation
  pending_proposals: import('./proposals.js').RawProposal[] | null;

  // Skip adversarial review: create tickets directly from scout proposals
  skip_review: boolean;

  // Exploration log for better escalation context across scout retries
  scout_exploration_log: string[];

  // Cross-run learnings
  learnings_enabled: boolean;
  /** True once learnings have been lazy-loaded from disk */
  learnings_loaded: boolean;
  injected_learning_ids: string[];
  /** Cached learnings (lazy-loaded on first use, not at session start) */
  cached_learnings: import('./learnings.js').Learning[];

  // Sector rotation
  selected_sector_path?: string;
  current_sector_path?: string;

  // Trajectory planning
  active_trajectory: string | null;
  trajectory_step_id: string | null;
  trajectory_step_title: string | null;

  // Dry-run mode — scout only, no execution
  dry_run: boolean;

  // User-specified QA commands (always run in addition to ticket verification commands)
  qa_commands: string[];
}

export interface ProjectMetadataSnapshot {
  languages: string[];
  package_manager: string | null;
  test_runner_name: string | null;
  test_run_command: string | null;
  test_filter_syntax: string | null;
  framework: string | null;
  linter: string | null;
  type_checker: string | null;
  monorepo_tool: string | null;
}

// ---------------------------------------------------------------------------
// Ticket Worker State (per-ticket in parallel mode)
// ---------------------------------------------------------------------------

export interface TicketWorkerState {
  phase: 'PLAN' | 'EXECUTE' | 'QA' | 'CROSS_QA' | 'PR' | 'DONE' | 'FAILED';
  plan: CommitPlan | null;
  plan_approved: boolean;
  plan_rejections: number;
  qa_retries: number;
  step_count: number;
  /** Session-level step_count when this worker last made progress */
  last_active_at_step: number;
  spindle: SpindleState;
  // Critic: last QA failure context for retry guidance
  last_qa_failure: { failed_commands: string[]; error_output: string } | null;
}

export interface DeferredProposal {
  category: string;
  title: string;
  description: string;
  files: string[];
  allowed_paths: string[];
  confidence: number;
  impact_score: number;
  original_scope: string;
  // Required fields for schema validation when re-injected
  verification_commands: string[];
  acceptance_criteria: string[];
  risk: string;
  touched_files_estimate: number;
  rollback_note: string;
  // Optional fields
  rationale?: string;
  estimated_complexity?: string;
}

// ---------------------------------------------------------------------------
// Events (appended to events.ndjson)
// ---------------------------------------------------------------------------

export type EventType =
  | 'SESSION_START'
  | 'ADVANCE_CALLED'
  | 'ADVANCE_RETURNED'
  | 'SCOUT_OUTPUT'
  | 'PROPOSALS_FILTERED'
  | 'TICKETS_CREATED'
  | 'TICKET_ASSIGNED'
  | 'PLAN_SUBMITTED'
  | 'PLAN_APPROVED'
  | 'PLAN_REJECTED'
  | 'TOOL_CALL_ATTEMPTED'
  | 'SCOPE_ALLOWED'
  | 'SCOPE_BLOCKED'
  | 'TICKET_RESULT'
  | 'QA_STARTED'
  | 'QA_COMMAND_RESULT'
  | 'QA_PASSED'
  | 'QA_FAILED'
  | 'PR_CREATED'
  | 'TICKET_COMPLETED'
  | 'TICKET_COMPLETED_NO_PR'
  | 'TICKET_FAILED'
  | 'BUDGET_WARNING'
  | 'BUDGET_EXHAUSTED'
  | 'SPINDLE_WARNING'
  | 'SPINDLE_ABORT'
  | 'TRACE_ANALYSIS'
  | 'HINT_CONSUMED'
  | 'USER_OVERRIDE'
  | 'PROPOSALS_REVIEWED'
  | 'SECTOR_ROTATION_FAILED'
  | 'WORKER_TIMEOUT'
  | 'LEARNINGS_LOAD_FAILED'
  | 'SESSION_END';

export interface RunEvent {
  ts: string;
  step: number;
  type: EventType;
  payload: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Advance Response
// ---------------------------------------------------------------------------

export interface AdvanceConstraints {
  allowed_paths: string[];
  denied_paths: string[];
  denied_patterns: string[];
  max_files: number;
  max_lines: number;
  required_commands: string[];
  plan_required: boolean;
  auto_approve_patterns: string[];
}

export interface AdvanceDigest {
  step: number;
  phase: string;
  tickets_completed: number;
  tickets_failed: number;
  budget_remaining: number;
  ticket_budget_remaining: number;
  spindle_risk: 'none' | 'low' | 'medium' | 'high';
  time_remaining_ms: number | null;
}

export interface ParallelTicketInfo {
  ticket_id: string;
  title: string;
  description: string;
  constraints: AdvanceConstraints;
  /** Self-contained prompt for a Task subagent — no MCP tools needed */
  inline_prompt: string;
}

export interface AdvanceResponse {
  next_action: 'PROMPT' | 'STOP' | 'PARALLEL_EXECUTE';
  phase: Phase;
  prompt: string | null;
  reason: string;
  constraints: AdvanceConstraints;
  digest: AdvanceDigest;
  parallel_tickets?: ParallelTicketInfo[];
}

// ---------------------------------------------------------------------------
// Session Config (user-provided at start)
// ---------------------------------------------------------------------------

export interface SessionConfig {
  hours?: number;
  formula?: string;
  deep?: boolean;
  continuous?: boolean;
  scope?: string;
  categories?: string[];
  min_confidence?: number;
  max_proposals?: number;
  step_budget?: number;
  ticket_step_budget?: number;
  max_prs?: number;
  max_cycles?: number;
  /** @deprecated Use create_prs instead */
  draft_prs?: boolean;
  create_prs?: boolean;
  draft?: boolean;
  eco?: boolean;
  parallel?: number;
  min_impact_score?: number;
  scout_exclude_dirs?: string[];
  learnings?: boolean;
  learnings_budget?: number;
  learnings_decay_rate?: number;
  /** Direct mode: edit in place without worktrees/branches. Default: true (simpler for solo use). */
  direct?: boolean;
  /** Cross-verify: use a separate verifier agent for QA instead of self-verification. Default: false. */
  cross_verify?: boolean;
  /** Skip adversarial review: create tickets directly from scout proposals without a second review pass. Default: false. */
  skip_review?: boolean;
  /** Dry-run mode: scout only, no ticket creation or execution. Default: false. */
  dry_run?: boolean;
  /** User-specified QA commands to run after every ticket (in addition to scout-proposed verification commands). */
  qa_commands?: string[];
}
