/**
 * Provider shorthand expansion, auth validation, and model selection for solo auto.
 */

import chalk from 'chalk';
import { createGitService } from '../lib/git.js';
import { loadConfig, saveConfig } from '../lib/solo-config.js';

export interface AuthOptions {
  codex?: boolean;
  claude?: boolean;
  kimi?: boolean;
  local?: boolean;
  localModel?: string;
  localUrl?: string;
  scoutBackend?: string;
  executeBackend?: string;
  codexModel?: string;
  kimiModel?: string;
  codexUnsafeFullAccess?: boolean;
}

/**
 * Expand provider shorthands (--codex, --kimi, --local) and validate auth.
 * Auto-detects backend from environment if no flags given.
 * Returns resolved scout/execute backend names.
 */
export async function resolveBackends(options: AuthOptions): Promise<{
  scoutBackendName: string;
  executeBackendName: string;
}> {
  const { isValidProvider, getProviderNames, getProvider } = await import('../lib/providers/index.js');

  // Expand shorthands
  const shorthands = [options.codex && 'codex', options.claude && 'claude', options.kimi && 'kimi', options.local && 'local'].filter(Boolean);
  if (shorthands.length > 1) {
    console.error(chalk.red(`✗ Cannot combine ${shorthands.map(s => `--${s}`).join(' and ')}`));
    process.exit(1);
  }

  // Auto-detect backend from environment if no explicit choice
  // Default: Codex. Use --claude to opt into Claude.
  if (!options.codex && !options.claude && !options.kimi && !options.local && !options.scoutBackend && !options.executeBackend) {
    options.codex = true;
  }

  if (options.codex) {
    options.scoutBackend = options.scoutBackend ?? 'codex';
    options.executeBackend = options.executeBackend ?? 'codex';
  }
  if (options.kimi) {
    options.scoutBackend = options.scoutBackend ?? 'kimi';
    options.executeBackend = options.executeBackend ?? 'kimi';
  }
  if (options.local) {
    if (!options.localModel) {
      console.error(chalk.red('✗ --local-model is required when using --local'));
      console.error(chalk.gray('  Example: promptwheel --local --local-model kimi-k2.5'));
      process.exit(1);
    }
    options.scoutBackend = options.scoutBackend ?? 'openai-local';
    options.executeBackend = options.executeBackend ?? 'openai-local';
    console.log(chalk.yellow('⚠ Local provider has no sandbox — worktree isolation + QA gating provides safety'));
  }

  const scoutBackendName = options.scoutBackend ?? 'claude';
  const executeBackendName = options.executeBackend ?? 'claude';

  // Validate backend names
  for (const [flag, value] of [['--scout-backend', scoutBackendName], ['--execute-backend', executeBackendName]] as const) {
    if (!isValidProvider(value)) {
      console.error(chalk.red(`✗ Invalid ${flag}: ${value}`));
      console.error(chalk.gray(`  Valid values: ${getProviderNames().join(', ')}`));
      process.exit(1);
    }
  }

  const needsClaude = scoutBackendName === 'claude' || executeBackendName === 'claude';
  const needsCodex = scoutBackendName === 'codex' || executeBackendName === 'codex';
  const needsKimi = scoutBackendName === 'kimi' || executeBackendName === 'kimi';
  const insideClaudeCode = process.env.CLAUDECODE === '1';

  // Detect running inside Claude Code session
  if (insideClaudeCode) {
    if (needsClaude) {
      console.error(chalk.red('✗ Cannot run Claude backend inside Claude Code'));
      console.error();
      console.error(chalk.gray('  The CLI spawns Claude as subprocesses (requires ANTHROPIC_API_KEY).'));
      console.error(chalk.gray('  Inside Claude Code, use the plugin instead:'));
      console.error();
      console.error(chalk.white('    /promptwheel:run'));
      console.error();
      console.error(chalk.gray('  Or run from a regular terminal:'));
      console.error();
      console.error(chalk.white('    promptwheel          # Claude (needs ANTHROPIC_API_KEY)'));
      console.error(chalk.white('    promptwheel --codex  # Codex (needs OPENAI_API_KEY)'));
      console.error();
      process.exit(1);
    } else {
      console.log(chalk.yellow('⚠ Running inside Claude Code session'));
      console.log(chalk.yellow('  This works, but you\'re paying for an idle Claude Code session.'));
      console.log(chalk.yellow('  Consider running from a regular terminal instead:'));
      console.log(chalk.white('    promptwheel --codex'));
      console.log();
    }
  }

  // Auth: Claude lane
  if (needsClaude && !process.env.ANTHROPIC_API_KEY) {
    console.error(chalk.red('✗ ANTHROPIC_API_KEY not set'));
    console.error(chalk.gray('  Required for Claude backend. Set the env var, or use:'));
    console.error(chalk.gray('    promptwheel --codex  (uses OPENAI_API_KEY or codex login)'));
    console.error(chalk.gray('    /promptwheel:run    (inside Claude Code, uses subscription)'));
    process.exit(1);
  }

  // Auth: Codex lane
  if (needsCodex) {
    if (!process.env.OPENAI_API_KEY) {
      const { spawnSync } = await import('node:child_process');
      const loginCheck = spawnSync('codex', ['login', 'status'], { encoding: 'utf-8', timeout: 10000 });
      if (loginCheck.status !== 0) {
        console.error(chalk.red('✗ Codex not authenticated'));
        console.error(chalk.gray('  Set OPENAI_API_KEY or run: codex login'));
        process.exit(1);
      }
    }
  }

  // Auth: Kimi lane
  if (needsKimi) {
    if (!process.env.MOONSHOT_API_KEY) {
      console.log(chalk.yellow('⚠ MOONSHOT_API_KEY not set — using kimi CLI stored credentials'));
      console.log(chalk.gray('  If auth fails, set MOONSHOT_API_KEY or run: kimi → /login'));
    }
  }

  // Model selection for Kimi
  if (needsKimi && !options.kimiModel) {
    options.kimiModel = 'kimi-k2.5';
  }

  // Model selection for Codex
  if (needsCodex) {
    await resolveCodexModel(options);
  }

  // Print auth summary
  const describeAuth = (backendName: string): string => {
    const prov = getProvider(backendName);
    if (prov.apiKeyEnvVar && process.env[prov.apiKeyEnvVar]) return `${prov.apiKeyEnvVar} (env)`;
    if (prov.altAuth) return prov.altAuth;
    return prov.apiKeyEnvVar ? `${prov.apiKeyEnvVar} (env)` : 'none';
  };
  if (scoutBackendName === executeBackendName) {
    console.log(chalk.gray(`Auth: ${describeAuth(scoutBackendName)}`));
  } else {
    console.log(chalk.gray(`Auth (scout):   ${describeAuth(scoutBackendName)}`));
    console.log(chalk.gray(`Auth (execute): ${describeAuth(executeBackendName)}`));
  }

  // Warn about unsafe flag
  if (options.codexUnsafeFullAccess) {
    if (executeBackendName !== 'codex') {
      console.error(chalk.red('✗ --codex-unsafe-full-access only applies with --execute-backend codex'));
      process.exit(1);
    }
    console.log(chalk.yellow('⚠ --codex-unsafe-full-access: sandbox disabled for Codex execution'));
    console.log(chalk.yellow('  Only use this inside an externally hardened/isolated runner'));
  }

  return { scoutBackendName, executeBackendName };
}

async function resolveCodexModel(options: AuthOptions): Promise<void> {
  const hasApiKey = !!process.env.OPENAI_API_KEY;
  const CODEX_MODELS = [
    { key: '1', name: 'gpt-5.3-codex', desc: 'Latest — strongest coding + reasoning (default)' },
    { key: '2', name: 'gpt-5.2-codex', desc: 'Previous generation' },
    { key: '3', name: 'gpt-5.1-codex-max', desc: 'Extended agentic tasks' },
    ...(hasApiKey ? [
      { key: '4', name: 'gpt-5.2-codex-high', desc: 'High reasoning (API key only)' },
      { key: '5', name: 'gpt-5.2-codex-xhigh', desc: 'Max reasoning (API key only)' },
      { key: '6', name: 'gpt-5.1-codex-mini', desc: 'Fast, cost-effective (API key only)' },
      { key: '7', name: 'gpt-5.2', desc: 'General-purpose (API key only)' },
      { key: '8', name: 'gpt-5.2-high', desc: 'General-purpose, high reasoning (API key only)' },
      { key: '9', name: 'gpt-5.2-xhigh', desc: 'General-purpose, max reasoning (API key only)' },
    ] : []),
  ];
  const LOGIN_SAFE_MODELS = ['gpt-5.3-codex', 'gpt-5.2-codex', 'gpt-5.1-codex-max'];
  const ALL_MODEL_NAMES = CODEX_MODELS.map(m => m.name);

  if (options.codexModel) {
    // Explicit model — validate
    if (!hasApiKey && !LOGIN_SAFE_MODELS.includes(options.codexModel)) {
      console.log(chalk.yellow(`\nModel "${options.codexModel}" requires OPENAI_API_KEY (not available with codex login).`));
      console.log(chalk.yellow(`Available models: ${LOGIN_SAFE_MODELS.join(', ')}`));
      console.log(chalk.yellow('Set OPENAI_API_KEY or choose a compatible model.\n'));
      process.exit(1);
    }
    const earlyGit = createGitService();
    const earlyRoot = await earlyGit.findRepoRoot(process.cwd());
    if (earlyRoot) {
      saveConfig(earlyRoot, { codexModel: options.codexModel });
    }
    return;
  }

  // Check for saved model in config
  const earlyGit = createGitService();
  const earlyRoot = await earlyGit.findRepoRoot(process.cwd());
  const savedConfig = earlyRoot ? loadConfig(earlyRoot) : null;
  const savedModel = savedConfig?.codexModel;

  if (savedModel && ALL_MODEL_NAMES.includes(savedModel)) {
    if (!hasApiKey && !LOGIN_SAFE_MODELS.includes(savedModel)) {
      console.log(chalk.yellow(`\nSaved model "${savedModel}" requires OPENAI_API_KEY.`));
      console.log(chalk.yellow('Please select a compatible model:\n'));
    } else {
      options.codexModel = savedModel;
      console.log(chalk.gray(`\nModel: ${options.codexModel} (saved)`));
      console.log(chalk.gray('  Change with: promptwheel --codex --codex-model <name>'));
      console.log();
      return;
    }
  } else if (savedModel) {
    console.log(chalk.yellow(`\nSaved model "${savedModel}" is no longer available.`));
    console.log(chalk.yellow('Please select a model:\n'));
  }

  // Interactive model picker
  console.log(chalk.white('\nSelect Codex model:'));
  for (const m of CODEX_MODELS) {
    console.log(chalk.gray(`  ${m.key}) ${m.name}  — ${m.desc}`));
  }
  const readline = await import('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => {
    rl.question(chalk.white('Choice [1]: '), (a) => { rl.close(); resolve(a.trim() || '1'); });
  });
  const picked = CODEX_MODELS.find(m => m.key === answer || m.name === answer);
  options.codexModel = picked?.name ?? answer;
  console.log(chalk.gray(`Model: ${options.codexModel}`));
  console.log();

  if (earlyRoot) {
    saveConfig(earlyRoot, { codexModel: options.codexModel });
  }
}
