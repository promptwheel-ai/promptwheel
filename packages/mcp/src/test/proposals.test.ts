/**
 * Tests for proposal filtering, dedup, scoring, and ticket creation (Phase 3).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createSQLiteAdapter } from '@blockspool/sqlite';
import { repos } from '@blockspool/core';
import type { DatabaseAdapter, Project } from '@blockspool/core';
import { RunManager } from '../run-manager.js';
import { filterAndCreateTickets, titleSimilarity } from '../proposals.js';
import type { RawProposal } from '../proposals.js';
import { processEvent } from '../event-processor.js';

let db: DatabaseAdapter;
let project: Project;
let tmpDir: string;
let run: RunManager;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-prop-test-'));
  const dbPath = path.join(tmpDir, 'test.sqlite');
  db = await createSQLiteAdapter({ url: dbPath });
  project = await repos.projects.ensureForRepo(db, {
    name: 'test-project',
    rootPath: tmpDir,
  });
  run = new RunManager(tmpDir);
  run.create(project.id, {
    step_budget: 100,
    categories: ['refactor', 'test', 'docs', 'perf'],
    min_confidence: 70,
    max_proposals: 5,
  });
});

afterEach(async () => {
  try { if (run.current) run.end(); } catch { /* ignore */ }
  await db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeProposal(overrides: Partial<RawProposal> = {}): RawProposal {
  return {
    category: 'refactor',
    title: 'Extract shared validation logic',
    description: 'Three handlers duplicate email validation',
    acceptance_criteria: ['Single validateEmail() function'],
    verification_commands: ['npm test'],
    allowed_paths: ['src/handlers/', 'src/utils/'],
    files: ['src/handlers/signup.ts', 'src/utils/validate.ts'],
    confidence: 85,
    impact_score: 7,
    rationale: 'Reduces duplication',
    estimated_complexity: 'simple',
    risk: 'low',
    touched_files_estimate: 3,
    rollback_note: 'Revert single commit',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Title similarity
// ---------------------------------------------------------------------------

describe('titleSimilarity', () => {
  it('returns 1.0 for identical titles', () => {
    expect(titleSimilarity('foo bar', 'foo bar')).toBe(1);
  });

  it('returns 1.0 for case-insensitive match', () => {
    expect(titleSimilarity('Foo Bar', 'foo bar')).toBe(1);
  });

  it('returns high similarity for minor differences', () => {
    const sim = titleSimilarity(
      'Extract shared validation logic',
      'Extract shared validation',
    );
    expect(sim).toBeGreaterThan(0.6);
  });

  it('returns low similarity for different titles', () => {
    const sim = titleSimilarity(
      'Extract shared validation logic',
      'Add dark mode support',
    );
    expect(sim).toBeLessThan(0.3);
  });

  it('handles empty strings', () => {
    expect(titleSimilarity('', '')).toBe(1);
    expect(titleSimilarity('foo', '')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------

describe('filterAndCreateTickets — schema validation', () => {
  it('rejects proposals missing required fields', async () => {
    const result = await filterAndCreateTickets(run, db, [
      { title: 'Missing fields' } as RawProposal,
    ]);

    expect(result.accepted).toHaveLength(0);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].reason).toContain('Missing fields');
  });

  it('accepts well-formed proposals', async () => {
    const result = await filterAndCreateTickets(run, db, [makeProposal()]);

    expect(result.accepted).toHaveLength(1);
    expect(result.created_ticket_ids).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Confidence filter
// ---------------------------------------------------------------------------

describe('filterAndCreateTickets — confidence filter (removed)', () => {
  it('accepts proposals regardless of confidence (confidence is now an execution hint)', async () => {
    const result = await filterAndCreateTickets(run, db, [
      makeProposal({ confidence: 50, title: 'Low confidence' }),
    ]);

    expect(result.accepted).toHaveLength(1);
    expect(result.rejected.some(r => r.reason.includes('Confidence'))).toBe(false);
  });

  it('accepts proposals at any confidence level', async () => {
    const result = await filterAndCreateTickets(run, db, [
      makeProposal({ confidence: 70, title: 'At threshold' }),
    ]);

    expect(result.accepted).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Category trust ladder
// ---------------------------------------------------------------------------

describe('filterAndCreateTickets — category trust ladder', () => {
  it('rejects proposals with blocked categories', async () => {
    const result = await filterAndCreateTickets(run, db, [
      makeProposal({ category: 'security', title: 'Security fix' }),
    ]);

    expect(result.accepted).toHaveLength(0);
    expect(result.rejected.some(r => r.reason.includes('trust ladder'))).toBe(true);
  });

  it('accepts proposals with allowed categories', async () => {
    const result = await filterAndCreateTickets(run, db, [
      makeProposal({ category: 'test', title: 'Add tests' }),
    ]);

    expect(result.accepted).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Dedup
// ---------------------------------------------------------------------------

describe('filterAndCreateTickets — dedup', () => {
  it('rejects proposals similar to existing tickets', async () => {
    // Create an existing ticket
    await repos.tickets.create(db, {
      projectId: project.id,
      title: 'Extract shared validation logic',
      description: 'Already exists',
      status: 'ready',
      priority: 80,
      category: 'refactor',
      allowedPaths: [],
      verificationCommands: [],
    });

    const result = await filterAndCreateTickets(run, db, [
      makeProposal({ title: 'Extract shared validation' }), // similar
    ]);

    expect(result.accepted).toHaveLength(0);
    expect(result.rejected.some(r => r.reason.includes('Duplicate'))).toBe(true);
  });

  it('rejects duplicates within the same batch', async () => {
    const result = await filterAndCreateTickets(run, db, [
      makeProposal({ title: 'Extract validation logic' }),
      makeProposal({ title: 'Extract validation' }), // similar to above
    ]);

    expect(result.accepted).toHaveLength(1);
    expect(result.rejected.some(r => r.reason.includes('within batch'))).toBe(true);
  });

  it('allows dissimilar proposals', async () => {
    await repos.tickets.create(db, {
      projectId: project.id,
      title: 'Add dark mode',
      description: 'existing',
      status: 'done',
      priority: 80,
      category: 'refactor',
      allowedPaths: [],
      verificationCommands: [],
    });

    const result = await filterAndCreateTickets(run, db, [
      makeProposal({ title: 'Refactor database queries' }),
    ]);

    expect(result.accepted).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Proposal cap + scoring
// ---------------------------------------------------------------------------

describe('filterAndCreateTickets — cap and scoring', () => {
  it('caps proposals at max_proposals_per_scout', async () => {
    const distinctTitles = [
      'Refactor database connection pooling',
      'Add unit tests for authentication module',
      'Optimize image loading pipeline',
      'Extract shared validation helpers',
      'Document REST API endpoints',
      'Improve error handling in payments',
      'Add retry logic for network calls',
      'Consolidate duplicate CSS styles',
      'Migrate legacy config to new format',
      'Add integration tests for checkout flow',
    ];
    const proposals = distinctTitles.map((title, i) =>
      makeProposal({
        title,
        confidence: 80 + i,
        impact_score: 5 + (i % 5),
        category: 'refactor',
      }),
    );

    const result = await filterAndCreateTickets(run, db, proposals);

    // max_proposals is 5
    expect(result.accepted).toHaveLength(5);
    expect(result.created_ticket_ids).toHaveLength(5);
  });

  it('ranks by impact_score × confidence', async () => {
    const proposals = [
      makeProposal({ title: 'Low score', confidence: 70, impact_score: 3 }), // 210
      makeProposal({ title: 'High score', confidence: 90, impact_score: 9 }), // 810
      makeProposal({ title: 'Mid score', confidence: 80, impact_score: 5 }), // 400
    ];

    const result = await filterAndCreateTickets(run, db, proposals);

    expect(result.accepted).toHaveLength(3);
    expect(result.accepted[0].title).toBe('High score');
    expect(result.accepted[1].title).toBe('Mid score');
    expect(result.accepted[2].title).toBe('Low score');
  });
});

// ---------------------------------------------------------------------------
// Ticket creation
// ---------------------------------------------------------------------------

describe('filterAndCreateTickets — ticket creation', () => {
  it('creates tickets with correct fields', async () => {
    const result = await filterAndCreateTickets(run, db, [
      makeProposal({
        title: 'Add input sanitization',
        category: 'refactor',
        allowed_paths: ['src/handlers/**'],
        verification_commands: ['npm test', 'npm run lint'],
      }),
    ]);

    expect(result.created_ticket_ids).toHaveLength(1);

    const ticket = await repos.tickets.getById(db, result.created_ticket_ids[0]);
    expect(ticket).toBeTruthy();
    expect(ticket!.title).toBe('Add input sanitization');
    expect(ticket!.status).toBe('ready');
    expect(ticket!.allowedPaths).toEqual(['src/handlers/**']);
    expect(ticket!.verificationCommands).toEqual(['npm test', 'npm run lint']);
    expect(ticket!.description).toContain('Risk:');
    expect(ticket!.description).toContain('Rollback');
  });
});

// ---------------------------------------------------------------------------
// SCOUT_OUTPUT event integration
// ---------------------------------------------------------------------------

describe('processEvent SCOUT_OUTPUT', () => {
  it('stores proposals as pending for review', async () => {
    const s = run.require();
    s.phase = 'SCOUT';

    const result = await processEvent(run, db, 'SCOUT_OUTPUT', {
      proposals: [makeProposal({ title: 'Good proposal' })],
    });

    expect(result.phase_changed).toBe(false);
    expect(result.message).toContain('pending adversarial review');
    expect(s.pending_proposals).toHaveLength(1);
  });

  it('creates tickets after PROPOSALS_REVIEWED', async () => {
    const s = run.require();
    s.phase = 'SCOUT';
    s.pending_proposals = [makeProposal({ title: 'Good proposal' })];

    const result = await processEvent(run, db, 'PROPOSALS_REVIEWED', {
      reviewed_proposals: [{ title: 'Good proposal', confidence: 85, impact_score: 7 }],
    });

    expect(result.phase_changed).toBe(true);
    expect(result.new_phase).toBe('NEXT_TICKET');
    expect(result.message).toContain('Created 1');
  });

  it('retries scout when no proposals and retries remaining', async () => {
    const s = run.require();
    s.phase = 'SCOUT';
    s.scout_retries = 0;

    const result = await processEvent(run, db, 'SCOUT_OUTPUT', {
      proposals: [],
    });

    expect(result.phase_changed).toBe(false);
    expect(s.scout_retries).toBe(1);
    expect(result.message).toContain('Retrying');
  });

  it('transitions to DONE when no proposals and retries exhausted', async () => {
    const s = run.require();
    s.phase = 'SCOUT';
    s.scout_retries = 2;

    const result = await processEvent(run, db, 'SCOUT_OUTPUT', {
      proposals: [],
    });

    expect(result.phase_changed).toBe(true);
    expect(result.new_phase).toBe('DONE');
  });

  it('retries scout when all proposals rejected after review and retries remaining', async () => {
    const s = run.require();
    s.phase = 'SCOUT';
    s.scout_retries = 0;
    // Use low impact score (below min_impact=3) to trigger rejection, since confidence no longer filters
    s.pending_proposals = [makeProposal({ impact_score: 1, title: 'Too low impact' })];

    const result = await processEvent(run, db, 'PROPOSALS_REVIEWED', {
      reviewed_proposals: [{ title: 'Too low impact', confidence: 85, impact_score: 1 }],
    });

    expect(result.phase_changed).toBe(false);
    expect(s.scout_retries).toBe(1);
  });

  it('transitions to DONE when all proposals rejected after review and retries exhausted', async () => {
    const s = run.require();
    s.phase = 'SCOUT';
    s.scout_retries = 2;
    // Use low impact score to trigger rejection
    s.pending_proposals = [makeProposal({ impact_score: 1, title: 'Too low impact' })];

    const result = await processEvent(run, db, 'PROPOSALS_REVIEWED', {
      reviewed_proposals: [{ title: 'Too low impact', confidence: 85, impact_score: 1 }],
    });

    expect(result.phase_changed).toBe(true);
    expect(result.new_phase).toBe('DONE');
    expect(result.message).toContain('rejected');
  });

  it('saves proposals artifact', async () => {
    const s = run.require();
    s.phase = 'SCOUT';

    await processEvent(run, db, 'SCOUT_OUTPUT', {
      proposals: [makeProposal()],
    });

    const artifactPath = path.join(
      tmpDir, '.blockspool', 'runs', s.run_id, 'artifacts',
      `${s.step_count}-scout-proposals.json`,
    );
    expect(fs.existsSync(artifactPath)).toBe(true);
    const content = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
    expect(content.raw).toHaveLength(1);
    expect(content.pending_review).toBe(true);
  });

  it('ignores SCOUT_OUTPUT outside SCOUT phase', async () => {
    const s = run.require();
    s.phase = 'EXECUTE';

    const result = await processEvent(run, db, 'SCOUT_OUTPUT', {
      proposals: [makeProposal()],
    });

    expect(result.phase_changed).toBe(false);
    expect(result.message).toContain('ignored');
  });
});

// ---------------------------------------------------------------------------
// Scout prompt content
// ---------------------------------------------------------------------------

describe('advance scout prompt', () => {
  it('includes required fields and scoring rubric', async () => {
    const { advance } = await import('../advance.js');

    const resp = await advance({ run, db, project });

    expect(resp.phase).toBe('SCOUT');
    expect(resp.prompt).toContain('category');
    expect(resp.prompt).toContain('risk');
    expect(resp.prompt).toContain('touched_files_estimate');
    expect(resp.prompt).toContain('rollback_note');
    expect(resp.prompt).toContain('impact_score');
    expect(resp.prompt).toContain('Scoring');
    expect(resp.prompt).toContain('impact_score × confidence');
  });
});
