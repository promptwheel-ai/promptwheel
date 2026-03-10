import { Command } from 'commander';
import * as path from 'node:path';
import chalk from 'chalk';
import { scoutRepo, type ScoutProgress } from '@promptwheel/core/services';
import {
  type ProposalCategory, detectScope, buildScanResult, toSarif, type ScanResult,
  appendScanHistory, getLastScan, diffScans, loadScanHistory, computeTrend,
  type ScanDiff,
  loadBaseline, saveBaseline, createBaseline, filterByBaseline, baselineSize,
  type Finding,
  appendFixAttempt, loadFixJournal, computeFixStats, buildFixContext, proposalToFinding,
  loadRules,
} from '@promptwheel/core/scout';
import { writeJsonArtifact } from '../lib/artifacts.js';
import {
  getPromptwheelDir,
  createScoutDeps,
  formatProgress,
} from '../lib/solo-config.js';
import {
  ensureInitializedOrExit,
  exitCommandError,
  resolveRepoRootOrExit,
  withCommandAdapter,
} from '../lib/command-runtime.js';

/** Legacy output format (kept for --legacy-format flag). */
interface ScoutOutput {
  success: boolean;
  project: string;
  scannedFiles: number;
  durationMs: number;
  proposals: Array<{
    title: string;
    category: string;
    description: string;
    files: string[];
    estimated_complexity: string;
    confidence: number;
    severity: string;
  }>;
  tickets: Array<{
    id: string;
    title: string;
    status: string;
  }>;
  errors: string[];
}

// ---------------------------------------------------------------------------
// Human-readable scan table
// ---------------------------------------------------------------------------

const SEVERITY_COLORS: Record<string, (s: string) => string> = {
  blocking: chalk.red,
  degrading: chalk.yellow,
  polish: chalk.gray,
  speculative: chalk.dim,
};

function formatScanTable(result: ScanResult, newFindingIds?: Set<string>): string {
  if (result.findings.length === 0) {
    return chalk.yellow('No findings.');
  }

  const lines: string[] = [];
  for (const f of result.findings) {
    const colorFn = SEVERITY_COLORS[f.severity] ?? chalk.white;
    const sev = colorFn(f.severity.toUpperCase().padEnd(11));
    const isNew = newFindingIds?.has(f.id);
    const newTag = isNew ? chalk.red(' ▲ NEW') : '';
    const title = f.title.slice(0, 55).padEnd(55);
    const file = chalk.gray((f.files[0] ?? '').slice(0, 30));
    const conf = chalk.cyan(`${f.confidence}%`);
    lines.push(` ${sev} ${title} ${file}  ${conf}${newTag}`);
  }
  return lines.join('\n');
}

function formatScanSummary(result: ScanResult): string {
  const parts: string[] = [];
  for (const [sev, count] of Object.entries(result.summary.by_severity)) {
    const colorFn = SEVERITY_COLORS[sev] ?? chalk.white;
    parts.push(colorFn(`${count} ${sev}`));
  }

  // Confidence bands — only show if findings span multiple bands
  let confLine = '';
  if (result.findings.length > 0) {
    const high = result.findings.filter(f => f.confidence > 80).length;
    const med = result.findings.filter(f => f.confidence >= 60 && f.confidence <= 80).length;
    const low = result.findings.filter(f => f.confidence < 60).length;
    const bands = [high > 0, med > 0, low > 0].filter(Boolean).length;
    if (bands > 1) {
      const bandParts: string[] = [];
      if (high > 0) bandParts.push(chalk.green(`${high} high (>80%)`));
      if (med > 0) bandParts.push(chalk.yellow(`${med} medium (60-80%)`));
      if (low > 0) bandParts.push(chalk.red(`${low} low (<60%)`));
      confLine = `\nConfidence: ${bandParts.join(', ')}`;
    }
  }

  return `${result.summary.total} findings: ${parts.join(', ')}${confLine}`;
}

export function registerInspectScoutCommand(solo: Command): void {
  // Register both 'scout' (legacy) and 'scan' (new primary)
  const scoutCmd = solo
    .command('scout [path]')
    .description('Scan a codebase for improvement opportunities')
    .option('-v, --verbose', 'Show detailed output')
    .option('-q, --quiet', 'Suppress non-essential output')
    .option('--json', 'Output as JSON (ScanResult format)')
    .option('--legacy-format', 'Use legacy JSON output format')
    .option('-s, --scope <pattern>', 'Glob pattern for files to scan (auto-detected if omitted)')
    .option('-t, --types <categories>', 'Comma-separated categories: refactor,docs,test,perf,security')
    .option('-m, --max <count>', 'Maximum proposals to generate', '10')
    .option('-c, --min-confidence <percent>', 'Minimum confidence threshold', '50')
    .option('--model <model>', 'Model to use: haiku, sonnet, opus', 'opus')
    .option('--auto-approve', 'Automatically create tickets for all proposals')
    .option('--dry-run', 'Show proposals without saving')
    .option('--max-files <count>', 'Maximum files to scan (default: 500)')
    .option('--fail-on <severity>', 'Exit with code 1 if findings at or above severity exist (blocking, degrading, polish)')
    .option('--fix [count]', 'Auto-approve top blocking/degrading findings as tickets (default: 3)')
    .option('--format <format>', 'Output format: json (default), sarif')
    .option('--diff', 'Show delta from last scan (new/fixed/changed findings)')
    .option('--history', 'Show scan trend over time')
    .option('--save-baseline', 'Save current findings as the accepted baseline')
    .option('--include-baseline', 'Show baselined (suppressed) findings too')
    .option('--fail-on-new <severity>', 'Exit 1 if NEW findings (not in baseline) at or above severity')
    .option('--stats', 'Show fix success rates alongside findings');

  // 'scan' is the primary user-facing alias
  solo.command('scan [path]')
    .description('Scan a codebase for issues — the primary entry point')
    .option('-v, --verbose', 'Show detailed output')
    .option('-q, --quiet', 'Suppress non-essential output')
    .option('--json', 'Output as JSON (ScanResult format)')
    .option('-s, --scope <pattern>', 'Glob pattern for files to scan (auto-detected if omitted)')
    .option('-t, --types <categories>', 'Comma-separated categories: refactor,docs,test,perf,security')
    .option('-m, --max <count>', 'Maximum proposals to generate', '10')
    .option('-c, --min-confidence <percent>', 'Minimum confidence threshold', '50')
    .option('--model <model>', 'Model to use: haiku, sonnet, opus', 'opus')
    .option('--dry-run', 'Show proposals without saving')
    .option('--max-files <count>', 'Maximum files to scan (default: 500)')
    .option('--fail-on <severity>', 'Exit with code 1 if findings at or above severity exist (blocking, degrading, polish)')
    .option('--fix [count]', 'Auto-approve top blocking/degrading findings as tickets (default: 3)')
    .option('--format <format>', 'Output format: json (default), sarif')
    .option('--diff', 'Show delta from last scan (new/fixed/changed findings)')
    .option('--history', 'Show scan trend over time')
    .option('--save-baseline', 'Save current findings as the accepted baseline')
    .option('--include-baseline', 'Show baselined (suppressed) findings too')
    .option('--fail-on-new <severity>', 'Exit 1 if NEW findings (not in baseline) at or above severity')
    .option('--stats', 'Show fix success rates alongside findings')
    .action(scoutAction);

  scoutCmd.action(scoutAction);
}

async function scoutAction(targetPath: string | undefined, options: {
  verbose?: boolean;
  quiet?: boolean;
  json?: boolean;
  legacyFormat?: boolean;
  scope?: string;
  types?: string;
  max?: string;
  minConfidence?: string;
  model?: string;
  autoApprove?: boolean;
  dryRun?: boolean;
  maxFiles?: string;
  failOn?: string;
  fix?: boolean | string;
  format?: string;
  diff?: boolean;
  history?: boolean;
  saveBaseline?: boolean;
  includeBaseline?: boolean;
  failOnNew?: string;
  stats?: boolean;
}): Promise<void> {
  const isSarifMode = options.format === 'sarif';
  const isJsonMode = options.json || isSarifMode;
  const isQuiet = options.quiet || isJsonMode;
  const fixMode = options.fix !== undefined && options.fix !== false;
  const fixCount = typeof options.fix === 'string' ? parseInt(options.fix, 10) : 3;

  if (!isQuiet) {
    console.log(chalk.blue('PromptWheel Scan'));
    console.log();
  }

  const repoRoot = await resolveRepoRootOrExit({
    cwd: '.',
    json: isJsonMode,
    notRepoHumanDetails: ['  Run this command from within a git repository'],
  });

  await ensureInitializedOrExit({
    repoRoot,
    json: isJsonMode,
    autoInit: true,
    quiet: isQuiet,
  });

  const pwDir = getPromptwheelDir(repoRoot);

  // --history: show trend and exit (no scan needed)
  if (options.history) {
    const entries = loadScanHistory(pwDir);
    if (entries.length === 0) {
      console.log(chalk.yellow('No scan history. Run `promptwheel scan` first.'));
      return;
    }
    const trend = computeTrend(entries);
    if (!trend) return;

    if (isJsonMode) {
      console.log(JSON.stringify(trend, null, 2));
      return;
    }

    console.log(chalk.blue(`Scan History — ${trend.total_scans} scans`));
    console.log(chalk.gray(`First: ${trend.first_scan}`));
    console.log(chalk.gray(`Last:  ${trend.last_scan}`));
    console.log();

    for (const c of trend.counts) {
      const date = c.scanned_at.slice(0, 19).replace('T', ' ');
      const sevParts: string[] = [];
      for (const [sev, n] of Object.entries(c.by_severity)) {
        const colorFn = SEVERITY_COLORS[sev] ?? chalk.white;
        sevParts.push(colorFn(`${n} ${sev}`));
      }
      console.log(`  ${chalk.gray(date)}  ${c.total} findings: ${sevParts.join(', ')}`);
    }

    console.log();
    const arrow = trend.net_change > 0 ? chalk.red(`+${trend.net_change}`) :
      trend.net_change < 0 ? chalk.green(`${trend.net_change}`) :
        chalk.gray('±0');
    console.log(`Net change: ${arrow} findings`);
    return;
  }

  const scope = targetPath ?? options.scope ?? detectScope(repoRoot);

  if (!isQuiet) {
    console.log(chalk.gray(`Project: ${path.basename(repoRoot)}`));
    console.log(chalk.gray(`Scope: ${scope}`));
    console.log();
  }

  await withCommandAdapter(repoRoot, async (adapter) => {
    const deps = createScoutDeps(adapter, options);
    const types = options.types?.split(',').map((value) => value.trim()) as ProposalCategory[] | undefined;
    const maxProposals = parseInt(options.max || '10', 10);
    const minConfidence = parseInt(options.minConfidence || '50', 10);
    const model = (options.model || 'opus') as 'haiku' | 'sonnet' | 'opus';
    const maxFiles = options.maxFiles ? parseInt(options.maxFiles, 10) : undefined;

    const controller = new AbortController();
    process.on('SIGINT', () => {
      if (!isQuiet) console.log(chalk.yellow('\n\nAborting scan...'));
      controller.abort();
    });

    // Load custom rules and fix context for prompt enrichment
    const { rules: customRules } = loadRules(pwDir);
    const fixJournal = loadFixJournal(pwDir);
    const fixCtx = buildFixContext(fixJournal);

    let lastProgress = '';
    const scoutOptions = {
      path: repoRoot,
      scope,
      types,
      maxProposals,
      minConfidence,
      model,
      signal: controller.signal,
      autoApprove: (options.autoApprove || fixMode) && !options.dryRun,
      onProgress: (progress: ScoutProgress) => {
        if (!isQuiet) {
          const formatted = formatProgress(progress);
          if (formatted !== lastProgress) {
            process.stdout.write(`\r${formatted.padEnd(80)}`);
            lastProgress = formatted;
          }
        }
      },
      ...(maxFiles !== undefined && { maxFiles }),
      ...(customRules.length > 0 && { customRules }),
      ...(fixCtx && { fixContext: fixCtx }),
    };
    const result = await scoutRepo(deps, scoutOptions);

    if (!isQuiet) {
      process.stdout.write('\r' + ' '.repeat(80) + '\r');
    }

    let proposalsArtifactPath: string | null = null;
    if (result.proposals.length > 0) {
      proposalsArtifactPath = writeJsonArtifact({
        baseDir: getPromptwheelDir(repoRoot),
        type: 'proposals',
        id: result.run.id,
        data: {
          runId: result.run.id,
          projectId: result.project.id,
          projectName: result.project.name,
          createdAt: new Date().toISOString(),
          proposals: result.proposals,
        },
      });
    }

    // --- JSON output ---
    if (isJsonMode) {
      if (options.legacyFormat) {
        const output: ScoutOutput = {
          success: result.success,
          project: path.basename(repoRoot),
          scannedFiles: result.scannedFiles,
          durationMs: result.durationMs,
          proposals: result.proposals.map((proposal) => ({
            title: proposal.title,
            category: proposal.category,
            description: proposal.description,
            files: proposal.files,
            estimated_complexity: proposal.estimated_complexity,
            confidence: proposal.confidence,
            severity: proposal.severity ?? 'polish',
          })),
          tickets: result.tickets.map((ticket) => ({
            id: ticket.id,
            title: ticket.title,
            status: ticket.status,
          })),
          errors: result.errors,
        };
        if (!result.success) {
          exitCommandError({
            json: true,
            message: result.errors[0] ?? 'Scout failed',
            jsonExtra: {
              project: output.project,
              scannedFiles: output.scannedFiles,
              durationMs: output.durationMs,
              proposals: output.proposals,
              tickets: output.tickets,
              errors: output.errors,
            },
          });
        }
        console.log(JSON.stringify(output, null, 2));
      } else {
        const fullScanResult = buildScanResult(result.proposals, {
          project: path.basename(repoRoot),
          scannedFiles: result.scannedFiles,
          durationMs: result.durationMs,
        });
        if (!result.success) {
          exitCommandError({
            json: true,
            message: result.errors[0] ?? 'Scout failed',
            jsonExtra: fullScanResult as unknown as Record<string, unknown>,
          });
        }

        // Persist FULL result to history (before baseline filtering)
        const previousScan = options.diff ? getLastScan(pwDir) : null;
        if (!options.dryRun) {
          appendScanHistory(pwDir, fullScanResult);
        }

        // Save baseline if requested
        if (options.saveBaseline && !options.dryRun) {
          const bl = createBaseline(fullScanResult.findings, 'initial baseline');
          saveBaseline(pwDir, bl);
        }

        // Apply baseline filtering for output
        const baseline = loadBaseline(pwDir);
        const { active, baselined } = filterByBaseline(fullScanResult.findings, baseline);
        const outputResult = options.includeBaseline ? fullScanResult : rebuildScanResult(fullScanResult, active);

        if (isSarifMode) {
          const sarifLog = toSarif(outputResult, '0.8.0');
          console.log(JSON.stringify(sarifLog, null, 2));
        } else if (options.diff && previousScan) {
          const diff = diffScans(previousScan.result, fullScanResult);
          console.log(JSON.stringify({ scan: outputResult, diff, baselined_count: baselined.length }, null, 2));
        } else {
          const out = baselined.length > 0
            ? { ...outputResult, baselined_count: baselined.length }
            : outputResult;
          console.log(JSON.stringify(out, null, 2));
        }

        applyFailOn(options.failOn, result.proposals);
        applyFailOnNew(options.failOnNew, active);
        return;
      }

      applyFailOn(options.failOn, result.proposals);
      return;
    }

    // --- Human output ---
    if (!result.success) {
      exitCommandError({
        message: 'Scout failed',
        humanDetails: result.errors.map((error) => `  ${error}`),
      });
    }

    const fullScanResult = buildScanResult(result.proposals, {
      project: path.basename(repoRoot),
      scannedFiles: result.scannedFiles,
      durationMs: result.durationMs,
    });

    // Load previous scan for diff and inline delta indicators
    const previousScan = getLastScan(pwDir);

    console.log(chalk.green(
      `Scanned ${result.scannedFiles} files in ${(result.durationMs / 1000).toFixed(1)}s`,
    ));
    console.log();

    // Persist FULL result to history (before baseline filtering)
    if (!options.dryRun) {
      appendScanHistory(pwDir, fullScanResult);
    }

    // Save baseline if requested
    if (options.saveBaseline && !options.dryRun) {
      const bl = createBaseline(fullScanResult.findings, 'initial baseline');
      saveBaseline(pwDir, bl);
      console.log(chalk.green(`Baseline saved: ${baselineSize(bl)} findings suppressed.`));
      console.log(chalk.gray('Future scans will only show new findings.'));
      console.log();
    }

    // Apply baseline filtering
    const baseline = loadBaseline(pwDir);
    const { active, baselined } = filterByBaseline(fullScanResult.findings, baseline);
    const displayFindings = options.includeBaseline ? fullScanResult.findings : active;
    const displayResult = options.includeBaseline ? fullScanResult : rebuildScanResult(fullScanResult, active);

    if (displayFindings.length === 0 && fullScanResult.findings.length > 0) {
      console.log(chalk.green('No new findings.'));
      console.log(chalk.gray(`${baselined.length} findings suppressed by baseline.`));
      console.log(chalk.gray(`Run with ${chalk.white('--include-baseline')} to see all.`));
      return;
    }

    if (displayFindings.length === 0) {
      console.log(chalk.yellow('No findings.'));
      console.log(chalk.gray('Try broadening your scope or lowering the confidence threshold.'));
      return;
    }

    // Build set of new finding IDs for inline delta markers
    let newFindingIds: Set<string> | undefined;
    if (previousScan) {
      const diff = diffScans(previousScan.result, fullScanResult);
      newFindingIds = new Set(diff.new.map(f => f.id));
    }

    console.log(formatScanTable(displayResult, newFindingIds));
    console.log();
    console.log(formatScanSummary(displayResult));

    if (baselined.length > 0 && !options.includeBaseline) {
      console.log(chalk.gray(`  (${baselined.length} baselined findings hidden)`));
    }

    // Show fix stats
    if (options.stats) {
      const journal = loadFixJournal(pwDir);
      if (journal.length > 0) {
        const stats = computeFixStats(journal, 'category');
        console.log();
        console.log(chalk.blue('Fix success rates:'));
        for (const [cat, s] of Object.entries(stats)) {
          const rate = Math.round(s.success_rate * 100);
          const color = rate >= 80 ? chalk.green : rate >= 50 ? chalk.yellow : chalk.red;
          console.log(`  ${cat.padEnd(12)} ${color(`${rate}%`)} (${s.successes}/${s.total_attempts})`);
        }
      }
    }

    // Show diff from last scan
    if (options.diff && previousScan) {
      const diff = diffScans(previousScan.result, fullScanResult);
      console.log();
      console.log(chalk.blue('Delta from last scan:'));
      console.log(formatDiffTable(diff));
    } else if (options.diff) {
      console.log();
      console.log(chalk.gray('No previous scan to compare against.'));
    }

    if (options.dryRun) {
      console.log(chalk.yellow('\n--dry-run: Not saved'));
      return;
    }

    // --fix: filter to blocking/degrading, create tickets, show run commands
    if (fixMode && result.tickets.length > 0) {
      const fixable = result.tickets.filter((_t, i) => {
        const sev = result.proposals[i]?.severity ?? 'polish';
        return sev === 'blocking' || sev === 'degrading';
      }).slice(0, fixCount);

      if (fixable.length > 0) {
        // Record fix attempts in the journal
        for (const ticket of fixable) {
          const proposal = result.proposals.find(p => p.title === ticket.title);
          if (proposal) {
            const finding = proposalToFinding(proposal);
            appendFixAttempt(pwDir, {
              finding_id: finding.id,
              ticket_id: ticket.id,
              title: ticket.title,
              category: proposal.category,
              severity: proposal.severity ?? 'polish',
              attempted_at: new Date().toISOString(),
            });
          }
        }

        console.log(chalk.green(`\n✓ Created ${fixable.length} tickets for auto-fix`));
        for (const ticket of fixable) {
          const proposal = result.proposals.find(p => p.title === ticket.title);
          const sevColor = SEVERITY_COLORS[proposal?.severity ?? 'polish'] ?? chalk.white;
          const sevLabel = sevColor(`[${proposal?.category ?? ''}/${proposal?.severity ?? 'polish'}]`);
          console.log(`  ${chalk.white(ticket.id)}  ${sevLabel}  ${ticket.title}`);
          if (proposal?.files?.length) {
            for (const f of proposal.files.slice(0, 3)) {
              console.log(`              ${chalk.gray(f)}`);
            }
          }
        }
        console.log();
        console.log(`Run ${chalk.cyan('promptwheel run <id>')} to fix individually, or ${chalk.cyan('promptwheel auto')} to fix all.`);
      } else {
        console.log(chalk.yellow('\nNo blocking or degrading findings to fix.'));
      }
    } else if (result.tickets.length > 0) {
      console.log(chalk.green(`\n✓ Created ${result.tickets.length} tickets`));
      console.log(chalk.gray(`  IDs: ${result.tickets.map((ticket) => ticket.id).join(', ')}`));
    } else if (result.proposals.length > 0) {
      console.log();
      console.log(chalk.gray(`Run ${chalk.white('promptwheel scan --json')} for machine-readable output.`));
      console.log(chalk.gray(`Run ${chalk.white('promptwheel scan --fix')} to auto-fix top findings.`));
      if (proposalsArtifactPath) {
        console.log(chalk.gray(`Proposals saved: ${proposalsArtifactPath}`));
      }
    }

    if (result.errors.length > 0) {
      console.log(chalk.yellow('\nWarnings:'));
      for (const error of result.errors) {
        console.log(chalk.yellow(`  ${error}`));
      }
    }

    applyFailOn(options.failOn, result.proposals);
    applyFailOnNew(options.failOnNew, active);
  });
}

/** Rebuild a ScanResult with a filtered set of findings. */
function rebuildScanResult(original: ScanResult, findings: Finding[]): ScanResult {
  const by_severity: Record<string, number> = {};
  const by_category: Record<string, number> = {};
  for (const f of findings) {
    by_severity[f.severity] = (by_severity[f.severity] ?? 0) + 1;
    by_category[f.category] = (by_category[f.category] ?? 0) + 1;
  }
  return {
    ...original,
    findings,
    summary: { total: findings.length, by_severity, by_category },
  };
}

function formatDiffTable(diff: ScanDiff): string {
  const lines: string[] = [];

  if (diff.new.length > 0) {
    lines.push(chalk.red(`  + ${diff.new.length} new`));
    for (const f of diff.new) {
      const colorFn = SEVERITY_COLORS[f.severity] ?? chalk.white;
      lines.push(`    ${chalk.red('+')} ${colorFn(f.severity.padEnd(11))} ${f.title.slice(0, 55)}`);
    }
  }

  if (diff.fixed.length > 0) {
    lines.push(chalk.green(`  - ${diff.fixed.length} fixed`));
    for (const f of diff.fixed) {
      lines.push(`    ${chalk.green('-')} ${chalk.strikethrough(f.title.slice(0, 55))}`);
    }
  }

  if (diff.severity_changed.length > 0) {
    lines.push(chalk.yellow(`  ~ ${diff.severity_changed.length} severity changed`));
    for (const { finding, previous_severity } of diff.severity_changed) {
      const prevColor = SEVERITY_COLORS[previous_severity] ?? chalk.white;
      const currColor = SEVERITY_COLORS[finding.severity] ?? chalk.white;
      lines.push(`    ${chalk.yellow('~')} ${finding.title.slice(0, 40)} ${prevColor(previous_severity)} → ${currColor(finding.severity)}`);
    }
  }

  if (diff.unchanged.length > 0) {
    lines.push(chalk.gray(`    ${diff.unchanged.length} unchanged`));
  }

  return lines.length > 0 ? lines.join('\n') : chalk.gray('  No changes.');
}

/** Like applyFailOn but only considers active (non-baselined) findings. */
function applyFailOnNew(failOnNew: string | undefined, activeFindings: Finding[]): void {
  if (!failOnNew) return;
  const severityOrder = ['speculative', 'polish', 'degrading', 'blocking'];
  const threshold = severityOrder.indexOf(failOnNew);
  if (threshold < 0) return;
  const hasAbove = activeFindings.some(f => {
    const idx = severityOrder.indexOf(f.severity);
    return idx >= threshold;
  });
  if (hasAbove) process.exitCode = 1;
}

function applyFailOn(failOn: string | undefined, proposals: Array<{ severity?: string }>): void {
  if (!failOn) return;
  const severityOrder = ['speculative', 'polish', 'degrading', 'blocking'];
  const threshold = severityOrder.indexOf(failOn);
  if (threshold < 0) return;
  const hasAbove = proposals.some(p => {
    const idx = severityOrder.indexOf(p.severity ?? 'polish');
    return idx >= threshold;
  });
  if (hasAbove) process.exitCode = 1;
}
