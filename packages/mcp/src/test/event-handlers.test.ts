/**
 * Tests for event handler modules:
 *   - event-handlers-scout.ts  (SCOUT_OUTPUT, PROPOSALS_REVIEWED fallback parsing)
 *   - event-handlers-qa.ts     (QA_PASSED, QA_FAILED, QA_COMMAND_RESULT)
 *   - event-processor.ts       (event routing / dispatch)
 *
 * These cover the critical untested paths including the v0.6.0 bug fix
 * where review results arrive via SCOUT_OUTPUT instead of PROPOSALS_REVIEWED.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createSQLiteAdapter } from '@promptwheel/sqlite';
import { repos } from '@promptwheel/core';
import type { DatabaseAdapter, Project } from '@promptwheel/core';
import { RunManager } from '../run-manager.js';
import { processEvent } from '../event-processor.js';
import type { RawProposal } from '../proposals.js';

let db: DatabaseAdapter;
let project: Project;
let tmpDir: string;
let run: RunManager;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-evh-'));
  const dbPath = path.join(tmpDir, 'test.sqlite');
  db = await createSQLiteAdapter({ url: dbPath });
  project = await repos.projects.ensureForRepo(db, {
    name: 'evh-test-project',
    rootPath: tmpDir,
  });
  run = new RunManager(tmpDir);
});

afterEach(async () => {
  try { if (run.current) run.end(); } catch { /* ignore */ }
  await db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function startRun(overrides?: Record<string, unknown>) {
  return run.create(project.id, {
    step_budget: 50,
    ticket_step_budget: 12,
    max_prs: 5,
    categories: ['refactor', 'test', 'docs'],
    ...overrides,
  });
}

function makeProposal(title: string, overrides?: Partial<RawProposal>): RawProposal {
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
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// SCOUT_OUTPUT handler
// ---------------------------------------------------------------------------

describe('handleScoutOutput', () => {
  it('stores valid proposals in pending_proposals (adversarial review path)', async () => {
    startRun();
    const s = run.require();
    expect(s.phase).toBe('SCOUT');

    const result = await processEvent(run, db, 'SCOUT_OUTPUT', {
      proposals: [makeProposal('Add input validation')],
    });

    expect(result.processed).toBe(true);
    expect(result.phase_changed).toBe(false);
    expect(result.message).toContain('pending');
    expect(s.pending_proposals).not.toBeNull();
    expect(s.pending_proposals!.length).toBe(1);
    expect(s.pending_proposals![0].title).toBe('Add input validation');
  });

  it('creates tickets directly when skip_review is enabled', async () => {
    startRun({ skip_review: true });
    const s = run.require();
    expect(s.phase).toBe('SCOUT');

    const result = await processEvent(run, db, 'SCOUT_OUTPUT', {
      proposals: [makeProposal('Remove dead code')],
    });

    expect(result.processed).toBe(true);
    expect(result.phase_changed).toBe(true);
    expect(result.new_phase).toBe('NEXT_TICKET');
    expect(result.message).toContain('review skipped');
    // Pending proposals should not be set (tickets created directly)
    expect(s.pending_proposals).toBeNull();
  });

  it('retries on empty proposals when retries remain', async () => {
    startRun();
    const s = run.require();
    s.scout_retries = 0;

    const result = await processEvent(run, db, 'SCOUT_OUTPUT', {
      proposals: [],
    });

    expect(result.processed).toBe(true);
    expect(result.phase_changed).toBe(false);
    expect(result.message).toContain('Retrying');
    expect(s.scout_retries).toBe(1);
    expect(s.phase).toBe('SCOUT');
  });

  it('transitions to DONE on empty proposals when retries exhausted', async () => {
    startRun();
    const s = run.require();
    s.scout_retries = 3; // MAX_SCOUT_RETRIES is 3

    const result = await processEvent(run, db, 'SCOUT_OUTPUT', {
      proposals: [],
    });

    expect(result.processed).toBe(true);
    expect(result.phase_changed).toBe(true);
    expect(result.new_phase).toBe('DONE');
    expect(result.message).toContain('after all retries');
  });

  it('ignores SCOUT_OUTPUT outside SCOUT phase', async () => {
    startRun();
    const s = run.require();
    s.phase = 'EXECUTE';

    const result = await processEvent(run, db, 'SCOUT_OUTPUT', {
      proposals: [makeProposal('Should be ignored')],
    });

    expect(result.processed).toBe(true);
    expect(result.phase_changed).toBe(false);
    expect(result.message).toContain('ignored');
  });

  it('tracks explored directories', async () => {
    startRun();
    const s = run.require();

    await processEvent(run, db, 'SCOUT_OUTPUT', {
      proposals: [makeProposal('Some fix')],
      explored_dirs: ['src/', 'lib/'],
    });

    expect(s.scouted_dirs).toContain('src/');
    expect(s.scouted_dirs).toContain('lib/');
  });

  it('appends to scout_exploration_log', async () => {
    startRun();
    const s = run.require();

    await processEvent(run, db, 'SCOUT_OUTPUT', {
      proposals: [makeProposal('Fix imports')],
      explored_dirs: ['src/'],
      exploration_summary: 'Found unused imports in utils',
    });

    expect(s.scout_exploration_log.length).toBe(1);
    expect(s.scout_exploration_log[0]).toContain('Attempt 1');
    expect(s.scout_exploration_log[0]).toContain('src/');
    expect(s.scout_exploration_log[0]).toContain('Found unused imports');
  });

  // v0.6.0 regression test: review results sent via SCOUT_OUTPUT
  describe('fallback parsing (v0.6.0 bug fix)', () => {
    it('redirects structured reviewed_proposals array to PROPOSALS_REVIEWED handler', async () => {
      startRun();
      const s = run.require();
      s.phase = 'SCOUT';

      // First, set up pending proposals (as if SCOUT_OUTPUT already ran once)
      s.pending_proposals = [makeProposal('Refactor auth module')];

      // Now simulate the LLM sending review results via SCOUT_OUTPUT
      // with a structured reviewed_proposals array
      const result = await processEvent(run, db, 'SCOUT_OUTPUT', {
        reviewed_proposals: [
          { title: 'Refactor auth module', confidence: 80, impact_score: 6 },
        ],
      });

      expect(result.processed).toBe(true);
      expect(result.phase_changed).toBe(true);
      expect(result.new_phase).toBe('NEXT_TICKET');
      // pending_proposals should be cleared after review processing
      expect(s.pending_proposals).toBeNull();
    });

    it('redirects XML <reviewed-proposals> block in text to PROPOSALS_REVIEWED handler', async () => {
      startRun();
      const s = run.require();
      s.phase = 'SCOUT';

      // Set up pending proposals
      s.pending_proposals = [makeProposal('Optimize database queries')];

      // Simulate the LLM sending review results embedded in text as XML
      const xmlText = `Here are the reviewed proposals:
<reviewed-proposals>
[
  { "title": "Optimize database queries", "confidence": 75, "impact_score": 8, "review_note": "Looks good" }
]
</reviewed-proposals>`;

      const result = await processEvent(run, db, 'SCOUT_OUTPUT', {
        text: xmlText,
      });

      expect(result.processed).toBe(true);
      expect(result.phase_changed).toBe(true);
      expect(result.new_phase).toBe('NEXT_TICKET');
      expect(s.pending_proposals).toBeNull();
    });

    it('does NOT trigger fallback when pending_proposals is null', async () => {
      startRun();
      const s = run.require();
      s.phase = 'SCOUT';
      s.pending_proposals = null;

      // Even if reviewed_proposals is in the payload, it should be treated
      // as a normal SCOUT_OUTPUT since there are no pending proposals
      const result = await processEvent(run, db, 'SCOUT_OUTPUT', {
        proposals: [makeProposal('New proposal')],
        reviewed_proposals: [
          { title: 'New proposal', confidence: 80, impact_score: 6 },
        ],
      });

      // Should store in pending_proposals (normal path), not redirect to review
      expect(result.phase_changed).toBe(false);
      expect(result.message).toContain('pending');
      expect(s.pending_proposals).not.toBeNull();
    });

    it('falls back to normal SCOUT_OUTPUT when XML text does not parse', async () => {
      startRun();
      const s = run.require();
      s.phase = 'SCOUT';
      s.pending_proposals = [makeProposal('Something')];

      const result = await processEvent(run, db, 'SCOUT_OUTPUT', {
        text: '<reviewed-proposals>INVALID JSON</reviewed-proposals>',
        proposals: [makeProposal('Another proposal')],
      });

      // XML parsing fails, so it falls through to normal SCOUT_OUTPUT processing
      // The new proposals should be stored as pending (replacing old ones)
      expect(result.processed).toBe(true);
      expect(result.message).toContain('pending');
    });
  });
});

// ---------------------------------------------------------------------------
// PROPOSALS_REVIEWED handler
// ---------------------------------------------------------------------------

describe('handleProposalsReviewed', () => {
  it('creates tickets from reviewed proposals and transitions to NEXT_TICKET', async () => {
    startRun();
    const s = run.require();
    s.phase = 'SCOUT';
    s.pending_proposals = [makeProposal('Cleanup old helpers')];

    const result = await processEvent(run, db, 'PROPOSALS_REVIEWED', {
      reviewed_proposals: [
        { title: 'Cleanup old helpers', confidence: 80, impact_score: 7 },
      ],
    });

    expect(result.processed).toBe(true);
    expect(result.phase_changed).toBe(true);
    expect(result.new_phase).toBe('NEXT_TICKET');
    expect(result.message).toContain('Created');
    expect(s.pending_proposals).toBeNull();
  });

  it('returns message when no pending proposals exist', async () => {
    startRun();
    const s = run.require();
    s.phase = 'SCOUT';
    s.pending_proposals = null;

    const result = await processEvent(run, db, 'PROPOSALS_REVIEWED', {
      reviewed_proposals: [
        { title: 'Ghost proposal', confidence: 80, impact_score: 7 },
      ],
    });

    expect(result.processed).toBe(true);
    expect(result.phase_changed).toBe(false);
    expect(result.message).toContain('No pending proposals');
  });

  it('ignores PROPOSALS_REVIEWED outside SCOUT phase', async () => {
    startRun();
    const s = run.require();
    s.phase = 'EXECUTE';
    s.pending_proposals = [makeProposal('Some proposal')];

    const result = await processEvent(run, db, 'PROPOSALS_REVIEWED', {
      reviewed_proposals: [
        { title: 'Some proposal', confidence: 80, impact_score: 7 },
      ],
    });

    expect(result.processed).toBe(true);
    expect(result.phase_changed).toBe(false);
    expect(result.message).toContain('outside SCOUT phase');
  });

  it('retries when all proposals rejected after review and retries remain', async () => {
    startRun();
    const s = run.require();
    s.phase = 'SCOUT';
    s.scout_retries = 0;
    // Proposal with confidence 0 will be rejected by the filter
    s.pending_proposals = [makeProposal('Bad proposal', { confidence: 0 })];

    const result = await processEvent(run, db, 'PROPOSALS_REVIEWED', {
      reviewed_proposals: [
        { title: 'Bad proposal', confidence: 0, impact_score: 1 },
      ],
    });

    expect(result.processed).toBe(true);
    expect(result.phase_changed).toBe(false);
    expect(result.message).toContain('rejected after review');
    expect(s.scout_retries).toBe(1);
  });

  it('transitions to DONE when all rejected and retries exhausted', async () => {
    startRun();
    const s = run.require();
    s.phase = 'SCOUT';
    s.scout_retries = 3; // MAX_SCOUT_RETRIES = 3
    s.pending_proposals = [makeProposal('Doomed', { confidence: 0 })];

    const result = await processEvent(run, db, 'PROPOSALS_REVIEWED', {
      reviewed_proposals: [
        { title: 'Doomed', confidence: 0, impact_score: 1 },
      ],
    });

    expect(result.processed).toBe(true);
    expect(result.phase_changed).toBe(true);
    expect(result.new_phase).toBe('DONE');
    expect(result.message).toContain('rejected after review');
  });

  it('merges reviewed scores back into pending proposals', async () => {
    startRun();
    const s = run.require();
    s.phase = 'SCOUT';
    s.pending_proposals = [makeProposal('Score update test', { confidence: 90, impact_score: 5 })];

    const result = await processEvent(run, db, 'PROPOSALS_REVIEWED', {
      reviewed_proposals: [
        { title: 'Score update test', confidence: 70, impact_score: 8 },
      ],
    });

    // The ticket should have been created with updated scores
    expect(result.processed).toBe(true);
    expect(result.phase_changed).toBe(true);
    expect(result.new_phase).toBe('NEXT_TICKET');
  });
});

// ---------------------------------------------------------------------------
// QA event handlers
// ---------------------------------------------------------------------------

describe('handleQaPassed', () => {
  it('transitions to NEXT_TICKET when PRs disabled', async () => {
    startRun({ create_prs: false });

    const ticket = await repos.tickets.create(db, {
      projectId: project.id,
      title: 'QA pass test',
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

    expect(result.processed).toBe(true);
    expect(result.phase_changed).toBe(true);
    expect(result.new_phase).toBe('NEXT_TICKET');
    expect(result.message).toContain('PRs disabled');
    expect(s.tickets_completed).toBe(1);
  });

  it('transitions to PR when PRs enabled', async () => {
    startRun({ create_prs: true });

    const ticket = await repos.tickets.create(db, {
      projectId: project.id,
      title: 'QA pass PR test',
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

    expect(result.processed).toBe(true);
    expect(result.phase_changed).toBe(true);
    expect(result.new_phase).toBe('PR');
  });

  it('ignores QA_PASSED outside QA phase', async () => {
    startRun();
    const s = run.require();
    s.phase = 'EXECUTE';

    const result = await processEvent(run, db, 'QA_PASSED', {});

    expect(result.processed).toBe(true);
    expect(result.phase_changed).toBe(false);
    expect(result.message).toContain('outside QA phase');
  });

  it('marks ticket as done in database', async () => {
    startRun({ create_prs: false });

    const ticket = await repos.tickets.create(db, {
      projectId: project.id,
      title: 'DB status test',
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

    await processEvent(run, db, 'QA_PASSED', {});

    const updatedTicket = await repos.tickets.getById(db, ticket.id);
    expect(updatedTicket!.status).toBe('done');
  });
});

describe('handleQaFailed', () => {
  it('retries by transitioning to EXECUTE when retries remain (code error)', async () => {
    startRun();

    const ticket = await repos.tickets.create(db, {
      projectId: project.id,
      title: 'QA fail retry test',
      description: 'test',
      status: 'in_progress',
      priority: 80,
      category: 'refactor',
      allowedPaths: [],
      verificationCommands: ['npm test'],
    });

    const s = run.require();
    s.phase = 'QA';
    s.current_ticket_id = ticket.id;
    s.qa_retries = 0;

    const result = await processEvent(run, db, 'QA_FAILED', {
      error: 'TypeError: Cannot read property of undefined',
    });

    expect(result.processed).toBe(true);
    expect(result.phase_changed).toBe(true);
    expect(result.new_phase).toBe('EXECUTE');
    expect(result.message).toContain('retrying');
    expect(s.qa_retries).toBe(1);
  });

  it('gives up after code error retries exhausted (3 attempts)', async () => {
    startRun();

    const ticket = await repos.tickets.create(db, {
      projectId: project.id,
      title: 'QA exhausted test',
      description: 'test',
      status: 'in_progress',
      priority: 80,
      category: 'refactor',
      allowedPaths: [],
      verificationCommands: ['npm test'],
    });

    const s = run.require();
    s.phase = 'QA';
    s.current_ticket_id = ticket.id;
    s.qa_retries = 2; // Already tried twice, this is the 3rd attempt

    const result = await processEvent(run, db, 'QA_FAILED', {
      error: 'TypeError: something broke',
    });

    expect(result.processed).toBe(true);
    expect(result.phase_changed).toBe(true);
    expect(result.new_phase).toBe('NEXT_TICKET');
    expect(result.message).toContain('giving up');
    expect(s.qa_retries).toBe(3);
  });

  it('gives up immediately on environment errors (max 1 retry)', async () => {
    startRun();

    const ticket = await repos.tickets.create(db, {
      projectId: project.id,
      title: 'QA env error test',
      description: 'test',
      status: 'in_progress',
      priority: 80,
      category: 'refactor',
      allowedPaths: [],
      verificationCommands: ['npm test'],
    });

    const s = run.require();
    s.phase = 'QA';
    s.current_ticket_id = ticket.id;
    s.qa_retries = 0;

    // First try — environment error gets 1 retry
    let result = await processEvent(run, db, 'QA_FAILED', {
      error: 'Permission denied: /etc/shadow',
    });

    expect(result.new_phase).toBe('NEXT_TICKET');
    expect(result.message).toContain('environment');
    expect(result.message).toContain('giving up');
  });

  it('allows 2 retries for timeout errors', async () => {
    startRun();

    const ticket = await repos.tickets.create(db, {
      projectId: project.id,
      title: 'QA timeout test',
      description: 'test',
      status: 'in_progress',
      priority: 80,
      category: 'refactor',
      allowedPaths: [],
      verificationCommands: ['npm test'],
    });

    const s = run.require();
    s.phase = 'QA';
    s.current_ticket_id = ticket.id;
    s.qa_retries = 0;

    // First timeout — should retry
    let result = await processEvent(run, db, 'QA_FAILED', {
      error: 'Command timed out after 30s',
    });
    expect(result.new_phase).toBe('EXECUTE');
    expect(s.qa_retries).toBe(1);

    // Second timeout — should give up (max 2 for timeout)
    s.phase = 'QA';
    result = await processEvent(run, db, 'QA_FAILED', {
      error: 'Command timed out after 30s',
    });
    expect(result.new_phase).toBe('NEXT_TICKET');
    expect(s.qa_retries).toBe(2);
  });

  it('marks ticket as blocked in database when giving up', async () => {
    startRun();

    const ticket = await repos.tickets.create(db, {
      projectId: project.id,
      title: 'QA block DB test',
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
    s.qa_retries = 2; // Will exhaust retries

    await processEvent(run, db, 'QA_FAILED', {
      error: 'assert.equal failed',
    });

    const updatedTicket = await repos.tickets.getById(db, ticket.id);
    expect(updatedTicket!.status).toBe('blocked');
  });

  it('ignores QA_FAILED outside QA phase', async () => {
    startRun();
    const s = run.require();
    s.phase = 'EXECUTE';

    const result = await processEvent(run, db, 'QA_FAILED', {
      error: 'test failed',
    });

    expect(result.processed).toBe(true);
    expect(result.phase_changed).toBe(false);
    expect(result.message).toContain('outside QA phase');
  });

  it('stores last_qa_failure context for critic block', async () => {
    startRun();

    const ticket = await repos.tickets.create(db, {
      projectId: project.id,
      title: 'QA failure context test',
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

    await processEvent(run, db, 'QA_FAILED', {
      failed_commands: ['npm test'],
      error: 'Expected 42 but got undefined',
    });

    expect(s.last_qa_failure).not.toBeNull();
    expect(s.last_qa_failure!.failed_commands).toEqual(['npm test']);
    expect(s.last_qa_failure!.error_output).toContain('Expected 42');
  });
});

describe('handleQaCommandResult', () => {
  it('records successful command result without phase change', async () => {
    startRun();
    const s = run.require();
    s.phase = 'QA';

    const result = await processEvent(run, db, 'QA_COMMAND_RESULT', {
      command: 'npm test',
      success: true,
      output: 'All 42 tests passed',
    });

    expect(result.processed).toBe(true);
    expect(result.phase_changed).toBe(false);
    expect(result.message).toContain('passed');
    expect(result.message).toContain('npm test');
  });

  it('records failed command result without phase change', async () => {
    startRun();
    const s = run.require();
    s.phase = 'QA';

    const result = await processEvent(run, db, 'QA_COMMAND_RESULT', {
      command: 'npm test',
      success: false,
      output: '3 tests failed',
    });

    expect(result.processed).toBe(true);
    expect(result.phase_changed).toBe(false);
    expect(result.message).toContain('failed');
  });

  it('ignores QA_COMMAND_RESULT outside QA phase', async () => {
    startRun();
    const s = run.require();
    s.phase = 'SCOUT';

    const result = await processEvent(run, db, 'QA_COMMAND_RESULT', {
      command: 'npm test',
      success: true,
      output: 'ok',
    });

    expect(result.processed).toBe(true);
    expect(result.phase_changed).toBe(false);
    expect(result.message).toContain('outside QA phase');
  });
});

// ---------------------------------------------------------------------------
// TICKET_RESULT handler
// ---------------------------------------------------------------------------

describe('handleTicketResult', () => {
  it('transitions to QA on successful ticket result', async () => {
    startRun();
    const s = run.require();
    s.phase = 'EXECUTE';
    s.current_ticket_id = 'tkt_test';

    const result = await processEvent(run, db, 'TICKET_RESULT', {
      status: 'done',
      changed_files: ['src/foo.ts'],
      lines_added: 5,
      lines_removed: 2,
    });

    expect(result.processed).toBe(true);
    expect(result.phase_changed).toBe(true);
    expect(result.new_phase).toBe('QA');
    expect(result.message).toContain('moving to QA');
  });

  it('accepts "success" status as equivalent to "done"', async () => {
    startRun();
    const s = run.require();
    s.phase = 'EXECUTE';
    s.current_ticket_id = 'tkt_test';

    const result = await processEvent(run, db, 'TICKET_RESULT', {
      status: 'success',
      changed_files: ['src/bar.ts'],
    });

    expect(result.phase_changed).toBe(true);
    expect(result.new_phase).toBe('QA');
  });

  it('transitions to NEXT_TICKET on ticket failure', async () => {
    startRun();

    const ticket = await repos.tickets.create(db, {
      projectId: project.id,
      title: 'Failing ticket',
      description: 'Will fail',
      status: 'in_progress',
      priority: 80,
      category: 'refactor',
      allowedPaths: ['src/**'],
      verificationCommands: [],
    });

    const s = run.require();
    s.phase = 'EXECUTE';
    s.current_ticket_id = ticket.id;

    const result = await processEvent(run, db, 'TICKET_RESULT', {
      status: 'failed',
      reason: 'Cannot resolve the issue',
    });

    expect(result.processed).toBe(true);
    expect(result.phase_changed).toBe(true);
    expect(result.new_phase).toBe('NEXT_TICKET');
    expect(result.message).toContain('failed');
    expect(s.tickets_failed).toBe(1);
  });

  it('marks failed ticket as blocked in database', async () => {
    startRun();

    const ticket = await repos.tickets.create(db, {
      projectId: project.id,
      title: 'DB block test',
      description: 'test',
      status: 'in_progress',
      priority: 80,
      category: 'refactor',
      allowedPaths: [],
      verificationCommands: [],
    });

    const s = run.require();
    s.phase = 'EXECUTE';
    s.current_ticket_id = ticket.id;

    await processEvent(run, db, 'TICKET_RESULT', {
      status: 'failed',
      reason: 'Impossible',
    });

    const updatedTicket = await repos.tickets.getById(db, ticket.id);
    expect(updatedTicket!.status).toBe('blocked');
  });

  it('ignores TICKET_RESULT outside EXECUTE phase', async () => {
    startRun();
    const s = run.require();
    s.phase = 'QA';

    const result = await processEvent(run, db, 'TICKET_RESULT', {
      status: 'done',
      changed_files: [],
    });

    expect(result.processed).toBe(true);
    expect(result.phase_changed).toBe(false);
    expect(result.message).toContain('outside EXECUTE phase');
  });

  it('tracks total_lines_changed on successful result', async () => {
    startRun();
    const s = run.require();
    s.phase = 'EXECUTE';
    s.current_ticket_id = 'tkt_test';

    await processEvent(run, db, 'TICKET_RESULT', {
      status: 'done',
      changed_files: ['src/a.ts'],
      lines_added: 10,
      lines_removed: 5,
    });

    expect(s.total_lines_changed).toBe(15);
  });
});

// ---------------------------------------------------------------------------
// Event processor routing
// ---------------------------------------------------------------------------

describe('processEvent — routing', () => {
  it('routes SCOUT_OUTPUT to scout handler', async () => {
    startRun();
    const result = await processEvent(run, db, 'SCOUT_OUTPUT', {
      proposals: [makeProposal('Route test')],
    });
    expect(result.processed).toBe(true);
    expect(result.message).toContain('pending');
  });

  it('routes PROPOSALS_REVIEWED to review handler', async () => {
    startRun();
    const s = run.require();
    s.pending_proposals = [makeProposal('Route review test')];

    const result = await processEvent(run, db, 'PROPOSALS_REVIEWED', {
      reviewed_proposals: [
        { title: 'Route review test', confidence: 80, impact_score: 7 },
      ],
    });
    expect(result.processed).toBe(true);
  });

  it('routes PLAN_SUBMITTED to plan handler', async () => {
    startRun();
    const s = run.require();
    s.phase = 'PLAN';
    s.current_ticket_id = 'tkt_plan';

    const result = await processEvent(run, db, 'PLAN_SUBMITTED', {
      ticket_id: 'tkt_plan',
      files_to_touch: [{ path: 'src/x.ts', action: 'modify', reason: 'fix' }],
      expected_tests: [],
      estimated_lines: 10,
      risk_level: 'low',
    });
    expect(result.processed).toBe(true);
    expect(result.new_phase).toBe('EXECUTE');
  });

  it('routes QA_PASSED to QA handler', async () => {
    startRun({ create_prs: true });

    const ticket = await repos.tickets.create(db, {
      projectId: project.id,
      title: 'Route QA pass',
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
    expect(result.new_phase).toBe('PR');
  });

  it('routes QA_FAILED to QA handler', async () => {
    startRun();

    const ticket = await repos.tickets.create(db, {
      projectId: project.id,
      title: 'Route QA fail',
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

    const result = await processEvent(run, db, 'QA_FAILED', {
      error: 'test broke',
    });
    expect(result.new_phase).toBe('EXECUTE');
  });

  it('routes PR_CREATED to PR handler', async () => {
    startRun();
    const s = run.require();
    s.phase = 'PR';
    s.current_ticket_id = 'tkt_pr';

    const result = await processEvent(run, db, 'PR_CREATED', {
      url: 'https://github.com/test/pr/1',
    });
    expect(result.new_phase).toBe('NEXT_TICKET');
  });

  it('handles USER_OVERRIDE hint', async () => {
    startRun();
    const result = await processEvent(run, db, 'USER_OVERRIDE', {
      hint: 'focus on auth module',
    });
    expect(result.processed).toBe(true);
    expect(result.message).toBe('Hint added');
    expect(run.require().hints).toContain('focus on auth module');
  });

  it('handles USER_OVERRIDE cancel', async () => {
    startRun();
    const result = await processEvent(run, db, 'USER_OVERRIDE', {
      cancel: true,
    });
    expect(result.phase_changed).toBe(true);
    expect(result.new_phase).toBe('DONE');
  });

  it('handles unknown event type gracefully (no crash)', async () => {
    startRun();
    const result = await processEvent(
      run,
      db,
      'SOME_UNKNOWN_EVENT' as any,
      { foo: 'bar' },
    );

    expect(result.processed).toBe(true);
    expect(result.phase_changed).toBe(false);
    expect(result.message).toContain('SOME_UNKNOWN_EVENT');
    expect(result.message).toContain('recorded');
  });

  it('USER_OVERRIDE skip_review creates tickets from pending proposals', async () => {
    startRun();
    const s = run.require();
    s.phase = 'SCOUT';
    s.pending_proposals = [makeProposal('Waiting for review')];

    const result = await processEvent(run, db, 'USER_OVERRIDE', {
      skip_review: true,
    });

    expect(result.processed).toBe(true);
    expect(result.phase_changed).toBe(true);
    expect(result.new_phase).toBe('NEXT_TICKET');
    expect(result.message).toContain('skip_review');
    expect(s.skip_review).toBe(true);
    expect(s.pending_proposals).toBeNull();
  });
});
