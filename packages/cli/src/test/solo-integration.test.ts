/**
 * Golden Integration Test for Solo Mode
 *
 * Tests the complete solo workflow:
 * 1. Database initialization and project setup
 * 2. Ticket creation and lifecycle
 * 3. Run tracking with steps
 * 4. Artifact creation and retrieval
 * 5. Scope enforcement
 *
 * Note: Does not test actual Claude CLI execution (requires API credentials).
 * Tests everything up to and after the agent step.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execSync } from 'node:child_process';
import { createSQLiteAdapter } from '@promptwheel/sqlite';
import { projects, tickets, runs, runSteps, type StepKind } from '@promptwheel/core/repos';
import {
  writeJsonArtifact,
  readJsonArtifact,
  listArtifacts,
  getArtifactsForRun,
  getAllArtifacts,
  type RunSummaryArtifact,
  type ViolationsArtifact,
} from '../lib/artifacts.js';
import { checkScopeViolations, parseChangedFiles, matchesPattern } from '../lib/scope.js';

describe('Solo Mode Integration', () => {
  let tempDir: string;
  let dbUrl: string;

  beforeEach(() => {
    // Create temporary directory
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptwheel-test-'));
    dbUrl = `sqlite://${path.join(tempDir, '.promptwheel', 'state.sqlite')}`;

    // Create .promptwheel directory
    fs.mkdirSync(path.join(tempDir, '.promptwheel'), { recursive: true });

    // Initialize git repo
    execSync('git init', { cwd: tempDir, stdio: 'ignore' });
    execSync('git config user.email "test@test.com"', { cwd: tempDir, stdio: 'ignore' });
    execSync('git config user.name "Test"', { cwd: tempDir, stdio: 'ignore' });

    // Create initial commit
    fs.writeFileSync(path.join(tempDir, 'README.md'), '# Test Repo');
    execSync('git add .', { cwd: tempDir, stdio: 'ignore' });
    execSync('git commit -m "Initial commit"', { cwd: tempDir, stdio: 'ignore' });
  });

  afterEach(() => {
    // Cleanup
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('Database Operations', () => {
    it('creates project from repo root', async () => {
      const adapter = await createSQLiteAdapter({ url: dbUrl });

      try {
        const project = await projects.ensureForRepo(adapter, {
          name: 'test-project',
          rootPath: tempDir,
        });

        expect(project.id).toBeDefined();
        expect(project.name).toBe('test-project');
        expect(project.rootPath).toBe(tempDir);

        // Calling again should return same project
        const project2 = await projects.ensureForRepo(adapter, {
          name: 'test-project',
          rootPath: tempDir,
        });

        expect(project2.id).toBe(project.id);
      } finally {
        await adapter.close();
      }
    });

    it('creates and retrieves tickets', async () => {
      const adapter = await createSQLiteAdapter({ url: dbUrl });

      try {
        const project = await projects.ensureForRepo(adapter, {
          name: 'test-project',
          rootPath: tempDir,
        });

        // Create ticket
        const ticket = await tickets.create(adapter, {
          projectId: project.id,
          title: 'Test ticket',
          description: 'Test description',
          category: 'refactor',
          allowedPaths: ['src/**'],
          forbiddenPaths: ['node_modules/**'],
        });

        expect(ticket.id).toBeDefined();
        expect(ticket.title).toBe('Test ticket');
        expect(ticket.status).toBe('ready');
        expect(ticket.allowedPaths).toEqual(['src/**']);
        expect(ticket.forbiddenPaths).toEqual(['node_modules/**']);

        // Retrieve ticket
        const retrieved = await tickets.getById(adapter, ticket.id);
        expect(retrieved).not.toBeNull();
        expect(retrieved?.title).toBe('Test ticket');

        // List tickets
        const allTickets = await tickets.listByProject(adapter, project.id);
        expect(allTickets).toHaveLength(1);
        expect(allTickets[0].id).toBe(ticket.id);
      } finally {
        await adapter.close();
      }
    });

    it('tracks ticket status changes', async () => {
      const adapter = await createSQLiteAdapter({ url: dbUrl });

      try {
        const project = await projects.ensureForRepo(adapter, {
          name: 'test-project',
          rootPath: tempDir,
        });

        const ticket = await tickets.create(adapter, {
          projectId: project.id,
          title: 'Status test',
          category: 'refactor',
        });

        expect(ticket.status).toBe('ready');

        // Update to in_progress
        await tickets.updateStatus(adapter, ticket.id, 'in_progress');
        let updated = await tickets.getById(adapter, ticket.id);
        expect(updated?.status).toBe('in_progress');

        // Update to done
        await tickets.updateStatus(adapter, ticket.id, 'done');
        updated = await tickets.getById(adapter, ticket.id);
        expect(updated?.status).toBe('done');
      } finally {
        await adapter.close();
      }
    });
  });

  describe('Run Tracking', () => {
    it('creates runs with steps', async () => {
      const adapter = await createSQLiteAdapter({ url: dbUrl });

      try {
        const project = await projects.ensureForRepo(adapter, {
          name: 'test-project',
          rootPath: tempDir,
        });

        const ticket = await tickets.create(adapter, {
          projectId: project.id,
          title: 'Run test',
          category: 'refactor',
        });

        // Create run
        const run = await runs.create(adapter, {
          projectId: project.id,
          type: 'worker',
          ticketId: ticket.id,
        });

        expect(run.id).toBeDefined();
        expect(run.status).toBe('running');
        expect(run.ticketId).toBe(ticket.id);

        // Create steps
        const stepDefs: Array<{ name: string; kind: StepKind }> = [
          { name: 'worktree', kind: 'git' },
          { name: 'agent', kind: 'internal' },
          { name: 'scope', kind: 'internal' },
          { name: 'commit', kind: 'git' },
        ];

        for (let i = 0; i < stepDefs.length; i++) {
          await runSteps.create(adapter, {
            runId: run.id,
            ordinal: i,
            name: stepDefs[i].name,
            kind: stepDefs[i].kind,
          });
        }

        // Verify steps (queued steps count as 'active')
        const summary = await runSteps.getSummary(adapter, run.id);
        expect(summary.counts.total).toBe(4);
        expect(summary.counts.active).toBe(4); // queued + running = active
        expect(summary.counts.passed).toBe(0);
      } finally {
        await adapter.close();
      }
    });

    it('tracks step progress through lifecycle', async () => {
      const adapter = await createSQLiteAdapter({ url: dbUrl });

      try {
        const project = await projects.ensureForRepo(adapter, {
          name: 'test-project',
          rootPath: tempDir,
        });

        const run = await runs.create(adapter, {
          projectId: project.id,
          type: 'worker',
        });

        // Create a step
        const step = await runSteps.create(adapter, {
          runId: run.id,
          ordinal: 0,
          name: 'test-step',
          kind: 'internal',
        });

        expect(step.status).toBe('queued');

        // Start step
        await runSteps.markStarted(adapter, step.id);
        let updated = await runSteps.getById(adapter, step.id);
        expect(updated?.status).toBe('running');

        // Mark success
        await runSteps.markSuccess(adapter, step.id, {
          metadata: { durationMs: 1000 },
        });
        updated = await runSteps.getById(adapter, step.id);
        expect(updated?.status).toBe('success');
      } finally {
        await adapter.close();
      }
    });

    it('handles step failures correctly', async () => {
      const adapter = await createSQLiteAdapter({ url: dbUrl });

      try {
        const project = await projects.ensureForRepo(adapter, {
          name: 'test-project',
          rootPath: tempDir,
        });

        const run = await runs.create(adapter, {
          projectId: project.id,
          type: 'worker',
        });

        const step = await runSteps.create(adapter, {
          runId: run.id,
          ordinal: 0,
          name: 'failing-step',
          kind: 'command',
        });

        await runSteps.markStarted(adapter, step.id);
        await runSteps.markFailed(adapter, step.id, {
          errorMessage: 'Something went wrong',
        });

        const updated = await runSteps.getById(adapter, step.id);
        expect(updated?.status).toBe('failed');
        expect(updated?.errorMessage).toBe('Something went wrong');
      } finally {
        await adapter.close();
      }
    });
  });

  describe('Artifact System', () => {
    it('writes and reads JSON artifacts', () => {
      const baseDir = path.join(tempDir, '.promptwheel');
      const runId = 'run_test123';

      // Write artifact
      const artifactPath = writeJsonArtifact({
        baseDir,
        type: 'executions',
        id: runId,
        data: {
          runId,
          stdout: 'test output',
          exitCode: 0,
        },
      });

      expect(fs.existsSync(artifactPath)).toBe(true);

      // Read artifact
      const data = readJsonArtifact<{ runId: string; stdout: string }>(artifactPath);
      expect(data).not.toBeNull();
      expect(data?.runId).toBe(runId);
      expect(data?.stdout).toBe('test output');
    });

    it('lists artifacts by type', () => {
      const baseDir = path.join(tempDir, '.promptwheel');

      // Write multiple artifacts
      writeJsonArtifact({ baseDir, type: 'executions', id: 'run_1', data: { id: 1 } });
      writeJsonArtifact({ baseDir, type: 'executions', id: 'run_2', data: { id: 2 } });
      writeJsonArtifact({ baseDir, type: 'diffs', id: 'run_1', data: { diff: 'abc' } });

      // List by type
      const executions = listArtifacts(baseDir, 'executions');
      expect(executions).toHaveLength(2);

      const diffs = listArtifacts(baseDir, 'diffs');
      expect(diffs).toHaveLength(1);
    });

    it('gets all artifacts for a run', () => {
      const baseDir = path.join(tempDir, '.promptwheel');
      const runId = 'run_golden';

      // Write artifacts of different types
      writeJsonArtifact({
        baseDir,
        type: 'executions',
        id: runId,
        data: { type: 'execution' },
        timestamp: false,
      });
      writeJsonArtifact({
        baseDir,
        type: 'diffs',
        id: runId,
        data: { type: 'diff' },
        timestamp: false,
      });
      writeJsonArtifact({
        baseDir,
        type: 'runs',
        id: runId,
        data: { type: 'run' },
        timestamp: false,
      });

      // Get all for run
      const artifacts = getArtifactsForRun(baseDir, runId);

      expect(artifacts.executions).not.toBeNull();
      expect(artifacts.diffs).not.toBeNull();
      expect(artifacts.runs).not.toBeNull();
      expect(artifacts.violations).toBeNull();
      expect(artifacts.proposals).toBeNull();
    });

    it('creates run summary artifact with correct structure', () => {
      const baseDir = path.join(tempDir, '.promptwheel');
      const runId = 'run_summary_test';

      const summary: RunSummaryArtifact = {
        runId,
        ticketId: 'ticket_123',
        ticketTitle: 'Test Ticket',
        projectId: 'project_456',
        success: true,
        startedAt: '2024-01-01T00:00:00Z',
        completedAt: '2024-01-01T00:01:00Z',
        durationMs: 60000,
        branchName: 'promptwheel/ticket_123',
        steps: [
          { name: 'worktree', status: 'success', durationMs: 1000 },
          { name: 'agent', status: 'success', durationMs: 50000 },
          { name: 'commit', status: 'success', durationMs: 500 },
        ],
        artifacts: {
          execution: '/path/to/execution.json',
          diff: '/path/to/diff.json',
        },
      };

      const artifactPath = writeJsonArtifact({
        baseDir,
        type: 'runs',
        id: runId,
        data: summary,
        timestamp: false,
      });

      const loaded = readJsonArtifact<RunSummaryArtifact>(artifactPath);
      expect(loaded?.runId).toBe(runId);
      expect(loaded?.success).toBe(true);
      expect(loaded?.steps).toHaveLength(3);
      expect(loaded?.artifacts.execution).toBeDefined();
    });

    it('creates violations artifact with correct structure', () => {
      const baseDir = path.join(tempDir, '.promptwheel');
      const runId = 'run_violations_test';

      const violations: ViolationsArtifact = {
        runId,
        ticketId: 'ticket_789',
        changedFiles: ['src/index.ts', 'config/secret.json', 'lib/utils.ts'],
        allowedPaths: ['src/**'],
        forbiddenPaths: ['config/**'],
        violations: [
          { file: 'config/secret.json', violation: 'in_forbidden', pattern: 'config/**' },
          { file: 'lib/utils.ts', violation: 'not_in_allowed' },
        ],
      };

      const artifactPath = writeJsonArtifact({
        baseDir,
        type: 'violations',
        id: runId,
        data: violations,
        timestamp: false,
      });

      const loaded = readJsonArtifact<ViolationsArtifact>(artifactPath);
      expect(loaded?.violations).toHaveLength(2);
      expect(loaded?.violations[0].violation).toBe('in_forbidden');
    });
  });

  describe('Scope Enforcement', () => {
    it('allows files within allowed paths', () => {
      const files = ['src/index.ts', 'src/lib/utils.ts', 'src/components/Button.tsx'];
      const allowed = ['src/**'];
      const forbidden: string[] = [];

      const violations = checkScopeViolations(files, allowed, forbidden);
      expect(violations).toHaveLength(0);
    });

    it('detects files outside allowed paths', () => {
      const files = ['src/index.ts', 'lib/external.ts', 'config/app.json'];
      const allowed = ['src/**'];
      const forbidden: string[] = [];

      const violations = checkScopeViolations(files, allowed, forbidden);
      expect(violations).toHaveLength(2);
      expect(violations.map(v => v.file).sort()).toEqual(['config/app.json', 'lib/external.ts']);
    });

    it('detects files in forbidden paths', () => {
      const files = ['src/index.ts', 'node_modules/pkg/index.js', '.env'];
      const allowed: string[] = [];
      const forbidden = ['node_modules/**', '.env'];

      const violations = checkScopeViolations(files, allowed, forbidden);
      expect(violations).toHaveLength(2);
      expect(violations.every(v => v.violation === 'in_forbidden')).toBe(true);
    });

    it('forbidden paths take priority over allowed', () => {
      const files = ['src/internal/secret.ts'];
      const allowed = ['src/**'];
      const forbidden = ['src/internal/**'];

      const violations = checkScopeViolations(files, allowed, forbidden);
      expect(violations).toHaveLength(1);
      expect(violations[0].violation).toBe('in_forbidden');
    });

    it('parses git status output correctly', () => {
      const statusOutput = `
 M src/modified.ts
A  src/added.ts
D  src/deleted.ts
R  src/old.ts -> src/new.ts
?? src/untracked.ts
`;
      const files = parseChangedFiles(statusOutput);
      expect(files).toEqual([
        'src/modified.ts',
        'src/added.ts',
        'src/deleted.ts',
        'src/new.ts', // Renamed: takes destination
        'src/untracked.ts',
      ]);
    });
  });

  describe('End-to-End Workflow Simulation', () => {
    it('simulates complete ticket execution flow', async () => {
      const adapter = await createSQLiteAdapter({ url: dbUrl });
      const baseDir = path.join(tempDir, '.promptwheel');

      try {
        // 1. Create project
        const project = await projects.ensureForRepo(adapter, {
          name: 'golden-test',
          rootPath: tempDir,
        });
        expect(project.id).toBeDefined();

        // 2. Create ticket
        const ticket = await tickets.create(adapter, {
          projectId: project.id,
          title: 'Add greeting function',
          description: 'Create a simple greeting function in src/greet.ts',
          category: 'refactor',
          allowedPaths: ['src/**'],
          forbiddenPaths: ['node_modules/**', '.env*'],
        });
        expect(ticket.status).toBe('ready');

        // 3. Mark ticket in_progress
        await tickets.updateStatus(adapter, ticket.id, 'in_progress');

        // 4. Create run
        const run = await runs.create(adapter, {
          projectId: project.id,
          type: 'worker',
          ticketId: ticket.id,
        });
        expect(run.status).toBe('running');

        // 5. Create steps
        const stepDefs = [
          { name: 'worktree', kind: 'git' as StepKind },
          { name: 'agent', kind: 'internal' as StepKind },
          { name: 'scope', kind: 'internal' as StepKind },
          { name: 'commit', kind: 'git' as StepKind },
          { name: 'push', kind: 'git' as StepKind },
          { name: 'qa', kind: 'command' as StepKind },
          { name: 'pr', kind: 'git' as StepKind },
          { name: 'cleanup', kind: 'internal' as StepKind },
        ];

        const stepRecords = new Map<string, Awaited<ReturnType<typeof runSteps.create>>>();
        for (let i = 0; i < stepDefs.length; i++) {
          const step = await runSteps.create(adapter, {
            runId: run.id,
            ordinal: i,
            name: stepDefs[i].name,
            kind: stepDefs[i].kind,
          });
          stepRecords.set(stepDefs[i].name, step);
        }

        // 6. Simulate step execution
        // Worktree step
        const worktreeStep = stepRecords.get('worktree')!;
        await runSteps.markStarted(adapter, worktreeStep.id);
        await runSteps.markSuccess(adapter, worktreeStep.id, {
          metadata: { branchName: `promptwheel/${ticket.id}` },
        });

        // Agent step
        const agentStep = stepRecords.get('agent')!;
        await runSteps.markStarted(adapter, agentStep.id);

        // Save execution artifact
        const execArtifactPath = writeJsonArtifact({
          baseDir,
          type: 'executions',
          id: run.id,
          data: {
            runId: run.id,
            ticketId: ticket.id,
            prompt: 'Create greeting function...',
            stdout: 'Created src/greet.ts',
            stderr: '',
            exitCode: 0,
            durationMs: 5000,
          },
          timestamp: false,
        });

        await runSteps.markSuccess(adapter, agentStep.id, {
          metadata: { artifactPath: execArtifactPath },
        });

        // Scope step
        const scopeStep = stepRecords.get('scope')!;
        await runSteps.markStarted(adapter, scopeStep.id);

        // Simulate changed files
        const changedFiles = ['src/greet.ts'];
        const violations = checkScopeViolations(
          changedFiles,
          ticket.allowedPaths,
          ticket.forbiddenPaths
        );
        expect(violations).toHaveLength(0); // Should pass scope check

        await runSteps.markSuccess(adapter, scopeStep.id, {
          metadata: { filesChecked: changedFiles.length },
        });

        // Commit step
        const commitStep = stepRecords.get('commit')!;
        await runSteps.markStarted(adapter, commitStep.id);

        // Save diff artifact
        const diffArtifactPath = writeJsonArtifact({
          baseDir,
          type: 'diffs',
          id: run.id,
          data: {
            runId: run.id,
            ticketId: ticket.id,
            diff: '+export function greet(name: string) {\n+  return `Hello, ${name}!`;\n+}',
            changedFiles,
          },
          timestamp: false,
        });

        await runSteps.markSuccess(adapter, commitStep.id, {
          metadata: { diffArtifactPath },
        });

        // Skip remaining steps for simulation
        for (const name of ['push', 'qa', 'pr', 'cleanup']) {
          await runSteps.markSkipped(adapter, stepRecords.get(name)!.id, 'Simulated');
        }

        // 7. Mark run successful
        await runs.markSuccess(adapter, run.id, {
          branchName: `promptwheel/${ticket.id}`,
          durationMs: 10000,
        });

        // 8. Save run summary artifact
        const runSummary: RunSummaryArtifact = {
          runId: run.id,
          ticketId: ticket.id,
          ticketTitle: ticket.title,
          projectId: project.id,
          success: true,
          startedAt: new Date(Date.now() - 10000).toISOString(),
          completedAt: new Date().toISOString(),
          durationMs: 10000,
          branchName: `promptwheel/${ticket.id}`,
          steps: [
            { name: 'worktree', status: 'success', durationMs: 500 },
            { name: 'agent', status: 'success', durationMs: 5000 },
            { name: 'scope', status: 'success', durationMs: 50 },
            { name: 'commit', status: 'success', durationMs: 200 },
            { name: 'push', status: 'skipped' },
            { name: 'qa', status: 'skipped' },
            { name: 'pr', status: 'skipped' },
            { name: 'cleanup', status: 'skipped' },
          ],
          artifacts: {
            execution: execArtifactPath,
            diff: diffArtifactPath,
          },
        };

        writeJsonArtifact({
          baseDir,
          type: 'runs',
          id: run.id,
          data: runSummary,
          timestamp: false,
        });

        // 9. Mark ticket done
        await tickets.updateStatus(adapter, ticket.id, 'done');

        // VERIFY FINAL STATE

        // Check ticket status
        const finalTicket = await tickets.getById(adapter, ticket.id);
        expect(finalTicket?.status).toBe('done');

        // Check run status
        const finalRun = await runs.getById(adapter, run.id);
        expect(finalRun?.status).toBe('success');

        // Check step summary
        const stepsSummary = await runSteps.getSummary(adapter, run.id);
        expect(stepsSummary.counts.passed).toBe(4);
        expect(stepsSummary.counts.skipped).toBe(4);
        expect(stepsSummary.counts.failed).toBe(0);

        // Check artifacts exist
        // Debug: list all artifacts in the directory
        const execDir = path.join(baseDir, 'artifacts', 'executions');
        const diffsDir = path.join(baseDir, 'artifacts', 'diffs');
        const runsDir = path.join(baseDir, 'artifacts', 'runs');
        const execFiles = fs.existsSync(execDir) ? fs.readdirSync(execDir) : [];
        const diffFiles = fs.existsSync(diffsDir) ? fs.readdirSync(diffsDir) : [];
        const runFiles = fs.existsSync(runsDir) ? fs.readdirSync(runsDir) : [];

        // Verify artifacts were written
        expect(execFiles.length).toBeGreaterThan(0);
        expect(diffFiles.length).toBeGreaterThan(0);
        expect(runFiles.length).toBeGreaterThan(0);

        const allArtifacts = getArtifactsForRun(baseDir, run.id);
        expect(allArtifacts.executions).not.toBeNull();
        expect(allArtifacts.diffs).not.toBeNull();
        expect(allArtifacts.runs).not.toBeNull();

        // Check run summary artifact content
        const loadedSummary = allArtifacts.runs?.data as RunSummaryArtifact;
        expect(loadedSummary.success).toBe(true);
        expect(loadedSummary.steps.filter(s => s.status === 'success')).toHaveLength(4);
      } finally {
        await adapter.close();
      }
    });

    it('simulates scope violation failure flow', async () => {
      const adapter = await createSQLiteAdapter({ url: dbUrl });
      const baseDir = path.join(tempDir, '.promptwheel');

      try {
        const project = await projects.ensureForRepo(adapter, {
          name: 'violation-test',
          rootPath: tempDir,
        });

        const ticket = await tickets.create(adapter, {
          projectId: project.id,
          title: 'Restricted task',
          category: 'refactor',
          allowedPaths: ['src/**'],
          forbiddenPaths: ['config/**'],
        });

        const run = await runs.create(adapter, {
          projectId: project.id,
          type: 'worker',
          ticketId: ticket.id,
        });

        // Create steps
        for (let i = 0; i < 3; i++) {
          await runSteps.create(adapter, {
            runId: run.id,
            ordinal: i,
            name: ['worktree', 'agent', 'scope'][i],
            kind: 'internal',
          });
        }

        // Simulate agent modifying forbidden file
        const changedFiles = ['src/index.ts', 'config/database.json'];
        const violations = checkScopeViolations(
          changedFiles,
          ticket.allowedPaths,
          ticket.forbiddenPaths
        );

        expect(violations).toHaveLength(1);
        expect(violations[0].file).toBe('config/database.json');
        expect(violations[0].violation).toBe('in_forbidden');

        // Save violations artifact
        const violationsData: ViolationsArtifact = {
          runId: run.id,
          ticketId: ticket.id,
          changedFiles,
          allowedPaths: ticket.allowedPaths,
          forbiddenPaths: ticket.forbiddenPaths,
          violations,
        };

        writeJsonArtifact({
          baseDir,
          type: 'violations',
          id: run.id,
          data: violationsData,
          timestamp: false,
        });

        // Mark run as failed
        await runs.markFailure(adapter, run.id, 'Scope violations detected');

        // Verify
        const finalRun = await runs.getById(adapter, run.id);
        expect(finalRun?.status).toBe('failure');

        // Debug: list violations artifacts
        const violationsDir = path.join(baseDir, 'artifacts', 'violations');
        const violationFiles = fs.existsSync(violationsDir) ? fs.readdirSync(violationsDir) : [];
        expect(violationFiles.length).toBeGreaterThan(0);

        const artifacts = getArtifactsForRun(baseDir, run.id);
        expect(artifacts.violations).not.toBeNull();

        const loadedViolations = artifacts.violations?.data as ViolationsArtifact;
        expect(loadedViolations.violations).toHaveLength(1);
      } finally {
        await adapter.close();
      }
    });
  });

  describe('Pattern Matching Edge Cases', () => {
    it('handles complex glob patterns', () => {
      // ** at end
      expect(matchesPattern('src/deep/nested/file.ts', 'src/**')).toBe(true);

      // **/ in middle
      expect(matchesPattern('src/components/Button.tsx', 'src/**/*.tsx')).toBe(true);
      expect(matchesPattern('src/Button.tsx', 'src/**/*.tsx')).toBe(true);

      // Single *
      expect(matchesPattern('src/index.ts', 'src/*.ts')).toBe(true);
      expect(matchesPattern('src/lib/index.ts', 'src/*.ts')).toBe(false);

      // ?
      expect(matchesPattern('src/a.ts', 'src/?.ts')).toBe(true);
      expect(matchesPattern('src/ab.ts', 'src/?.ts')).toBe(false);

      // Multiple patterns
      const files = ['src/a.ts', 'lib/b.ts', 'test/c.ts'];
      const allowed = ['src/**', 'lib/**'];
      const violations = checkScopeViolations(files, allowed, []);
      expect(violations).toHaveLength(1);
      expect(violations[0].file).toBe('test/c.ts');
    });

    it('handles special characters in paths', () => {
      expect(matchesPattern('src/file.test.ts', 'src/*.test.ts')).toBe(true);
      expect(matchesPattern('src/[special].ts', 'src/[special].ts')).toBe(true);
      expect(matchesPattern('src/(grouped).ts', 'src/(grouped).ts')).toBe(true);
    });
  });
});
