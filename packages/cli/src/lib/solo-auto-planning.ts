/**
 * Planning round for auto mode: scout all sectors → present roadmap → user approves → execute.
 *
 * Default mode when running `promptwheel` with no flags.
 */

import chalk from 'chalk';
import type { TicketProposal } from '@promptwheel/core/scout';
import type { AutoSessionState } from './solo-auto-state.js';
import { getNextScope } from './solo-auto-state.js';
import { runScoutPhase } from './solo-auto-scout.js';
import { filterProposals } from './solo-auto-filter.js';

// ── Scout all sectors ────────────────────────────────────────────────────────

export interface ScoutAllResult {
  /** All approved proposals from all sectors, ranked. */
  proposals: TicketProposal[];
  /** Number of sectors scanned. */
  sectorsScanned: number;
}

/**
 * Scout every sector (or --scope if specified) and collect all approved proposals.
 * Respects the existing filter pipeline (category, scope, dedup).
 */
export async function scoutAllSectors(state: AutoSessionState): Promise<ScoutAllResult> {
  const allProposals: TicketProposal[] = [];
  let sectorsScanned = 0;

  const totalSectors = state.sectorState?.sectors.length ?? 1;

  // If --scope is set, scout only that scope
  if (state.userScope) {
    state.displayAdapter.log(chalk.bold(`Scouting scope: ${state.userScope}...`));
    state.cycleCount++;

    const scoutResult = await runScoutPhase(state, state.userScope);
    if (!scoutResult.shouldBreak && scoutResult.proposals.length > 0) {
      const filterResult = await filterProposals(state, scoutResult.proposals, scoutResult.scope, scoutResult.cycleFormula);
      if (filterResult.toProcess.length > 0) {
        allProposals.push(...filterResult.toProcess);
      }
    }
    sectorsScanned = 1;
    return { proposals: rankProposals(allProposals), sectorsScanned };
  }

  // Scout all sectors
  state.displayAdapter.log(chalk.bold(`Scouting ${totalSectors} sector(s)...`));
  state.displayAdapter.log('');

  // Keep scouting until getNextScope returns null (all sectors covered)
  // or we hit a shutdown signal
  const maxIterations = totalSectors + 5; // safety bound
  let iterations = 0;

  while (!state.shutdownRequested && iterations < maxIterations) {
    iterations++;
    const scope = getNextScope(state);
    if (scope === null) break; // all sectors scanned

    state.cycleCount++;
    sectorsScanned++;

    state.displayAdapter.log(chalk.gray(`  [${sectorsScanned}/${totalSectors}] ${scope}`));

    const scoutResult = await runScoutPhase(state, scope);
    if (scoutResult.shouldBreak) break;

    if (scoutResult.proposals.length > 0) {
      const filterResult = await filterProposals(state, scoutResult.proposals, scoutResult.scope, scoutResult.cycleFormula);
      if (filterResult.toProcess.length > 0) {
        allProposals.push(...filterResult.toProcess);
      }
    }

    // Reset scout retries between sectors in planning mode
    state.scoutRetries = 0;
    state.scoutedDirs = [];
  }

  return { proposals: rankProposals(allProposals), sectorsScanned };
}

// ── Rank proposals ───────────────────────────────────────────────────────────

function rankProposals(proposals: TicketProposal[]): TicketProposal[] {
  return [...proposals].sort((a, b) => {
    const scoreA = (a.impact_score ?? 5) * (a.confidence / 100);
    const scoreB = (b.impact_score ?? 5) * (b.confidence / 100);
    return scoreB - scoreA; // highest first
  });
}

// ── Present roadmap ──────────────────────────────────────────────────────────

export interface RoadmapResult {
  /** The proposals the user approved for execution. */
  approved: TicketProposal[];
  /** Whether the user cancelled the session. */
  cancelled: boolean;
}

/**
 * Display a ranked roadmap and prompt the user to approve.
 *
 * Supports:
 * - `--yes`: auto-approve all
 * - `--dry-run`: show roadmap only, no execution
 * - TUI mode: auto-approve (readline incompatible with neo-blessed)
 * - Selection syntax: `1-3,5,7-9` to pick specific proposals
 */
export async function presentRoadmap(
  state: AutoSessionState,
  proposals: TicketProposal[],
): Promise<RoadmapResult> {
  if (proposals.length === 0) {
    state.displayAdapter.log(chalk.yellow('No improvements found across all sectors.'));
    return { approved: [], cancelled: false };
  }

  // Display roadmap
  state.displayAdapter.log('');
  state.displayAdapter.log(chalk.bold(`📋 Roadmap: ${proposals.length} improvement(s)`));
  state.displayAdapter.log('');

  for (let i = 0; i < proposals.length; i++) {
    const p = proposals[i];
    const impact = p.impact_score ?? 5;
    const conf = p.confidence;
    const score = (impact * (conf / 100)).toFixed(1);
    const complexity = p.estimated_complexity || 'simple';
    const cat = p.category || 'refactor';

    state.displayAdapter.log(
      chalk.cyan(`  ${String(i + 1).padStart(2)}. `) +
      chalk.bold(p.title)
    );
    state.displayAdapter.log(
      chalk.gray(`      ${cat} | ${complexity} | impact ${impact} × ${conf}% = ${score} | ${(p.files ?? p.allowed_paths ?? []).length} file(s)`)
    );
  }
  state.displayAdapter.log('');

  // --dry-run: show only
  if (state.options.dryRun) {
    state.displayAdapter.log(chalk.yellow('Dry run — roadmap displayed, no execution.'));
    return { approved: [], cancelled: false };
  }

  // --yes or TUI mode: auto-approve all
  if (state.options.yes || state.options.tui !== false && !process.stdout.isTTY) {
    state.displayAdapter.log(chalk.green(`Auto-approved all ${proposals.length} proposal(s).`));
    return { approved: proposals, cancelled: false };
  }

  // TUI mode (neo-blessed active): auto-approve since readline is incompatible
  const useTui = state.options.tui !== false && process.stdout.isTTY;
  if (useTui) {
    state.displayAdapter.log(chalk.green(`Auto-approved all ${proposals.length} proposal(s) (TUI mode).`));
    return { approved: proposals, cancelled: false };
  }

  // Interactive prompt
  const readline = await import('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const answer = await new Promise<string>((resolve) => {
    rl.question(
      chalk.bold(`Execute all ${proposals.length}? [Y/n/1-3,5 to select] `),
      resolve,
    );
  });
  rl.close();

  const trimmed = answer.trim().toLowerCase();

  // Cancel
  if (trimmed === 'n' || trimmed === 'no') {
    state.displayAdapter.log(chalk.gray('Cancelled.'));
    return { approved: [], cancelled: true };
  }

  // Accept all
  if (trimmed === '' || trimmed === 'y' || trimmed === 'yes') {
    return { approved: proposals, cancelled: false };
  }

  // Parse selection (e.g. "1-3,5,7-9")
  const selected = parseSelection(trimmed, proposals.length);
  if (selected.length === 0) {
    state.displayAdapter.log(chalk.yellow('No valid selections. Cancelled.'));
    return { approved: [], cancelled: true };
  }

  const approved = selected.map(i => proposals[i]);
  state.displayAdapter.log(chalk.green(`Selected ${approved.length} proposal(s).`));
  return { approved, cancelled: false };
}

// ── Selection parser ─────────────────────────────────────────────────────────

/**
 * Parse a selection string like "1-3,5,7-9" into 0-based indices.
 * Invalid or out-of-range values are silently ignored.
 */
export function parseSelection(input: string, max: number): number[] {
  const indices = new Set<number>();
  const parts = input.split(',').map(s => s.trim()).filter(Boolean);

  for (const part of parts) {
    const rangeMatch = part.match(/^(\d+)\s*-\s*(\d+)$/);
    if (rangeMatch) {
      const start = parseInt(rangeMatch[1], 10);
      const end = parseInt(rangeMatch[2], 10);
      for (let i = Math.min(start, end); i <= Math.max(start, end); i++) {
        if (i >= 1 && i <= max) {
          indices.add(i - 1); // 0-based
        }
      }
    } else {
      const n = parseInt(part, 10);
      if (!Number.isNaN(n) && n >= 1 && n <= max) {
        indices.add(n - 1); // 0-based
      }
    }
  }

  return [...indices].sort((a, b) => a - b);
}
