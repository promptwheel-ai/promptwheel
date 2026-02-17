/**
 * Tests for spindle loop detection (Phase 6).
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
import { processEvent } from '../event-processor.js';
import {
  checkSpindle,
  recordOutput,
  recordDiff,
  recordCommandFailure,
  recordPlanHash,
  getFileEditWarnings,
  DEFAULT_SPINDLE_CONFIG,
} from '../spindle.js';
import type { SpindleState } from '../types.js';

// ---------------------------------------------------------------------------
// Pure unit tests for spindle detection
// ---------------------------------------------------------------------------

function emptySpindle(): SpindleState {
  return {
    output_hashes: [],
    diff_hashes: [],
    iterations_since_change: 0,
    total_output_chars: 0,
    total_change_chars: 0,
    failing_command_signatures: [],
    plan_hashes: [],
  };
}

describe('checkSpindle — stalling', () => {
  it('returns pass when iterations_since_change is low', () => {
    const s = emptySpindle();
    s.iterations_since_change = 2;
    const result = checkSpindle(s);
    expect(result.shouldAbort).toBe(false);
  });

  it('triggers abort when stalling at threshold', () => {
    const s = emptySpindle();
    s.iterations_since_change = 5;
    const result = checkSpindle(s);
    expect(result.shouldAbort).toBe(true);
    expect(result.reason).toBe('stalling');
    expect(result.confidence).toBeGreaterThan(0.8);
  });

  it('triggers abort at custom threshold', () => {
    const s = emptySpindle();
    s.iterations_since_change = 3;
    const result = checkSpindle(s, { ...DEFAULT_SPINDLE_CONFIG, maxStallIterations: 3 });
    expect(result.shouldAbort).toBe(true);
    expect(result.reason).toBe('stalling');
  });
});

describe('checkSpindle — oscillation', () => {
  it('detects A→B→A diff hash pattern', () => {
    const s = emptySpindle();
    s.diff_hashes = ['aaa', 'bbb', 'aaa'];
    const result = checkSpindle(s);
    expect(result.shouldAbort).toBe(true);
    expect(result.reason).toBe('oscillation');
  });

  it('does not trigger on distinct hashes', () => {
    const s = emptySpindle();
    s.diff_hashes = ['aaa', 'bbb', 'ccc'];
    const result = checkSpindle(s);
    expect(result.shouldAbort).toBe(false);
  });

  it('does not trigger with fewer than 3 hashes', () => {
    const s = emptySpindle();
    s.diff_hashes = ['aaa', 'bbb'];
    const result = checkSpindle(s);
    expect(result.shouldAbort).toBe(false);
  });
});

describe('checkSpindle — repetition', () => {
  it('detects 3 consecutive identical output hashes', () => {
    const s = emptySpindle();
    s.output_hashes = ['xxx', 'xxx', 'xxx'];
    const result = checkSpindle(s);
    expect(result.shouldAbort).toBe(true);
    expect(result.reason).toBe('repetition');
  });

  it('does not trigger on 2 identical hashes', () => {
    const s = emptySpindle();
    s.output_hashes = ['xxx', 'xxx'];
    const result = checkSpindle(s);
    expect(result.shouldAbort).toBe(false);
  });

  it('does not trigger on different hashes', () => {
    const s = emptySpindle();
    s.output_hashes = ['aaa', 'bbb', 'ccc'];
    const result = checkSpindle(s);
    expect(result.shouldAbort).toBe(false);
  });
});

describe('checkSpindle — QA ping-pong', () => {
  it('detects alternating failure pattern', () => {
    const s = emptySpindle();
    // A→B→A→B→A→B (3 cycles)
    s.failing_command_signatures = ['aaa', 'bbb', 'aaa', 'bbb', 'aaa', 'bbb'];
    const result = checkSpindle(s);
    expect(result.shouldAbort).toBe(true);
    expect(result.reason).toBe('qa_ping_pong');
  });

  it('does not trigger on non-alternating', () => {
    const s = emptySpindle();
    s.failing_command_signatures = ['aaa', 'bbb', 'ccc', 'ddd', 'eee', 'fff'];
    const result = checkSpindle(s);
    expect(result.shouldAbort).toBe(false);
  });
});

describe('checkSpindle — command failure', () => {
  it('blocks (not aborts) on same command failing 3 times', () => {
    const s = emptySpindle();
    s.failing_command_signatures = ['aaa', 'bbb', 'aaa', 'aaa'];
    const result = checkSpindle(s);
    expect(result.shouldAbort).toBe(false);
    expect(result.shouldBlock).toBe(true);
    expect(result.reason).toBe('command_failure');
  });

  it('does not trigger below threshold', () => {
    const s = emptySpindle();
    s.failing_command_signatures = ['aaa', 'bbb'];
    const result = checkSpindle(s);
    expect(result.shouldBlock).toBe(false);
  });
});

describe('checkSpindle — risk levels', () => {
  it('returns none for clean state', () => {
    const result = checkSpindle(emptySpindle());
    expect(result.risk).toBe('none');
  });

  it('returns low when approaching stall', () => {
    const s = emptySpindle();
    s.iterations_since_change = 2;
    const result = checkSpindle(s);
    expect(result.risk).toBe('low');
  });

  it('returns medium when multiple signals', () => {
    const s = emptySpindle();
    s.iterations_since_change = 3; // 60% of 5
    s.output_hashes = ['aaa', 'aaa']; // repeated last 2
    const result = checkSpindle(s);
    expect(['medium', 'high']).toContain(result.risk);
  });
});

// ---------------------------------------------------------------------------
// State update helpers
// ---------------------------------------------------------------------------

describe('recordOutput', () => {
  it('adds hash and caps at 10', () => {
    const s = emptySpindle();
    for (let i = 0; i < 15; i++) {
      recordOutput(s, `output ${i}`);
    }
    expect(s.output_hashes.length).toBe(10);
    expect(s.total_output_chars).toBeGreaterThan(0);
  });
});

describe('recordDiff', () => {
  it('resets stall counter on non-empty diff', () => {
    const s = emptySpindle();
    s.iterations_since_change = 3;
    recordDiff(s, '+++ b/foo.ts\n+const x = 1;');
    expect(s.iterations_since_change).toBe(0);
    expect(s.diff_hashes.length).toBe(1);
  });

  it('increments stall counter on null diff', () => {
    const s = emptySpindle();
    recordDiff(s, null);
    expect(s.iterations_since_change).toBe(1);
    recordDiff(s, '');
    expect(s.iterations_since_change).toBe(2);
  });

  it('tracks file edit counts', () => {
    const s = emptySpindle();
    recordDiff(s, '+++ b/src/foo.ts\n+line');
    recordDiff(s, '+++ b/src/foo.ts\n+another');
    recordDiff(s, '+++ b/src/foo.ts\n+third');
    expect(s.file_edit_counts!['src/foo.ts']).toBe(3);
  });
});

describe('recordCommandFailure', () => {
  it('adds signature and caps at 20', () => {
    const s = emptySpindle();
    for (let i = 0; i < 25; i++) {
      recordCommandFailure(s, 'npm test', `error ${i}`);
    }
    expect(s.failing_command_signatures.length).toBe(20);
  });
});

describe('getFileEditWarnings', () => {
  it('returns warnings for files edited 3+ times', () => {
    const s = emptySpindle();
    s.file_edit_counts = { 'src/foo.ts': 4, 'src/bar.ts': 1 };
    const warnings = getFileEditWarnings(s);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain('src/foo.ts');
  });
});

// ---------------------------------------------------------------------------
// Integration tests — spindle in advance()
// ---------------------------------------------------------------------------

let db: DatabaseAdapter;
let project: Project;
let tmpDir: string;
let run: RunManager;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-spindle-test-'));
  const dbPath = path.join(tmpDir, 'test.sqlite');
  db = await createSQLiteAdapter({ url: dbPath });
  project = await repos.projects.ensureForRepo(db, {
    name: 'test-project',
    rootPath: tmpDir,
  });
  run = new RunManager(tmpDir);
});

afterEach(async () => {
  try { if (run.current) run.end(); } catch { /* ignore */ }
  await db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('advance — spindle integration', () => {
  it('recovers from first spindle stall instead of terminating', async () => {
    run.create(project.id, { step_budget: 50 });

    const ticket = await repos.tickets.create(db, {
      projectId: project.id,
      title: 'Stalling test',
      description: 'test',
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
    s.spindle.iterations_since_change = 5; // At stall threshold

    const resp = await advance({ run, db, project });

    // Recovery: ticket failed, session continues (not FAILED_SPINDLE)
    expect(resp.phase).not.toBe('FAILED_SPINDLE');
    expect(s.spindle_recoveries).toBe(1);
    expect(s.tickets_failed).toBeGreaterThanOrEqual(1);
  });

  it('recovers from first oscillation instead of terminating', async () => {
    run.create(project.id, { step_budget: 50 });

    const ticket = await repos.tickets.create(db, {
      projectId: project.id,
      title: 'Oscillation test',
      description: 'test',
      status: 'in_progress',
      priority: 80,
      category: 'refactor',
      allowedPaths: ['src/**'],
      verificationCommands: [],
    });

    const s = run.require();
    s.phase = 'EXECUTE';
    s.current_ticket_id = ticket.id;
    s.plan_approved = true;
    s.spindle.diff_hashes = ['hash_a', 'hash_b', 'hash_a']; // Oscillation

    const resp = await advance({ run, db, project });

    // Recovery: session continues (not FAILED_SPINDLE)
    expect(resp.phase).not.toBe('FAILED_SPINDLE');
    expect(s.spindle_recoveries).toBe(1);
  });

  it('recovers from first command failure block instead of terminating', async () => {
    run.create(project.id, { step_budget: 50 });

    const ticket = await repos.tickets.create(db, {
      projectId: project.id,
      title: 'Command fail test',
      description: 'test',
      status: 'in_progress',
      priority: 80,
      category: 'refactor',
      allowedPaths: ['src/**'],
      verificationCommands: [],
    });

    const s = run.require();
    s.phase = 'EXECUTE';
    s.current_ticket_id = ticket.id;
    s.plan_approved = true;
    s.spindle.failing_command_signatures = ['sig_a', 'sig_a', 'sig_a']; // Same command 3x

    const resp = await advance({ run, db, project });

    // Recovery: session continues (not BLOCKED_NEEDS_HUMAN)
    expect(resp.phase).not.toBe('BLOCKED_NEEDS_HUMAN');
    expect(s.spindle_recoveries).toBe(1);
  });

  it('terminates after 3 spindle recoveries (shouldAbort)', async () => {
    run.create(project.id, { step_budget: 50 });

    const ticket = await repos.tickets.create(db, {
      projectId: project.id,
      title: 'Recovery cap test',
      description: 'test',
      status: 'in_progress',
      priority: 80,
      category: 'refactor',
      allowedPaths: ['src/**'],
      verificationCommands: [],
    });

    const s = run.require();
    s.phase = 'EXECUTE';
    s.current_ticket_id = ticket.id;
    s.plan_approved = true;
    s.spindle_recoveries = 2; // Already recovered twice
    s.spindle.iterations_since_change = 5;

    const resp = await advance({ run, db, project });

    expect(resp.next_action).toBe('STOP');
    expect(resp.phase).toBe('FAILED_SPINDLE');
    expect(resp.reason).toContain('recovery cap reached');
    expect(s.spindle_recoveries).toBe(3);
  });

  it('terminates after 3 spindle recoveries (shouldBlock)', async () => {
    run.create(project.id, { step_budget: 50 });

    const ticket = await repos.tickets.create(db, {
      projectId: project.id,
      title: 'Block recovery cap test',
      description: 'test',
      status: 'in_progress',
      priority: 80,
      category: 'refactor',
      allowedPaths: ['src/**'],
      verificationCommands: [],
    });

    const s = run.require();
    s.phase = 'EXECUTE';
    s.current_ticket_id = ticket.id;
    s.plan_approved = true;
    s.spindle_recoveries = 2; // Already recovered twice
    s.spindle.failing_command_signatures = ['sig_a', 'sig_a', 'sig_a'];

    const resp = await advance({ run, db, project });

    expect(resp.next_action).toBe('STOP');
    expect(resp.phase).toBe('BLOCKED_NEEDS_HUMAN');
    expect(resp.reason).toContain('recovery cap reached');
    expect(s.spindle_recoveries).toBe(3);
  });

  it('resets spindle state on recovery', async () => {
    run.create(project.id, { step_budget: 50 });

    const ticket = await repos.tickets.create(db, {
      projectId: project.id,
      title: 'Reset state test',
      description: 'test',
      status: 'in_progress',
      priority: 80,
      category: 'refactor',
      allowedPaths: ['src/**'],
      verificationCommands: [],
    });

    const s = run.require();
    s.phase = 'EXECUTE';
    s.current_ticket_id = ticket.id;
    s.plan_approved = true;
    s.spindle.iterations_since_change = 5;
    s.spindle.output_hashes = ['aaa', 'bbb'];
    s.spindle.diff_hashes = ['ccc'];

    await advance({ run, db, project });

    // After recovery, spindle should be reset
    expect(s.spindle.iterations_since_change).toBe(0);
    expect(s.spindle.output_hashes).toEqual([]);
    expect(s.spindle.diff_hashes).toEqual([]);
    expect(s.current_ticket_id).toBeNull();
  });

  it('does not trigger spindle in SCOUT phase', async () => {
    run.create(project.id, { step_budget: 50 });

    const s = run.require();
    s.spindle.iterations_since_change = 10; // Would trigger in EXECUTE

    const resp = await advance({ run, db, project });

    // SCOUT phase should not be affected by spindle
    expect(resp.phase).toBe('SCOUT');
    expect(resp.next_action).toBe('PROMPT');
  });

  it('logs SPINDLE_ABORT event', async () => {
    run.create(project.id, { step_budget: 50 });

    const ticket = await repos.tickets.create(db, {
      projectId: project.id,
      title: 'Abort event test',
      description: 'test',
      status: 'in_progress',
      priority: 80,
      category: 'refactor',
      allowedPaths: ['src/**'],
      verificationCommands: [],
    });

    const s = run.require();
    s.phase = 'QA';
    s.current_ticket_id = ticket.id;
    s.spindle.iterations_since_change = 5;

    await advance({ run, db, project });

    const eventsPath = path.join(
      tmpDir, '.promptwheel', 'runs', s.run_id, 'events.ndjson',
    );
    const events = fs.readFileSync(eventsPath, 'utf8')
      .trim().split('\n').map(l => JSON.parse(l));
    const abortEvents = events.filter(e => e.type === 'SPINDLE_ABORT');
    expect(abortEvents.length).toBe(1);
    expect(abortEvents[0].payload.reason).toBe('stalling');
  });

  it('FAILED_SPINDLE is a clean terminal state', async () => {
    run.create(project.id, { step_budget: 50 });
    const s = run.require();
    s.phase = 'FAILED_SPINDLE';

    const resp = await advance({ run, db, project });

    expect(resp.next_action).toBe('STOP');
    expect(resp.phase).toBe('FAILED_SPINDLE');
  });
});

describe('processEvent — spindle state updates', () => {
  it('QA_COMMAND_RESULT failure records in spindle', async () => {
    run.create(project.id, { step_budget: 50 });
    const s = run.require();
    s.phase = 'QA';

    await processEvent(run, db, 'QA_COMMAND_RESULT', {
      command: 'npm test',
      success: false,
      output: 'Error: test failed',
    });

    expect(s.spindle.failing_command_signatures.length).toBe(1);
  });

  it('QA_FAILED increments stall counter', async () => {
    run.create(project.id, { step_budget: 50 });

    const ticket = await repos.tickets.create(db, {
      projectId: project.id,
      title: 'QA fail spindle test',
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
    const prevStall = s.spindle.iterations_since_change;

    await processEvent(run, db, 'QA_FAILED', { error: 'test failed' });

    expect(s.spindle.iterations_since_change).toBe(prevStall + 1);
  });

  it('TICKET_RESULT with diff resets stall counter', async () => {
    run.create(project.id, { step_budget: 50 });
    const s = run.require();
    s.phase = 'EXECUTE';
    s.current_ticket_id = 'tkt_test';
    s.plan_approved = true;
    s.spindle.iterations_since_change = 3;

    await processEvent(run, db, 'TICKET_RESULT', {
      status: 'done',
      changed_files: ['src/foo.ts'],
      lines_added: 5,
      lines_removed: 2,
    });

    // Diff was recorded (changed_files joined as fallback), resets stall
    expect(s.spindle.iterations_since_change).toBe(0);
  });

  it('buildDigest returns correct spindle_risk', async () => {
    run.create(project.id, { step_budget: 50 });
    const s = run.require();

    // Clean state
    expect(run.buildDigest().spindle_risk).toBe('none');

    // Approaching stall
    s.spindle.iterations_since_change = 2;
    expect(run.buildDigest().spindle_risk).toBe('low');
  });
});
