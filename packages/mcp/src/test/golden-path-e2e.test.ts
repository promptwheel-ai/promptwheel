/**
 * Golden Path E2E — proves the full state machine works end-to-end.
 *
 * Simulates: SCOUT → PLAN → EXECUTE → QA → PR → DONE
 * No real Claude needed. Just MCP-level event injection.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createSQLiteAdapter } from '@promptwheel/sqlite';
import { repos } from '@promptwheel/core';
import type { DatabaseAdapter, Project } from '@promptwheel/core';
import { RunManager } from '../run-manager.js';
import { advance } from '../advance.js';
import type { AdvanceContext } from '../advance.js';
import { processEvent } from '../event-processor.js';
import type { RawProposal } from '../proposals.js';

let db: DatabaseAdapter;
let project: Project;
let tmpDir: string;
let run: RunManager;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-e2e-'));
  const dbPath = path.join(tmpDir, 'test.sqlite');
  db = await createSQLiteAdapter({ url: dbPath });
  project = await repos.projects.ensureForRepo(db, {
    name: 'e2e-project',
    rootPath: tmpDir,
  });
  run = new RunManager(tmpDir);
});

afterEach(async () => {
  try { if (run.current) run.end(); } catch { /* ignore */ }
  await db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function ctx(): AdvanceContext {
  return { run, db, project };
}

/** Simulates promptwheel_ingest_event: log raw event then process */
async function ingestEvent(type: string, payload: Record<string, unknown>) {
  run.appendEvent(type as any, payload);
  return processEvent(run, db, type as any, payload);
}

function makeProposal(title: string): RawProposal {
  return {
    category: 'refactor',
    title,
    description: 'Fix the thing',
    acceptance_criteria: ['Tests pass'],
    verification_commands: ['npm test'],
    allowed_paths: ['src/**'],
    files: ['src/utils.ts'],
    confidence: 85,
    impact_score: 7,
    rationale: 'Reduces complexity',
    estimated_complexity: 'simple',
    risk: 'low',
    touched_files_estimate: 1,
    rollback_note: 'Revert single commit',
  };
}

// ---------------------------------------------------------------------------
// The Golden Path
// ---------------------------------------------------------------------------

describe('Golden Path E2E', () => {
  it('completes full flow: scout → plan → execute → qa → pr → done', async () => {
    // 1. Start session
    run.create(project.id, {
      step_budget: 50,
      ticket_step_budget: 12,
      max_prs: 5,
      create_prs: true,
      categories: ['refactor', 'test', 'docs'],
    });

    // 2. First advance → SCOUT (no tickets yet)
    let resp = await advance(ctx());
    expect(resp.phase).toBe('SCOUT');
    expect(resp.next_action).toBe('PROMPT');
    expect(resp.prompt).toContain('Scout Phase');

    // 3. Inject scout output with a proposal (stored as pending)
    const scoutResult = await ingestEvent('SCOUT_OUTPUT', {
      proposals: [makeProposal('Remove unused import in utils.ts')],
    });
    expect(scoutResult.phase_changed).toBe(false);
    expect(scoutResult.message).toContain('pending');

    // 3b. Advance returns review prompt
    resp = await advance(ctx());
    expect(resp.phase).toBe('SCOUT');
    expect(resp.prompt).toContain('Adversarial Proposal Review');

    // 3c. Submit reviewed proposals
    const reviewResult = await ingestEvent('PROPOSALS_REVIEWED', {
      reviewed_proposals: [
        { title: 'Remove unused import in utils.ts', confidence: 85, impact_score: 7 },
      ],
    });
    expect(reviewResult.phase_changed).toBe(true);
    expect(reviewResult.new_phase).toBe('NEXT_TICKET');

    // 4. Advance → NEXT_TICKET picks up ticket → PLAN
    resp = await advance(ctx());
    expect(resp.phase).toBe('PLAN');
    expect(resp.next_action).toBe('PROMPT');
    expect(resp.prompt).toContain('Commit Plan Required');
    expect(resp.constraints.plan_required).toBe(true);

    const s = run.require();
    expect(s.current_ticket_id).not.toBeNull();
    const ticketId = s.current_ticket_id!;

    // 5. Submit plan
    const planResult = await ingestEvent('PLAN_SUBMITTED', {
      ticket_id: ticketId,
      files_to_touch: [{ path: 'src/utils.ts', action: 'modify', reason: 'Remove unused import' }],
      expected_tests: ['npm test'],
      estimated_lines: 5,
      risk_level: 'low',
    });
    expect(planResult.phase_changed).toBe(true);
    expect(planResult.new_phase).toBe('EXECUTE');

    // 6. Advance → EXECUTE
    resp = await advance(ctx());
    expect(resp.phase).toBe('EXECUTE');
    expect(resp.next_action).toBe('PROMPT');
    expect(resp.prompt).toContain('Execute:');
    expect(resp.prompt).toContain('Approved Commit Plan');

    // 7. Inject ticket result (done)
    const ticketResult = await ingestEvent('TICKET_RESULT', {
      status: 'done',
      changed_files: ['src/utils.ts'],
      lines_added: 0,
      lines_removed: 3,
      summary: 'Removed unused import',
    });
    expect(ticketResult.phase_changed).toBe(true);
    expect(ticketResult.new_phase).toBe('QA');

    // 8. Advance → QA
    resp = await advance(ctx());
    expect(resp.phase).toBe('QA');
    expect(resp.prompt).toContain('QA:');
    expect(resp.prompt).toContain('npm test');

    // 9. Inject QA command result
    await ingestEvent('QA_COMMAND_RESULT', {
      command: 'npm test',
      success: true,
      output: 'All tests passed',
    });

    // 10. Inject QA passed
    const qaResult = await ingestEvent('QA_PASSED', {});
    expect(qaResult.phase_changed).toBe(true);
    expect(qaResult.new_phase).toBe('PR');

    // 11. Advance → PR
    resp = await advance(ctx());
    expect(resp.phase).toBe('PR');
    expect(resp.prompt).toContain('Create PR');
    expect(resp.prompt).toContain('Dry-run');

    // 12. Inject PR created
    const prResult = await ingestEvent('PR_CREATED', {
      url: 'https://github.com/test/repo/pull/42',
      branch: 'promptwheel/remove-unused-import',
    });
    expect(prResult.phase_changed).toBe(true);
    expect(prResult.new_phase).toBe('NEXT_TICKET');

    // 13. Advance → NEXT_TICKET → DONE (no more tickets, already scouted)
    resp = await advance(ctx());
    expect(resp.next_action).toBe('STOP');
    expect(resp.phase).toBe('DONE');

    // ---------------------------------------------------------------------------
    // Verify final state
    // ---------------------------------------------------------------------------
    const finalState = run.require();
    expect(finalState.tickets_completed).toBe(1);
    expect(finalState.prs_created).toBe(1);
    expect(finalState.total_lines_changed).toBe(3);

    // Verify ticket is done in DB
    const ticket = await repos.tickets.getById(db, ticketId);
    expect(ticket!.status).toBe('done');

    // Verify events.ndjson has full trace
    const eventsPath = path.join(
      tmpDir, '.promptwheel', 'runs', finalState.run_id, 'events.ndjson',
    );
    expect(fs.existsSync(eventsPath)).toBe(true);
    const events = fs.readFileSync(eventsPath, 'utf8')
      .trim().split('\n').map(l => JSON.parse(l));

    const eventTypes = events.map(e => e.type);
    expect(eventTypes).toContain('SESSION_START');
    expect(eventTypes).toContain('ADVANCE_CALLED');
    expect(eventTypes).toContain('SCOUT_OUTPUT');
    expect(eventTypes).toContain('PROPOSALS_REVIEWED');
    expect(eventTypes).toContain('PROPOSALS_FILTERED');
    expect(eventTypes).toContain('TICKETS_CREATED');
    expect(eventTypes).toContain('TICKET_ASSIGNED');
    expect(eventTypes).toContain('PLAN_SUBMITTED');
    expect(eventTypes).toContain('PLAN_APPROVED');
    expect(eventTypes).toContain('TICKET_RESULT');
    expect(eventTypes).toContain('QA_COMMAND_RESULT');
    expect(eventTypes).toContain('QA_PASSED');
    expect(eventTypes).toContain('PR_CREATED');
    expect(eventTypes).toContain('TICKET_COMPLETED');

    // Verify artifacts exist
    const artifactsDir = path.join(
      tmpDir, '.promptwheel', 'runs', finalState.run_id, 'artifacts',
    );
    const artifacts = fs.readdirSync(artifactsDir);
    expect(artifacts.some(a => a.includes('scout-proposals'))).toBe(true);
    expect(artifacts.some(a => a.includes('ticket-result'))).toBe(true);
    expect(artifacts.some(a => a.includes('qa-'))).toBe(true);
    expect(artifacts.some(a => a.includes('pr-created'))).toBe(true);
  });

  it('handles QA failure → retry → pass flow', async () => {
    run.create(project.id, {
      step_budget: 50,
      create_prs: true,
      categories: ['refactor'],
    });

    // Seed a ticket directly
    const ticket = await repos.tickets.create(db, {
      projectId: project.id,
      title: 'Fix failing test',
      description: 'The test is broken',
      status: 'ready',
      priority: 80,
      category: 'refactor',
      allowedPaths: ['src/**'],
      verificationCommands: ['npm test'],
    });

    // Advance through to EXECUTE
    let resp = await advance(ctx()); // SCOUT → NEXT_TICKET (has ticket) → PLAN
    expect(resp.phase).toBe('PLAN');

    await ingestEvent('PLAN_SUBMITTED', {
      ticket_id: ticket.id,
      files_to_touch: [{ path: 'src/test.ts', action: 'modify', reason: 'fix test' }],
      expected_tests: ['npm test'],
      estimated_lines: 10,
      risk_level: 'low',
    });

    resp = await advance(ctx()); // EXECUTE
    expect(resp.phase).toBe('EXECUTE');

    await ingestEvent('TICKET_RESULT', {
      status: 'done',
      changed_files: ['src/test.ts'],
      lines_added: 5,
      lines_removed: 5,
    });

    resp = await advance(ctx()); // QA
    expect(resp.phase).toBe('QA');

    // QA fails first time
    await ingestEvent('QA_FAILED', { error: 'Test still failing' });
    expect(run.require().qa_retries).toBe(1);
    expect(run.require().phase).toBe('EXECUTE');

    // Back to EXECUTE for fix
    resp = await advance(ctx());
    expect(resp.phase).toBe('EXECUTE');

    // Re-submit ticket result
    await ingestEvent('TICKET_RESULT', {
      status: 'done',
      changed_files: ['src/test.ts'],
      lines_added: 7,
      lines_removed: 5,
    });

    resp = await advance(ctx()); // QA again
    expect(resp.phase).toBe('QA');

    // QA passes this time
    await ingestEvent('QA_PASSED', {});
    expect(run.require().phase).toBe('PR');

    // PR
    resp = await advance(ctx());
    expect(resp.phase).toBe('PR');

    await ingestEvent('PR_CREATED', {
      url: 'https://github.com/test/pr/1',
    });

    // NEXT_TICKET → SCOUT (scout_cycles=0 since ticket was seeded directly)
    resp = await advance(ctx());
    expect(resp.phase).toBe('SCOUT');
    expect(run.require().tickets_completed).toBe(1);

    // Inject empty scout output → exhaust retries → DONE
    run.require().scout_retries = 3;
    await ingestEvent('SCOUT_OUTPUT', { proposals: [] });
    resp = await advance(ctx());
    expect(resp.phase).toBe('DONE');
  });

  it('handles ticket failure flow', async () => {
    run.create(project.id, {
      step_budget: 50,
      categories: ['refactor'],
    });

    await repos.tickets.create(db, {
      projectId: project.id,
      title: 'Impossible task',
      description: 'Cannot be done',
      status: 'ready',
      priority: 80,
      category: 'refactor',
      allowedPaths: ['src/**'],
      verificationCommands: [],
    });

    // Advance to PLAN
    let resp = await advance(ctx());
    expect(resp.phase).toBe('PLAN');

    const s = run.require();
    const ticketId = s.current_ticket_id!;

    await ingestEvent('PLAN_SUBMITTED', {
      ticket_id: ticketId,
      files_to_touch: [{ path: 'src/foo.ts', action: 'modify', reason: 'attempt' }],
      expected_tests: [],
      estimated_lines: 10,
      risk_level: 'low',
    });

    resp = await advance(ctx()); // EXECUTE

    // Ticket fails
    await ingestEvent('TICKET_RESULT', {
      status: 'failed',
      reason: 'Cannot figure out the solution',
    });

    // NEXT_TICKET → SCOUT (scout_cycles=0 since ticket was seeded directly)
    resp = await advance(ctx());
    expect(resp.phase).toBe('SCOUT');
    expect(run.require().tickets_failed).toBe(1);

    // Empty scout → exhaust retries → DONE
    run.require().scout_retries = 3;
    await ingestEvent('SCOUT_OUTPUT', { proposals: [] });
    resp = await advance(ctx());
    expect(resp.phase).toBe('DONE');
  });

  it('validates changed files against plan', async () => {
    run.create(project.id, {
      step_budget: 50,
      categories: ['refactor'],
    });

    const ticket = await repos.tickets.create(db, {
      projectId: project.id,
      title: 'Scoped change',
      description: 'Only touch one file',
      status: 'ready',
      priority: 80,
      category: 'refactor',
      allowedPaths: ['src/**'],
      verificationCommands: [],
    });

    let resp = await advance(ctx()); // → PLAN
    const ticketId = run.require().current_ticket_id!;

    await ingestEvent('PLAN_SUBMITTED', {
      ticket_id: ticketId,
      files_to_touch: [{ path: 'src/foo.ts', action: 'modify', reason: 'fix' }],
      expected_tests: [],
      estimated_lines: 10,
      risk_level: 'low',
    });

    resp = await advance(ctx()); // → EXECUTE

    // Submit result with surprise file not in plan
    const result = await ingestEvent('TICKET_RESULT', {
      status: 'done',
      changed_files: ['src/foo.ts', 'src/bar.ts'], // bar.ts not in plan!
      lines_added: 5,
      lines_removed: 2,
    });

    expect(result.phase_changed).toBe(false);
    expect(result.message).toContain('not in plan');
    expect(result.message).toContain('src/bar.ts');
    // Should still be in EXECUTE
    expect(run.require().phase).toBe('EXECUTE');
  });

  it('validates lines changed against budget', async () => {
    run.create(project.id, {
      step_budget: 50,
      categories: ['refactor'],
    });

    await repos.tickets.create(db, {
      projectId: project.id,
      title: 'Small change',
      description: 'Should be small',
      status: 'ready',
      priority: 80,
      category: 'refactor',
      allowedPaths: ['src/**'],
      verificationCommands: [],
    });

    await advance(ctx()); // → PLAN
    const ticketId = run.require().current_ticket_id!;

    await ingestEvent('PLAN_SUBMITTED', {
      ticket_id: ticketId,
      files_to_touch: [{ path: 'src/foo.ts', action: 'modify', reason: 'fix' }],
      expected_tests: [],
      estimated_lines: 10,
      risk_level: 'low',
    });

    await advance(ctx()); // → EXECUTE

    // Submit result with too many lines
    const result = await ingestEvent('TICKET_RESULT', {
      status: 'done',
      changed_files: ['src/foo.ts'],
      lines_added: 400,
      lines_removed: 200, // total = 600 > 500 default budget
    });

    expect(result.phase_changed).toBe(false);
    expect(result.message).toContain('exceeds budget');
  });

  it('docs ticket skips plan phase', async () => {
    run.create(project.id, {
      step_budget: 50,
      categories: ['docs', 'refactor'],
    });

    await repos.tickets.create(db, {
      projectId: project.id,
      title: 'Update README',
      description: 'Add usage section',
      status: 'ready',
      priority: 60,
      category: 'docs',
      allowedPaths: ['*.md', 'docs/**'],
      verificationCommands: [],
    });

    const resp = await advance(ctx());
    // Should skip PLAN entirely
    expect(resp.phase).toBe('EXECUTE');
    expect(resp.constraints.plan_required).toBe(false);
  });
});
