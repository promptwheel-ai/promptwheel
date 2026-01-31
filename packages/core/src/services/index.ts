/**
 * Service exports
 *
 * Services provide business logic orchestration.
 * They use repositories for data access and are dependency-injected for testability.
 */

export {
  scoutRepo,
  approveProposals,
  type ScoutDeps,
  type ScoutRepoOptions,
  type ScoutRepoResult,
  type ScoutProgress,
  type GitService,
  type Logger,
} from './scout.js';

export type { ScoutBackend } from '../scout/index.js';

export {
  runQa,
  getQaRunDetails,
  type QaDeps,
  type QaLogger,
  type QaCommand,
  type QaConfig,
  type QaArtifactsConfig,
  type QaRetryConfig,
  type QaRunOptions,
  type QaRunResult,
} from './qa.js';
