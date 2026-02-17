/**
 * Scope enforcement utilities
 *
 * Pure algorithms live in @promptwheel/core/scope/shared.
 * This file re-exports them for CLI consumers.
 */

export {
  normalizePath,
  detectHallucinatedPath,
  checkScopeViolations,
  matchesPattern,
  analyzeViolationsForExpansion,
  parseChangedFiles,
  type ScopeViolation,
  type ScopeExpansionResult,
} from '@promptwheel/core/scope/shared';
