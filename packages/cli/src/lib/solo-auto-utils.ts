/**
 * Small pure helpers for solo-auto mode
 */

/**
 * Compute ticket timeout based on complexity and per-category config.
 */
export function computeTicketTimeout(
  proposal: { estimated_complexity?: string; category?: string },
  config?: { categoryTimeouts?: Record<string, number> },
): number {
  if (config?.categoryTimeouts?.[proposal.category ?? ''])
    return Math.min(config.categoryTimeouts[proposal.category!], 1_200_000);
  switch (proposal.estimated_complexity) {
    case 'trivial': return 180_000;
    case 'simple': return 300_000;
    case 'complex': return 900_000;
    default: return 600_000;
  }
}

/**
 * Determine session phase based on elapsed time vs total budget.
 * Only meaningful when a time budget is set (--hours/--minutes).
 */
export function getSessionPhase(elapsed: number, totalBudgetMs: number | undefined): 'warmup' | 'deep' | 'cooldown' {
  if (!totalBudgetMs) return 'deep'; // no time budget → always deep
  const pct = elapsed / totalBudgetMs;
  if (pct < 0.2) return 'warmup';
  if (pct > 0.8) return 'cooldown';
  return 'deep';
}

/**
 * Format milliseconds as a human-readable elapsed string.
 */
export function formatElapsed(ms: number): string {
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor((ms % 3600000) / 60000);
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}
