import { Command } from 'commander';
import chalk from 'chalk';
import { loadRules, saveRule, rulesDir, type CustomRule } from '@promptwheel/core/scout';
import { getPromptwheelDir } from '../lib/solo-config.js';
import { resolveRepoRootOrExit } from '../lib/command-runtime.js';

const SEVERITY_COLORS: Record<string, (s: string) => string> = {
  blocking: chalk.red,
  degrading: chalk.yellow,
  polish: chalk.gray,
  speculative: chalk.dim,
};

export function registerInspectRulesCommand(solo: Command): void {
  const rules = solo
    .command('rules')
    .description('Manage custom scan rules');

  rules
    .command('list')
    .description('List all custom rules')
    .option('--json', 'Output as JSON')
    .action(async (options: { json?: boolean }) => {
      const repoRoot = await resolveRepoRootOrExit({ cwd: '.', json: !!options.json });
      const pwDir = getPromptwheelDir(repoRoot);
      const { rules: loaded, errors } = loadRules(pwDir);

      if (options.json) {
        console.log(JSON.stringify({ rules: loaded, errors }, null, 2));
        return;
      }

      if (loaded.length === 0) {
        console.log(chalk.yellow('No custom rules.'));
        console.log(chalk.gray(`Create rules in ${rulesDir(pwDir)}/`));
        console.log(chalk.gray('Run `promptwheel rules add` to create one.'));
        return;
      }

      console.log(chalk.blue(`${loaded.length} custom rules`));
      console.log();

      for (const rule of loaded) {
        const colorFn = SEVERITY_COLORS[rule.severity] ?? chalk.white;
        const sev = colorFn(rule.severity.toUpperCase().padEnd(11));
        const cat = rule.category ? chalk.gray(`[${rule.category}]`) : '';
        console.log(` ${chalk.white(rule.id.padEnd(20))} ${sev} ${rule.title} ${cat}`);
        if (rule.files) {
          console.log(`   ${chalk.gray(`files: ${rule.files}`)}`);
        }
      }

      if (errors.length > 0) {
        console.log(chalk.yellow('\nWarnings:'));
        for (const err of errors) {
          console.log(chalk.yellow(`  ${err}`));
        }
      }
    });

  rules
    .command('add <id>')
    .description('Create a new custom rule')
    .requiredOption('--title <title>', 'Rule title')
    .requiredOption('--description <description>', 'What to check for')
    .option('--severity <severity>', 'Severity: blocking, degrading, polish, speculative', 'degrading')
    .option('--category <category>', 'Finding category')
    .option('--files <glob>', 'File glob pattern')
    .option('--bad <example>', 'Example of bad code')
    .option('--good <example>', 'Example of good code')
    .action(async (id: string, options: {
      title: string;
      description: string;
      severity: string;
      category?: string;
      files?: string;
      bad?: string;
      good?: string;
    }) => {
      const repoRoot = await resolveRepoRootOrExit({ cwd: '.' });
      const pwDir = getPromptwheelDir(repoRoot);

      const validSeverities = ['blocking', 'degrading', 'polish', 'speculative'];
      const severity = validSeverities.includes(options.severity)
        ? options.severity as CustomRule['severity']
        : 'degrading';

      const rule: CustomRule = {
        id,
        title: options.title,
        description: options.description,
        severity,
        ...(options.category && { category: options.category }),
        ...(options.files && { files: options.files }),
        ...((options.bad || options.good) && {
          examples: {
            ...(options.bad && { bad: options.bad }),
            ...(options.good && { good: options.good }),
          },
        }),
      };

      const filePath = saveRule(pwDir, rule);
      console.log(chalk.green(`Rule created: ${filePath}`));
      console.log(chalk.gray('This rule will be injected into future scans.'));
    });

  rules
    .command('test')
    .description('Dry-run: show what rules would be injected into the scout prompt')
    .action(async () => {
      const repoRoot = await resolveRepoRootOrExit({ cwd: '.' });
      const pwDir = getPromptwheelDir(repoRoot);
      const { rules: loaded, errors } = loadRules(pwDir);

      if (loaded.length === 0) {
        console.log(chalk.yellow('No rules to inject.'));
        return;
      }

      // Import and show the prompt section
      const { buildRulesPromptSection } = await import('@promptwheel/core/scout');
      const section = buildRulesPromptSection(loaded);
      console.log(chalk.blue('Rules prompt section (injected into every scan):'));
      console.log();
      console.log(section);

      if (errors.length > 0) {
        console.log(chalk.yellow('\nWarnings:'));
        for (const err of errors) {
          console.log(chalk.yellow(`  ${err}`));
        }
      }
    });
}
