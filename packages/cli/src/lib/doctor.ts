/**
 * Doctor checks for PromptWheel prerequisites
 *
 * Detects missing tools, auth issues, and configuration problems
 * before users hit cryptic errors mid-workflow.
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Check status
 */
export type CheckStatus = 'pass' | 'warn' | 'fail';

/**
 * Individual check result
 */
export interface CheckResult {
  name: string;
  status: CheckStatus;
  message: string;
  fix?: string;
  details?: string;
}

/**
 * Full doctor report
 */
export interface DoctorReport {
  checks: CheckResult[];
  canScout: boolean;
  canRun: boolean;
  canPr: boolean;
}

/**
 * Helper to create CheckResult objects consistently
 */
function createCheckResult(
  name: string,
  status: CheckStatus,
  message: string,
  options?: { fix?: string; details?: string }
): CheckResult {
  const result: CheckResult = { name, status, message };
  if (options?.fix) result.fix = options.fix;
  if (options?.details) result.details = options.details;
  return result;
}

/**
 * Run all doctor checks
 */
export async function runDoctorChecks(options: {
  repoRoot?: string;
  verbose?: boolean;
}): Promise<DoctorReport> {
  const checks: CheckResult[] = [];

  // 1. Git installed
  checks.push(checkGitInstalled());

  // 2. In a git repo
  checks.push(checkIsGitRepo(options.repoRoot));

  // 3. Node version
  checks.push(checkNodeVersion());

  // 4. Claude CLI installed
  checks.push(checkClaudeInstalled());

  // 5. Claude CLI authenticated
  checks.push(await checkClaudeAuthenticated());

  // 6. gh CLI installed (for --pr)
  checks.push(checkGhInstalled());

  // 7. gh CLI authenticated (for --pr)
  checks.push(await checkGhAuthenticated());

  // 8. .promptwheel/ writable
  checks.push(checkPromptwheelWritable(options.repoRoot));

  // 9. Optional: ripgrep for faster scanning
  checks.push(checkRipgrepInstalled());

  // 10. SQLite native module
  checks.push(await checkSqliteModule());

  // Determine capabilities
  const hasGit = checks.find(c => c.name === 'git')?.status === 'pass';
  const isRepo = checks.find(c => c.name === 'git-repo')?.status === 'pass';
  const hasClaude = checks.find(c => c.name === 'claude')?.status === 'pass';
  const claudeAuth = checks.find(c => c.name === 'claude-auth')?.status === 'pass';
  const hasGh = checks.find(c => c.name === 'gh')?.status === 'pass';
  const ghAuth = checks.find(c => c.name === 'gh-auth')?.status === 'pass';
  const writable = checks.find(c => c.name === 'promptwheel-dir')?.status !== 'fail';
  const hasSqlite = checks.find(c => c.name === 'sqlite')?.status === 'pass';

  return {
    checks,
    canScout: hasGit && isRepo && writable && hasSqlite,
    canRun: hasGit && isRepo && hasClaude && claudeAuth && writable && hasSqlite,
    canPr: hasGit && isRepo && hasClaude && claudeAuth && hasGh && ghAuth && writable && hasSqlite,
  };
}

/**
 * Check: git installed
 */
function checkGitInstalled(): CheckResult {
  try {
    const result = spawnSync('git', ['--version'], { encoding: 'utf-8' });
    if (result.status === 0) {
      const version = result.stdout.trim().replace('git version ', '');
      return createCheckResult('git', 'pass', `git found (${version})`);
    }
  } catch {
    // Fall through to fail
  }

  return createCheckResult('git', 'fail', 'git not found', {
    fix: 'Install git: https://git-scm.com/downloads',
  });
}

/**
 * Check: current directory is a git repo
 */
function checkIsGitRepo(repoRoot?: string): CheckResult {
  const cwd = repoRoot ?? process.cwd();

  try {
    const result = spawnSync('git', ['rev-parse', '--git-dir'], {
      cwd,
      encoding: 'utf-8',
    });

    if (result.status === 0) {
      return createCheckResult('git-repo', 'pass', 'Inside a git repository');
    }
  } catch {
    // Fall through to fail
  }

  return createCheckResult('git-repo', 'fail', 'Not a git repository', {
    fix: 'Run `git init` or cd into an existing repo',
  });
}

/**
 * Check: Node version is supported
 */
function checkNodeVersion(): CheckResult {
  const version = process.version;
  const major = parseInt(version.slice(1).split('.')[0], 10);

  // Require Node 18+ for ESM and modern features
  if (major >= 18) {
    return createCheckResult('node', 'pass', `Node ${version} (supported)`);
  }

  if (major >= 16) {
    return createCheckResult('node', 'warn', `Node ${version} (may work, but 18+ recommended)`, {
      fix: 'Upgrade to Node 18+: https://nodejs.org/',
    });
  }

  return createCheckResult('node', 'fail', `Node ${version} (too old)`, {
    fix: 'Upgrade to Node 18+: https://nodejs.org/',
  });
}

/**
 * Check: Claude CLI installed
 */
function checkClaudeInstalled(): CheckResult {
  try {
    const result = spawnSync('claude', ['--version'], {
      encoding: 'utf-8',
      timeout: 5000,
    });

    if (result.status === 0) {
      const version = result.stdout.trim();
      return createCheckResult('claude', 'pass', `Claude CLI found (${version})`);
    }
  } catch {
    // Fall through to fail
  }

  return createCheckResult('claude', 'fail', 'Claude CLI not found', {
    fix: 'Install Claude Code: https://claude.ai/code',
    details: 'Required for `solo run` to execute tickets',
  });
}

/**
 * Check: Claude CLI authenticated
 */
async function checkClaudeAuthenticated(): Promise<CheckResult> {
  try {
    // Try a simple command that requires auth
    const result = spawnSync('claude', ['--help'], {
      encoding: 'utf-8',
      timeout: 10000,
    });

    // If claude is installed, assume it handles its own auth
    // We can't easily test auth without making an API call
    if (result.status === 0) {
      return createCheckResult('claude-auth', 'pass', 'Claude CLI accessible', {
        details: 'Auth will be checked on first run',
      });
    }
  } catch {
    // Fall through
  }

  // If Claude isn't installed, skip this check
  return createCheckResult('claude-auth', 'warn', 'Could not verify Claude authentication', {
    fix: 'Run `claude` and complete authentication',
  });
}

/**
 * Check: gh CLI installed
 */
function checkGhInstalled(): CheckResult {
  try {
    const result = spawnSync('gh', ['--version'], {
      encoding: 'utf-8',
      timeout: 5000,
    });

    if (result.status === 0) {
      const firstLine = result.stdout.split('\n')[0];
      const version = firstLine.replace('gh version ', '').split(' ')[0];
      return createCheckResult('gh', 'pass', `GitHub CLI found (${version})`);
    }
  } catch {
    // Fall through
  }

  return createCheckResult('gh', 'warn', 'GitHub CLI not found', {
    fix: 'Install gh: https://cli.github.com/',
    details: 'Only needed for `solo run --pr` to create PRs',
  });
}

/**
 * Check: gh CLI authenticated
 */
async function checkGhAuthenticated(): Promise<CheckResult> {
  try {
    const result = spawnSync('gh', ['auth', 'status'], {
      encoding: 'utf-8',
      timeout: 10000,
    });

    if (result.status === 0) {
      // Parse the output to get the account
      const match = result.stdout.match(/Logged in to .* as (\S+)/);
      const account = match ? match[1] : 'authenticated';
      return createCheckResult('gh-auth', 'pass', `GitHub CLI authenticated (${account})`);
    }

    // Check stderr for more info
    if (result.stderr?.includes('not logged in')) {
      return createCheckResult('gh-auth', 'warn', 'GitHub CLI not authenticated', {
        fix: 'Run `gh auth login`',
        details: 'Only needed for `solo run --pr` to create PRs',
      });
    }
  } catch {
    // Fall through
  }

  return createCheckResult('gh-auth', 'warn', 'Could not verify GitHub authentication', {
    fix: 'Run `gh auth login`',
    details: 'Only needed for `solo run --pr` to create PRs',
  });
}

/**
 * Check: .promptwheel/ directory is writable
 */
function checkPromptwheelWritable(repoRoot?: string): CheckResult {
  const cwd = repoRoot ?? process.cwd();
  const promptwheelDir = path.join(cwd, '.promptwheel');

  try {
    // Check if directory exists
    if (fs.existsSync(promptwheelDir)) {
      // Check if writable
      fs.accessSync(promptwheelDir, fs.constants.W_OK);
      return createCheckResult('promptwheel-dir', 'pass', '.promptwheel/ exists and is writable');
    }

    // Directory doesn't exist - check if we can create it
    fs.accessSync(cwd, fs.constants.W_OK);
    return createCheckResult('promptwheel-dir', 'pass', '.promptwheel/ can be created');
  } catch {
    return createCheckResult('promptwheel-dir', 'fail', 'Cannot write to .promptwheel/', {
      fix: 'Check directory permissions or run with appropriate access',
    });
  }
}

/**
 * Check: ripgrep installed (optional, for faster scanning)
 */
function checkRipgrepInstalled(): CheckResult {
  try {
    const result = spawnSync('rg', ['--version'], {
      encoding: 'utf-8',
      timeout: 5000,
    });

    if (result.status === 0) {
      const version = result.stdout.split('\n')[0].replace('ripgrep ', '');
      return createCheckResult('ripgrep', 'pass', `ripgrep found (${version})`, {
        details: 'Enables faster code scanning',
      });
    }
  } catch {
    // Fall through
  }

  return createCheckResult('ripgrep', 'warn', 'ripgrep not found (optional)', {
    fix: 'Install rg: https://github.com/BurntSushi/ripgrep#installation',
    details: 'Scanning will work but may be slower on large repos',
  });
}

/**
 * Check: SQLite native module
 *
 * better-sqlite3 is a native module that requires either:
 * 1. Prebuild binary for the platform (automatic via prebuild-install)
 * 2. Node-gyp build tools (python, c++ compiler)
 */
async function checkSqliteModule(): Promise<CheckResult> {
  try {
    // Try to import better-sqlite3 - this will fail if native module isn't built
    const { default: Database } = await import('better-sqlite3');

    // Try to create a temporary in-memory database
    const db = new Database(':memory:');
    db.exec('SELECT 1');
    db.close();

    return createCheckResult('sqlite', 'pass', 'SQLite native module loaded', {
      details: 'better-sqlite3 working correctly',
    });
  } catch (err) {
    const error = err as Error;
    const message = error.message || String(err);

    // Check for common native module errors
    if (message.includes('Could not locate the bindings file') ||
        message.includes('was compiled against a different Node.js version') ||
        message.includes('NODE_MODULE_VERSION')) {
      return createCheckResult('sqlite', 'fail', 'SQLite native module needs rebuild', {
        fix: 'Run: npm rebuild better-sqlite3',
        details: message,
      });
    }

    if (message.includes('Cannot find module')) {
      return createCheckResult('sqlite', 'fail', 'SQLite native module not installed', {
        fix: 'Run: npm install better-sqlite3',
        details: message,
      });
    }

    // Generic failure
    return createCheckResult('sqlite', 'fail', 'SQLite native module failed to load', {
      fix: 'Try: npm rebuild better-sqlite3. If that fails, ensure you have build tools (python, c++ compiler)',
      details: message,
    });
  }
}

/**
 * Format doctor report for human-readable output
 */
export function formatDoctorReport(report: DoctorReport): string {
  const lines: string[] = [];

  // Status icons
  const icons = {
    pass: '✅',
    warn: '⚠️',
    fail: '❌',
  };

  lines.push('PromptWheel Doctor\n');

  // Group checks by status
  const failed = report.checks.filter(c => c.status === 'fail');
  const warned = report.checks.filter(c => c.status === 'warn');

  // Show all checks
  for (const check of report.checks) {
    lines.push(`${icons[check.status]} ${check.message}`);
    if (check.fix && check.status !== 'pass') {
      lines.push(`   fix: ${check.fix}`);
    }
  }

  lines.push('');

  // Summary
  lines.push('Capabilities:');
  lines.push(`  ${report.canScout ? '✅' : '❌'} solo scout — Find improvement opportunities`);
  lines.push(`  ${report.canRun ? '✅' : '❌'} solo run — Execute tickets with Claude`);
  lines.push(`  ${report.canPr ? '✅' : '❌'} solo run --pr — Create PRs on GitHub`);

  // Action items if there are failures
  if (failed.length > 0) {
    lines.push('');
    lines.push('Action required:');
    for (const check of failed) {
      if (check.fix) {
        lines.push(`  • ${check.fix}`);
      }
    }
  }

  // Warnings that might affect workflow
  if (warned.length > 0 && failed.length === 0) {
    lines.push('');
    lines.push('Optional improvements:');
    for (const check of warned) {
      if (check.fix) {
        lines.push(`  • ${check.fix}`);
      }
    }
  }

  return lines.join('\n');
}

/**
 * Format doctor report as JSON
 */
export function formatDoctorReportJson(report: DoctorReport): string {
  return JSON.stringify({
    checks: report.checks.map(c => ({
      name: c.name,
      status: c.status,
      message: c.message,
      fix: c.fix,
      details: c.details,
    })),
    capabilities: {
      scout: report.canScout,
      run: report.canRun,
      pr: report.canPr,
    },
  }, null, 2);
}
