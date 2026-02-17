/**
 * Session report generator — produces a shareable Markdown summary
 * of a PromptWheel session that can be pasted into Slack, PRs, etc.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { getPromptwheelDir } from './solo-config.js';
import { computeCoverage } from './sectors.js';
import { formatElapsed } from './solo-auto-utils.js';
import { getQualityRate } from './run-state.js';
import type { SessionSummaryContext } from './solo-session-summary.js';
import type { TraceAnalysis } from '@promptwheel/core/trace/shared';

const _require = createRequire(import.meta.url);
const CLI_VERSION: string = _require('../../package.json').version;

export interface CompletedTicket {
  title: string;
  category: string;
  files: string[];
}

export interface SessionReportContext extends SessionSummaryContext {
  completedDirectTickets: CompletedTicket[];
  /** Trace analyses from ticket executions (one per ticket, if stream-json was available) */
  traceAnalyses?: TraceAnalysis[];
}

/**
 * Generate a Markdown session report from the session context.
 */
export function generateSessionReport(ctx: SessionReportContext): string {
  const elapsed = Date.now() - ctx.startTime;
  const startDate = new Date(ctx.startTime);
  const endDate = new Date();

  const dateStr = startDate.toISOString().slice(0, 10);
  const startTimeStr = startDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const endTimeStr = endDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  const mode = ctx.isContinuous ? 'Wheel' : 'Planning';
  const formula = ctx.activeFormula?.name ?? 'default';
  const scope = ctx.userScope ?? (ctx.isContinuous ? 'rotating' : 'all');

  const tickets = ctx.completedDirectTickets;
  const totalCompleted = tickets.length;
  const totalFiles = new Set(tickets.flatMap(t => t.files)).size;
  const qualityRate = getQualityRate(ctx.repoRoot);
  const qualityPct = Math.round(qualityRate * 100);

  const lines: string[] = [];

  lines.push('# PromptWheel Session Report');
  lines.push('');
  lines.push(`**Date:** ${dateStr} ${startTimeStr} — ${endTimeStr} (${formatElapsed(elapsed)})`);
  lines.push(`**Mode:** ${mode} | **Formula:** ${formula} | **Scope:** ${scope}`);
  lines.push('');

  // Results table
  lines.push('## Results');
  lines.push('');
  lines.push('| Metric | Value |');
  lines.push('|--------|-------|');
  lines.push(`| Cycles | ${ctx.cycleCount} |`);
  lines.push(`| Tickets completed | ${totalCompleted} |`);
  lines.push(`| Tickets failed | ${ctx.totalFailed} |`);
  lines.push(`| Files modified | ${totalFiles} |`);
  lines.push(`| PRs created | ${ctx.allPrUrls.length} |`);
  lines.push(`| Quality rate | ${qualityPct}% |`);
  lines.push('');

  // Ticket details
  if (tickets.length > 0) {
    lines.push('## Tickets');
    lines.push('');
    lines.push('| # | Category | Title | Files | Status |');
    lines.push('|---|----------|-------|-------|--------|');
    for (let i = 0; i < tickets.length; i++) {
      const t = tickets[i];
      lines.push(`| ${i + 1} | ${t.category} | ${t.title} | ${t.files.length} | ✓ |`);
    }
    lines.push('');
  }

  // PR links
  if (ctx.allPrUrls.length > 0) {
    lines.push('## Pull Requests');
    lines.push('');
    for (const url of ctx.allPrUrls) {
      lines.push(`- ${url}`);
    }
    lines.push('');
  }

  // Token usage (from trace analyses)
  if (ctx.traceAnalyses && ctx.traceAnalyses.length > 0) {
    const analyses = ctx.traceAnalyses.filter(a => a.is_stream_json);
    if (analyses.length > 0) {
      // Aggregate tool profiles across all tickets
      const toolAgg = new Map<string, { calls: number; input: number; output: number; errors: number }>();
      let totalInputAll = 0;
      let totalOutputAll = 0;
      let totalCost = 0;
      let compactionCount = 0;

      for (const a of analyses) {
        totalInputAll += a.total_input_tokens;
        totalOutputAll += a.total_output_tokens;
        totalCost += a.total_cost_usd ?? 0;
        compactionCount += a.compactions.length;
        for (const p of a.tool_profiles) {
          const agg = toolAgg.get(p.tool_name) ?? { calls: 0, input: 0, output: 0, errors: 0 };
          agg.calls += p.call_count;
          agg.input += p.total_input_tokens;
          agg.output += p.total_output_tokens;
          agg.errors += p.error_count;
          toolAgg.set(p.tool_name, agg);
        }
      }

      lines.push('## Token Usage');
      lines.push('');
      lines.push('| Tool | Calls | Input Tokens | Output Tokens | Errors |');
      lines.push('|------|-------|-------------|--------------|--------|');

      // Sort by total tokens descending
      const sorted = [...toolAgg.entries()].sort((a, b) =>
        (b[1].input + b[1].output) - (a[1].input + a[1].output)
      );
      for (const [name, agg] of sorted) {
        lines.push(`| ${name} | ${agg.calls} | ${agg.input.toLocaleString()} | ${agg.output.toLocaleString()} | ${agg.errors} |`);
      }

      const totalTokens = totalInputAll + totalOutputAll;
      const costStr = totalCost > 0 ? ` (~$${totalCost.toFixed(2)})` : '';
      lines.push(`\n**Total:** ${totalTokens.toLocaleString()} tokens${costStr}`);
      if (compactionCount > 0) {
        lines.push(`**Compactions:** ${compactionCount}`);
      }
      lines.push('');
    }
  }

  // Health
  lines.push('## Health');
  lines.push('');
  lines.push(`- Quality: ${qualityPct}%${totalCompleted > 0 ? ` (${totalCompleted - ctx.totalFailed}/${totalCompleted} first-pass)` : ''}`);
  if (ctx.sectorState) {
    const cov = computeCoverage(ctx.sectorState);
    lines.push(`- Sector coverage: ${cov.scannedSectors}/${cov.totalSectors} (${cov.percent}%)`);
  }
  lines.push(`- Learnings: ${ctx.allLearningsCount} accumulated`);
  lines.push('');

  // Footer
  lines.push('---');
  lines.push(`*Generated by [PromptWheel](https://github.com/promptwheel-ai/promptwheel) v${CLI_VERSION}*`);

  return lines.join('\n');
}

/**
 * Write a session report to `.promptwheel/reports/session-<ISO-date>.md`.
 * Returns the relative path to the report file.
 */
export function writeSessionReport(repoRoot: string, report: string): string {
  const reportsDir = path.join(getPromptwheelDir(repoRoot), 'reports');
  if (!fs.existsSync(reportsDir)) {
    fs.mkdirSync(reportsDir, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = `session-${timestamp}.md`;
  const filePath = path.join(reportsDir, filename);
  fs.writeFileSync(filePath, report, 'utf-8');

  return path.relative(repoRoot, filePath);
}
