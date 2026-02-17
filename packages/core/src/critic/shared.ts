/**
 * Critic Scoring — pure algorithms for retry guidance.
 *
 * When QA fails or a plan is rejected, these functions analyze structured
 * learnings to build targeted guidance for the retry prompt.
 *
 * No I/O — callers provide learnings and failure context.
 */

import type { Learning } from '../learnings/shared.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FailureContext {
  failed_commands: string[];
  error_output: string;
  attempt: number;
  max_attempts: number;
}

export interface RetryRiskScore {
  score: number;        // 0-100
  level: 'low' | 'medium' | 'high';
  signals: string[];
}

export interface CriticStrategy {
  label: string;
  instruction: string;
  confidence: number;   // 0-100
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/**
 * Compute retry risk based on learnings overlap with the failing ticket.
 */
export function computeRetryRisk(
  ticketPaths: string[],
  ticketCommands: string[],
  learnings: Learning[],
  failureContext: FailureContext,
): RetryRiskScore {
  const signals: string[] = [];
  let score = failureContext.attempt * 20;

  const pathSet = new Set(ticketPaths.map(p => p.replace(/\/?\*\*?$/, '')));

  for (const l of learnings) {
    if (!l.structured) continue;
    const sk = l.structured;

    // Fragile path overlap
    if (sk.fragile_paths) {
      for (const fp of sk.fragile_paths) {
        if (pathSet.has(fp) || [...pathSet].some(p => fp.startsWith(p + '/') || p.startsWith(fp + '/'))) {
          score += 15;
          signals.push(`Fragile: ${fp}`);
          break;
        }
      }
    }

    // Error signature match
    if (sk.failure_context?.error_signature && failureContext.error_output) {
      if (failureContext.error_output.includes(sk.failure_context.error_signature) ||
          sk.failure_context.error_signature.includes(failureContext.error_output.slice(0, 80))) {
        score += 20;
        signals.push(`Known error: ${sk.failure_context.error_signature.slice(0, 60)}`);
      }
    }

    // Cochange files not in allowed paths
    if (sk.cochange_files) {
      for (const cf of sk.cochange_files) {
        const cfClean = cf.replace(/\/?\*\*?$/, '');
        if (!pathSet.has(cfClean) && ![...pathSet].some(p => cfClean.startsWith(p + '/'))) {
          score += 10;
          signals.push(`Missing cochange: ${cf}`);
          break;
        }
      }
    }
  }

  score = Math.min(100, score);
  const level = score < 30 ? 'low' : score <= 60 ? 'medium' : 'high';
  return { score, level, signals };
}

/**
 * Generate ranked strategies for a retry based on learnings.
 * Returns top 3 by confidence.
 */
export function scoreStrategies(
  ticketPaths: string[],
  failureContext: FailureContext,
  learnings: Learning[],
): CriticStrategy[] {
  const strategies: CriticStrategy[] = [];
  const pathSet = new Set(ticketPaths.map(p => p.replace(/\/?\*\*?$/, '')));

  for (const l of learnings) {
    if (!l.structured) continue;
    const sk = l.structured;

    // "Apply known fix" — if a learning has fix_applied
    if (sk.failure_context?.fix_applied) {
      strategies.push({
        label: 'Apply known fix',
        instruction: sk.failure_context.fix_applied,
        confidence: l.weight,
      });
    }

    // "Include cochange files" — if cochange_files overlap
    if (sk.cochange_files) {
      const missing = sk.cochange_files.filter(cf => {
        const cfClean = cf.replace(/\/?\*\*?$/, '');
        return !pathSet.has(cfClean) && ![...pathSet].some(p => cfClean.startsWith(p + '/'));
      });
      if (missing.length > 0) {
        strategies.push({
          label: 'Include cochange files',
          instruction: `${missing.join(', ')} often change together with the ticket files`,
          confidence: Math.round(l.weight * 0.8),
        });
      }
    }

    // "Avoid antipattern" — if antipattern learning matches
    if (sk.pattern_type === 'antipattern') {
      strategies.push({
        label: 'Avoid antipattern',
        instruction: l.text,
        confidence: Math.round(l.weight * 0.7),
      });
    }
  }

  // "Different approach" fallback on attempt >= 2
  if (failureContext.attempt >= 2) {
    strategies.push({
      label: 'Different approach',
      instruction: 'The previous approach failed. Try a fundamentally different implementation strategy.',
      confidence: 30,
    });
  }

  // Deduplicate by label (keep highest confidence)
  const best = new Map<string, CriticStrategy>();
  for (const s of strategies) {
    const existing = best.get(s.label);
    if (!existing || s.confidence > existing.confidence) {
      best.set(s.label, s);
    }
  }

  return [...best.values()]
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 3);
}

// ---------------------------------------------------------------------------
// Block builders
// ---------------------------------------------------------------------------

/**
 * Build a critic review block for QA retry prompts.
 * Returns empty string if risk is low and no high-confidence strategies exist.
 */
export function buildCriticBlock(
  failureContext: FailureContext,
  risk: RetryRiskScore,
  strategies: CriticStrategy[],
  _learnings: Learning[],
): string {
  // Skip prompt bloat when risk is low and no strategies are confident
  if (risk.level === 'low' && !strategies.some(s => s.confidence > 50)) {
    return '';
  }

  const lines: string[] = [
    '<critic-review>',
    `## Retry Guidance (attempt ${failureContext.attempt}/${failureContext.max_attempts})`,
    '',
    '### What Went Wrong',
  ];

  for (const cmd of failureContext.failed_commands) {
    lines.push(`- Failed: \`${cmd}\``);
  }
  if (failureContext.error_output) {
    const truncated = failureContext.error_output.slice(0, 200);
    lines.push(`- Error: ${truncated}`);
  }

  lines.push('');
  lines.push(`### Risk: ${risk.level.toUpperCase()} (score: ${risk.score})`);
  for (const sig of risk.signals) {
    lines.push(`- ${sig}`);
  }

  if (strategies.length > 0) {
    lines.push('');
    lines.push('### Recommended Approach');
    for (const s of strategies) {
      lines.push(`${s.confidence}. [${s.confidence}] ${s.label}: ${s.instruction}`);
    }
  }

  lines.push('</critic-review>');
  return lines.join('\n');
}

/**
 * Build a critic block for plan rejection retries.
 * Returns empty string if no actionable guidance exists.
 */
export function buildPlanRejectionCriticBlock(
  context: { rejection_reason: string; attempt: number; max_attempts: number },
  learnings: Learning[],
  ticketPaths: string[],
): string {
  const pathSet = new Set(ticketPaths.map(p => p.replace(/\/?\*\*?$/, '')));
  const relevantLearnings = learnings.filter(l => {
    if (!l.structured) return false;
    if (l.source.type !== 'plan_rejection' && l.source.type !== 'scope_violation') return false;
    // Check path overlap
    for (const tag of l.tags) {
      if (tag.startsWith('path:')) {
        const lPath = tag.slice(5);
        if (pathSet.has(lPath) || [...pathSet].some(p => lPath.startsWith(p + '/') || p.startsWith(lPath + '/'))) {
          return true;
        }
      }
    }
    return false;
  });

  if (relevantLearnings.length === 0 && !context.rejection_reason) {
    return '';
  }

  const lines: string[] = [
    '<critic-review>',
    `## Plan Revision Guidance (attempt ${context.attempt}/${context.max_attempts})`,
    '',
    `### Rejection Reason`,
    context.rejection_reason,
    '',
  ];

  if (relevantLearnings.length > 0) {
    lines.push('### Previous Plan Rejections in These Files');
    for (const l of relevantLearnings.slice(0, 3)) {
      lines.push(`- ${l.text}`);
      if (l.structured?.root_cause) {
        lines.push(`  Cause: ${l.structured.root_cause}`);
      }
    }
  }

  lines.push('</critic-review>');
  return lines.join('\n');
}
