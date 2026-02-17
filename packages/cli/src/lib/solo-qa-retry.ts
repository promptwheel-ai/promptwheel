/**
 * QA failure detection and retry-with-test-fix logic
 */

import type { DatabaseAdapter } from '@promptwheel/core/db';
import { runQa, getQaRunDetails } from '@promptwheel/core/services';
import type { tickets } from '@promptwheel/core/repos';
import { buildTicketPrompt } from './solo-prompt-builder.js';
import type { ExecutionBackend } from './execution-backends/index.js';
import { gitExecFile } from './solo-git.js';

/**
 * Check if a QA failure is a test failure (vitest/jest/pytest etc.)
 */
export function isTestFailure(failedStepName: string | undefined): boolean {
  if (!failedStepName) return false;
  const lower = failedStepName.toLowerCase();
  return /test|vitest|jest|pytest|mocha|karma/.test(lower);
}

/**
 * Extract test file paths from QA error output
 */
export function extractTestFilesFromQaOutput(output: string): string[] {
  const files = new Set<string>();
  // Match common test file path patterns
  const patterns = [
    // vitest/jest: "FAIL src/foo.test.ts" or "❌ src/foo.test.ts"
    /(?:FAIL|❌|✗)\s+([^\s]+\.(?:test|spec)\.[jt]sx?)/gi,
    // General file paths ending in .test.* or .spec.*
    /([a-zA-Z0-9_/.\\-]+\.(?:test|spec)\.[jt]sx?)/g,
    // Python test files
    /([a-zA-Z0-9_/.\\-]+test_[a-zA-Z0-9_]+\.py)/g,
    // __tests__ directory files
    /([a-zA-Z0-9_/.\\-]+\/__tests__\/[^\s]+\.[jt]sx?)/g,
  ];

  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(output)) !== null) {
      files.add(match[1]);
    }
  }

  return [...files];
}

export interface QaRetryContext {
  ticket: NonNullable<Awaited<ReturnType<typeof tickets.getById>>>;
  worktreePath: string;
  execBackend: ExecutionBackend;
  timeoutMs: number;
  verbose: boolean;
  onProgress: (msg: string) => void;
  adapter: DatabaseAdapter;
  projectId: string;
  qaConfig: any;
  guidelinesContext?: string;
  learningsContext?: string;
  metadataContext?: string;
  qaDetails: Awaited<ReturnType<typeof getQaRunDetails>>;
  failedStepName: string | undefined;
}

export interface QaRetryResult {
  retried: boolean;
  success: boolean;
  qaRunId?: string;
  errorParts?: string[];
}

/**
 * Attempt to retry a QA failure by expanding scope to include test files
 * and asking the agent to fix them.
 */
export async function runQaRetryWithTestFix(ctx: QaRetryContext): Promise<QaRetryResult> {
  const { ticket, worktreePath, execBackend, timeoutMs, verbose, onProgress, adapter, projectId, qaConfig, qaDetails, failedStepName } = ctx;

  if (!isTestFailure(failedStepName)) {
    return { retried: false, success: false };
  }

  onProgress('QA test failure — retrying with test files in scope...');

  // Gather error output for test file extraction
  let qaErrorOutput = '';
  if (qaDetails) {
    const failedStepInfo = qaDetails.steps.find(
      s => s.name === failedStepName && s.status === 'failed'
    );
    if (failedStepInfo) {
      qaErrorOutput = (failedStepInfo.stderrTail || '') + '\n' + (failedStepInfo.stdoutTail || '');
    }
  }

  const testFiles = extractTestFilesFromQaOutput(qaErrorOutput);
  if (testFiles.length === 0) {
    return { retried: false, success: false };
  }

  // Expand allowed_paths to include the test files
  const expandedPaths = [...new Set([...ticket.allowedPaths, ...testFiles])];

  const retryPrompt = [
    `Your changes broke these tests. Fix the tests to match the new behavior. Do NOT revert your changes.`,
    '',
    'Failed test files:',
    ...testFiles.map(f => `- ${f}`),
    '',
    'Error output:',
    qaErrorOutput.slice(-2000),
  ].join('\n');

  const fullRetryPrompt = buildTicketPrompt(
    { ...ticket, allowedPaths: expandedPaths } as typeof ticket,
    ctx.guidelinesContext,
    ctx.learningsContext,
    ctx.metadataContext,
  ) + '\n\n' + retryPrompt;

  try {
    const retryResult = await execBackend.run({
      worktreePath,
      prompt: fullRetryPrompt,
      timeoutMs,
      verbose,
      onProgress: verbose ? onProgress : () => {},
    });

    if (retryResult.success) {
      // Re-commit
      // Stage only files within ticket scope (allowed_paths + expanded test files)
      const filesToStage = [...new Set([...expandedPaths])];
      for (const filePattern of filesToStage) {
        try {
          await gitExecFile('git', ['add', filePattern], { cwd: worktreePath });
        } catch {
          // File may not exist or may not have changes — that's fine
        }
      }
      try {
        await gitExecFile('git', ['commit', '-m', `fix: update tests for ${ticket.title}`], { cwd: worktreePath });
      } catch {
        // No new changes to commit — that's fine
      }

      // Re-run QA
      const { createExecRunner } = await import('../lib/exec.js');
      const { createLogger } = await import('../lib/logger.js');
      const exec = createExecRunner({
        defaultMaxLogBytes: qaConfig.artifacts.maxLogBytes,
        defaultTailBytes: qaConfig.artifacts.tailBytes,
      });
      const logger = createLogger({ quiet: true });

      const retryQaResult = await runQa(
        { db: adapter, exec, logger },
        { projectId, repoRoot: worktreePath, config: qaConfig },
      );

      if (retryQaResult.status === 'success') {
        onProgress('QA retry succeeded after fixing tests');
        return { retried: true, success: true, qaRunId: retryQaResult.runId };
      } else {
        return { retried: true, success: false };
      }
    } else {
      return { retried: true, success: false };
    }
  } catch {
    return { retried: true, success: false };
  }
}
