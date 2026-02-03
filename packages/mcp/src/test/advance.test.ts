/**
 * Tests for the advance engine (state machine + budgets + terminal states).
 *
 * Uses a real SQLite in-memory DB to test the full advance loop.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createSQLiteAdapter } from '@blockspool/sqlite';
import { repos } from '@blockspool/core';
import type { DatabaseAdapter, Project } from '@blockspool/core';
import { RunManager } from '../run-manager.js';
import { advance } from '../advance.js';
import { processEvent } from '../event-processor.js';
import type { AdvanceResponse } from '../types.js';

let db: DatabaseAdapter;
let project: Project;
let tmpDir: string;
let run: RunManager;

beforeEach(async () => {
  // Create temp dir for run folders
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-test-'));

  // Create in-memory SQLite
  const dbPath = path.join(tmpDir, 'test.sqlite');
  db = await createSQLiteAdapter({ url: dbPath });

  // Ensure project
  project = await repos.projects.ensureForRepo(db, {
    name: 'test-project',
    rootPath: tmpDir,
  });

  // Create run manager
  run = new RunManager(tmpDir);
});

afterEach(async () => {
  try {
    if (run.current) run.end();
  } catch { /* ignore */ }
  await db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function ctx() {
  return { run, db, project };
}

function startRun(overrides?: Record<string, unknown>) {
  return run.create(project.id, {
    step_budget: 10,
    ticket_step_budget: 5,
    max_prs: 3,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Phase: SCOUT
// ---------------------------------------------------------------------------

describe('advance — SCOUT phase', () => {
  it('returns scout prompt when no tickets exist', async () => {
    startRun();
    const resp = await advance(ctx());

    expect(resp.next_action).toBe('PROMPT');
    expect(resp.phase).toBe('SCOUT');
    expect(resp.prompt).toContain('Scout Phase');
    expect(resp.digest.step).toBe(1);
  });

  it('transitions to NEXT_TICKET when ready tickets exist', async () => {
    startRun();

    // Seed a ready ticket
    await repos.tickets.create(db, {
      projectId: project.id,
      title: 'Test ticket',
      description: 'Do something',
      status: 'ready',
      priority: 80,
      category: 'refactor',
      allowedPaths: ['src/**'],
      verificationCommands: ['npm test'],
    });

    const resp = await advance(ctx());

    // Should skip SCOUT and go straight to PLAN (via NEXT_TICKET)
    expect(resp.phase).toBe('PLAN');
    expect(resp.next_action).toBe('PROMPT');
    expect(resp.prompt).toContain('Commit Plan Required');
  });
});

// ---------------------------------------------------------------------------
// Phase: NEXT_TICKET
// ---------------------------------------------------------------------------

describe('advance — NEXT_TICKET phase', () => {
  it('transitions to DONE when no tickets and already scouted', async () => {
    startRun();
    const s = run.require();
    s.phase = 'NEXT_TICKET';
    s.scout_cycles = 1; // Already scouted

    const resp = await advance(ctx());

    expect(resp.next_action).toBe('STOP');
    expect(resp.phase).toBe('DONE');
  });

  it('transitions to SCOUT when no tickets and never scouted', async () => {
    startRun();
    const s = run.require();
    s.phase = 'NEXT_TICKET';
    s.scout_cycles = 0;

    const resp = await advance(ctx());

    // Goes to SCOUT, which returns a prompt
    expect(resp.next_action).toBe('PROMPT');
    expect(resp.phase).toBe('SCOUT');
  });

  it('transitions to DONE when PR limit reached', async () => {
    startRun({ max_prs: 2 });
    const s = run.require();
    s.phase = 'NEXT_TICKET';
    s.prs_created = 2;

    const resp = await advance(ctx());

    expect(resp.next_action).toBe('STOP');
    expect(resp.phase).toBe('DONE');
    expect(resp.reason).toContain('PR limit');
  });
});

// ---------------------------------------------------------------------------
// Phase: PLAN
// ---------------------------------------------------------------------------

describe('advance — PLAN phase', () => {
  it('returns plan prompt for assigned ticket', async () => {
    startRun();

    const ticket = await repos.tickets.create(db, {
      projectId: project.id,
      title: 'Plan test',
      description: 'Needs planning',
      status: 'in_progress',
      priority: 80,
      category: 'refactor',
      allowedPaths: ['src/**'],
      verificationCommands: ['npm test'],
    });

    const s = run.require();
    s.phase = 'PLAN';
    s.current_ticket_id = ticket.id;

    const resp = await advance(ctx());

    expect(resp.next_action).toBe('PROMPT');
    expect(resp.phase).toBe('PLAN');
    expect(resp.prompt).toContain('Commit Plan Required');
    expect(resp.constraints.plan_required).toBe(true);
  });

  it('transitions to BLOCKED_NEEDS_HUMAN after max plan rejections', async () => {
    startRun();

    const ticket = await repos.tickets.create(db, {
      projectId: project.id,
      title: 'Plan rejection test',
      description: 'Will be rejected',
      status: 'in_progress',
      priority: 80,
      category: 'refactor',
      allowedPaths: [],
      verificationCommands: [],
    });

    const s = run.require();
    s.phase = 'PLAN';
    s.current_ticket_id = ticket.id;
    s.plan_rejections = 3;

    const resp = await advance(ctx());

    expect(resp.next_action).toBe('STOP');
    expect(resp.phase).toBe('BLOCKED_NEEDS_HUMAN');
    expect(resp.reason).toContain('rejected');
  });
});

// ---------------------------------------------------------------------------
// Phase: EXECUTE
// ---------------------------------------------------------------------------

describe('advance — EXECUTE phase', () => {
  it('returns execute prompt', async () => {
    startRun();

    const ticket = await repos.tickets.create(db, {
      projectId: project.id,
      title: 'Execute test',
      description: 'Do the work',
      status: 'in_progress',
      priority: 80,
      category: 'refactor',
      allowedPaths: ['src/**'],
      verificationCommands: ['npm test'],
    });

    const s = run.require();
    s.phase = 'EXECUTE';
    s.current_ticket_id = ticket.id;
    s.plan_approved = true;

    const resp = await advance(ctx());

    expect(resp.next_action).toBe('PROMPT');
    expect(resp.phase).toBe('EXECUTE');
    expect(resp.prompt).toContain('Execute: Execute test');
  });

  it('blocks when ticket step budget exhausted', async () => {
    startRun({ ticket_step_budget: 3 });

    const ticket = await repos.tickets.create(db, {
      projectId: project.id,
      title: 'Budget test',
      description: 'Will run out',
      status: 'in_progress',
      priority: 80,
      category: 'refactor',
      allowedPaths: [],
      verificationCommands: [],
    });

    const s = run.require();
    s.phase = 'EXECUTE';
    s.current_ticket_id = ticket.id;
    s.ticket_step_count = 3;

    const resp = await advance(ctx());

    expect(resp.next_action).toBe('STOP');
    expect(resp.phase).toBe('BLOCKED_NEEDS_HUMAN');
    expect(resp.reason).toContain('Ticket step budget');
  });
});

// ---------------------------------------------------------------------------
// Budget enforcement
// ---------------------------------------------------------------------------

describe('advance — budget enforcement', () => {
  it('stops at step budget', async () => {
    startRun({ step_budget: 3 });
    const s = run.require();
    s.step_count = 3; // already at limit

    const resp = await advance(ctx());

    expect(resp.next_action).toBe('STOP');
    expect(resp.phase).toBe('FAILED_BUDGET');
    expect(resp.reason).toContain('Step budget');
  });

  it('stops at time budget', async () => {
    startRun({ hours: 1 });
    const s = run.require();
    // Set expiry to the past
    s.expires_at = new Date(Date.now() - 1000).toISOString();

    const resp = await advance(ctx());

    expect(resp.next_action).toBe('STOP');
    expect(resp.phase).toBe('FAILED_BUDGET');
    expect(resp.reason).toContain('Time budget');
  });
});

// ---------------------------------------------------------------------------
// Terminal states
// ---------------------------------------------------------------------------

describe('advance — terminal states', () => {
  for (const phase of ['DONE', 'BLOCKED_NEEDS_HUMAN', 'FAILED_BUDGET', 'FAILED_VALIDATION', 'FAILED_SPINDLE'] as const) {
    it(`returns STOP for terminal phase ${phase}`, async () => {
      startRun();
      const s = run.require();
      s.phase = phase;

      const resp = await advance(ctx());

      expect(resp.next_action).toBe('STOP');
      expect(resp.phase).toBe(phase);
    });
  }
});

// ---------------------------------------------------------------------------
// Event processor
// ---------------------------------------------------------------------------

describe('processEvent', () => {
  it('PLAN_SUBMITTED auto-approves low-risk plan', async () => {
    startRun();
    const s = run.require();
    s.phase = 'PLAN';
    s.current_ticket_id = 'tkt_test';

    const result = await processEvent(run, db, 'PLAN_SUBMITTED', {
      ticket_id: 'tkt_test',
      files_to_touch: [{ path: 'src/foo.ts', action: 'modify', reason: 'fix bug' }],
      expected_tests: ['npm test'],
      estimated_lines: 10,
      risk_level: 'low',
    });

    expect(result.phase_changed).toBe(true);
    expect(result.new_phase).toBe('EXECUTE');
    expect(s.plan_approved).toBe(true);
  });

  it('PLAN_SUBMITTED rejects plan exceeding line limit', async () => {
    startRun();
    const s = run.require();
    s.phase = 'PLAN';
    s.current_ticket_id = 'tkt_test';

    const result = await processEvent(run, db, 'PLAN_SUBMITTED', {
      ticket_id: 'tkt_test',
      files_to_touch: [{ path: 'src/foo.ts', action: 'modify', reason: 'big change' }],
      expected_tests: [],
      estimated_lines: 9999,
      risk_level: 'low',
    });

    expect(result.phase_changed).toBe(false);
    expect(result.message).toContain('rejected');
    expect(s.plan_rejections).toBe(1);
  });

  it('PLAN_SUBMITTED rejects plan touching sensitive files', async () => {
    startRun();
    const s = run.require();
    s.phase = 'PLAN';
    s.current_ticket_id = 'tkt_test';

    const result = await processEvent(run, db, 'PLAN_SUBMITTED', {
      ticket_id: 'tkt_test',
      files_to_touch: [{ path: '.env', action: 'modify', reason: 'add key' }],
      expected_tests: [],
      estimated_lines: 5,
      risk_level: 'low',
    });

    expect(result.message).toContain('denied path');
  });

  it('TICKET_RESULT done transitions to QA', async () => {
    startRun();
    const s = run.require();
    s.phase = 'EXECUTE';
    s.current_ticket_id = 'tkt_test';

    const result = await processEvent(run, db, 'TICKET_RESULT', {
      status: 'done',
      changed_files: ['src/foo.ts'],
    });

    expect(result.phase_changed).toBe(true);
    expect(result.new_phase).toBe('QA');
  });

  it('QA_PASSED transitions to PR', async () => {
    startRun();

    const ticket = await repos.tickets.create(db, {
      projectId: project.id,
      title: 'QA test',
      description: 'test',
      status: 'in_progress',
      priority: 80,
      category: 'refactor',
      allowedPaths: [],
      verificationCommands: [],
    });

    const s = run.require();
    s.phase = 'QA';
    s.current_ticket_id = ticket.id;

    const result = await processEvent(run, db, 'QA_PASSED', {});

    expect(result.phase_changed).toBe(true);
    expect(result.new_phase).toBe('PR');
  });

  it('QA_FAILED retries then gives up', async () => {
    startRun();

    const ticket = await repos.tickets.create(db, {
      projectId: project.id,
      title: 'QA fail test',
      description: 'test',
      status: 'in_progress',
      priority: 80,
      category: 'refactor',
      allowedPaths: [],
      verificationCommands: [],
    });

    const s = run.require();
    s.phase = 'QA';
    s.current_ticket_id = ticket.id;
    s.qa_retries = 0;

    // First failure: retry
    let result = await processEvent(run, db, 'QA_FAILED', { error: 'test failed' });
    expect(result.new_phase).toBe('EXECUTE');
    expect(s.qa_retries).toBe(1);

    // Reset phase for next call
    s.phase = 'QA';
    result = await processEvent(run, db, 'QA_FAILED', { error: 'test failed' });
    expect(result.new_phase).toBe('EXECUTE');
    expect(s.qa_retries).toBe(2);

    // Third failure: give up
    s.phase = 'QA';
    result = await processEvent(run, db, 'QA_FAILED', { error: 'test failed' });
    expect(result.new_phase).toBe('NEXT_TICKET');
  });

  it('PR_CREATED increments counter and moves to NEXT_TICKET', async () => {
    startRun();
    const s = run.require();
    s.phase = 'PR';
    s.current_ticket_id = 'tkt_test';

    const result = await processEvent(run, db, 'PR_CREATED', {
      url: 'https://github.com/test/pr/1',
    });

    expect(result.phase_changed).toBe(true);
    expect(result.new_phase).toBe('NEXT_TICKET');
    expect(s.prs_created).toBe(1);
  });

  it('USER_OVERRIDE cancel transitions to DONE', async () => {
    startRun();
    const s = run.require();

    const result = await processEvent(run, db, 'USER_OVERRIDE', { cancel: true });

    expect(result.phase_changed).toBe(true);
    expect(result.new_phase).toBe('DONE');
  });
});

// ---------------------------------------------------------------------------
// Budget warnings
// ---------------------------------------------------------------------------

describe('advance — budget warnings', () => {
  it('fires warning at 80% of step budget', async () => {
    startRun({ step_budget: 10 });
    const s = run.require();
    s.step_count = 7; // 80% of 10 = 8, but advance increments first

    await advance(ctx());

    // Check events for budget warning
    const eventsPath = path.join(tmpDir, '.blockspool', 'runs', s.run_id, 'events.ndjson');
    const events = fs.readFileSync(eventsPath, 'utf8')
      .trim().split('\n').map(l => JSON.parse(l));
    const warnings = events.filter(e => e.type === 'BUDGET_WARNING');
    expect(warnings.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Digest
// ---------------------------------------------------------------------------

describe('advance — digest', () => {
  it('includes correct digest in response', async () => {
    startRun({ step_budget: 100 });

    const resp = await advance(ctx());

    expect(resp.digest).toMatchObject({
      step: 1,
      phase: expect.any(String),
      tickets_completed: 0,
      tickets_failed: 0,
      budget_remaining: 99,
    });
  });
});

// ---------------------------------------------------------------------------
// Parallel execution: event forwarding
// ---------------------------------------------------------------------------

describe('advance — parallel execution event forwarding', () => {
  it('PR_CREATED via processEvent is forwarded to ticket worker in PARALLEL_EXECUTE phase', async () => {
    startRun({ parallel: 2 });

    const ticket = await repos.tickets.create(db, {
      projectId: project.id,
      title: 'Parallel test ticket',
      description: 'test',
      status: 'in_progress',
      priority: 80,
      category: 'refactor',
      allowedPaths: [],
      verificationCommands: [],
    });

    const s = run.require();
    s.phase = 'PARALLEL_EXECUTE';

    // Initialize ticket worker (simulating what advanceNextTicket does)
    run.initTicketWorker(ticket.id, { title: ticket.title });

    // Call processEvent with PR_CREATED (simulating user calling blockspool_ingest_event)
    const result = await processEvent(run, db, 'PR_CREATED', {
      ticket_id: ticket.id,
      url: 'https://github.com/test/pr/1',
      branch: 'blockspool/test',
    }, project);

    // Should be forwarded to ticket worker and complete the ticket
    expect(result.processed).toBe(true);
    expect(result.message).toBe('PR created, ticket complete');
    expect(s.tickets_completed).toBe(1);
    expect(s.prs_created).toBe(1);

    // Worker should be removed
    expect(run.getTicketWorker(ticket.id)).toBeNull();
  });

  it('TICKET_RESULT via processEvent is forwarded to ticket worker in PARALLEL_EXECUTE phase', async () => {
    startRun({ parallel: 2 });

    const ticket = await repos.tickets.create(db, {
      projectId: project.id,
      title: 'Parallel test ticket 2',
      description: 'test',
      status: 'in_progress',
      priority: 80,
      category: 'refactor',
      allowedPaths: [],
      verificationCommands: [],
    });

    const s = run.require();
    s.phase = 'PARALLEL_EXECUTE';

    // Initialize ticket worker
    run.initTicketWorker(ticket.id, { title: ticket.title });

    // Call processEvent with TICKET_RESULT (done status with PR URL)
    const result = await processEvent(run, db, 'TICKET_RESULT', {
      ticket_id: ticket.id,
      status: 'done',
      pr_url: 'https://github.com/test/pr/2',
    }, project);

    // Should be forwarded and complete with PR
    expect(result.processed).toBe(true);
    expect(result.message).toBe('Ticket complete with PR');
    expect(s.tickets_completed).toBe(1);
    expect(s.prs_created).toBe(1);
  });

  it('events without ticket_id fall through to normal processing', async () => {
    startRun({ parallel: 2 });

    const s = run.require();
    s.phase = 'PARALLEL_EXECUTE';

    // PR_CREATED without ticket_id should fall through to normal processing
    // which will return "PR created outside PR phase"
    const result = await processEvent(run, db, 'PR_CREATED', {
      url: 'https://github.com/test/pr/1',
    }, project);

    expect(result.message).toBe('PR created outside PR phase');
  });

  it('events for non-existent workers fall through to normal processing', async () => {
    startRun({ parallel: 2 });

    const s = run.require();
    s.phase = 'PARALLEL_EXECUTE';

    // PR_CREATED with ticket_id that has no worker should fall through
    const result = await processEvent(run, db, 'PR_CREATED', {
      ticket_id: 'nonexistent',
      url: 'https://github.com/test/pr/1',
    }, project);

    expect(result.message).toBe('PR created outside PR phase');
  });
});
