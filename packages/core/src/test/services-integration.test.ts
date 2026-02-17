import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createSQLiteAdapter } from '@promptwheel/sqlite';
import * as projects from '../repos/projects.js';
import * as tickets from '../repos/tickets.js';
import * as runs from '../repos/runs.js';
import * as runSteps from '../repos/run_steps.js';
import { runQa, getQaRunDetails } from '../services/qa.js';
import { approveProposals } from '../services/scout.js';
import type { DatabaseAdapter } from '../db/adapter.js';
import type { ExecRunner, ExecResult, ExecOutput } from '../exec/types.js';
import type { TicketProposal } from '../scout/types.js';
import type { QaConfig, QaDeps, QaLogger } from '../services/qa.js';

let db: DatabaseAdapter;

beforeAll(async () => {
  db = await createSQLiteAdapter({ url: ':memory:' });
});

afterAll(async () => {
  await db.close();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeOutput(overrides?: Partial<ExecOutput>): ExecOutput {
  return {
    path: '/logs/out.log',
    absPath: '/tmp/logs/out.log',
    bytes: 0,
    truncated: false,
    tail: '',
    ...overrides,
  };
}

function makeExecResult(overrides?: Partial<ExecResult>): ExecResult {
  return {
    status: 'success',
    exitCode: 0,
    signal: null,
    pid: 1234,
    startedAtMs: Date.now(),
    endedAtMs: Date.now() + 100,
    durationMs: 100,
    stdout: makeOutput(),
    stderr: makeOutput({ path: '/logs/err.log', absPath: '/tmp/logs/err.log' }),
    ...overrides,
  };
}

function makeExec(results: ExecResult[]): ExecRunner {
  let i = 0;
  return {
    run: vi.fn(async () => results[i++] ?? makeExecResult()),
  };
}

function makeLogger(): QaLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

function makeQaConfig(overrides?: Partial<QaConfig>): QaConfig {
  return {
    commands: [
      { name: 'build', cmd: 'npm run build' },
      { name: 'test', cmd: 'npm test' },
    ],
    artifacts: { dir: '.promptwheel/artifacts', maxLogBytes: 1_000_000, tailBytes: 4096 },
    retry: { enabled: false, maxAttempts: 1 },
    ...overrides,
  };
}

function makeProposal(overrides?: Partial<TicketProposal>): TicketProposal {
  return {
    id: 'scout-123-abc',
    category: 'refactor',
    title: 'Refactor auth module',
    description: 'Extract auth logic into separate service',
    acceptance_criteria: ['Auth service extracted', 'Tests pass'],
    verification_commands: ['npm run build'],
    allowed_paths: ['src/auth.ts'],
    files: ['src/auth.ts'],
    confidence: 85,
    rationale: 'Reduces coupling',
    estimated_complexity: 'simple',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// QA Service
// ---------------------------------------------------------------------------
describe('QA service — runQa with real DB', () => {
  let projId: string;

  beforeAll(async () => {
    const p = await projects.ensureForRepo(db, {
      id: 'proj_qa_svc',
      name: 'qa-svc',
      rootPath: '/tmp/qa-svc',
    });
    projId = p.id;
  });

  it('all commands pass -> run marked success', async () => {
    const exec = makeExec([makeExecResult(), makeExecResult()]);
    const result = await runQa(
      { db, exec, logger: makeLogger() },
      { projectId: projId, repoRoot: '/tmp/qa-svc', config: makeQaConfig() }
    );
    expect(result.status).toBe('success');
    expect(result.attempts).toBe(1);

    // Verify run in DB
    const run = await runs.getById(db, result.runId);
    expect(run!.status).toBe('success');

    // Verify steps in DB
    const steps = await runSteps.listByRun(db, result.runId);
    expect(steps).toHaveLength(2);
    expect(steps[0].status).toBe('success');
    expect(steps[1].status).toBe('success');
  });

  it('first command fails -> second is skipped', async () => {
    const exec = makeExec([
      makeExecResult({ status: 'failed', exitCode: 1 }),
    ]);
    const result = await runQa(
      { db, exec, logger: makeLogger() },
      { projectId: projId, repoRoot: '/tmp/qa-svc', config: makeQaConfig() }
    );
    expect(result.status).toBe('failed');
    expect(result.failedAt).toBeDefined();
    expect(result.failedAt!.stepName).toBe('build');

    const steps = await runSteps.listByRun(db, result.runId, { attempt: 1 });
    expect(steps[0].status).toBe('failed');
    expect(steps[1].status).toBe('skipped');
  });

  it('second command fails -> first is success, second is failed', async () => {
    const exec = makeExec([
      makeExecResult(),
      makeExecResult({ status: 'failed', exitCode: 2 }),
    ]);
    const result = await runQa(
      { db, exec, logger: makeLogger() },
      { projectId: projId, repoRoot: '/tmp/qa-svc', config: makeQaConfig() }
    );
    expect(result.status).toBe('failed');
    expect(result.failedAt!.stepName).toBe('test');

    const steps = await runSteps.listByRun(db, result.runId, { attempt: 1 });
    expect(steps[0].status).toBe('success');
    expect(steps[1].status).toBe('failed');
  });

  it('retry succeeds on second attempt', async () => {
    const exec = makeExec([
      // Attempt 1: build ok, test fails
      makeExecResult(),
      makeExecResult({ status: 'failed', exitCode: 1 }),
      // Attempt 2: both pass
      makeExecResult(),
      makeExecResult(),
    ]);
    const config = makeQaConfig({ retry: { enabled: true, maxAttempts: 2 } });
    const result = await runQa(
      { db, exec, logger: makeLogger() },
      { projectId: projId, repoRoot: '/tmp/qa-svc', config }
    );
    expect(result.status).toBe('success');
    expect(result.attempts).toBe(2);
  });

  it('retry exhausted -> final failure', async () => {
    const exec = makeExec([
      makeExecResult({ status: 'failed', exitCode: 1 }),
      makeExecResult({ status: 'failed', exitCode: 1 }),
    ]);
    const config = makeQaConfig({
      commands: [{ name: 'build', cmd: 'npm run build' }],
      retry: { enabled: true, maxAttempts: 2 },
    });
    const result = await runQa(
      { db, exec, logger: makeLogger() },
      { projectId: projId, repoRoot: '/tmp/qa-svc', config }
    );
    expect(result.status).toBe('failed');
    expect(result.attempts).toBe(2);

    const run = await runs.getById(db, result.runId);
    expect(run!.status).toBe('failure');
  });

  it('maxAttemptsOverride overrides config', async () => {
    const exec = makeExec([
      makeExecResult({ status: 'failed', exitCode: 1 }),
      makeExecResult({ status: 'failed', exitCode: 1 }),
      makeExecResult(),
    ]);
    const config = makeQaConfig({
      commands: [{ name: 'build', cmd: 'npm run build' }],
      retry: { enabled: true, maxAttempts: 1 },
    });
    const result = await runQa(
      { db, exec, logger: makeLogger() },
      { projectId: projId, repoRoot: '/tmp/qa-svc', config, maxAttemptsOverride: 3 }
    );
    expect(result.status).toBe('success');
    expect(result.attempts).toBe(3);
  });

  it('canceled via AbortSignal before start', async () => {
    const controller = new AbortController();
    controller.abort();
    const exec = makeExec([]);
    const result = await runQa(
      { db, exec, logger: makeLogger() },
      {
        projectId: projId,
        repoRoot: '/tmp/qa-svc',
        config: makeQaConfig(),
        signal: controller.signal,
      }
    );
    expect(result.status).toBe('canceled');
    expect(result.attempts).toBe(0);
  });

  it('throws when config has no commands', async () => {
    const exec = makeExec([]);
    await expect(
      runQa(
        { db, exec, logger: makeLogger() },
        { projectId: projId, repoRoot: '/tmp/qa-svc', config: makeQaConfig({ commands: [] }) }
      )
    ).rejects.toThrow('no commands');
  });

  it('throws on missing command name', async () => {
    const exec = makeExec([]);
    await expect(
      runQa(
        { db, exec, logger: makeLogger() },
        {
          projectId: projId,
          repoRoot: '/tmp/qa-svc',
          config: makeQaConfig({ commands: [{ name: '', cmd: 'echo' }] }),
        }
      )
    ).rejects.toThrow('missing a name');
  });

  it('throws on duplicate command names', async () => {
    const exec = makeExec([]);
    await expect(
      runQa(
        { db, exec, logger: makeLogger() },
        {
          projectId: projId,
          repoRoot: '/tmp/qa-svc',
          config: makeQaConfig({
            commands: [
              { name: 'build', cmd: 'npm run build' },
              { name: 'build', cmd: 'npm run build:prod' },
            ],
          }),
        }
      )
    ).rejects.toThrow('Duplicate');
  });

  it('timeout status maps to failed step', async () => {
    const exec = makeExec([
      makeExecResult({ status: 'timeout', exitCode: null }),
    ]);
    const config = makeQaConfig({
      commands: [{ name: 'slow', cmd: 'sleep 999', timeoutMs: 100 }],
    });
    const result = await runQa(
      { db, exec, logger: makeLogger() },
      { projectId: projId, repoRoot: '/tmp/qa-svc', config }
    );
    expect(result.status).toBe('failed');
  });
});

// ---------------------------------------------------------------------------
// QA Service — getQaRunDetails
// ---------------------------------------------------------------------------
describe('QA service — getQaRunDetails with real DB', () => {
  let projId: string;

  beforeAll(async () => {
    const p = await projects.ensureForRepo(db, {
      id: 'proj_qa_details',
      name: 'qa-details',
      rootPath: '/tmp/qa-details',
    });
    projId = p.id;
  });

  it('returns null for non-existent run', async () => {
    const result = await getQaRunDetails(db, 'run_nonexistent');
    expect(result).toBeNull();
  });

  it('returns run, steps, and summary', async () => {
    const exec = makeExec([makeExecResult(), makeExecResult()]);
    const qaResult = await runQa(
      { db, exec, logger: makeLogger() },
      { projectId: projId, repoRoot: '/tmp/qa-details', config: makeQaConfig() }
    );

    const details = await getQaRunDetails(db, qaResult.runId);
    expect(details).not.toBeNull();
    expect(details!.run).not.toBeNull();
    expect(details!.run!.type).toBe('qa');
    expect(details!.steps).toHaveLength(2);
    expect(details!.summary.counts.passed).toBe(2);
    expect(details!.summary.counts.failed).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Scout Service — approveProposals
// ---------------------------------------------------------------------------
describe('Scout service — approveProposals with real DB', () => {
  let projId: string;

  beforeAll(async () => {
    const p = await projects.ensureForRepo(db, {
      id: 'proj_scout_svc',
      name: 'scout-svc',
      rootPath: '/tmp/scout-svc',
    });
    projId = p.id;
  });

  const mockGit = {
    findRepoRoot: vi.fn(async () => '/tmp/scout-svc'),
    getRemoteUrl: vi.fn(async () => 'https://github.com/test/repo'),
    getProjectId: vi.fn(() => 'proj_scout_svc'),
  };

  it('creates tickets from proposals', async () => {
    const proposals = [
      makeProposal({ title: 'Proposal A', confidence: 90 }),
      makeProposal({ title: 'Proposal B', confidence: 70, category: 'test' }),
    ];

    const created = await approveProposals(
      { db, git: mockGit },
      projId,
      proposals
    );

    expect(created).toHaveLength(2);
    expect(created[0].title).toBe('Proposal A');
    expect(created[0].priority).toBe(90);
    expect(created[0].status).toBe('ready');
    expect(created[1].category).toBe('test');
  });

  it('ticket description includes acceptance criteria and rationale', async () => {
    const proposals = [
      makeProposal({
        title: 'Desc check',
        acceptance_criteria: ['Criterion 1', 'Criterion 2'],
        rationale: 'Important reason',
        files: ['src/x.ts'],
        estimated_complexity: 'moderate',
        confidence: 80,
      }),
    ];

    const created = await approveProposals({ db, git: mockGit }, projId, proposals);
    expect(created[0].description).toContain('Criterion 1');
    expect(created[0].description).toContain('Important reason');
    expect(created[0].description).toContain('moderate');
    expect(created[0].description).toContain('80%');
  });

  it('handles empty proposal list', async () => {
    const created = await approveProposals({ db, git: mockGit }, projId, []);
    expect(created).toEqual([]);
  });

  it('sets allowed_paths and verification_commands on tickets', async () => {
    const proposals = [
      makeProposal({
        title: 'With paths',
        allowed_paths: ['src/a.ts', 'src/b.ts'],
        verification_commands: ['npm run build', 'npm test'],
      }),
    ];

    const created = await approveProposals({ db, git: mockGit }, projId, proposals);
    expect(created[0].allowedPaths).toEqual(['src/a.ts', 'src/b.ts']);
    expect(created[0].verificationCommands).toEqual(['npm run build', 'npm test']);
  });

  it('tickets are persisted and retrievable', async () => {
    const proposals = [makeProposal({ title: 'Persist check' })];
    const created = await approveProposals({ db, git: mockGit }, projId, proposals);

    const fetched = await tickets.getById(db, created[0].id);
    expect(fetched).not.toBeNull();
    expect(fetched!.title).toBe('Persist check');
  });
});
