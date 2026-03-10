import { Command } from 'commander';
import chalk from 'chalk';
import {
  loadBaseline, saveBaseline, unsuppressFinding, baselineSize, parseDuration, countExpired,
  type Baseline,
} from '@promptwheel/core/scout';
import { getPromptwheelDir } from '../lib/solo-config.js';
import { resolveRepoRootOrExit } from '../lib/command-runtime.js';

const SEVERITY_COLORS: Record<string, (s: string) => string> = {
  blocking: chalk.red,
  degrading: chalk.yellow,
  polish: chalk.gray,
  speculative: chalk.dim,
};

export function registerInspectBaselineCommand(solo: Command): void {
  const baseline = solo
    .command('baseline')
    .description('Manage the scan baseline (suppressed findings)');

  baseline
    .command('show')
    .description('List all suppressed findings in the baseline')
    .option('--json', 'Output as JSON')
    .action(async (options: { json?: boolean }) => {
      const repoRoot = await resolveRepoRootOrExit({ cwd: '.', json: !!options.json });
      const pwDir = getPromptwheelDir(repoRoot);
      const bl = loadBaseline(pwDir);

      if (!bl || baselineSize(bl) === 0) {
        if (options.json) {
          console.log(JSON.stringify({ entries: [], count: 0 }));
        } else {
          console.log(chalk.yellow('No baseline. Run `promptwheel scan --save-baseline` to create one.'));
        }
        return;
      }

      if (options.json) {
        console.log(JSON.stringify(bl, null, 2));
        return;
      }

      const entries = Object.entries(bl.entries);
      const expiredCount = countExpired(bl);
      console.log(chalk.blue(`Baseline: ${entries.length} suppressed findings`));
      if (expiredCount > 0) {
        console.log(chalk.yellow(`  ${expiredCount} expired (will reappear in scans)`));
      }
      console.log(chalk.gray(`Created: ${bl.created_at}`));
      console.log(chalk.gray(`Updated: ${bl.updated_at}`));
      console.log();

      const now = Date.now();
      for (const [id, entry] of entries) {
        const isExpired = entry.expires_at && new Date(entry.expires_at).getTime() <= now;
        const colorFn = isExpired ? chalk.strikethrough : (SEVERITY_COLORS[entry.severity] ?? chalk.white);
        const sev = colorFn(entry.severity.toUpperCase().padEnd(11));
        const who = entry.suppressed_by ? chalk.gray(` by ${entry.suppressed_by}`) : '';
        const expiry = entry.expires_at
          ? (isExpired ? chalk.red(' EXPIRED') : chalk.gray(` expires ${entry.expires_at.split('T')[0]}`))
          : '';
        console.log(` ${chalk.dim(id)}  ${sev} ${entry.title}${expiry}`);
        if (entry.reason) {
          console.log(`              ${chalk.gray(entry.reason)}${who}`);
        }
      }
    });

  baseline
    .command('clear')
    .description('Remove the baseline (all findings become active)')
    .action(async () => {
      const repoRoot = await resolveRepoRootOrExit({ cwd: '.' });
      const pwDir = getPromptwheelDir(repoRoot);
      const bl = loadBaseline(pwDir);

      if (!bl) {
        console.log(chalk.yellow('No baseline to clear.'));
        return;
      }

      const count = baselineSize(bl);
      const empty: Baseline = {
        version: '1.0',
        created_at: bl.created_at,
        updated_at: new Date().toISOString(),
        entries: {},
      };
      saveBaseline(pwDir, empty);
      console.log(chalk.green(`Cleared baseline (${count} findings unsuppressed).`));
    });

  // Top-level suppress / unsuppress commands
  solo
    .command('suppress <finding-id>')
    .description('Suppress a finding (add to baseline)')
    .option('-r, --reason <reason>', 'Reason for suppression', 'manually suppressed')
    .option('--expires <duration>', 'Auto-expire after duration (e.g., 90d, 4w, 6m)')
    .action(async (findingId: string, options: { reason: string; expires?: string }) => {
      const repoRoot = await resolveRepoRootOrExit({ cwd: '.' });
      const pwDir = getPromptwheelDir(repoRoot);
      const bl = loadBaseline(pwDir);

      if (!bl) {
        console.log(chalk.yellow('No baseline exists. Run `promptwheel scan --save-baseline` first.'));
        return;
      }

      // Parse expiration
      let expiresAt: string | undefined;
      if (options.expires) {
        const ms = parseDuration(options.expires);
        if (ms === null) {
          console.error(chalk.red(`Invalid duration: "${options.expires}". Use e.g., 90d, 4w, 6m`));
          process.exitCode = 1;
          return;
        }
        expiresAt = new Date(Date.now() + ms).toISOString();
      }

      if (findingId in bl.entries) {
        bl.entries[findingId].reason = options.reason;
        bl.entries[findingId].suppressed_at = new Date().toISOString();
        if (expiresAt) bl.entries[findingId].expires_at = expiresAt;
      } else {
        bl.entries[findingId] = {
          title: '(suppressed by ID)',
          severity: 'unknown',
          suppressed_at: new Date().toISOString(),
          reason: options.reason,
          ...(expiresAt && { expires_at: expiresAt }),
        };
      }

      saveBaseline(pwDir, bl);
      const expiresMsg = expiresAt ? chalk.gray(` (expires ${options.expires})`) : '';
      console.log(chalk.green(`Suppressed finding ${findingId}.`) + expiresMsg);
    });

  solo
    .command('unsuppress <finding-id>')
    .description('Unsuppress a finding (remove from baseline)')
    .action(async (findingId: string) => {
      const repoRoot = await resolveRepoRootOrExit({ cwd: '.' });
      const pwDir = getPromptwheelDir(repoRoot);
      const bl = loadBaseline(pwDir);

      if (!bl) {
        console.log(chalk.yellow('No baseline exists.'));
        return;
      }

      if (unsuppressFinding(bl, findingId)) {
        saveBaseline(pwDir, bl);
        console.log(chalk.green(`Unsuppressed finding ${findingId}.`));
      } else {
        console.log(chalk.yellow(`Finding ${findingId} not in baseline.`));
      }
    });
}
