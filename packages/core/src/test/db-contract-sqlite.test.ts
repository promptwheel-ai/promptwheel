import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createSQLiteAdapter } from '@promptwheel/sqlite';
import * as projects from '../repos/projects.js';
import * as tickets from '../repos/tickets.js';
import * as runs from '../repos/runs.js';
import type { DatabaseAdapter } from '../db/adapter.js';

let db: DatabaseAdapter;
let tmpDir: string;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptwheel-test-'));
  const dbPath = path.join(tmpDir, 'test.db');
  db = await createSQLiteAdapter({ url: dbPath });
});

afterAll(async () => {
  await db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('projects repo', () => {
  it('creates a project via ensureForRepo', async () => {
    const project = await projects.ensureForRepo(db, {
      id: 'proj_test1',
      name: 'test-project',
      rootPath: '/tmp/test-project',
      repoUrl: 'https://github.com/test/project',
    });

    expect(project.id).toBe('proj_test1');
    expect(project.name).toBe('test-project');
    expect(project.rootPath).toBe('/tmp/test-project');
    expect(project.repoUrl).toBe('https://github.com/test/project');
  });

  it('getById returns created project', async () => {
    const project = await projects.getById(db, 'proj_test1');

    expect(project).not.toBeNull();
    expect(project!.id).toBe('proj_test1');
    expect(project!.name).toBe('test-project');
  });

  it('getOrCreate returns existing project', async () => {
    const project = await projects.ensureForRepo(db, {
      id: 'proj_test1_different_id',
      name: 'different-name',
      rootPath: '/tmp/test-project',
    });

    // Should return the existing one (matched by rootPath)
    expect(project.id).toBe('proj_test1');
    expect(project.name).toBe('test-project');
  });

  it('list returns all projects', async () => {
    await projects.ensureForRepo(db, {
      id: 'proj_test2',
      name: 'second-project',
      rootPath: '/tmp/second-project',
    });

    const all = await projects.list(db);
    expect(all.length).toBeGreaterThanOrEqual(2);

    const ids = all.map(p => p.id);
    expect(ids).toContain('proj_test1');
    expect(ids).toContain('proj_test2');
  });
});

describe('tickets repo', () => {
  it('creates a ticket', async () => {
    const ticket = await tickets.create(db, {
      projectId: 'proj_test1',
      title: 'Fix broken tests',
      description: 'Some tests are flaky',
      status: 'ready',
      priority: 50,
      category: 'test',
    });

    expect(ticket.id).toMatch(/^tkt_/);
    expect(ticket.title).toBe('Fix broken tests');
    expect(ticket.projectId).toBe('proj_test1');
    expect(ticket.status).toBe('ready');
    expect(ticket.category).toBe('test');
  });

  let ticketId: string;

  it('getById returns ticket', async () => {
    const created = await tickets.create(db, {
      projectId: 'proj_test1',
      title: 'Improve docs',
      description: 'Add examples',
      priority: 30,
      category: 'docs',
    });
    ticketId = created.id;

    const ticket = await tickets.getById(db, ticketId);
    expect(ticket).not.toBeNull();
    expect(ticket!.title).toBe('Improve docs');
  });

  it('listByProject with status filter', async () => {
    await tickets.create(db, {
      projectId: 'proj_test1',
      title: 'Done ticket',
      status: 'done',
      priority: 10,
    });

    const readyTickets = await tickets.listByProject(db, 'proj_test1', { status: 'ready' });
    for (const t of readyTickets) {
      expect(t.status).toBe('ready');
    }

    const doneTickets = await tickets.listByProject(db, 'proj_test1', { status: 'done' });
    expect(doneTickets.length).toBeGreaterThanOrEqual(1);
    for (const t of doneTickets) {
      expect(t.status).toBe('done');
    }
  });

  it('updateStatus changes status', async () => {
    const updated = await tickets.updateStatus(db, ticketId, 'in_progress');

    expect(updated).not.toBeNull();
    expect(updated!.status).toBe('in_progress');

    const fetched = await tickets.getById(db, ticketId);
    expect(fetched!.status).toBe('in_progress');
  });
});

describe('runs repo', () => {
  let runId: string;

  it('creates a run', async () => {
    const run = await runs.create(db, {
      projectId: 'proj_test1',
      type: 'scout',
      metadata: { scope: 'src/**' },
    });

    runId = run.id;
    expect(run.id).toMatch(/^run_/);
    expect(run.projectId).toBe('proj_test1');
    expect(run.type).toBe('scout');
    expect(run.status).toBe('running');
    expect(run.metadata).toEqual({ scope: 'src/**' });
  });

  it('getById returns run', async () => {
    const run = await runs.getById(db, runId);

    expect(run).not.toBeNull();
    expect(run!.id).toBe(runId);
    expect(run!.type).toBe('scout');
  });

  it('markSuccess changes status', async () => {
    const updated = await runs.markSuccess(db, runId, { proposalCount: 5 });

    expect(updated).not.toBeNull();
    expect(updated!.status).toBe('success');
    expect(updated!.completedAt).not.toBeNull();
    expect(updated!.metadata).toEqual(expect.objectContaining({
      scope: 'src/**',
      proposalCount: 5,
    }));
  });

  it('markFailure records error', async () => {
    const run = await runs.create(db, {
      projectId: 'proj_test1',
      type: 'worker',
    });

    const updated = await runs.markFailure(db, run.id, new Error('Build failed'), {
      durationMs: 1234,
    });

    expect(updated).not.toBeNull();
    expect(updated!.status).toBe('failure');
    expect(updated!.error).toBe('Build failed');
    expect(updated!.completedAt).not.toBeNull();
    expect(updated!.metadata).toEqual(expect.objectContaining({ durationMs: 1234 }));
  });

  it('listByProject returns runs for project', async () => {
    const allRuns = await runs.listByProject(db, 'proj_test1');

    expect(allRuns.length).toBeGreaterThanOrEqual(2);
    for (const r of allRuns) {
      expect(r.projectId).toBe('proj_test1');
    }
  });

  it('listByProject filters by type', async () => {
    const scoutRuns = await runs.listByProject(db, 'proj_test1', { type: 'scout' });
    for (const r of scoutRuns) {
      expect(r.type).toBe('scout');
    }
  });
});
