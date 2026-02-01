/**
 * Tests for DirectClient — second adapter (Phase 9).
 *
 * Proves the canonical loop protocol works without Claude Code or MCP transport.
 * No code changes to the MCP server were needed — DirectClient calls the same
 * advance() and processEvent() functions.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createSQLiteAdapter } from '@blockspool/sqlite';
import type { DatabaseAdapter } from '@blockspool/core';
import { DirectClient } from '../direct-client.js';

let tmpDir: string;
let db: DatabaseAdapter;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-direct-test-'));
  const dbPath = path.join(tmpDir, 'test.sqlite');
  db = await createSQLiteAdapter({ url: dbPath });
});

afterEach(async () => {
  await db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Basic lifecycle
// ---------------------------------------------------------------------------

describe('DirectClient — lifecycle', () => {
  it('creates client and starts session', async () => {
    const client = await DirectClient.create({ projectPath: tmpDir, db });
    const state = client.startSession({ step_budget: 50 });
    expect(state.run_id).toMatch(/^run_/);
    expect(state.phase).toBe('SCOUT');
    expect(state.step_budget).toBe(50);
    client.endSession();
    await client.close();
  });

  it('advance returns SCOUT prompt initially', async () => {
    const client = await DirectClient.create({ projectPath: tmpDir, db });
    client.startSession({ step_budget: 50 });

    const resp = await client.advance();
    expect(resp.next_action).toBe('PROMPT');
    expect(resp.phase).toBe('SCOUT');
    expect(resp.prompt).toContain('Scout Phase');

    client.endSession();
    await client.close();
  });
});

// ---------------------------------------------------------------------------
// Golden path E2E — same flow as golden-path-e2e.test.ts but via DirectClient
// ---------------------------------------------------------------------------

describe('DirectClient — golden path', () => {
  it('completes scout → ticket → plan → execute → QA → PR → DONE', async () => {
    const client = await DirectClient.create({ projectPath: tmpDir, db });
    client.startSession({ step_budget: 100, categories: ['refactor'] });

    // Step 1: Advance → SCOUT
    const scout = await client.advance();
    expect(scout.phase).toBe('SCOUT');

    // Step 2: Submit proposals via SCOUT_OUTPUT
    await client.ingestEvent('SCOUT_OUTPUT', {
      proposals: [{
        category: 'refactor',
        title: 'Extract helper function',
        description: 'Move repeated logic into a shared helper',
        acceptance_criteria: ['Helper exists', 'Tests pass'],
        verification_commands: ['npm test'],
        allowed_paths: ['src/**'],
        files: ['src/utils.ts'],
        confidence: 85,
        impact_score: 7,
        risk: 'low',
        touched_files_estimate: 1,
        rollback_note: 'Revert commit',
      }],
    });

    // Step 3: Advance → should now be in NEXT_TICKET or PLAN
    const next1 = await client.advance();
    // NEXT_TICKET assigns ticket, then moves to PLAN
    expect(['PLAN', 'EXECUTE']).toContain(next1.phase);

    // Step 4: Submit plan
    if (next1.phase === 'PLAN') {
      const ticketId = client.getState().current_ticket_id!;
      await client.ingestEvent('PLAN_SUBMITTED', {
        ticket_id: ticketId,
        files_to_touch: [{ path: 'src/utils.ts', action: 'modify', reason: 'Extract helper' }],
        expected_tests: ['npm test'],
        estimated_lines: 20,
        risk_level: 'low',
      });

      // Advance → EXECUTE (plan auto-approved for low risk)
      const exec = await client.advance();
      expect(exec.phase).toBe('EXECUTE');
    }

    // Step 5: Submit ticket result
    await client.ingestEvent('TICKET_RESULT', {
      status: 'done',
      changed_files: ['src/utils.ts'],
      lines_added: 15,
      lines_removed: 5,
      summary: 'Extracted helper function',
    });

    // Step 6: Advance → QA
    const qa = await client.advance();
    expect(qa.phase).toBe('QA');

    // Step 7: Report QA passed
    await client.ingestEvent('QA_COMMAND_RESULT', {
      command: 'npm test',
      success: true,
      output: 'All tests passed',
    });
    await client.ingestEvent('QA_PASSED', { summary: 'All checks passed' });

    // Step 8: Advance → PR
    const pr = await client.advance();
    expect(pr.phase).toBe('PR');

    // Step 9: Report PR created
    await client.ingestEvent('PR_CREATED', {
      url: 'https://github.com/test/test/pull/1',
      branch: 'blockspool/extract-helper',
    });

    // Step 10: Advance → should go to NEXT_TICKET, then DONE (no more tickets)
    const final = await client.advance();
    expect(final.next_action).toBe('STOP');
    expect(final.phase).toBe('DONE');

    // Verify state
    const state = client.getState();
    expect(state.tickets_completed).toBe(1);
    expect(state.prs_created).toBe(1);

    client.endSession();
    await client.close();
  });

  it('handles QA failure and retry', async () => {
    const client = await DirectClient.create({ projectPath: tmpDir, db });
    client.startSession({ step_budget: 100, categories: ['test'] });

    // Scout → proposals
    await client.advance();
    await client.ingestEvent('SCOUT_OUTPUT', {
      proposals: [{
        category: 'test',
        title: 'Add unit tests',
        description: 'Add tests for utils',
        acceptance_criteria: ['Tests exist'],
        verification_commands: ['npm test'],
        allowed_paths: ['src/**'],
        files: ['src/utils.test.ts'],
        confidence: 90,
        impact_score: 8,
        risk: 'low',
        touched_files_estimate: 1,
        rollback_note: 'Remove test file',
      }],
    });

    // Advance through to EXECUTE
    let resp = await client.advance();
    if (resp.phase === 'PLAN') {
      const ticketId = client.getState().current_ticket_id!;
      await client.ingestEvent('PLAN_SUBMITTED', {
        ticket_id: ticketId,
        files_to_touch: [{ path: 'src/utils.test.ts', action: 'create', reason: 'Add tests' }],
        expected_tests: ['npm test'],
        estimated_lines: 30,
        risk_level: 'low',
      });
      resp = await client.advance();
    }
    expect(resp.phase).toBe('EXECUTE');

    // Submit result
    await client.ingestEvent('TICKET_RESULT', {
      status: 'done',
      changed_files: ['src/utils.test.ts'],
      lines_added: 30,
      lines_removed: 0,
    });

    // Advance → QA
    resp = await client.advance();
    expect(resp.phase).toBe('QA');

    // QA fails
    await client.ingestEvent('QA_COMMAND_RESULT', {
      command: 'npm test',
      success: false,
      output: 'Error: assertion failed',
    });
    await client.ingestEvent('QA_FAILED', { error: 'Tests failed' });

    // Advance → back to EXECUTE for retry
    resp = await client.advance();
    expect(resp.phase).toBe('EXECUTE');
    expect(client.getState().qa_retries).toBe(1);

    client.endSession();
    await client.close();
  });
});

// ---------------------------------------------------------------------------
// Events.ndjson format — same format regardless of adapter
// ---------------------------------------------------------------------------

describe('DirectClient — events.ndjson format', () => {
  it('produces same event format as MCP tools', async () => {
    const client = await DirectClient.create({ projectPath: tmpDir, db });
    client.startSession({ step_budget: 50 });

    await client.advance(); // SCOUT
    await client.ingestEvent('SCOUT_OUTPUT', { proposals: [] });

    const state = client.getState();
    const eventsPath = path.join(
      tmpDir, '.blockspool', 'runs', state.run_id, 'events.ndjson',
    );

    expect(fs.existsSync(eventsPath)).toBe(true);
    const events = fs.readFileSync(eventsPath, 'utf8')
      .trim().split('\n').map(l => JSON.parse(l));

    // Verify event structure
    for (const e of events) {
      expect(e).toHaveProperty('ts');
      expect(e).toHaveProperty('step');
      expect(e).toHaveProperty('type');
      expect(e).toHaveProperty('payload');
      // ts is ISO string
      expect(new Date(e.ts).toISOString()).toBe(e.ts);
    }

    // Verify expected event types present
    const types = events.map(e => e.type);
    expect(types).toContain('SESSION_START');
    expect(types).toContain('ADVANCE_CALLED');
    expect(types).toContain('SCOUT_OUTPUT');

    client.endSession();
    await client.close();
  });
});

// ---------------------------------------------------------------------------
// Formula + hints via DirectClient
// ---------------------------------------------------------------------------

describe('DirectClient — formula + hints', () => {
  it('formula affects scout prompt', async () => {
    const client = await DirectClient.create({ projectPath: tmpDir, db });
    client.startSession({ step_budget: 50, formula: 'security-audit' });

    const resp = await client.advance();
    expect(resp.prompt).toContain('security-audit');
    expect(resp.prompt).toContain('OWASP');

    client.endSession();
    await client.close();
  });

  it('hints appear in scout prompt', async () => {
    const client = await DirectClient.create({ projectPath: tmpDir, db });
    client.startSession({ step_budget: 50 });

    // Add hint before advancing
    client._run.addHint('focus on database queries');

    const resp = await client.advance();
    expect(resp.prompt).toContain('focus on database queries');

    client.endSession();
    await client.close();
  });
});

// ---------------------------------------------------------------------------
// Spindle detection via DirectClient
// ---------------------------------------------------------------------------

describe('DirectClient — spindle detection', () => {
  it('detects stalling and aborts', async () => {
    const client = await DirectClient.create({ projectPath: tmpDir, db });
    client.startSession({ step_budget: 100 });

    // Scout → ticket
    await client.advance();
    await client.ingestEvent('SCOUT_OUTPUT', {
      proposals: [{
        category: 'refactor',
        title: 'Stalling test',
        description: 'test',
        acceptance_criteria: ['done'],
        verification_commands: [],
        allowed_paths: ['src/**'],
        files: ['src/a.ts'],
        confidence: 80,
        impact_score: 5,
        risk: 'low',
        touched_files_estimate: 1,
        rollback_note: 'revert',
      }],
    });

    // Advance to get ticket assigned
    let resp = await client.advance();
    // Skip through PLAN if needed
    if (resp.phase === 'PLAN') {
      await client.ingestEvent('PLAN_SUBMITTED', {
        ticket_id: client.getState().current_ticket_id,
        files_to_touch: [{ path: 'src/a.ts', action: 'modify', reason: 'test' }],
        expected_tests: [],
        estimated_lines: 10,
        risk_level: 'low',
      });
      resp = await client.advance();
    }

    // Force spindle stalling state
    const state = client.getState();
    state.spindle.iterations_since_change = 5;

    // Advance should detect spindle and abort
    resp = await client.advance();
    expect(resp.next_action).toBe('STOP');
    expect(resp.phase).toBe('FAILED_SPINDLE');
    expect(resp.reason).toContain('stalling');

    client.endSession();
    await client.close();
  });
});
