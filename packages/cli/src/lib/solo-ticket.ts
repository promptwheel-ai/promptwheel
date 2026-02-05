/**
 * Solo mode ticket execution
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { DatabaseAdapter } from '@blockspool/core/db';
import {
  runQa,
  getQaRunDetails,
} from '@blockspool/core/services';
import { projects, tickets, runs, runSteps } from '@blockspool/core/repos';
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
import { buildExclusionIndex } from '../lib/exclusion-index.js';
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
import { getBlockspoolDir, type SoloConfig } from './solo-config.js';
import { normalizeQaConfig } from './solo-utils.js';
import { withGitMutex, gitExec, gitExecFile, cleanupWorktree } from './solo-git.js';
import { generateSpindleRecommendations } from './solo-ci.js';
import { ClaudeExecutionBackend, type ExecutionBackend } from './execution-backends/index.js';
import { buildTicketPrompt } from './solo-prompt-builder.js';
import { isTestFailure, extractTestFilesFromQaOutput } from './solo-qa-retry.js';
import { recordBaselineResult, recordQaCommandResult } from './qa-stats.js';
import { recordQualitySignal } from './run-state.js';
import type {
  FailureReason,
  RunTicketResult,
  RunTicketOptions,
  SpindleAbortDetails,
  StepName,
} from './solo-ticket-types.js';
import { EXECUTE_STEPS } from './solo-ticket-types.js';


const execFileAsync = promisify(execFile);

/**
 * Detect package manager from lockfiles and install deps in worktree.
 * Returns silently if no Node.js project detected or install fails.
 */
async function installWorktreeDeps(
  worktreePath: string,
  verbose: boolean,
  onProgress: (msg: string) => void,
): Promise<void> {
  // Only install if package.json exists but node_modules doesn't
  if (!fs.existsSync(path.join(worktreePath, 'package.json'))) return;
  if (fs.existsSync(path.join(worktreePath, 'node_modules'))) return;

  // Detect package manager from lockfiles
  let pm = 'npm';
  let installArgs = ['install', '--ignore-scripts', '--no-audit', '--no-fund'];
  if (fs.existsSync(path.join(worktreePath, 'pnpm-lock.yaml'))) {
    pm = 'pnpm';
    installArgs = ['install', '--frozen-lockfile', '--ignore-scripts'];
  } else if (fs.existsSync(path.join(worktreePath, 'yarn.lock'))) {
    pm = 'yarn';
    installArgs = ['install', '--frozen-lockfile', '--ignore-scripts'];
  } else if (fs.existsSync(path.join(worktreePath, 'bun.lockb')) || fs.existsSync(path.join(worktreePath, 'bun.lock'))) {
    pm = 'bun';
    installArgs = ['install', '--frozen-lockfile'];
  }

  onProgress(`Installing dependencies (${pm})...`);
  try {
    await execFileAsync(pm, installArgs, {
      cwd: worktreePath,
      timeout: 120_000, // 2 min cap
    });
  } catch (err) {
    // Non-fatal: agent can still try to install itself, or QA will catch it
    if (verbose) {
      const msg = err instanceof Error ? err.message : String(err);
      onProgress(`Warning: worktree dep install failed: ${msg}`);
    }
  }
}

export interface BaselineResult {
  passed: boolean;
  output?: string; // stderr/stdout from failed commands
}

/** Convert full baseline results to simple pass/fail map */
export function baselineToPassFail(baseline: Map<string, BaselineResult>): Map<string, boolean> {
  const result = new Map<string, boolean>();
  for (const [name, r] of baseline) {
    result.set(name, r.passed);
  }
  return result;
}

/**
 * Run QA commands to capture baseline pass/fail state.
 * Returns a map of command name → result (passed + error output).
 * Lightweight — no DB records, no artifacts, just exit codes.
 * Async to avoid blocking the event loop during long QA runs.
 */
export async function captureQaBaseline(
  cwd: string,
  config: SoloConfig,
  onProgress?: (msg: string) => void,
  projectRoot?: string,
): Promise<Map<string, BaselineResult>> {
  const baseline = new Map<string, BaselineResult>();
  const qaConfig = normalizeQaConfig(config);

  for (const cmd of qaConfig.commands) {
    onProgress?.(`  baseline: running ${cmd.name}...`);
    const cmdCwd = cmd.cwd && cmd.cwd !== '.'
      ? path.resolve(cwd, cmd.cwd)
      : cwd;

    try {
      await new Promise<void>((resolve, reject) => {
        execFile('sh', ['-c', cmd.cmd], {
          cwd: cmdCwd,
          timeout: cmd.timeoutMs ?? 120_000,
          maxBuffer: 10 * 1024 * 1024,
        }, (err) => err ? reject(err) : resolve());
      });
      baseline.set(cmd.name, { passed: true });
      onProgress?.(`  baseline: ${cmd.name} ✓`);
      if (projectRoot) recordBaselineResult(projectRoot, cmd.name, true);
    } catch (err) {
      // Capture error output for the fix prompt
      let output = '';
      if (err && typeof err === 'object' && 'stderr' in err) {
        output = String((err as { stderr?: unknown }).stderr || '');
      }
      if (!output && err && typeof err === 'object' && 'stdout' in err) {
        output = String((err as { stdout?: unknown }).stdout || '');
      }
      if (!output && err instanceof Error) {
        output = err.message;
      }
      // Truncate to avoid huge prompts
      if (output.length > 2000) {
        output = output.slice(-2000) + '\n... (truncated)';
      }
      baseline.set(cmd.name, { passed: false, output });
      onProgress?.(`  baseline: ${cmd.name} ✗ (pre-existing failure)`);
      if (projectRoot) recordBaselineResult(projectRoot, cmd.name, false);
    }
  }

  return baseline;
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

    // Build exclusion index: scan for indicator files (lockfiles, configs)
    // and write inferred artifact patterns to .git/info/exclude so that
    // git status natively filters them out. Must run before dep install.
    const excludedPatterns = buildExclusionIndex(worktreePath);
    if (excludedPatterns.length > 0 && verbose) {
      onProgress(`Exclusion index: ${excludedPatterns.length} artifact patterns discovered`);
    }

    // Install dependencies in worktree (needed for monorepos where node_modules isn't shared)
    await installWorktreeDeps(worktreePath, verbose, onProgress);

    // Baseline snapshot: capture what git status reports AFTER dep install
    // but BEFORE the agent runs.  Anything in this baseline is a setup
    // artifact (lockfile churn, untracked dep dirs the exclusion index
    // missed, etc.) and will be subtracted from the post-agent status so
    // only the agent's actual changes enter scope validation.
    const baselineStatus = (await gitExec('git status --porcelain', {
      cwd: worktreePath,
    })).trim();
    const baselineFiles = new Set(parseChangedFiles(baselineStatus));

    // QA baseline: use cycle-level cache if provided, else capture per-ticket
    let qaBaseline: Map<string, boolean> | null = opts.qaBaseline ?? null;
    if (!qaBaseline && !skipQa && config?.qa?.commands?.length && !config?.qa?.disableBaseline) {
      onProgress('Capturing QA baseline...');
      const fullBaseline = await captureQaBaseline(worktreePath, config, onProgress);
      qaBaseline = baselineToPassFail(fullBaseline);
    }

    if (qaBaseline) {
      const preExisting = [...qaBaseline.entries()].filter(([, passed]) => !passed);
      if (preExisting.length > 0) {
        onProgress(`QA baseline: ${preExisting.length} pre-existing failure(s) — will be skipped`);
        for (const [name] of preExisting) {
          onProgress(`  ⚠ ${name} already failing before agent`);
        }
      }
    }

    // Step 2: Run agent
    await markStep('agent', 'started');

    const prompt = buildTicketPrompt(ticket, opts.guidelinesContext, opts.learningsContext, opts.metadataContext, { confidence: opts.confidence, complexity: opts.complexity });
    const execBackend: ExecutionBackend = opts.executionBackend ?? new ClaudeExecutionBackend();

    const claudeResult = await execBackend.run({
      worktreePath,
      prompt,
      timeoutMs,
      verbose,
      onProgress, // Always report progress for visibility
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

        // Log scope diagnostics before discarding the worktree
        try {
          const abortStatus = (await gitExec('git status --porcelain', { cwd: worktreePath })).trim();
          if (abortStatus) {
            const abortAllFiles = parseChangedFiles(abortStatus);
            const abortChanged = baselineFiles.size > 0
              ? abortAllFiles.filter(f => !baselineFiles.has(f))
              : abortAllFiles;
            const abortViolations = checkScopeViolations(abortChanged, ticket.allowedPaths, ticket.forbiddenPaths);
            if (abortViolations.length > 0) {
              (spindleArtifactData as Record<string, unknown>).scopeViolations = abortViolations.map(v => v.file);
              onProgress(`  Scope violations (discarded): ${abortViolations.map(v => v.file).join(', ')}`);
            }
          }
        } catch { /* diagnostic only */ }

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

        // Log scope diagnostics before discarding the worktree
        try {
          const blockStatus = (await gitExec('git status --porcelain', { cwd: worktreePath })).trim();
          if (blockStatus) {
            const blockAllFiles = parseChangedFiles(blockStatus);
            const blockChanged = baselineFiles.size > 0
              ? blockAllFiles.filter(f => !baselineFiles.has(f))
              : blockAllFiles;
            const blockViolations = checkScopeViolations(blockChanged, ticket.allowedPaths, ticket.forbiddenPaths);
            if (blockViolations.length > 0) {
              onProgress(`  Scope violations (discarded): ${blockViolations.map(v => v.file).join(', ')}`);
            }
          }
        } catch { /* diagnostic only */ }

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

    // Subtract baseline: only files the agent actually changed pass through.
    const allChangedFiles = parseChangedFiles(statusOutput);
    const changedFiles = baselineFiles.size > 0
      ? allChangedFiles.filter(f => !baselineFiles.has(f))
      : allChangedFiles;

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
    await gitExecFile('git', ['commit', '-m', ticket.title], { cwd: worktreePath });

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

      // Filter out pre-existing failures BEFORE running QA.
      // runQa breaks on first failure — if a pre-existing failure is hit first,
      // subsequent commands never run and agent-introduced regressions go undetected.
      let effectiveQaConfig = qaConfig;
      const skippedCommands: string[] = [];
      if (qaBaseline) {
        const passingCommands = qaConfig.commands.filter(cmd => {
          if (qaBaseline.get(cmd.name) === false) {
            skippedCommands.push(cmd.name);
            return false;
          }
          return true;
        });
        if (skippedCommands.length > 0) {
          onProgress(`QA: skipping ${skippedCommands.length} pre-existing failure(s): ${skippedCommands.join(', ')}`);
          effectiveQaConfig = { ...qaConfig, commands: passingCommands };
        }
      }

      // If all commands were pre-existing failures, skip QA entirely
      if (effectiveQaConfig.commands.length === 0) {
        onProgress('QA: all commands were pre-existing failures — skipping');
        await markStep('qa', 'success', {
          metadata: { allPreExisting: true, skippedCommands },
        });
      } else {
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
          config: effectiveQaConfig,
        }
      );

      if (qaResult.status !== 'success') {
        const failedStep = qaResult.failedAt?.stepName ?? 'unknown step';

        await markStep('qa', 'failed', {
          errorMessage: `QA failed at ${failedStep}`,
          metadata: { qaRunId: qaResult.runId },
        });
        recordQualitySignal(repoRoot, 'qa_fail');
        await skipRemaining(6, 'QA failed');

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

          // Record per-command QA stats on failure path
          try {
            for (const step of qaDetails.steps) {
              recordQaCommandResult(repoRoot, step.name, {
                passed: step.status === 'success',
                durationMs: step.durationMs ?? 0,
                timedOut: (step.signal === 'SIGTERM') || false,
                skippedPreExisting: false,
              });
            }
            for (const name of skippedCommands) {
              recordQaCommandResult(repoRoot, name, {
                passed: false,
                durationMs: 0,
                timedOut: false,
                skippedPreExisting: true,
              });
            }
          } catch {
            // Non-fatal
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
                onProgress, // Always report progress for visibility
              });

              if (retryResult.success) {
                // Re-validate scope before committing retry changes
                const retryStatusOutput = (await gitExec('git status --porcelain', {
                  cwd: worktreePath,
                })).trim();
                const retryAllFiles = parseChangedFiles(retryStatusOutput);
                const retryChangedFiles = baselineFiles.size > 0
                  ? retryAllFiles.filter(f => !baselineFiles.has(f))
                  : retryAllFiles;
                const retryViolations = checkScopeViolations(
                  retryChangedFiles,
                  expandedPaths,
                  ticket.forbiddenPaths
                );
                if (retryViolations.length > 0) {
                  const violatedFiles = retryViolations.map(v => v.file).join(', ');
                  errorParts.push('');
                  errorParts.push(`(QA retry created scope violations: ${violatedFiles})`);
                  errorParts.push(`Worktree preserved for inspection: ${worktreePath}`);
                  const result = {
                    success: false,
                    branchName,
                    durationMs: Date.now() - startTime,
                    error: errorParts.join('\n'),
                    failureReason: 'scope_violation' as FailureReason,
                  };
                  await saveRunSummary(result);
                  return result;
                }

                // Re-commit
                await gitExec('git add -A', { cwd: worktreePath });
                try {
                  await gitExecFile('git', ['commit', '-m', `fix: update tests for ${ticket.title}`], { cwd: worktreePath });
                } catch {
                  // No new changes to commit — that's fine
                }

                // Re-run QA
                const retryQaResult = await runQa(
                  { db: adapter, exec, logger },
                  { projectId: project.id, repoRoot: worktreePath, config: effectiveQaConfig },
                );

                if (retryQaResult.status === 'success') {
                  onProgress('QA retry succeeded after fixing tests');
                  await markStep('qa', 'success', { metadata: { qaRunId: retryQaResult.runId, qaRetried: true } });
                  recordQualitySignal(repoRoot, 'qa_pass');
                  // Fall through to push/PR steps below
                } else {
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

      await markStep('qa', 'success', {
        metadata: {
          qaRunId: qaResult.runId,
          ...(skippedCommands.length > 0 ? { skippedPreExisting: skippedCommands } : {}),
        },
      });
      recordQualitySignal(repoRoot, 'qa_pass');

      // Record per-command QA stats
      try {
        const qaStatsDetails = await getQaRunDetails(adapter, qaResult.runId);
        if (qaStatsDetails) {
          for (const step of qaStatsDetails.steps) {
            recordQaCommandResult(repoRoot, step.name, {
              passed: step.status === 'success',
              durationMs: step.durationMs ?? 0,
              timedOut: (step.signal === 'SIGTERM') || false,
              skippedPreExisting: false,
            });
          }
        }
        for (const name of skippedCommands) {
          recordQaCommandResult(repoRoot, name, {
            passed: false,
            durationMs: 0,
            timedOut: false,
            skippedPreExisting: true,
          });
        }
      } catch {
        // Non-fatal — stats recording failure shouldn't block execution
      }

      } // end effectiveQaConfig.commands.length > 0
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
        const ghArgs = ['pr', 'create', '--title', ticket.title, '--body', prBody, '--head', branchName];
        if (draftPr) ghArgs.push('--draft');

        const prOutput = (await gitExecFile('gh', ghArgs, { cwd: worktreePath })).trim();

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
