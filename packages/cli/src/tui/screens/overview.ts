/**
 * Overview screen - Default view showing project status
 */

import blessed from 'neo-blessed';
import type { Widgets } from 'neo-blessed';
import type { TuiSnapshot } from '../state.js';
import type { TuiScreen } from '../types.js';

export type OverviewScreenDeps = {
  onHint?: (msg: string) => void;
};

function fmtDuration(ms?: number | null): string {
  if (ms === null || ms === undefined) return '-';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

function fmtTimeAgo(date?: Date | null): string {
  if (!date) return '-';
  const d = Date.now() - date.getTime();
  if (d < 1000) return 'just now';
  if (d < 60_000) return `${Math.floor(d / 1000)}s ago`;
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`;
  return `${Math.floor(d / 86_400_000)}d ago`;
}

function statusBadge(status?: string | null): string {
  const s = (status ?? '').toLowerCase();
  if (s === 'success') return '{green-fg}success{/green-fg}';
  if (s === 'failure' || s === 'failed') return '{red-fg}failed{/red-fg}';
  if (s === 'running') return '{cyan-fg}running{/cyan-fg}';
  if (s === 'canceled' || s === 'aborted') return '{yellow-fg}canceled{/yellow-fg}';
  return '{gray-fg}-{/gray-fg}';
}

export function createOverviewScreen(deps: OverviewScreenDeps = {}): TuiScreen {
  let screen: Widgets.Screen | null = null;
  let root: Widgets.BoxElement | null = null;
  let header: Widgets.BoxElement | null = null;
  let left: Widgets.BoxElement | null = null;
  let right: Widgets.BoxElement | null = null;

  function mount(s: Widgets.Screen) {
    screen = s;

    root = blessed.box({
      parent: screen,
      top: 0,
      left: 0,
      width: '100%',
      height: '100%',
    });

    header = blessed.box({
      parent: root,
      top: 0,
      left: 0,
      height: 1,
      width: '100%',
      tags: true,
      content: '{bold}PromptWheel Solo{/bold}  {gray-fg}s{/gray-fg} scout  {gray-fg}q{/gray-fg} qa  {gray-fg}r{/gray-fg} refresh  {gray-fg}ctrl+c{/gray-fg} quit',
    });

    left = blessed.box({
      parent: root,
      top: 1,
      left: 0,
      width: '50%',
      height: '100%-2',
      border: { type: 'line' },
      label: ' Project ',
      tags: true,
      scrollable: true,
      alwaysScroll: true,
      padding: { left: 1, right: 1 },
    });

    right = blessed.box({
      parent: root,
      top: 1,
      left: '50%',
      width: '50%',
      height: '100%-2',
      border: { type: 'line' },
      label: ' Runs ',
      tags: true,
      scrollable: true,
      alwaysScroll: true,
      padding: { left: 1, right: 1 },
    });

    deps.onHint?.('Overview loaded');
  }

  function update(snapshot: TuiSnapshot) {
    if (!left || !right) return;

    const p = snapshot.project;
    const t = snapshot.tickets;

    // Left pane: Project + Tickets
    const projectLines: string[] = [];
    if (!p) {
      projectLines.push('{red-fg}No project found{/red-fg}');
      projectLines.push('');
      projectLines.push('Run: {bold}promptwheel solo init{/bold}');
      projectLines.push('Then: {bold}promptwheel solo scout .{/bold}');
    } else {
      projectLines.push(`{bold}${p.name}{/bold}`);
      projectLines.push(`{gray-fg}${p.repoRoot}{/gray-fg}`);
      projectLines.push('');
      projectLines.push('{bold}Tickets{/bold}');
      projectLines.push(`  {green-fg}ready:{/green-fg}       ${t.ready}`);
      projectLines.push(`  {yellow-fg}in_progress:{/yellow-fg} ${t.in_progress}`);
      projectLines.push(`  {cyan-fg}in_review:{/cyan-fg}   ${t.in_review}`);
      projectLines.push(`  {blue-fg}done:{/blue-fg}        ${t.done}`);
      projectLines.push(`  {gray-fg}backlog:{/gray-fg}     ${t.backlog}`);
      projectLines.push(`  {red-fg}blocked:{/red-fg}     ${t.blocked}`);
    }
    left.setContent(projectLines.join('\n'));

    // Right pane: Runs
    const runsLines: string[] = [];

    runsLines.push(`Active runs: {bold}${snapshot.runs.activeCount}{/bold}`);
    if (snapshot.runs.runningStep) {
      runsLines.push(`Running step: {cyan-fg}${snapshot.runs.runningStep.name}{/cyan-fg}`);
    }
    runsLines.push('');

    // Scout summary
    const scout = snapshot.runs.lastScout;
    runsLines.push('{bold}Last Scout{/bold}');
    if (!scout) {
      runsLines.push('  {gray-fg}No scout runs yet{/gray-fg}');
      runsLines.push('  Press [s] to run scout');
    } else {
      runsLines.push(`  ${statusBadge(scout.status)} | ${fmtTimeAgo(scout.completedAt)}`);
      const details: string[] = [];
      if (scout.scannedFiles) details.push(`${scout.scannedFiles} files`);
      if (scout.proposalCount) details.push(`${scout.proposalCount} proposals`);
      if (scout.ticketCount) details.push(`${scout.ticketCount} tickets`);
      if (details.length) runsLines.push(`  ${details.join(', ')}`);
      runsLines.push(`  Duration: ${fmtDuration(scout.durationMs)}`);
    }
    runsLines.push('');

    // QA summary
    const qa = snapshot.runs.lastQa;
    const qaSummary = snapshot.runs.lastQaStepsSummary;
    runsLines.push('{bold}Last QA{/bold}');
    if (!qa) {
      runsLines.push('  {gray-fg}No QA runs yet{/gray-fg}');
      runsLines.push('  Press [q] to run QA');
    } else {
      runsLines.push(`  ${statusBadge(qa.status)} | ${fmtTimeAgo(qa.completedAt)}`);

      if (qaSummary) {
        const c = qaSummary.counts;
        runsLines.push(`  {green-fg}${c.passed} passed{/green-fg}, {red-fg}${c.failed} failed{/red-fg}, ${c.active} active`);
        if (qaSummary.firstFailedStep) {
          runsLines.push(`  Failed at: {red-fg}${qaSummary.firstFailedStep}{/red-fg}`);
        }
      } else {
        runsLines.push(`  {green-fg}${qa.stepsPassed} passed{/green-fg}, {red-fg}${qa.stepsFailed} failed{/red-fg}`);
      }
      runsLines.push(`  Duration: ${fmtDuration(qa.durationMs)}`);
    }

    right.setContent(runsLines.join('\n'));
  }

  function focus() {
    left?.focus();
  }

  function destroy() {
    root?.destroy();
    root = null;
    header = null;
    left = null;
    right = null;
    screen = null;
  }

  return {
    name: 'overview',
    mount,
    update,
    destroy,
    focus,
  };
}
