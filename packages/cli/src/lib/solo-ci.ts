/**
 * Solo mode CI integration
 */

import { spawnSync } from 'node:child_process';

/**
 * Safe spawnSync wrapper
 */
export function spawnSyncSafe(cmd: string, args: string[], options?: { cwd?: string }): { ok: boolean; stdout: string; stderr: string } {
  try {
    const result = spawnSync(cmd, args, {
      encoding: 'utf-8',
      timeout: 30000,
      ...options,
    });
    return {
      ok: result.status === 0,
      stdout: result.stdout || '',
      stderr: result.stderr || '',
    };
  } catch {
    return { ok: false, stdout: '', stderr: '' };
  }
}

/**
 * Get current branch name
 */
export async function getCurrentBranch(repoRoot: string): Promise<string> {
  const result = spawnSyncSafe('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoRoot });
  return result.stdout.trim();
}

/**
 * CI status result
 */
export interface CIStatus {
  status: 'success' | 'failure' | 'pending' | 'unknown';
  conclusion?: string;
  runId?: string;
  failedJobs: Array<{ id: string; name: string }>;
}

/**
 * Get CI status for a branch
 */
export async function getCIStatus(repoRoot: string, branch: string): Promise<CIStatus> {
  const result = spawnSyncSafe('gh', [
    'run', 'list',
    '--branch', branch,
    '--limit', '1',
    '--json', 'status,conclusion,databaseId,jobs',
  ], { cwd: repoRoot });

  if (!result.ok || !result.stdout) {
    return { status: 'unknown', failedJobs: [] };
  }

  try {
    const runList = JSON.parse(result.stdout);
    if (runList.length === 0) {
      return { status: 'unknown', failedJobs: [] };
    }

    const run = runList[0];

    if (run.status === 'in_progress' || run.status === 'queued') {
      return { status: 'pending', failedJobs: [] };
    }

    if (run.conclusion === 'success') {
      return { status: 'success', failedJobs: [] };
    }

    const failedJobs: Array<{ id: string; name: string }> = [];
    if (run.jobs) {
      for (const job of run.jobs) {
        if (job.conclusion === 'failure') {
          failedJobs.push({ id: String(job.databaseId), name: job.name });
        }
      }
    }

    return {
      status: 'failure',
      conclusion: run.conclusion,
      runId: String(run.databaseId),
      failedJobs,
    };
  } catch {
    return { status: 'unknown', failedJobs: [] };
  }
}

/**
 * Get failure logs for a job
 */
export async function getFailureLogs(runId: string | undefined, jobId: string): Promise<string | null> {
  if (!runId) return null;

  const result = spawnSyncSafe('gh', [
    'run', 'view', runId,
    '--job', jobId,
    '--log-failed',
  ]);

  return result.ok ? result.stdout : null;
}

/**
 * Parsed failure from CI logs
 */
export interface ParsedFailure {
  type: 'test' | 'build' | 'lint' | 'typecheck' | 'unknown';
  framework?: string;
  message: string;
  file?: string;
  line?: number;
  stackTrace?: string[];
}

/**
 * Parse failure from CI logs
 */
export function parseFailure(logs: string): ParsedFailure | null {
  // Jest failure pattern
  const jestMatch = logs.match(/FAIL\s+(.+\.(?:test|spec)\.[jt]sx?)/);
  if (jestMatch) {
    const errorMatch = logs.match(/●\s+(.+)\n\n\s+(.+)/);
    return {
      type: 'test',
      framework: 'jest',
      message: errorMatch?.[2] || 'Jest test failed',
      file: jestMatch[1],
      stackTrace: extractStackTrace(logs),
    };
  }

  // Vitest failure pattern
  const vitestMatch = logs.match(/❯\s+(.+\.(?:test|spec)\.[jt]sx?)/);
  if (vitestMatch) {
    return {
      type: 'test',
      framework: 'vitest',
      message: 'Vitest test failed',
      file: vitestMatch[1],
      stackTrace: extractStackTrace(logs),
    };
  }

  // Pytest failure pattern
  const pytestMatch = logs.match(/FAILED\s+(.+\.py)::(.+)/);
  if (pytestMatch) {
    return {
      type: 'test',
      framework: 'pytest',
      message: `Test ${pytestMatch[2]} failed`,
      file: pytestMatch[1],
      stackTrace: extractStackTrace(logs),
    };
  }

  // Go test failure pattern
  const goMatch = logs.match(/---\s+FAIL:\s+(\w+)\s+\(([^)]+)\)/);
  if (goMatch) {
    const fileMatch = logs.match(/(\w+_test\.go):(\d+)/);
    return {
      type: 'test',
      framework: 'go',
      message: `Test ${goMatch[1]} failed`,
      file: fileMatch?.[1],
      line: fileMatch ? parseInt(fileMatch[2], 10) : undefined,
      stackTrace: extractStackTrace(logs),
    };
  }

  // TypeScript error pattern
  const tsMatch = logs.match(/(.+\.tsx?)\((\d+),(\d+)\):\s+error\s+TS\d+:\s+(.+)/);
  if (tsMatch) {
    return {
      type: 'typecheck',
      framework: 'typescript',
      message: tsMatch[4],
      file: tsMatch[1],
      line: parseInt(tsMatch[2], 10),
    };
  }

  // ESLint error pattern
  const eslintMatch = logs.match(/(.+\.(?:js|ts|jsx|tsx))\n\s+(\d+):(\d+)\s+error\s+(.+)/);
  if (eslintMatch) {
    return {
      type: 'lint',
      framework: 'eslint',
      message: eslintMatch[4],
      file: eslintMatch[1],
      line: parseInt(eslintMatch[2], 10),
    };
  }

  // Generic build failure
  if (logs.includes('Build failed') || logs.includes('error:') || logs.includes('Error:')) {
    const errorLine = logs.split('\n').find((l) => l.includes('error') || l.includes('Error'));
    return {
      type: 'build',
      message: errorLine || 'Build failed',
    };
  }

  return null;
}

/**
 * Extract stack trace lines from logs
 */
export function extractStackTrace(logs: string): string[] {
  const lines = logs.split('\n');
  const stackLines: string[] = [];

  for (const line of lines) {
    if (line.match(/^\s+at\s+/) || line.match(/^\s+File\s+"/) || line.match(/^\s+\w+\.go:\d+/)) {
      stackLines.push(line.trim());
    }
  }

  return stackLines.slice(0, 10);
}

/**
 * Extract file scope from failure
 */
export function extractFailureScope(failure: ParsedFailure): string[] {
  const files = new Set<string>();

  if (failure.file) {
    files.add(failure.file);

    const sourceFile = testToSourceFile(failure.file);
    if (sourceFile) {
      files.add(sourceFile);
    }
  }

  if (failure.stackTrace) {
    for (const line of failure.stackTrace) {
      const extracted = extractFileFromStackLine(line);
      if (extracted && !extracted.includes('node_modules')) {
        files.add(extracted);
      }
    }
  }

  return Array.from(files);
}

/**
 * Convert test file path to likely source file path
 */
export function testToSourceFile(testFile: string): string | null {
  const jestMatch = testFile.match(/^(.+)\.(test|spec)\.(js|ts|jsx|tsx)$/);
  if (jestMatch) {
    return `${jestMatch[1]}.${jestMatch[3]}`;
  }

  const pytestMatch = testFile.match(/^test_(.+)\.py$/);
  if (pytestMatch) {
    return `${pytestMatch[1]}.py`;
  }

  const goMatch = testFile.match(/^(.+)_test\.go$/);
  if (goMatch) {
    return `${goMatch[1]}.go`;
  }

  return null;
}

/**
 * Extract file path from a stack trace line
 */
export function extractFileFromStackLine(line: string): string | null {
  const jsMatch = line.match(/\(([^:)]+\.[jt]sx?):\d+:\d+\)/);
  if (jsMatch) {
    return jsMatch[1];
  }

  const pyMatch = line.match(/File "([^"]+\.py)"/);
  if (pyMatch) {
    return pyMatch[1];
  }

  const goMatch = line.match(/([^\s]+\.go):\d+/);
  if (goMatch) {
    return goMatch[1];
  }

  return null;
}

/**
 * Generate CI fix ticket description
 */
export function generateCIFixDescription(failure: ParsedFailure, scope: string[], _ciStatus: CIStatus): string {
  let desc = `## Task\n\nFix the CI failure detected in the latest run.\n\n`;

  desc += `## Failure Details\n\n`;
  desc += `**Type:** ${failure.type}\n`;
  if (failure.framework) desc += `**Framework:** ${failure.framework}\n`;
  desc += `**Message:** ${failure.message}\n`;
  if (failure.file) desc += `**File:** ${failure.file}${failure.line ? `:${failure.line}` : ''}\n`;

  if (failure.stackTrace?.length) {
    desc += `\n**Stack Trace:**\n\`\`\`\n${failure.stackTrace.join('\n')}\n\`\`\`\n`;
  }

  desc += `\n## Constraints\n\n`;
  desc += `You may ONLY modify these files:\n`;
  for (const file of scope) {
    desc += `- ${file}\n`;
  }

  desc += `\nDo NOT:\n`;
  desc += `- Add new dependencies\n`;
  desc += `- Modify unrelated code\n`;
  desc += `- Change test expectations unless the test itself is wrong\n`;
  desc += `- Skip or disable the failing test\n`;

  desc += `\n## Expected Outcome\n\n`;
  desc += `After your changes:\n`;
  desc += `1. The failing test/check should pass\n`;
  desc += `2. No other tests should break\n`;
  desc += `3. The code should be correct, not just passing\n`;

  return desc;
}

/**
 * Generate actionable recommendations for Spindle abort
 */
export function generateSpindleRecommendations(
  trigger: 'oscillation' | 'spinning' | 'stalling' | 'repetition' | 'token_budget' | 'qa_ping_pong' | 'command_failure',
  ticket: { allowedPaths: string[]; forbiddenPaths: string[] },
  config: { tokenBudgetAbort: number; maxStallIterations: number; similarityThreshold: number }
): string[] {
  const recommendations: string[] = [];

  switch (trigger) {
    case 'token_budget':
      recommendations.push(
        `Increase token limit: config.spindle.tokenBudgetAbort (current: ${config.tokenBudgetAbort})`,
        'Break ticket into smaller, focused tasks',
        'Narrow scope with more specific allowed_paths'
      );
      break;
    case 'stalling':
      recommendations.push(
        'Agent may be stuck - check if requirements are clear',
        'Review ticket description for ambiguity',
        `Decrease stall threshold: config.spindle.maxStallIterations (current: ${config.maxStallIterations})`
      );
      break;
    case 'oscillation':
      recommendations.push(
        'Agent is flip-flopping between approaches',
        'Clarify the desired solution in ticket description',
        'Add constraints to narrow valid solutions'
      );
      break;
    case 'repetition':
      recommendations.push(
        'Agent is repeating similar outputs',
        'Check if the task is achievable with current context',
        `Adjust similarity threshold: config.spindle.similarityThreshold (current: ${config.similarityThreshold})`
      );
      break;
    case 'spinning':
      recommendations.push(
        'Agent has high activity but no progress',
        'Simplify the task requirements',
        'Check for circular dependencies in the codebase'
      );
      break;
    case 'qa_ping_pong':
      recommendations.push(
        'QA failures are alternating between two error types',
        'Fix one issue fully before addressing the next',
        'Check if fixes for one issue are causing the other'
      );
      break;
    case 'command_failure':
      recommendations.push(
        'Same command keeps failing with the same error',
        'Manual intervention needed — the issue may be environmental',
        'Check test/lint config for issues outside the ticket scope'
      );
      break;
  }

  recommendations.push(
    'View full diagnostics: promptwheel solo artifacts --type spindle',
    'Disable Spindle (not recommended): config.spindle.enabled = false'
  );

  return recommendations;
}
