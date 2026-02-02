/**
 * Execution backends registry
 *
 * Each backend spawns a different LLM CLI to implement tickets in worktrees.
 */

export type { ClaudeResult, ExecutionBackend } from './types.js';
export { ClaudeExecutionBackend, runClaude } from './claude.js';
export { CodexExecutionBackend } from './codex.js';
export { KimiExecutionBackend } from './kimi.js';
