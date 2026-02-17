/**
 * Solo inspect commands: scout, status, history, formulas, export, artifacts, approve
 */

import { Command } from 'commander';
import * as path from 'node:path';
import * as fs from 'node:fs';
import chalk from 'chalk';
import {
  scoutRepo,
  approveProposals,
  type ScoutProgress,
} from '@promptwheel/core/services';
import { projects, tickets, runs } from '@promptwheel/core/repos';
import type { ProposalCategory } from '@promptwheel/core/scout';
import { createGitService } from '../lib/git.js';
import {
  writeJsonArtifact,
  getLatestArtifact,
  getAllArtifacts,
  getArtifactsForRun,
  getArtifactByRunId,
  type ArtifactType,
} from '../lib/artifacts.js';
import { parseSelection } from '../lib/selection.js';
import {
  getPromptwheelDir,
  getDbPath,
  isInitialized,
  initSolo,
  getAdapter,
  createScoutDeps,
  formatProgress,
  displayProposal,
} from '../lib/solo-config.js';
import {
  formatDuration,
  formatRelativeTime,
  type StatusOutput,
  type ProposalsArtifact,
} from '../lib/solo-utils.js';

/**
 * Scout output for JSON mode
 */
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
  }>;
  tickets: Array<{
    id: string;
    title: string;
    status: string;
  }>;
  errors: string[];
}

export function registerInspectCommands(solo: Command): void {
  /**
   * solo scout - Scan codebase and create tickets
   */
  solo
    .command('scout [path]')
    .description('Scan a codebase and create improvement tickets')
    .option('-v, --verbose', 'Show detailed output')
    .option('-q, --quiet', 'Suppress non-essential output')
    .option('--json', 'Output as JSON')
    .option('-s, --scope <pattern>', 'Glob pattern for files to scan', 'src/**')
    .option('-t, --types <categories>', 'Comma-separated categories: refactor,docs,test,perf,security')
    .option('-m, --max <count>', 'Maximum proposals to generate', '10')
    .option('-c, --min-confidence <percent>', 'Minimum confidence threshold', '50')
    .option('--model <model>', 'Model to use: haiku, sonnet, opus', 'opus')
    .option('--auto-approve', 'Automatically create tickets for all proposals')
    .option('--dry-run', 'Show proposals without saving')
    .option('--max-files <count>', 'Maximum files to scan (default: 500)')
    .action(async (targetPath: string | undefined, options: {
      verbose?: boolean;
      quiet?: boolean;
      json?: boolean;
      scope?: string;
      types?: string;
      max?: string;
      minConfidence?: string;
      model?: string;
      autoApprove?: boolean;
      dryRun?: boolean;
      maxFiles?: string;
    }) => {
      const isJsonMode = options.json;
      const isQuiet = options.quiet || isJsonMode;

      const scope = targetPath ?? options.scope ?? 'src/**';

      if (!isQuiet) {
        console.log(chalk.blue('🔍 PromptWheel Solo Scout'));
        console.log();
      }

      const git = createGitService();
      const repoRoot = await git.findRepoRoot('.');

      if (!repoRoot) {
        if (isJsonMode) {
          console.log(JSON.stringify({ success: false, error: 'Not a git repository' }));
        } else {
          console.error(chalk.red('✗ Not a git repository'));
          console.error('  Run this command from within a git repository');
        }
        process.exit(1);
      }

      if (!isInitialized(repoRoot)) {
        if (!isQuiet) {
          console.log(chalk.gray('Initializing local state...'));
        }
        await initSolo(repoRoot);
      }

      if (!isQuiet) {
        console.log(chalk.gray(`Project: ${path.basename(repoRoot)}`));
        console.log(chalk.gray(`Scope: ${scope}`));
        console.log();
      }

      const adapter = await getAdapter(repoRoot);
      const deps = createScoutDeps(adapter, options);

      try {
        const types = options.types?.split(',').map(t => t.trim()) as ProposalCategory[] | undefined;
        const maxProposals = parseInt(options.max || '10', 10);
        const minConfidence = parseInt(options.minConfidence || '50', 10);
        const model = (options.model || 'opus') as 'haiku' | 'sonnet' | 'opus';
        const maxFiles = options.maxFiles ? parseInt(options.maxFiles, 10) : undefined;

        const controller = new AbortController();
        process.on('SIGINT', () => {
          if (!isQuiet) {
            console.log(chalk.yellow('\n\nAborting scan...'));
          }
          controller.abort();
        });

        let lastProgress = '';
        const scoutOptions = {
          path: repoRoot,
          scope,
          types,
          maxProposals,
          minConfidence,
          model,
          signal: controller.signal,
          autoApprove: options.autoApprove && !options.dryRun,
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

        if (isJsonMode) {
          const output: ScoutOutput = {
            success: result.success,
            project: path.basename(repoRoot),
            scannedFiles: result.scannedFiles,
            durationMs: result.durationMs,
            proposals: result.proposals.map(p => ({
              title: p.title,
              category: p.category,
              description: p.description,
              files: p.files,
              estimated_complexity: p.estimated_complexity,
              confidence: p.confidence,
            })),
            tickets: result.tickets.map(t => ({
              id: t.id,
              title: t.title,
              status: t.status,
            })),
            errors: result.errors,
          };
          console.log(JSON.stringify(output, null, 2));
          return;
        }

        if (!result.success) {
          console.error(chalk.red('✗ Scout failed'));
          for (const error of result.errors) {
            console.error(chalk.red(`  ${error}`));
          }
          process.exit(1);
        }

        console.log(chalk.green(
          `✓ Scanned ${result.scannedFiles} files in ` +
          `${(result.durationMs / 1000).toFixed(1)}s`
        ));

        if (result.proposals.length === 0) {
          console.log(chalk.yellow('\nNo improvement opportunities found.'));
          console.log(chalk.gray('Try broadening your scope or lowering the confidence threshold.'));
          return;
        }

        console.log(chalk.blue(`\nFound ${result.proposals.length} proposals:`));

        for (let i = 0; i < result.proposals.length; i++) {
          displayProposal(result.proposals[i], i);
        }

        if (options.dryRun) {
          console.log(chalk.yellow('\n--dry-run: Proposals not saved'));
          return;
        }

        if (result.tickets.length > 0) {
          console.log(chalk.green(`\n✓ Created ${result.tickets.length} tickets`));
          console.log(chalk.gray(`  IDs: ${result.tickets.map(t => t.id).join(', ')}`));
        } else if (!options.autoApprove && result.proposals.length > 0) {
          console.log(chalk.blue('\nNext steps:'));
          console.log('  promptwheel solo approve 1-3     # Approve proposals 1-3');
          console.log('  promptwheel solo approve all     # Approve all proposals');
          if (proposalsArtifactPath) {
            console.log(chalk.gray(`\n  Proposals saved: ${proposalsArtifactPath}`));
          }
        }

        if (result.errors.length > 0) {
          console.log(chalk.yellow('\nWarnings:'));
          for (const error of result.errors) {
            console.log(chalk.yellow(`  ${error}`));
          }
        }

      } finally {
        await adapter.close();
      }
    });

  /**
   * solo status - Show current state
   */
  solo
    .command('status')
    .description('Show local state and active tickets')
    .option('-v, --verbose', 'Show detailed output')
    .option('--json', 'Output as JSON')
    .action(async (options: { verbose?: boolean; json?: boolean }) => {
      const git = createGitService();
      const repoRoot = await git.findRepoRoot(process.cwd());

      if (!repoRoot) {
        if (options.json) {
          console.log(JSON.stringify({ error: 'Not a git repository' }));
        } else {
          console.error(chalk.red('✗ Not a git repository'));
        }
        process.exit(1);
      }

      const dbPath = getDbPath(repoRoot);
      const adapter = await getAdapter(repoRoot);

      try {
        const projectList = await projects.list(adapter);

        if (options.json) {
          const output: StatusOutput = {
            dbPath,
            projects: [],
          };

          for (const project of projectList) {
            const counts = await tickets.countByStatus(adapter, project.id);
            const summary = await runs.getSummary(adapter, project.id);

            let lastExecuteCompletionOutcome: string | null = null;
            if (summary.lastExecute?.id) {
              const fullRun = await runs.getById(adapter, summary.lastExecute.id);
              if (fullRun?.metadata?.completionOutcome) {
                lastExecuteCompletionOutcome = fullRun.metadata.completionOutcome as string;
              }
            }

            output.projects.push({
              id: project.id,
              name: project.name,
              ticketCounts: counts,
              lastScout: summary.lastScout ? {
                ...summary.lastScout,
                completedAt: summary.lastScout.completedAt?.toISOString() ?? null,
              } : null,
              lastQa: summary.lastQa ? {
                ...summary.lastQa,
                completedAt: summary.lastQa.completedAt?.toISOString() ?? null,
              } : null,
              lastExecute: summary.lastExecute ? {
                ...summary.lastExecute,
                completedAt: summary.lastExecute.completedAt?.toISOString() ?? null,
                completionOutcome: lastExecuteCompletionOutcome,
              } : null,
              activeRuns: summary.activeRuns,
            });
          }

          // Add wheel data to JSON output
          try {
            const { readRunState: readRS, getQualityRate: getQR } = await import('../lib/run-state.js');
            const { loadQaStats: loadQS } = await import('../lib/qa-stats.js');
            const { loadLearnings: loadL } = await import('../lib/learnings.js');
            const rs = readRS(repoRoot);
            const qaS = loadQS(repoRoot);
            const allL = loadL(repoRoot, 0);
            (output as any).wheel = {
              qualityRate: getQR(repoRoot),
              qualitySignals: rs.qualitySignals ?? null,
              disabledCommands: qaS.disabledCommands,
              processInsights: allL.filter(l => l.source.type === 'process_insight').length,
              qaCommands: Object.fromEntries(
                Object.entries(qaS.commands).map(([k, v]) => [k, {
                  successRate: v.totalRuns > 0 ? v.successes / v.totalRuns : -1,
                  avgDurationMs: v.avgDurationMs,
                  totalRuns: v.totalRuns,
                }]),
              ),
            };
          } catch {
            // Non-fatal
          }

          console.log(JSON.stringify(output, null, 2));
          return;
        }

        console.log(chalk.blue('📊 PromptWheel Solo Status'));
        console.log();
        console.log(chalk.gray(`Database: ${dbPath}`));
        console.log();

        console.log(`Projects: ${projectList.length}`);

        if (projectList.length === 0) {
          console.log(chalk.yellow('\nNo projects found. Run: promptwheel solo scout .'));
          return;
        }

        for (const project of projectList) {
          console.log();
          console.log(chalk.bold(project.name));

          const summary = await runs.getSummary(adapter, project.id);

          if (summary.lastScout) {
            const scout = summary.lastScout;
            const statusColor = scout.status === 'success' ? chalk.green :
                               scout.status === 'failure' ? chalk.red : chalk.yellow;
            const timeAgo = scout.completedAt ? formatRelativeTime(scout.completedAt) : 'running';

            console.log();
            console.log(`  ${chalk.cyan('Last Scout:')}`);
            console.log(`    ${statusColor(scout.status)} | ${timeAgo}`);
            console.log(`    ${scout.scannedFiles} files scanned, ${scout.proposalCount} proposals, ${scout.ticketCount} tickets`);
            if (scout.durationMs > 0) {
              console.log(`    Duration: ${formatDuration(scout.durationMs)}`);
            }
          }

          if (summary.lastQa) {
            const qa = summary.lastQa;
            const statusColor = qa.status === 'success' ? chalk.green :
                               qa.status === 'failure' ? chalk.red : chalk.yellow;
            const timeAgo = qa.completedAt ? formatRelativeTime(qa.completedAt) : 'running';
            const passFailText = `${qa.stepsPassed} passed, ${qa.stepsFailed} failed`;

            console.log();
            console.log(`  ${chalk.cyan('Last QA:')}`);
            console.log(`    ${statusColor(qa.status)} | ${timeAgo}`);
            console.log(`    ${passFailText}`);
            if (qa.durationMs > 0) {
              console.log(`    Duration: ${formatDuration(qa.durationMs)}`);
            }
          }

          if (summary.lastExecute) {
            const exec = summary.lastExecute;
            const baseDir = getPromptwheelDir(repoRoot);

            let spindleInfo: { reason?: string; artifactPath?: string } | null = null;
            if (exec.status === 'failure' && exec.id) {
              const spindleArtifact = getArtifactByRunId(baseDir, exec.id, 'spindle');
              if (spindleArtifact) {
                const data = spindleArtifact.data as { reason?: string };
                spindleInfo = {
                  reason: data.reason,
                  artifactPath: spindleArtifact.path,
                };
              }
            }

            let completionOutcome: string | null = null;
            if (exec.status === 'success' && exec.id) {
              const fullRun = await runs.getById(adapter, exec.id);
              if (fullRun?.metadata?.completionOutcome) {
                completionOutcome = fullRun.metadata.completionOutcome as string;
              }
            }

            const isNoChangesNeeded = completionOutcome === 'no_changes_needed';
            const isSpindleFailure = exec.status === 'failure' && spindleInfo?.reason;
            const statusColor = exec.status === 'success' ? chalk.green :
                               isSpindleFailure ? chalk.yellow :
                               exec.status === 'failure' ? chalk.red : chalk.yellow;
            const timeAgo = exec.completedAt ? formatRelativeTime(exec.completedAt) : 'running';

            console.log();
            console.log(`  ${chalk.cyan('Last Execute:')}`);
            if (isSpindleFailure) {
              console.log(`    ${statusColor('failed')} (Spindle: ${spindleInfo!.reason}) | ${timeAgo}`);
              console.log(chalk.gray(`    See artifacts: ${spindleInfo!.artifactPath}`));
            } else if (isNoChangesNeeded) {
              console.log(`    ${statusColor('success')} (no changes needed) | ${timeAgo}`);
            } else {
              console.log(`    ${statusColor(exec.status)} | ${timeAgo}`);
            }
            if (exec.ticketId) {
              console.log(`    Ticket: ${exec.ticketId}`);
            }
            if (exec.branchName) {
              console.log(`    Branch: ${exec.branchName}`);
            }
            if (exec.prUrl) {
              console.log(`    PR: ${chalk.cyan(exec.prUrl)}`);
            }
            if (exec.durationMs > 0) {
              console.log(`    Duration: ${formatDuration(exec.durationMs)}`);
            }
          }

          const counts = await tickets.countByStatus(adapter, project.id);
          const total = Object.values(counts).reduce((a, b) => a + b, 0);

          console.log();
          console.log(`  ${chalk.cyan('Tickets:')}`);
          if (total === 0) {
            console.log(chalk.gray('    No tickets'));
          } else {
            for (const [status, count] of Object.entries(counts)) {
              if (count === 0) continue;
              const color = status === 'done' ? chalk.green :
                           status === 'blocked' || status === 'aborted' ? chalk.red :
                           status === 'in_progress' || status === 'leased' ? chalk.yellow :
                           chalk.gray;
              console.log(`    ${color(status)}: ${count}`);
            }
          }

          if (summary.activeRuns > 0) {
            console.log(`    ${chalk.cyan('active runs')}: ${summary.activeRuns}`);
          }
        }

        // Wheel health section
        try {
          const { readRunState, getQualityRate } = await import('../lib/run-state.js');
          const { loadQaStats } = await import('../lib/qa-stats.js');
          const { loadLearnings } = await import('../lib/learnings.js');

          const rs = readRunState(repoRoot);
          const qualityRate = getQualityRate(repoRoot);
          const qaStats = loadQaStats(repoRoot);
          const allLearnings = loadLearnings(repoRoot, 0);

          const qs = rs.qualitySignals;
          const qualityPct = Math.round(qualityRate * 100);
          const processInsights = allLearnings.filter(l => l.source.type === 'process_insight');
          const originalConf = 20;
          const confDelta = (rs as any).effectiveMinConfidence !== undefined
            ? (rs as any).effectiveMinConfidence - originalConf : 0;

          console.log();
          console.log(`  ${chalk.cyan('Wheel:')}`);
          if (qs && qs.totalTickets > 0) {
            const qaStr = (qs.qaPassed + qs.qaFailed) > 0
              ? `${qs.qaPassed}/${qs.qaPassed + qs.qaFailed}`
              : 'untested';
            console.log(`    Quality rate: ${qualityPct}%    (first-pass: ${qs.firstPassSuccess}/${qs.totalTickets}, QA: ${qaStr})`);
          } else {
            console.log(chalk.gray('    Quality rate: 100% (no data)'));
          }
          console.log(`    Confidence: ${originalConf + confDelta}       (original: ${originalConf}${confDelta !== 0 ? `, delta: ${confDelta > 0 ? '+' : ''}${confDelta}` : ''})`);
          if (qaStats.disabledCommands.length > 0) {
            console.log(`    Disabled commands:    ${qaStats.disabledCommands.map(d => d.name).join(', ')}`);
          } else {
            console.log('    Disabled commands:    none');
          }
          console.log(`    Meta-learnings:       ${processInsights.length} process insights`);

          const cmdEntries = Object.values(qaStats.commands);
          if (cmdEntries.length > 0) {
            console.log('    QA command stats:');
            for (const s of cmdEntries) {
              const rate = s.totalRuns > 0 ? Math.round(s.successes / s.totalRuns * 100) : null;
              const rateStr = rate !== null ? `${rate}% success` : 'no data';
              const avgStr = s.totalRuns > 0
                ? (s.avgDurationMs >= 1000 ? `avg ${(s.avgDurationMs / 1000).toFixed(1)}s` : `avg ${s.avgDurationMs}ms`)
                : '';
              console.log(`      ${s.name}:  ${rateStr}${avgStr ? `, ${avgStr}` : ''}  (${s.totalRuns} runs)`);
            }
          }

          if (options.json) {
            // Wheel section for JSON mode is handled via output.wheel below
          }
        } catch {
          // Non-fatal — wheel data may not exist yet
        }

      } finally {
        await adapter.close();
      }
    });

  /**
   * solo history - View auto run history
   */
  solo
    .command('history')
    .description('View auto run history')
    .option('-n, --limit <n>', 'Number of entries to show', '10')
    .option('--json', 'Output as JSON')
    .action(async (options: { limit?: string; json?: boolean }) => {
      const { readRunHistory, formatHistoryEntry } = await import('../lib/run-history.js');
      const git = createGitService();
      const repoRoot = await git.findRepoRoot(process.cwd());

      const entries = readRunHistory(repoRoot || undefined, parseInt(options.limit || '10', 10));

      if (entries.length === 0) {
        console.log(chalk.gray('No history yet. Run `promptwheel solo auto` to get started.'));
        return;
      }

      if (options.json) {
        console.log(JSON.stringify(entries, null, 2));
        return;
      }

      console.log(chalk.bold(`Run History (${entries.length} entries):\n`));
      for (const entry of entries) {
        console.log(formatHistoryEntry(entry));
        console.log();
      }
    });

  /**
   * solo formulas - List available formulas
   */
  solo
    .command('formulas')
    .description('List available auto formulas')
    .action(async () => {
      const { listFormulas } = await import('../lib/formulas.js');
      const git = createGitService();
      const repoRoot = await git.findRepoRoot(process.cwd());
      const formulas = listFormulas(repoRoot || undefined);

      if (formulas.length === 0) {
        console.log(chalk.gray('No formulas available'));
        return;
      }

      console.log(chalk.bold('Available formulas:\n'));
      for (const formula of formulas) {
        const tags = formula.tags?.length ? chalk.gray(` [${formula.tags.join(', ')}]`) : '';
        console.log(`  ${chalk.cyan(formula.name)}${tags}`);
        console.log(`    ${formula.description}`);
        if (formula.categories?.length) {
          console.log(chalk.gray(`    Categories: ${formula.categories.join(', ')}`));
        }
        if (formula.minConfidence) {
          console.log(chalk.gray(`    Min confidence: ${formula.minConfidence}%`));
        }
        console.log();
      }

      console.log(chalk.gray('Usage: promptwheel solo auto --formula <name>'));
      console.log(chalk.gray('Custom: Create .promptwheel/formulas/<name>.yaml'));
    });

  /**
   * solo export - Export state for debugging
   */
  solo
    .command('export')
    .description('Export local state for debugging or migration')
    .option('-o, --output <file>', 'Output file', 'promptwheel-export.json')
    .action(async (options: { output: string }) => {
      const git = createGitService();
      const repoRoot = await git.findRepoRoot(process.cwd());

      if (!repoRoot) {
        console.error(chalk.red('✗ Not a git repository'));
        process.exit(1);
      }

      const adapter = await getAdapter(repoRoot);

      try {
        const projectList = await projects.list(adapter);

        const data: Record<string, unknown> = {
          exportedAt: new Date().toISOString(),
          version: 1,
          projects: [],
        };

        for (const project of projectList) {
          const projectTickets = await tickets.listByProject(adapter, project.id);
          const projectRuns = await runs.listByProject(adapter, project.id);

          (data.projects as unknown[]).push({
            ...project,
            tickets: projectTickets,
            runs: projectRuns,
          });
        }

        fs.writeFileSync(options.output, JSON.stringify(data, null, 2));
        console.log(chalk.green(`✓ Exported to ${options.output}`));

      } finally {
        await adapter.close();
      }
    });

  /**
   * solo artifacts - List and view run artifacts
   */
  solo
    .command('artifacts')
    .description('List and view run artifacts')
    .option('--run <runId>', 'Show artifacts for a specific run')
    .option('--type <type>', 'Filter by artifact type (proposals, executions, diffs, runs, violations)')
    .option('--show <path>', 'Display contents of a specific artifact file')
    .option('--json', 'Output in JSON format')
    .action(async (options: {
      run?: string;
      type?: string;
      show?: string;
      json?: boolean;
    }) => {
      const repoRoot = process.cwd();
      const baseDir = getPromptwheelDir(repoRoot);
      const artifactsDir = path.join(baseDir, 'artifacts');

      if (options.show) {
        const filePath = options.show.startsWith('/') ? options.show : path.join(process.cwd(), options.show);
        if (!fs.existsSync(filePath)) {
          console.error(chalk.red(`Artifact not found: ${filePath}`));
          process.exit(1);
        }
        const content = fs.readFileSync(filePath, 'utf-8');
        if (options.json) {
          console.log(content);
        } else {
          console.log(chalk.cyan(`\n─── ${path.basename(filePath)} ───\n`));
          try {
            const data = JSON.parse(content);
            console.log(JSON.stringify(data, null, 2));
          } catch {
            console.log(content);
          }
        }
        return;
      }

      if (options.run) {
        const artifacts = getArtifactsForRun(baseDir, options.run);
        const found = Object.entries(artifacts).filter(([, v]) => v !== null);

        if (options.json) {
          console.log(JSON.stringify({
            runId: options.run,
            artifacts: Object.fromEntries(
              found.map(([type, artifact]) => [type, artifact?.path])
            ),
          }, null, 2));
          return;
        }

        if (found.length === 0) {
          console.log(chalk.yellow(`No artifacts found for run: ${options.run}`));
          return;
        }

        console.log(chalk.cyan(`\nArtifacts for run ${options.run}:\n`));
        for (const [type, artifact] of found) {
          if (artifact) {
            console.log(`  ${chalk.bold(type)}: ${artifact.path}`);
          }
        }
        console.log();
        return;
      }

      if (!fs.existsSync(artifactsDir)) {
        console.log(chalk.yellow('No artifacts found. Run a ticket to generate artifacts.'));
        return;
      }

      const allArtifacts = getAllArtifacts(baseDir);
      const types: ArtifactType[] = options.type
        ? [options.type as ArtifactType]
        : ['runs', 'executions', 'diffs', 'violations', 'proposals', 'spindle'];

      if (options.json) {
        const output: Record<string, Array<{ id: string; path: string; timestamp: number }>> = {};
        for (const type of types) {
          output[type] = allArtifacts[type] ?? [];
        }
        console.log(JSON.stringify(output, null, 2));
        return;
      }

      let totalCount = 0;
      for (const type of types) {
        const artifacts = allArtifacts[type] ?? [];
        if (artifacts.length === 0) continue;

        console.log(chalk.cyan(`\n${type.toUpperCase()} (${artifacts.length}):`));
        for (const artifact of artifacts.slice(0, 10)) {
          const date = new Date(artifact.timestamp).toISOString().slice(0, 19).replace('T', ' ');
          console.log(`  ${chalk.gray(date)}  ${artifact.id}`);
          console.log(`    ${chalk.dim(artifact.path)}`);
          totalCount++;
        }
        if (artifacts.length > 10) {
          console.log(chalk.dim(`    ... and ${artifacts.length - 10} more`));
        }
      }

      if (totalCount === 0) {
        console.log(chalk.yellow('No artifacts found. Run a ticket to generate artifacts.'));
      } else {
        console.log(chalk.dim(`\nUse --show <path> to view an artifact, or --run <id> to see all artifacts for a run.\n`));
      }
    });

  /**
   * solo approve - Convert proposals to tickets
   */
  solo
    .command('approve <selection>')
    .description('Approve proposals and create tickets')
    .addHelpText('after', `
Selection formats:
  1         Single proposal (1-indexed)
  1,3,5     Multiple specific proposals
  1-3       Range of proposals
  1-3,5,7   Mixed selection
  all       All proposals

Examples:
  promptwheel solo approve 1       # Approve first proposal
  promptwheel solo approve 1-3     # Approve proposals 1, 2, 3
  promptwheel solo approve all     # Approve all proposals
`)
    .option('-v, --verbose', 'Show detailed output')
    .option('--json', 'Output as JSON')
    .action(async (selection: string, options: { verbose?: boolean; json?: boolean }) => {
      const isJsonMode = options.json;

      const git = createGitService();
      const repoRoot = await git.findRepoRoot(process.cwd());

      if (!repoRoot) {
        if (isJsonMode) {
          console.log(JSON.stringify({ success: false, error: 'Not a git repository' }));
        } else {
          console.error(chalk.red('✗ Not a git repository'));
        }
        process.exit(1);
      }

      const baseDir = getPromptwheelDir(repoRoot);
      const artifact = getLatestArtifact<ProposalsArtifact>(baseDir, 'proposals');

      if (!artifact) {
        if (isJsonMode) {
          console.log(JSON.stringify({
            success: false,
            error: 'No proposals found. Run: promptwheel solo scout .',
          }));
        } else {
          console.error(chalk.red('✗ No proposals found'));
          console.log(chalk.gray('  Run: promptwheel solo scout .'));
        }
        process.exit(1);
      }

      const { proposals } = artifact.data;

      if (proposals.length === 0) {
        if (isJsonMode) {
          console.log(JSON.stringify({ success: false, error: 'No proposals in artifact' }));
        } else {
          console.error(chalk.red('✗ No proposals in artifact'));
        }
        process.exit(1);
      }

      let selectedIndices: number[];
      try {
        selectedIndices = parseSelection(selection, proposals.length);
      } catch (err) {
        if (isJsonMode) {
          console.log(JSON.stringify({
            success: false,
            error: err instanceof Error ? err.message : String(err),
          }));
        } else {
          console.error(chalk.red(`✗ Invalid selection: ${err instanceof Error ? err.message : err}`));
          console.log(chalk.gray(`  Valid range: 1-${proposals.length}`));
        }
        process.exit(1);
      }

      if (selectedIndices.length === 0) {
        if (isJsonMode) {
          console.log(JSON.stringify({ success: false, error: 'No proposals selected' }));
        } else {
          console.error(chalk.red('✗ No proposals selected'));
          console.log(chalk.gray(`  Valid range: 1-${proposals.length}`));
        }
        process.exit(1);
      }

      const selectedProposals = selectedIndices.map(i => proposals[i]);

      if (!isJsonMode) {
        console.log(chalk.blue('📋 PromptWheel Solo Approve'));
        console.log();
        console.log(`Selected ${selectedProposals.length} proposal(s):`);
        for (const idx of selectedIndices) {
          const p = proposals[idx];
          console.log(`  ${chalk.bold(idx + 1)}. ${p.title}`);
        }
        console.log();
      }

      const adapter = await getAdapter(repoRoot);

      try {
        const deps = createScoutDeps(adapter, options);
        const createdTickets = await approveProposals(
          deps,
          artifact.data.projectId,
          selectedProposals
        );

        if (isJsonMode) {
          console.log(JSON.stringify({
            success: true,
            tickets: createdTickets.map(t => ({
              id: t.id,
              title: t.title,
              status: t.status,
            })),
          }));
        } else {
          console.log(chalk.green(`✓ Created ${createdTickets.length} ticket(s)`));
          for (const t of createdTickets) {
            console.log(`  ${chalk.gray(t.id)} ${t.title}`);
          }
          console.log();
          console.log(chalk.blue('Next steps:'));
          console.log(`  promptwheel solo run ${createdTickets[0]?.id}  # Run a ticket`);
          console.log('  promptwheel solo status                # View all tickets');
        }

      } finally {
        await adapter.close();
      }
    });
}
