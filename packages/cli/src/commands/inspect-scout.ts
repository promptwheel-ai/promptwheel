import { Command } from 'commander';
import * as path from 'node:path';
import chalk from 'chalk';
import { scoutRepo, type ScoutProgress } from '@promptwheel/core/services';
import { type ProposalCategory, detectScope } from '@promptwheel/core/scout';
import { writeJsonArtifact } from '../lib/artifacts.js';
import {
  getPromptwheelDir,
  createScoutDeps,
  formatProgress,
  displayProposal,
} from '../lib/solo-config.js';
import {
  ensureInitializedOrExit,
  exitCommandError,
  resolveRepoRootOrExit,
  withCommandAdapter,
} from '../lib/command-runtime.js';

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

export function registerInspectScoutCommand(solo: Command): void {
  solo
    .command('scout [path]')
    .description('Scan a codebase and create improvement tickets')
    .option('-v, --verbose', 'Show detailed output')
    .option('-q, --quiet', 'Suppress non-essential output')
    .option('--json', 'Output as JSON')
    .option('-s, --scope <pattern>', 'Glob pattern for files to scan (auto-detected if omitted)')
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

      if (!isQuiet) {
        console.log(chalk.blue('🔍 PromptWheel Solo Scout'));
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

      // Auto-detect scope if not explicitly provided
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
          return;
        }

        if (!result.success) {
          exitCommandError({
            message: 'Scout failed',
            humanDetails: result.errors.map((error) => `  ${error}`),
          });
        }

        console.log(chalk.green(
          `✓ Scanned ${result.scannedFiles} files in ` +
          `${(result.durationMs / 1000).toFixed(1)}s`,
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
          console.log(chalk.gray(`  IDs: ${result.tickets.map((ticket) => ticket.id).join(', ')}`));
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
      });
    });
}
