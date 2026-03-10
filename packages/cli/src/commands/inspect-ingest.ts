import { Command } from 'commander';
import chalk from 'chalk';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  parseSarif, ingestToScanResult, findingToProposal,
  appendScanHistory, getLastScan, diffScans,
  loadBaseline, filterByBaseline,
  appendFixAttempt,
  type IngestOptions,
} from '@promptwheel/core/scout';
import { repos } from '@promptwheel/core';
import { getPromptwheelDir } from '../lib/solo-config.js';
import { resolveRepoRootOrExit, withCommandAdapter } from '../lib/command-runtime.js';

const SEVERITY_COLORS: Record<string, (s: string) => string> = {
  blocking: chalk.red,
  degrading: chalk.yellow,
  polish: chalk.gray,
  speculative: chalk.dim,
};

export function registerInspectIngestCommand(solo: Command): void {
  solo
    .command('ingest <sarif-file>')
    .description('Import findings from a SARIF 2.1.0 file (CodeQL, Semgrep, etc.)')
    .option('--source <name>', 'Override source tool name')
    .option('--json', 'Output as JSON')
    .option('--diff', 'Show delta from last scan')
    .option('--dry-run', 'Parse and display without saving to history')
    .option('--min-level <level>', 'Minimum SARIF level to import (error|warning|note|none)', 'note')
    .option('--fail-on <severity>', 'Exit 1 if findings at or above severity exist')
    .option('--fail-on-new <severity>', 'Exit 1 if NEW findings at or above severity exist')
    .option('--fix [count]', 'Create tickets for top blocking/degrading findings (default: 3)')
    .action(async (sarifFile: string, options: {
      source?: string;
      json?: boolean;
      diff?: boolean;
      dryRun?: boolean;
      minLevel?: string;
      failOn?: string;
      failOnNew?: string;
      fix?: boolean | string;
    }) => {
      const repoRoot = await resolveRepoRootOrExit({ cwd: '.', json: !!options.json });
      const pwDir = getPromptwheelDir(repoRoot);

      // Read SARIF file
      const filePath = path.resolve(sarifFile);
      if (!fs.existsSync(filePath)) {
        console.error(chalk.red(`✗ File not found: ${filePath}`));
        process.exitCode = 1;
        return;
      }

      const json = fs.readFileSync(filePath, 'utf-8');

      // Parse
      const ingestOpts: IngestOptions = {
        source: options.source,
        minLevel: (options.minLevel as IngestOptions['minLevel']) ?? 'note',
      };
      const result = parseSarif(json, ingestOpts);

      // Report warnings
      for (const w of result.warnings) {
        console.error(chalk.yellow(`⚠ ${w}`));
      }

      if (result.findings.length === 0) {
        console.log(chalk.gray(`No findings ingested from ${result.source} (${result.skipped} skipped)`));
        return;
      }

      // Build scan result
      const project = path.basename(repoRoot);
      const scanResult = ingestToScanResult(result, project);

      // Apply baseline
      const baseline = loadBaseline(pwDir);
      const { active, baselined } = baseline
        ? filterByBaseline(scanResult.findings, baseline)
        : { active: scanResult.findings, baselined: [] };

      // JSON output
      if (options.json) {
        console.log(JSON.stringify({
          source: result.source,
          total: result.findings.length,
          active: active.length,
          baselined: baselined.length,
          skipped: result.skipped,
          findings: active,
        }, null, 2));
      } else {
        // Human-readable output
        console.log(chalk.bold(`\n${result.source} — ${active.length} active findings`));
        if (baselined.length > 0) {
          console.log(chalk.gray(`  (${baselined.length} baselined, hidden)`));
        }
        if (result.skipped > 0) {
          console.log(chalk.gray(`  (${result.skipped} below ${options.minLevel ?? 'note'} level, skipped)`));
        }
        console.log();

        // Table
        for (const f of active) {
          const color = SEVERITY_COLORS[f.severity] ?? chalk.white;
          const fileStr = f.files.length > 0 ? chalk.dim(f.files[0]) : '';
          const ruleStr = f.external_rule_id ? chalk.dim(`[${f.external_rule_id}]`) : '';
          console.log(`  ${color(f.severity.padEnd(11))} ${f.title}`);
          if (fileStr || ruleStr) {
            console.log(`             ${fileStr} ${ruleStr}`);
          }
        }

        // Summary
        console.log();
        const bySev = scanResult.summary.by_severity;
        const parts: string[] = [];
        if (bySev['blocking']) parts.push(chalk.red(`${bySev['blocking']} blocking`));
        if (bySev['degrading']) parts.push(chalk.yellow(`${bySev['degrading']} degrading`));
        if (bySev['polish']) parts.push(chalk.gray(`${bySev['polish']} polish`));
        if (bySev['speculative']) parts.push(chalk.dim(`${bySev['speculative']} speculative`));
        console.log(`  ${parts.join(' · ')}`);
      }

      // Diff from last scan
      if (options.diff) {
        const lastScan = getLastScan(pwDir);
        if (lastScan) {
          const diff = diffScans(lastScan.result, scanResult);
          console.log();
          if (diff.summary.new_count > 0) {
            console.log(chalk.red(`  ▲ ${diff.summary.new_count} new`));
            for (const f of diff.new) {
              console.log(`    + ${f.title}`);
            }
          }
          if (diff.summary.fixed_count > 0) {
            console.log(chalk.green(`  ▼ ${diff.summary.fixed_count} fixed`));
            for (const f of diff.fixed) {
              console.log(`    - ${f.title}`);
            }
          }
          if (diff.summary.new_count === 0 && diff.summary.fixed_count === 0) {
            console.log(chalk.gray('  No changes from last scan'));
          }
        } else {
          console.log(chalk.gray('\n  No previous scan to diff against'));
        }
      }

      // Save to history (unless dry-run)
      if (!options.dryRun) {
        appendScanHistory(pwDir, scanResult);
        if (!options.json) {
          console.log(chalk.gray(`\n  Saved to scan history`));
        }
      }

      // --fix: create tickets for top blocking/degrading findings
      const fixMode = options.fix !== undefined && options.fix !== false;
      if (fixMode && !options.dryRun) {
        const fixCount = typeof options.fix === 'string' ? parseInt(options.fix, 10) || 3 : 3;
        const fixable = active
          .filter(f => f.severity === 'blocking' || f.severity === 'degrading')
          .filter(f => f.files.length > 0)
          .slice(0, fixCount);

        if (fixable.length > 0) {
          await withCommandAdapter(repoRoot, async (adapter) => {
            // Ensure project exists
            const projectRecord = await repos.projects.ensureForRepo(adapter, {
              name: path.basename(repoRoot),
              rootPath: repoRoot,
            });

            const proposals = fixable.map(findingToProposal);
            const ticketInputs = proposals.map(p => ({
              projectId: projectRecord.id,
              title: p.title,
              description: `[${result.source}] ${p.description}`,
              status: 'ready' as const,
              priority: p.confidence,
              category: p.category,
              allowedPaths: p.allowed_paths,
              verificationCommands: p.verification_commands,
            }));

            const created = await repos.tickets.createMany(adapter, ticketInputs);

            // Record fix attempts in journal
            for (let i = 0; i < created.length; i++) {
              const finding = fixable[i];
              appendFixAttempt(pwDir, {
                finding_id: finding.id,
                ticket_id: created[i].id,
                title: finding.title,
                category: finding.category,
                severity: finding.severity,
                attempted_at: new Date().toISOString(),
              });
            }

            console.log(chalk.green(`\n✓ Created ${created.length} tickets for auto-fix`));
            for (const ticket of created) {
              console.log(`  ${chalk.white(ticket.id)}  ${ticket.title}`);
            }
            console.log();
            console.log('Run these to fix:');
            for (const ticket of created) {
              console.log(chalk.cyan(`  promptwheel run ${ticket.id}`));
            }
          });
        } else {
          console.log(chalk.yellow('\nNo blocking or degrading findings with file locations to fix.'));
        }
      }

      // Fail-on gates
      const severityRank: Record<string, number> = { blocking: 4, degrading: 3, polish: 2, speculative: 1 };
      if (options.failOn) {
        const threshold = severityRank[options.failOn] ?? 0;
        const failing = active.filter(f => (severityRank[f.severity] ?? 0) >= threshold);
        if (failing.length > 0) {
          console.error(chalk.red(`\n✗ ${failing.length} findings at or above '${options.failOn}'`));
          process.exitCode = 1;
        }
      }
      if (options.failOnNew) {
        const threshold = severityRank[options.failOnNew] ?? 0;
        const lastScan = getLastScan(pwDir);
        if (lastScan) {
          const diff = diffScans(lastScan.result, scanResult);
          const newFailing = diff.new.filter(f => (severityRank[f.severity] ?? 0) >= threshold);
          if (newFailing.length > 0) {
            console.error(chalk.red(`\n✗ ${newFailing.length} new findings at or above '${options.failOnNew}'`));
            process.exitCode = 1;
          }
        }
      }
    });
}
