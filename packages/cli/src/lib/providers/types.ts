/**
 * Provider configuration types
 */

import type { ScoutBackend } from '@promptwheel/core/scout';
import type { ExecutionBackend } from '../execution-backends/index.js';

export interface ProviderFactoryOpts {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
}

export interface ExecutionFactoryOpts extends ProviderFactoryOpts {
  unsafeBypassSandbox?: boolean;
  maxIterations?: number;
}

export interface ProviderConfig {
  /** Human-readable name */
  displayName: string;
  /** Default model for this provider */
  defaultModel: string;
  /** Env var for API key authentication, or null if auth is handled differently */
  apiKeyEnvVar: string | null;
  /** Alternative auth description (e.g., "codex login") */
  altAuth?: string;
  /** Primary guidelines filename (CLAUDE.md, AGENTS.md, KIMI.md, etc.) */
  guidelinesFile: string;
  /** Default scout timeout in ms */
  defaultScoutTimeoutMs: number;
  /** Default scout concurrency */
  defaultScoutConcurrency: number;
  /** Default batch token budget */
  defaultBatchTokenBudget: number;
  /** Create a scout backend instance */
  createScoutBackend(opts: ProviderFactoryOpts): Promise<ScoutBackend>;
  /** Create an execution backend instance */
  createExecutionBackend(opts: ExecutionFactoryOpts): Promise<ExecutionBackend>;
}
