/**
 * Pre-session QA baseline initialization — extracted from initSession() in solo-auto-state.ts.
 * Runs QA commands upfront to establish baselines, auto-fixes lint issues, and tunes QA config.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import chalk from 'chalk';
import type { SoloConfig } from './solo-config.js';
import { getPromptwheelDir } from './solo-config.js';
import { normalizeQaConfig } from './solo-utils.js';
import { resetQaStatsForSession } from './qa-stats.js';
import { captureQaBaseline, baselineToPassFail } from './solo-ticket-qa.js';

export interface InitQaResult {
  /** Updated config with tuned QA commands */
  config: SoloConfig;
  /** Cached baseline pass/fail map for reuse in first execute cycle */
  qaBaseline: Map<string, boolean> | null;
}

export interface InitQaOptions {
  qaFix: boolean;
  codex?: boolean;
  codexModel?: string;
  dryRun?: boolean;
}

/**
 * Initialize QA baselines and auto-tune config.
 * Extracted from initSession to reduce file size.
 */
export async function initQaBaseline(
  repoRoot: string,
  config: SoloConfig,
  options: InitQaOptions,
): Promise<InitQaResult> {
  if (!config?.qa?.commands?.length || options.dryRun) {
    return { config, qaBaseline: null };
  }

  console.log(chalk.cyan('🎛️  Tuning QA baselines...'));
  const qaConfig = normalizeQaConfig(config);

  // Run each command to establish baseline
  let baseline = await captureQaBaseline(repoRoot, config, (msg) => console.log(chalk.gray(msg)), repoRoot);

  // Check for failures
  const failingCommands = [...baseline.entries()].filter(([, r]) => !r.passed).map(([name]) => name);

  // Try auto-fix for lint commands (--fix flag)
  if (failingCommands.length > 0) {
    const lintCommands = failingCommands.filter(name =>
      name.toLowerCase().includes('lint') ||
      qaConfig.commands.find(c => c.name === name)?.cmd.includes('eslint') ||
      qaConfig.commands.find(c => c.name === name)?.cmd.includes('prettier')
    );

    if (lintCommands.length > 0) {
      console.log(chalk.cyan('  🔧 Attempting auto-fix for lint issues...'));
      for (const name of lintCommands) {
        const cmd = qaConfig.commands.find(c => c.name === name);
        if (!cmd) continue;

        const fixCmd = cmd.cmd.includes('--fix') ? cmd.cmd : `${cmd.cmd} --fix`;
        try {
          const { execFileSync } = await import('node:child_process');
          execFileSync('sh', ['-c', fixCmd], {
            cwd: cmd.cwd ? path.resolve(repoRoot, cmd.cwd) : repoRoot,
            timeout: cmd.timeoutMs ?? 120_000,
            stdio: 'pipe',
          });
          console.log(chalk.green(`    ✓ Auto-fixed: ${name}`));
        } catch {
          console.log(chalk.gray(`    • Could not auto-fix: ${name}`));
        }
      }

      // Re-run baseline after auto-fix
      console.log(chalk.gray('  Re-checking baselines...'));
      resetQaStatsForSession(repoRoot);
      baseline = await captureQaBaseline(repoRoot, config, (msg) => console.log(chalk.gray(msg)), repoRoot);

      // Auto-commit lint auto-fix changes
      try {
        const { spawnSync } = await import('node:child_process');
        const status = spawnSync('git', ['status', '--porcelain'], { cwd: repoRoot });
        const hasChanges = status.stdout?.toString().trim().length > 0;
        if (hasChanges) {
          spawnSync('git', ['add', '-A'], { cwd: repoRoot });
          spawnSync('git', ['commit', '-m', 'style: auto-fix lint issues'], { cwd: repoRoot });
          console.log(chalk.gray('  Auto-committed lint fixes'));
        }
      } catch { /* non-fatal */ }
    }
  }

  // Check for remaining failures after auto-fix attempts
  const stillFailing = [...baseline.entries()].filter(([, r]) => !r.passed).map(([name]) => name);

  if (stillFailing.length > 0 && options.qaFix) {
    // Try one AI fix cycle silently — no prompts, no wheel
    console.log(chalk.gray(`  ${stillFailing.length} failing — trying quick fix...`));

    const { ClaudeExecutionBackend, CodexExecutionBackend } = await import('./execution-backends/index.js');
    const backend = options.codex
      ? new CodexExecutionBackend({ model: options.codexModel })
      : new ClaudeExecutionBackend();

    // Build prompt with command info and error output
    const failingDetails = stillFailing.map(name => {
      const cmd = qaConfig.commands.find(c => c.name === name);
      const result = baseline.get(name);
      let detail = `## ${name}\nCommand: ${cmd?.cmd || name}`;
      if (result?.output) {
        detail += `\nError output:\n\`\`\`\n${result.output}\n\`\`\``;
      }
      return detail;
    }).join('\n\n');

    const fixPrompt = `These QA commands are failing. Fix the source code so they pass.

${failingDetails}

Read the error output above, then fix the source code. Minimal, targeted changes only.`;

    const { createSpinner } = await import('./spinner.js');
    const spinner = createSpinner(`Fixing ${stillFailing.length} QA issue(s)...`);

    try {
      await backend.run({
        worktreePath: repoRoot,
        prompt: fixPrompt,
        timeoutMs: 0,
        verbose: true,
        onProgress: (msg) => spinner.update(msg),
      });
      spinner.stop();

      // Re-check baselines
      const checkSpinner = createSpinner('Re-checking baselines...');
      resetQaStatsForSession(repoRoot);
      baseline = await captureQaBaseline(repoRoot, config, (msg) => checkSpinner.update(msg), repoRoot);

      const nowFailing = [...baseline.entries()].filter(([, r]) => !r.passed).map(([name]) => name);

      if (nowFailing.length === 0) {
        checkSpinner.succeed('All QA commands now passing!');
      } else if (nowFailing.length < stillFailing.length) {
        const fixed = stillFailing.length - nowFailing.length;
        checkSpinner.succeed(`${fixed} fixed, ${nowFailing.length} still failing`);
      } else {
        checkSpinner.fail(`${nowFailing.length} still failing`);
      }

      // Auto-commit qa-fix changes so the next session doesn't block on dirty tree
      if (nowFailing.length < stillFailing.length) {
        try {
          const { spawnSync } = await import('node:child_process');
          const status = spawnSync('git', ['status', '--porcelain'], { cwd: repoRoot });
          const hasChanges = status.stdout?.toString().trim().length > 0;
          if (hasChanges) {
            spawnSync('git', ['add', '-A'], { cwd: repoRoot });
            const fixed = stillFailing.length - nowFailing.length;
            spawnSync('git', ['commit', '-m', `fix: auto-heal ${fixed} QA baseline issue(s)`], { cwd: repoRoot });
            console.log(chalk.gray(`  Auto-committed QA fixes`));
          }
        } catch { /* non-fatal */ }
      }

      // Update stillFailing for final reporting
      stillFailing.length = 0;
      stillFailing.push(...nowFailing);
    } catch (err) {
      spinner.fail(`Fix error: ${err instanceof Error ? err.message : err}`);
    }
    console.log();
  }

  // Persist baseline failures for inline prompts (plugin/MCP path)
  try {
    const baselineFailures = [...baseline.entries()]
      .filter(([, r]) => !r.passed)
      .map(([name]) => name);
    const baselineDetails: Record<string, { cmd: string; output: string }> = {};
    for (const name of baselineFailures) {
      const result = baseline.get(name);
      const cmdDef = qaConfig.commands.find(c => c.name === name);
      baselineDetails[name] = {
        cmd: cmdDef?.cmd ?? name,
        output: result?.output ?? '',
      };
    }
    const baselinePath = path.join(getPromptwheelDir(repoRoot), 'qa-baseline.json');
    fs.writeFileSync(baselinePath, JSON.stringify({
      failures: baselineFailures,
      details: baselineDetails,
      timestamp: Date.now(),
    }));
  } catch { /* non-fatal */ }

  // Cache baseline for reuse in the first execute cycle
  const qaBaseline = baselineToPassFail(baseline);

  // Report baseline health — no commands are disabled, failing ones are
  // skipped during QA verification and surfaced to scout for healing.
  const passingCount = [...baseline.entries()].filter(([, r]) => r.passed).length;
  const failingCount = [...baseline.entries()].filter(([, r]) => !r.passed).length;

  if (failingCount > 0) {
    console.log(chalk.yellow(`  ⚠ ${failingCount} command(s) failing baseline — scout will target for healing`));
  }
  if (passingCount > 0) {
    console.log(chalk.green(`  ✓ ${passingCount} QA command(s) passing`));
  } else if (failingCount > 0) {
    console.log(chalk.yellow(`  ⚠ No QA commands passing — scout will prioritize healing`));
  }
  console.log();

  return { config, qaBaseline };
}
