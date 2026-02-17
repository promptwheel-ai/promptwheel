/**
 * Centralized default constants for BlockSpool.
 *
 * Both CLI (solo-config.ts) and MCP (run-manager.ts) must agree on these values.
 * Add new defaults here — not scattered across packages.
 */

// ---------------------------------------------------------------------------
// Session budgets
// ---------------------------------------------------------------------------

export const SESSION_DEFAULTS = {
  /** Max advance() calls per session */
  STEP_BUDGET: 200,
  /** Max steps per ticket (relaxed in continuous/hours mode) */
  TICKET_STEP_BUDGET: 12,
  /** Max line changes per ticket before scope-creep guard triggers */
  MAX_LINES_PER_TICKET: 500,
  /** Max tool calls per ticket */
  MAX_TOOL_CALLS_PER_TICKET: 50,
  /** Default PRs per session (non-continuous) */
  MAX_PRS: 5,
  /** Default scout→execute cycles (non-continuous) */
  MAX_CYCLES: 1,
} as const;

// ---------------------------------------------------------------------------
// Scout defaults
// ---------------------------------------------------------------------------

export const SCOUT_DEFAULTS = {
  /** Minimum confidence to accept a proposal (MCP plugin mode) */
  MIN_CONFIDENCE: 55,
  /** Maximum proposals per scout cycle */
  MAX_PROPOSALS_PER_SCOUT: 5,
  /** Minimum impact score for proposals (matches PROPOSALS_DEFAULTS.DEFAULT_MIN_IMPACT) */
  MIN_IMPACT_SCORE: 3,
  /** Retries when scout returns zero proposals */
  MAX_SCOUT_RETRIES: 3,
  /** Default scope glob */
  SCOPE: '**',
  /** Default trust ladder categories */
  CATEGORIES: ['refactor', 'docs', 'perf', 'security', 'fix', 'cleanup', 'types'] as readonly string[],
  /** Directories excluded from scanning */
  EXCLUDE_DIRS: [
    // JS/TS
    'node_modules', 'dist', 'build', '.next', 'coverage',
    // Python
    '__pycache__', '.venv', 'venv', '.tox', '*.egg-info',
    // Rust
    'target',
    // Java/Kotlin
    '.gradle', '.mvn',
    // Elixir
    '_build', 'deps',
    // Ruby
    '.bundle',
    // C#
    'bin', 'obj',
    // Swift
    '.build', '.swiftpm',
    // Dart
    '.dart_tool',
    // Haskell
    '.stack-work', 'dist-newstyle', '.cabal-sandbox',
    // Zig
    'zig-cache', 'zig-out',
    // General
    'assets', 'public/static', 'vendor', '.git',
  ] as readonly string[],
} as const;

// ---------------------------------------------------------------------------
// Execution defaults
// ---------------------------------------------------------------------------

export const EXECUTION_DEFAULTS = {
  /** Max QA retry attempts before failing a ticket */
  MAX_QA_RETRIES: 3,
  /** Default parallel ticket count */
  PARALLEL: 2,
  /** Maximum parallel tickets allowed */
  MAX_PARALLEL: 5,
} as const;
