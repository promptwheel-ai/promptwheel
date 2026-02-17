/**
 * Adversarial proposal review — second-pass critical evaluation of scout proposals.
 *
 * Pure algorithms (prompt building, response parsing, score application) live in
 * @promptwheel/core/proposals/shared. This file re-exports them for CLI consumers.
 */

// Re-export all pure review functions from core
export {
  buildProposalReviewPrompt,
  parseReviewedProposals,
  applyReviewToProposals,
} from '@promptwheel/core/proposals/shared';

export type { ReviewedProposal } from '@promptwheel/core/proposals/shared';
