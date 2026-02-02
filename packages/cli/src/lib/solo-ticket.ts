/**
 * Solo mode ticket execution
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import chalk from 'chalk';
import type { DatabaseAdapter } from '@blockspool/core/db';
import {
  runQa,
  getQaRunDetails,
} from '@blockspool/core/services';
import { projects, tickets, runs, runSteps, type StepKind } from '@blockspool/core/repos';
import {
  writeJsonArtifact,
  type RunSummaryArtifact,
  type ViolationsArtifact,
} from '../lib/artifacts.js';
import {
  checkScopeViolations,
  parseChangedFiles,
  analyzeViolationsForExpansion,
} from '../lib/scope.js';
import {
  checkSpindleLoop,
  createSpindleState,
  DEFAULT_SPINDLE_CONFIG,
  formatSpindleResult,
  recordCommandFailure,
  getFileEditWarnings,
  type SpindleConfig,
} from '../lib/spindle/index.js';
import { createExecRunner } from '../lib/exec.js';
import { createLogger } from '../lib/logger.js';
import type { SoloConfig } from './solo-config.js';
import { getBlockspoolDir, getAdapter } from './solo-config.js';
import { normalizeQaConfig } from './solo-utils.js';
import { withGitMutex, gitExec, cleanupWorktree } from './solo-git.js';
import { generateSpindleRecommendations } from './solo-ci.js';
import { ClaudeExecutionBackend, type ExecutionBackend } from './execution-backends/index.js';

/**
 * Canonical failure reasons for run results
 */
export type FailureReason =
  | 'agent_error'
  | 'scope_violation'
  | 'spindle_abort'
  | 'qa_failed'
  | 'git_error'
  | 'pr_error'
  | 'timeout'
  | 'cancelled';

/**
 * Outcome type for successful completions that don't involve code changes
 */
export type CompletionOutcome =
  | 'no_changes_needed';

/**
 * Spindle abort details for diagnostics
 */
export interface SpindleAbortDetails {
  trigger: 'oscillation' | 'spinning' | 'stalling' | 'repetition' | 'token_budget' | 'qa_ping_pong' | 'command_failure';
  confidence: number;
  estimatedTokens: number;
  iteration: number;
  thresholds: {
    similarityThreshold: number;
    maxSimilarOutputs: number;
    maxStallIterations: number;
    tokenBudgetWarning: number;
    tokenBudgetAbort: number;
  };
  metrics: {
    similarityScore?: number;
    iterationsWithoutChange?: number;
    repeatedPatterns?: string[];
    oscillationPattern?: string;
  };
  recommendations: string[];
  artifactPath: string;
}

/**
 * Result of running a ticket
 */
export interface RunTicketResult {
  success: boolean;
  branchName?: string;
  prUrl?: string;
  durationMs: number;
  error?: string;
  failureReason?: FailureReason;
  completionOutcome?: CompletionOutcome;
  spindle?: SpindleAbortDetails;
  artifacts?: {
    execution?: string;
    diff?: string;
    violations?: string;
    spindle?: string;
    runSummary?: string;
  };
  scopeExpanded?: {
    addedPaths: string[];
    newRetryCount: number;
  };
}

/**
 * Exit codes for solo run
 */
export const EXIT_CODES = {
  SUCCESS: 0,
  FAILURE: 1,
  SPINDLE_ABORT: 2,
  SIGINT: 130,
} as const;

/**
 * Options for running a ticket
 */
export interface RunTicketOptions {
  ticket: Awaited<ReturnType<typeof tickets.getById>> & {};
  repoRoot: string;
  config: SoloConfig | null;
  adapter: Awaited<ReturnType<typeof getAdapter>>;
  runId: string;
  skipQa: boolean;
  createPr: boolean;
  draftPr?: boolean;
  timeoutMs: number;
  verbose: boolean;
  onProgress: (msg: string) => void;
  /** Override the base branch for worktree creation (e.g. milestone branch) */
  baseBranch?: string;
  /** Skip pushing the branch to origin */
  skipPush?: boolean;
  /** Skip PR creation even if createPr is true */
  skipPr?: boolean;
  /** Execution backend override (default: ClaudeExecutionBackend) */
  executionBackend?: ExecutionBackend;
  /** Project guidelines context to prepend to execution prompt */
  guidelinesContext?: string;
  /** Learnings context to prepend to execution prompt */
  learningsContext?: string;
  /** Project metadata context to prepend to execution prompt */
  metadataContext?: string;
  /** If true, retry QA failures by expanding scope to include test files and fixing them */
  qaRetryWithTestFix?: boolean;
}

/**
 * Execution step definitions
 */
const EXECUTE_STEPS = [
  { name: 'worktree', kind: 'git' as StepKind },
  { name: 'agent', kind: 'internal' as StepKind },
  { name: 'scope', kind: 'internal' as StepKind },
  { name: 'commit', kind: 'git' as StepKind },
  { name: 'push', kind: 'git' as StepKind },
  { name: 'qa', kind: 'command' as StepKind },
  { name: 'pr', kind: 'git' as StepKind },
  { name: 'cleanup', kind: 'internal' as StepKind },
] as const;

export type StepName = typeof EXECUTE_STEPS[number]['name'];

/**
 * Build the prompt for Claude from a ticket
 */
export function buildTicketPrompt(ticket: NonNullable<Awaited<ReturnType<typeof tickets.getById>>>, guidelinesContext?: string, learningsContext?: string, metadataContext?: string): string {
  const parts: string[] = [];

  if (guidelinesContext) {
    parts.push(guidelinesContext, '');
  }

  if (metadataContext) {
    parts.push(metadataContext, '');
  }

  if (learningsContext) {
    parts.push(learningsContext, '');
  }

  parts.push(
    `# Task: ${ticket.title}`,
    '',
    ticket.description ?? '',
    '',
  );

  if (ticket.allowedPaths.length > 0) {
    parts.push('## Allowed Paths');
    parts.push('Only modify files in these paths:');
    for (const p of ticket.allowedPaths) {
      parts.push(`- ${p}`);
    }
    parts.push('');
  }

  if (ticket.forbiddenPaths.length > 0) {
    parts.push('## Forbidden Paths');
    parts.push('Do NOT modify files in these paths:');
    for (const p of ticket.forbiddenPaths) {
      parts.push(`- ${p}`);
    }
    parts.push('');
  }

  if (ticket.verificationCommands.length > 0) {
    parts.push('## Verification');
    parts.push('After making changes, verify with:');
    for (const cmd of ticket.verificationCommands) {
      parts.push(`- \`${cmd}\``);
    }
    parts.push('');
  }

  parts.push('## Instructions');
  parts.push('1. Analyze the codebase to understand the context');
  parts.push('2. Implement the required changes');
  parts.push('3. Ensure all verification commands pass');
  parts.push('4. Keep changes minimal and focused');

  return parts.join('\n');
}

// Re-export execution backend types and implementations from modular directory
export type { ClaudeResult, ExecutionBackend } from './execution-backends/index.js';
export { ClaudeExecutionBackend, runClaude, CodexExecutionBackend, KimiExecutionBackend } from './execution-backends/index.js';




/**
 * Check if a QA failure is a test failure (vitest/jest/pytest etc.)
 */
function isTestFailure(failedStepName: string | undefined): boolean {
  if (!failedStepName) return false;
  const lower = failedStepName.toLowerCase();
  return /test|vitest|jest|pytest|mocha|karma/.test(lower);
}

/**
 * Extract test file paths from QA error output
 */
function extractTestFilesFromQaOutput(output: string): string[] {
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

/**
 * Execute a ticket in isolation with step tracking
 *
 * Steps tracked: worktree → agent → commit → push → qa → pr → cleanup
 */
export async function soloRunTicket(opts: RunTicketOptions): Promise<RunTicketResult> {
  const {
    ticket,
    repoRoot,
    config,
    adapter,
    runId,
    skipQa,
    createPr,
    draftPr = false,
    timeoutMs,
    verbose,
    onProgress,
  } = opts;

  const startTime = Date.now();
  const branchName = `blockspool/${ticket.id}`;
  const worktreePath = path.join(repoRoot, '.blockspool', 'worktrees', ticket.id);
  const baseDir = getBlockspoolDir(repoRoot);

  // Create all steps upfront
  const stepRecords = new Map<StepName, Awaited<ReturnType<typeof runSteps.create>>>();

  for (let i = 0; i < EXECUTE_STEPS.length; i++) {
    const stepDef = EXECUTE_STEPS[i];
    const step = await runSteps.create(adapter, {
      runId,
      ordinal: i,
      name: stepDef.name,
      kind: stepDef.kind,
    });
    stepRecords.set(stepDef.name, step);
  }

  // Track artifact paths for run summary
  const artifactPaths: {
    execution?: string;
    diff?: string;
    violations?: string;
    spindle?: string;
  } = {};

  // Initialize Spindle state for loop detection
  const spindleConfig: SpindleConfig = {
    ...DEFAULT_SPINDLE_CONFIG,
    ...config?.spindle,
  };
  const spindleState = createSpindleState();

  // Track step results for run summary
  const stepResults: Array<{
    name: string;
    status: 'success' | 'failed' | 'skipped';
    startedAt?: number;
    completedAt?: number;
    errorMessage?: string;
  }> = [];

  // Helper to save run summary artifact
  async function saveRunSummary(result: RunTicketResult): Promise<string> {
    const summary: RunSummaryArtifact = {
      runId,
      ticketId: ticket.id,
      ticketTitle: ticket.title,
      projectId: ticket.projectId,
      success: result.success,
      startedAt: new Date(startTime).toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: result.durationMs,
      branchName: result.branchName,
      prUrl: result.prUrl,
      error: result.error,
      steps: stepResults.map(s => ({
        name: s.name,
        status: s.status,
        durationMs: s.startedAt && s.completedAt ? s.completedAt - s.startedAt : undefined,
        errorMessage: s.errorMessage,
      })),
      artifacts: artifactPaths,
    };

    return writeJsonArtifact({
      baseDir,
      type: 'runs',
      id: runId,
      data: summary,
    });
  }

  // Helper to mark step progress
  async function markStep(name: StepName, status: 'started' | 'success' | 'failed' | 'skipped', markOpts?: {
    errorMessage?: string;
    metadata?: Record<string, unknown>;
  }) {
    const step = stepRecords.get(name);
    if (!step) return;

    onProgress(`${name}...`);

    let stepResult = stepResults.find(s => s.name === name);
    if (!stepResult) {
      stepResult = { name, status: 'skipped' };
      stepResults.push(stepResult);
    }

    switch (status) {
      case 'started':
        stepResult.startedAt = Date.now();
        await runSteps.markStarted(adapter, step.id);
        break;
      case 'success':
        stepResult.status = 'success';
        stepResult.completedAt = Date.now();
        await runSteps.markSuccess(adapter, step.id, markOpts);
        break;
      case 'failed':
        stepResult.status = 'failed';
        stepResult.completedAt = Date.now();
        stepResult.errorMessage = markOpts?.errorMessage;
        await runSteps.markFailed(adapter, step.id, {
          errorMessage: markOpts?.errorMessage,
          metadata: markOpts?.metadata,
        });
        break;
      case 'skipped':
        stepResult.status = 'skipped';
        stepResult.errorMessage = markOpts?.errorMessage;
        await runSteps.markSkipped(adapter, step.id, markOpts?.errorMessage);
        break;
    }
  }

  // Helper to mark remaining steps as skipped
  async function skipRemaining(fromIndex: number, reason: string) {
    for (let i = fromIndex; i < EXECUTE_STEPS.length; i++) {
      await markStep(EXECUTE_STEPS[i].name, 'skipped', { errorMessage: reason });
    }
  }

  try {
    // Step 1: Create worktree
    await markStep('worktree', 'started');

    const worktreesDir = path.join(repoRoot, '.blockspool', 'worktrees');
    if (!fs.existsSync(worktreesDir)) {
      fs.mkdirSync(worktreesDir, { recursive: true });
    }

    let baseBranch = 'master';
    await withGitMutex(async () => {
      if (fs.existsSync(worktreePath)) {
        await gitExec(`git worktree remove --force "${worktreePath}"`, { cwd: repoRoot });
      }

      if (opts.baseBranch) {
        // Use provided base branch (e.g. milestone branch)
        baseBranch = opts.baseBranch;
      } else {
        let detectedBranch = 'master';
        try {
          const remoteHead = (await gitExec('git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null || echo "refs/remotes/origin/master"', { cwd: repoRoot })).trim();
          detectedBranch = remoteHead.replace('refs/remotes/origin/', '');
        } catch {
          // Fall back to master
        }
        baseBranch = detectedBranch;

        try {
          await gitExec(`git fetch origin ${baseBranch}`, { cwd: repoRoot });
        } catch {
          // Fetch failed, continue with what we have
        }
      }

      const branchBase = opts.baseBranch ? opts.baseBranch : `origin/${baseBranch}`;
      try {
        await gitExec(`git branch "${branchName}" "${branchBase}"`, { cwd: repoRoot });
      } catch {
        // Branch already exists
      }
      await gitExec(`git worktree add "${worktreePath}" "${branchName}"`, { cwd: repoRoot });
    });

    await markStep('worktree', 'success', { metadata: { branchName, worktreePath } });

    // Step 2: Run agent
    await markStep('agent', 'started');

    const prompt = buildTicketPrompt(ticket, opts.guidelinesContext, opts.learningsContext, opts.metadataContext);
    const execBackend: ExecutionBackend = opts.executionBackend ?? new ClaudeExecutionBackend();

    const claudeResult = await execBackend.run({
      worktreePath,
      prompt,
      timeoutMs,
      verbose,
      onProgress: verbose ? onProgress : () => {},
    });

    // Save agent artifact
    const agentArtifactPath = writeJsonArtifact({
      baseDir,
      type: 'executions',
      id: runId,
      data: {
        runId,
        ticketId: ticket.id,
        prompt,
        stdout: claudeResult.stdout,
        stderr: claudeResult.stderr,
        exitCode: claudeResult.exitCode,
        timedOut: claudeResult.timedOut,
        durationMs: claudeResult.durationMs,
      },
    });
    artifactPaths.execution = agentArtifactPath;

    if (!claudeResult.success) {
      await markStep('agent', 'failed', {
        errorMessage: claudeResult.error ?? 'Agent execution failed',
        metadata: { artifactPath: agentArtifactPath },
      });
      await skipRemaining(2, 'Agent failed');
      await cleanupWorktree(repoRoot, worktreePath);

      const baseError = claudeResult.error ?? 'Claude execution failed';
      const errorParts = [
        claudeResult.timedOut ? 'Agent timed out' : 'Agent execution failed',
        `  ${baseError}`,
        '',
      ];

      if (claudeResult.timedOut) {
        errorParts.push('The agent exceeded its time limit.');
        errorParts.push('Consider breaking down the ticket into smaller tasks.');
      }

      errorParts.push(`To retry: blockspool solo run ${ticket.id}`);
      errorParts.push(`Execution logs: ${agentArtifactPath}`);

      const result: RunTicketResult = {
        success: false,
        durationMs: Date.now() - startTime,
        error: errorParts.join('\n'),
        failureReason: claudeResult.timedOut ? 'timeout' : 'agent_error',
        artifacts: { ...artifactPaths },
      };
      await saveRunSummary(result);
      return result;
    }

    await markStep('agent', 'success', {
      metadata: { artifactPath: agentArtifactPath, durationMs: claudeResult.durationMs },
    });

    // Spindle check
    if (spindleConfig.enabled) {
      let prelimDiff: string | null = null;
      try {
        prelimDiff = (await gitExec('git diff', {
          cwd: worktreePath,
          maxBuffer: 10 * 1024 * 1024,
        })).trim();
      } catch {
        // Ignore diff errors for Spindle check
      }

      const spindleCheck = checkSpindleLoop(
        spindleState,
        claudeResult.stdout,
        prelimDiff,
        spindleConfig
      );

      for (const warning of spindleState.warnings) {
        onProgress(`⚠ ${warning}`);
      }
      spindleState.warnings = [];

      if (spindleCheck.shouldAbort) {
        const trigger = spindleCheck.reason as SpindleAbortDetails['trigger'];
        const recommendations = generateSpindleRecommendations(trigger, ticket, spindleConfig);

        const spindleArtifactData = {
          runId,
          ticketId: ticket.id,
          triggeredAtMs: Date.now(),
          iteration: spindleState.outputs.length,
          reason: trigger,
          metrics: {
            similarity: spindleCheck.diagnostics.similarityScore,
            similarOutputs: spindleState.outputs.length,
            stallIterations: spindleCheck.diagnostics.iterationsWithoutChange,
            estimatedTokens: spindleState.estimatedTokens,
            repeatedPatterns: spindleCheck.diagnostics.repeatedPatterns,
            oscillationPattern: spindleCheck.diagnostics.oscillationPattern,
          },
          thresholds: {
            similarityThreshold: spindleConfig.similarityThreshold,
            maxSimilarOutputs: spindleConfig.maxSimilarOutputs,
            maxStallIterations: spindleConfig.maxStallIterations,
            tokenBudgetWarning: spindleConfig.tokenBudgetWarning,
            tokenBudgetAbort: spindleConfig.tokenBudgetAbort,
          },
          pointers: {
            agentExecution: artifactPaths.execution,
          },
          recommendations,
          recentOutputs: spindleState.outputs.slice(-3),
          recentDiffs: spindleState.diffs.slice(-3),
          formatted: formatSpindleResult(spindleCheck),
        };

        const spindleArtifactPath = writeJsonArtifact({
          baseDir,
          type: 'spindle',
          id: runId,
          data: spindleArtifactData,
        });
        artifactPaths.spindle = spindleArtifactPath;

        const spindleDetails: SpindleAbortDetails = {
          trigger,
          confidence: spindleCheck.confidence,
          estimatedTokens: spindleState.estimatedTokens,
          iteration: spindleState.outputs.length,
          thresholds: {
            similarityThreshold: spindleConfig.similarityThreshold,
            maxSimilarOutputs: spindleConfig.maxSimilarOutputs,
            maxStallIterations: spindleConfig.maxStallIterations,
            tokenBudgetWarning: spindleConfig.tokenBudgetWarning,
            tokenBudgetAbort: spindleConfig.tokenBudgetAbort,
          },
          metrics: {
            similarityScore: spindleCheck.diagnostics.similarityScore,
            iterationsWithoutChange: spindleCheck.diagnostics.iterationsWithoutChange,
            repeatedPatterns: spindleCheck.diagnostics.repeatedPatterns,
            oscillationPattern: spindleCheck.diagnostics.oscillationPattern,
          },
          recommendations,
          artifactPath: spindleArtifactPath,
        };

        onProgress(`Spindle loop detected: ${trigger}`);
        onProgress(`  Confidence: ${(spindleCheck.confidence * 100).toFixed(0)}%`);
        onProgress(`  Tokens: ~${spindleState.estimatedTokens.toLocaleString()}`);

        await skipRemaining(2, `Spindle loop: ${trigger}`);
        await cleanupWorktree(repoRoot, worktreePath);

        const result: RunTicketResult = {
          success: false,
          durationMs: Date.now() - startTime,
          error: `Spindle loop detected: ${trigger} (confidence: ${(spindleCheck.confidence * 100).toFixed(0)}%)`,
          failureReason: 'spindle_abort',
          spindle: spindleDetails,
          artifacts: { ...artifactPaths },
        };
        await saveRunSummary(result);
        return result;
      }

      // Handle shouldBlock (command_failure → needs human intervention)
      if (spindleCheck.shouldBlock) {
        onProgress(`Spindle blocked: ${spindleCheck.reason} — needs human intervention`);
        for (const w of getFileEditWarnings(spindleState, spindleConfig.maxFileEdits)) {
          onProgress(`  ⚠ ${w}`);
        }

        await skipRemaining(2, `Spindle blocked: ${spindleCheck.reason}`);
        await cleanupWorktree(repoRoot, worktreePath);

        const result: RunTicketResult = {
          success: false,
          durationMs: Date.now() - startTime,
          error: `Spindle blocked: ${spindleCheck.reason} (needs human intervention)`,
          failureReason: 'spindle_abort',
          artifacts: { ...artifactPaths },
        };
        await saveRunSummary(result);
        return result;
      }
    }

    // Step 3: Scope check
    await markStep('scope', 'started');

    const statusOutput = (await gitExec('git status --porcelain', {
      cwd: worktreePath,
    })).trim();

    if (!statusOutput) {
      await markStep('scope', 'success', { errorMessage: 'No changes needed' });
      await skipRemaining(3, 'No changes needed');
      await cleanupWorktree(repoRoot, worktreePath);
      const result: RunTicketResult = {
        success: true,
        durationMs: Date.now() - startTime,
        completionOutcome: 'no_changes_needed',
        artifacts: { ...artifactPaths },
      };
      await saveRunSummary(result);
      return result;
    }

    const changedFiles = parseChangedFiles(statusOutput);
    const violations = checkScopeViolations(
      changedFiles,
      ticket.allowedPaths,
      ticket.forbiddenPaths
    );

    if (violations.length > 0) {
      const violationsData: ViolationsArtifact = {
        runId,
        ticketId: ticket.id,
        changedFiles,
        allowedPaths: ticket.allowedPaths,
        forbiddenPaths: ticket.forbiddenPaths,
        violations,
      };
      const violationsArtifactPath = writeJsonArtifact({
        baseDir,
        type: 'violations',
        id: runId,
        data: violationsData,
      });
      artifactPaths.violations = violationsArtifactPath;

      const canAutoRetry = ticket.retryCount < ticket.maxRetries;
      const expansionResult = canAutoRetry
        ? analyzeViolationsForExpansion(violations, ticket.allowedPaths)
        : { canExpand: false, expandedPaths: ticket.allowedPaths, addedPaths: [], reason: 'Max retries exceeded' };

      if (expansionResult.canExpand && expansionResult.addedPaths.length > 0) {
        const newRetryCount = ticket.retryCount + 1;

        await adapter.query(
          `UPDATE tickets SET
            allowed_paths = $1,
            retry_count = $2,
            status = 'ready',
            updated_at = datetime('now')
          WHERE id = $3`,
          [JSON.stringify(expansionResult.expandedPaths), newRetryCount, ticket.id]
        );

        await markStep('scope', 'failed', {
          errorMessage: `Scope expanded: +${expansionResult.addedPaths.length} paths, retry ${newRetryCount}/${ticket.maxRetries}`,
          metadata: { violations, expansionResult, artifactPath: violationsArtifactPath },
        });
        await skipRemaining(4, 'Scope expansion - retry scheduled');
        await cleanupWorktree(repoRoot, worktreePath);

        const result: RunTicketResult = {
          success: false,
          durationMs: Date.now() - startTime,
          error: `Scope auto-expanded: ${expansionResult.addedPaths.join(', ')}`,
          failureReason: 'scope_violation',
          artifacts: { ...artifactPaths },
          scopeExpanded: {
            addedPaths: expansionResult.addedPaths,
            newRetryCount,
          },
        };
        await saveRunSummary(result);
        return result;
      }

      const violationSummary = violations
        .map(v => v.violation === 'in_forbidden'
          ? `${v.file} (forbidden by ${v.pattern})`
          : `${v.file} (not in allowed paths)`)
        .join(', ');

      await markStep('scope', 'failed', {
        errorMessage: `Scope violations: ${violationSummary}`,
        metadata: { violations, expansionResult, artifactPath: violationsArtifactPath },
      });
      await skipRemaining(4, 'Scope violations');
      await cleanupWorktree(repoRoot, worktreePath);

      const violationDetails = violations
        .map(v => v.violation === 'in_forbidden'
          ? `  ${v.file} (forbidden by ${v.pattern})`
          : `  ${v.file} (not in allowed_paths)`)
        .join('\n');
      const blockReason = expansionResult.reason
        ? `\nNote: ${expansionResult.reason}`
        : '';
      const errorMessage = [
        `Scope violation: Changes outside allowed paths`,
        violationDetails,
        blockReason,
        ``,
        `To fix: blockspool solo retry ${ticket.id}`,
        `  This regenerates allowed_paths and resets the ticket to 'ready'`,
      ].join('\n');

      const result: RunTicketResult = {
        success: false,
        durationMs: Date.now() - startTime,
        error: errorMessage,
        failureReason: 'scope_violation',
        artifacts: { ...artifactPaths },
      };
      await saveRunSummary(result);
      return result;
    }

    await markStep('scope', 'success', {
      metadata: { filesChecked: changedFiles.length },
    });

    // Step 4: Commit changes
    await markStep('commit', 'started');

    const diffOutput = await gitExec('git diff HEAD', {
      cwd: worktreePath,
      maxBuffer: 10 * 1024 * 1024,
    });

    const diffArtifactPath = writeJsonArtifact({
      baseDir,
      type: 'diffs',
      id: runId,
      data: {
        runId,
        ticketId: ticket.id,
        diff: diffOutput,
        filesChanged: statusOutput.split('\n').length,
        changedFiles,
      },
    });
    artifactPaths.diff = diffArtifactPath;

    await gitExec('git add -A', { cwd: worktreePath });
    await gitExec(
      `git commit -m "${ticket.title.replace(/"/g, '\\"')}"`,
      { cwd: worktreePath }
    );

    await markStep('commit', 'success', { metadata: { diffArtifactPath } });

    // Step 5: Push branch
    if (opts.skipPush) {
      await markStep('push', 'skipped', { errorMessage: 'Skipped (milestone mode)' });
    } else {
      await markStep('push', 'started');

      try {
        const { assertPushSafe } = await import('./solo-remote.js');
        await assertPushSafe(worktreePath, config?.allowedRemote);
        await gitExec(`git push -u origin "${branchName}"`, { cwd: worktreePath });
        await markStep('push', 'success');
      } catch (pushError) {
        await markStep('push', 'failed', {
          errorMessage: pushError instanceof Error ? pushError.message : String(pushError),
        });
        await skipRemaining(5, 'Push failed');
        await cleanupWorktree(repoRoot, worktreePath);
        const result = {
          success: false,
          branchName,
          durationMs: Date.now() - startTime,
          error: `Push failed: ${pushError instanceof Error ? pushError.message : pushError}`,
        };
        await saveRunSummary(result);
        return result;
      }
    }

    // Step 6: Run QA
    if (!skipQa && config?.qa?.commands?.length) {
      await markStep('qa', 'started');

      const qaConfig = normalizeQaConfig(config);
      const exec = createExecRunner({
        defaultMaxLogBytes: qaConfig.artifacts.maxLogBytes,
        defaultTailBytes: qaConfig.artifacts.tailBytes,
      });
      const logger = createLogger({ quiet: true });

      const project = await projects.ensureForRepo(adapter, {
        name: path.basename(repoRoot),
        rootPath: repoRoot,
      });

      const qaResult = await runQa(
        { db: adapter, exec, logger },
        {
          projectId: project.id,
          repoRoot: worktreePath,
          config: qaConfig,
        }
      );

      if (qaResult.status !== 'success') {
        await markStep('qa', 'failed', {
          errorMessage: `QA failed at ${qaResult.failedAt?.stepName ?? 'unknown step'}`,
          metadata: { qaRunId: qaResult.runId },
        });
        await skipRemaining(6, 'QA failed');

        const failedStep = qaResult.failedAt?.stepName ?? 'unknown step';

        // Record command failure for spindle tracking
        recordCommandFailure(spindleState, failedStep, `QA failed at ${failedStep}`);

        const errorParts = [`QA failed at: ${failedStep}`];

        const qaDetails = await getQaRunDetails(adapter, qaResult.runId);
        if (qaDetails) {
          const failedStepInfo = qaDetails.steps.find(
            s => s.name === failedStep && s.status === 'failed'
          );
          if (failedStepInfo) {
            const errorOutput = failedStepInfo.stderrTail || failedStepInfo.stdoutTail;
            if (errorOutput) {
              const truncated = errorOutput.length > 500
                ? '...' + errorOutput.slice(-497)
                : errorOutput;
              errorParts.push('');
              errorParts.push('Error output:');
              errorParts.push(truncated.split('\n').map(l => `  ${l}`).join('\n'));
            }
            if (failedStepInfo.errorMessage) {
              errorParts.push('');
              errorParts.push(`Error: ${failedStepInfo.errorMessage}`);
            }
          }
        }

        // QA retry with test-fix scope expansion
        const failedStepName = qaResult.failedAt?.stepName;
        if (opts.qaRetryWithTestFix && isTestFailure(failedStepName)) {
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
          if (testFiles.length > 0) {
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
              opts.guidelinesContext,
              opts.learningsContext,
              opts.metadataContext,
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
                await gitExec('git add -A', { cwd: worktreePath });
                try {
                  await gitExec(
                    `git commit -m "fix: update tests for ${ticket.title.replace(/"/g, '\\"')}"`,
                    { cwd: worktreePath },
                  );
                } catch {
                  // No new changes to commit — that's fine
                }

                // Re-run QA
                const retryQaResult = await runQa(
                  { db: adapter, exec, logger },
                  { projectId: project.id, repoRoot: worktreePath, config: qaConfig },
                );

                if (retryQaResult.status === 'success') {
                  onProgress('QA retry succeeded after fixing tests');
                  await markStep('qa', 'success', { metadata: { qaRunId: retryQaResult.runId, qaRetried: true } });
                  // Fall through to push/PR steps below
                } else {
                  // Second failure — give up
                  errorParts.push('');
                  errorParts.push('(QA retry with test-fix also failed)');
                  errorParts.push(`To retry: blockspool solo run ${ticket.id}`);
                  errorParts.push(`Worktree preserved for inspection: ${worktreePath}`);

                  const result = {
                    success: false,
                    branchName,
                    durationMs: Date.now() - startTime,
                    error: errorParts.join('\n'),
                    failureReason: 'qa_failed' as FailureReason,
                  };
                  await saveRunSummary(result);
                  return result;
                }
              } else {
                // Agent retry failed
                errorParts.push('');
                errorParts.push('(QA retry agent execution failed)');
                errorParts.push(`To retry: blockspool solo run ${ticket.id}`);
                errorParts.push(`Worktree preserved for inspection: ${worktreePath}`);

                const result = {
                  success: false,
                  branchName,
                  durationMs: Date.now() - startTime,
                  error: errorParts.join('\n'),
                  failureReason: 'qa_failed' as FailureReason,
                };
                await saveRunSummary(result);
                return result;
              }
            } catch {
              // Retry mechanism failed — fall through to original error
              errorParts.push('');
              errorParts.push(`To retry: blockspool solo run ${ticket.id}`);
              errorParts.push(`Worktree preserved for inspection: ${worktreePath}`);

              const result = {
                success: false,
                branchName,
                durationMs: Date.now() - startTime,
                error: errorParts.join('\n'),
                failureReason: 'qa_failed' as FailureReason,
              };
              await saveRunSummary(result);
              return result;
            }
          } else {
            // No test files found — can't retry
            errorParts.push('');
            errorParts.push(`To retry: blockspool solo run ${ticket.id}`);
            errorParts.push(`Worktree preserved for inspection: ${worktreePath}`);

            const result = {
              success: false,
              branchName,
              durationMs: Date.now() - startTime,
              error: errorParts.join('\n'),
              failureReason: 'qa_failed' as FailureReason,
            };
            await saveRunSummary(result);
            return result;
          }
        } else {
          errorParts.push('');
          errorParts.push(`To retry: blockspool solo run ${ticket.id}`);
          errorParts.push(`Worktree preserved for inspection: ${worktreePath}`);

          const result = {
            success: false,
            branchName,
            durationMs: Date.now() - startTime,
            error: errorParts.join('\n'),
            failureReason: 'qa_failed' as FailureReason,
          };
          await saveRunSummary(result);
          return result;
        }
      }

      await markStep('qa', 'success', { metadata: { qaRunId: qaResult.runId } });
    } else {
      await markStep('qa', 'skipped', { errorMessage: skipQa ? 'Skipped by flag' : 'No QA configured' });
    }

    // Step 7: Create PR
    let prUrl: string | undefined;
    if (opts.skipPr) {
      await markStep('pr', 'skipped', { errorMessage: 'Skipped (milestone mode)' });
    } else if (createPr) {
      await markStep('pr', 'started');

      try {
        const { assertPushSafe: assertPrSafe } = await import('./solo-remote.js');
        await assertPrSafe(worktreePath, config?.allowedRemote);
        const prBody = `## Summary\n\n${ticket.description ?? ticket.title}\n\n---\n_Created by BlockSpool_`;
        const draftFlag = draftPr ? ' --draft' : '';

        const prOutput = (await gitExec(
          `gh pr create --title "${ticket.title.replace(/"/g, '\\"')}" --body "${prBody.replace(/"/g, '\\"')}" --head "${branchName}"${draftFlag}`,
          { cwd: worktreePath }
        )).trim();

        const urlMatch = prOutput.match(/https:\/\/github\.com\/[^\s]+/);
        prUrl = urlMatch ? urlMatch[0] : undefined;

        await markStep('pr', 'success', { metadata: { prUrl } });
      } catch (prError) {
        await markStep('pr', 'failed', {
          errorMessage: prError instanceof Error ? prError.message : String(prError),
        });
        onProgress(`PR creation failed: ${prError instanceof Error ? prError.message : prError}`);
      }
    } else {
      await markStep('pr', 'skipped', { errorMessage: 'Not requested' });
    }

    // Step 8: Clean up worktree
    await markStep('cleanup', 'started');
    await cleanupWorktree(repoRoot, worktreePath);
    await markStep('cleanup', 'success');

    const result = {
      success: true,
      branchName,
      prUrl,
      durationMs: Date.now() - startTime,
    };
    await saveRunSummary(result);
    return result;

  } catch (error) {
    await cleanupWorktree(repoRoot, worktreePath);

    const result = {
      success: false,
      durationMs: Date.now() - startTime,
      error: error instanceof Error ? error.message : String(error),
    };
    await saveRunSummary(result);
    return result;
  }
}
