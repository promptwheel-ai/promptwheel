/**
 * Formula and category selection logic for auto-mode cycles.
 */

import { readRunState, isDocsAuditDue } from './run-state.js';
import type { Formula } from './formulas.js';

export interface CycleFormulaContext {
  activeFormula: Formula | null;
  sessionPhase: 'warmup' | 'deep' | 'cooldown';
  deepFormula: Formula | null;
  docsAuditFormula: Formula | null;
  isContinuous: boolean;
  repoRoot: string;
  options: {
    docsAuditInterval?: string;
    safe?: boolean;
    tests?: boolean;
  };
  config: { auto?: { docsAuditInterval?: number; docsAudit?: boolean } } | null;
}

/**
 * Determine the formula to use for a given cycle.
 */
export function getCycleFormula(ctx: CycleFormulaContext, cycle: number): Formula | null {
  const { activeFormula, sessionPhase, deepFormula, docsAuditFormula, isContinuous, repoRoot, options, config } = ctx;

  if (activeFormula) return activeFormula;

  // Session arc: cooldown phase → no formula (light work only)
  if (sessionPhase === 'cooldown') return null;

  const rs = readRunState(repoRoot);

  // Hard guarantee: deep at least every 7 cycles
  if (deepFormula && isContinuous) {
    const deepStats = rs.formulaStats['deep'];
    if (cycle - (deepStats?.lastResetCycle ?? 0) >= 7) {
      // Session arc: warmup phase → skip deep
      if (sessionPhase !== 'warmup') return deepFormula;
    }
  }

  // Docs-audit: keep existing periodic logic
  if (docsAuditFormula && repoRoot) {
    let interval = options.docsAuditInterval
      ? parseInt(options.docsAuditInterval, 10)
      : config?.auto?.docsAuditInterval ?? 3;
    const docsStats = rs.formulaStats['docs-audit'];
    if (docsStats && docsStats.cycles >= 3 && docsStats.proposalsGenerated === 0) {
      interval = Math.max(interval, 10);
    }
    if (config?.auto?.docsAudit !== false && isDocsAuditDue(repoRoot, interval)) return docsAuditFormula;
  }

  // Session arc: warmup phase → skip UCB1 deep selection
  if (sessionPhase === 'warmup') return null;

  // UCB1 selection: default vs deep
  if (!deepFormula || !isContinuous) return null;
  const candidates = [
    { name: 'default', formula: null as typeof deepFormula | null },
    { name: 'deep', formula: deepFormula },
  ];
  let bestScore = -Infinity;
  let bestFormula: typeof deepFormula | null = null;
  for (const c of candidates) {
    const stats = rs.formulaStats[c.name];
    const alpha = (stats?.recentTicketsSucceeded ?? 0) + 1;
    const beta = ((stats?.recentTicketsTotal ?? 0) - (stats?.recentTicketsSucceeded ?? 0)) + 1;
    const exploitation = alpha / (alpha + beta);
    const exploration = Math.sqrt(2 * Math.log(Math.max(cycle, 1)) / Math.max(stats?.recentCycles ?? 0, 1));
    if (exploitation + exploration > bestScore) {
      bestScore = exploitation + exploration;
      bestFormula = c.formula;
    }
  }
  return bestFormula;
}

/**
 * Get allow/block category lists for a given formula and session context.
 */
export function getCycleCategories(ctx: CycleFormulaContext, formula: Formula | null): { allow: string[]; block: string[] } {
  const { sessionPhase, options } = ctx;

  // Session arc: cooldown → restrict to light categories
  if (sessionPhase === 'cooldown') {
    return { allow: ['docs', 'cleanup', 'types'], block: ['deps', 'auth', 'config', 'migration'] };
  }
  let allow = formula?.categories
    ? formula.categories as string[]
    : options.safe
      ? ['refactor', 'docs', 'types', 'perf']
      : ['refactor', 'docs', 'types', 'perf', 'security', 'fix', 'cleanup'];
  // --tests flag opts in to test proposals
  if (options.tests && !allow.includes('test')) {
    allow = [...allow, 'test'];
  }
  const block = formula?.categories
    ? []
    : options.safe
      ? ['deps', 'auth', 'config', 'migration', 'security', 'fix', 'cleanup']
      : ['deps', 'auth', 'config', 'migration'];
  return { allow, block };
}
