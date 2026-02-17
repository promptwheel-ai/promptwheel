/**
 * @promptwheel/core
 *
 * Core business logic and shared types for PromptWheel.
 * This package is open source (Apache-2.0) and provides:
 *
 * - Database adapter interface (works with Postgres or SQLite)
 * - Repository layer for data access
 * - Services for business logic orchestration
 * - Scout service for codebase analysis
 * - Shared type definitions
 * - Core business logic utilities
 */

// Database adapter
export * from './db/index.js';

// Repositories (namespaced)
export * as repos from './repos/index.js';
export type { Project, Ticket, TicketStatus, TicketCategory, Run, RunStatus, RunType } from './repos/index.js';

// Services (namespaced to avoid conflicts with scout)
export * as services from './services/index.js';
export type { ScoutDeps, ScoutRepoOptions, ScoutRepoResult, GitService, Logger } from './services/index.js';
export { scoutRepo, approveProposals } from './services/index.js';

// Scout (low-level scanning/analysis - namespaced)
export * as scout from './scout/index.js';

// Exec runner interface
export * from './exec/index.js';

// Spindle shared detection functions
export * as spindle from './spindle/shared.js';

// Dedup shared algorithms
export * as dedup from './dedup/shared.js';

// Scope shared algorithms
export * as scope from './scope/shared.js';

// Guidelines shared logic
export * as guidelines from './guidelines/shared.js';

// Learnings shared algorithms
export * as learnings from './learnings/shared.js';

// Formulas shared definitions and parsing
export * as formulas from './formulas/shared.js';

// Proposals shared algorithms
export * as proposals from './proposals/shared.js';

// Sector rotation shared algorithms
export * as sectors from './sectors/shared.js';

// Wave scheduling shared algorithms
export * as waves from './waves/shared.js';

// Trace analysis shared algorithms
export * as trace from './trace/shared.js';

// Trajectory planning shared algorithms
export * as trajectory from './trajectory/shared.js';

// Centralized defaults
export { SESSION_DEFAULTS, SCOUT_DEFAULTS, EXECUTION_DEFAULTS } from './config/defaults.js';

// Utilities
export * from './utils/index.js';
