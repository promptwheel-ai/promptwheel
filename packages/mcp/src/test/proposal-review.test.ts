/**
 * Tests for adversarial proposal review (Two-Claude Pattern).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createSQLiteAdapter } from '@blockspool/sqlite';
import { repos } from '@blockspool/core';
import type { DatabaseAdapter, Project } from '@blockspool/core';
import { RunManager } from '../run-manager.js';
import { buildProposalReviewPrompt } from '../proposals.js';
import type { ValidatedProposal, RawProposal } from '../proposals.js';
import { processEvent } from '../event-processor.js';
import { advance } from '../advance.js';

let db: DatabaseAdapter;
let project: Project;
let tmpDir: string;
let run: RunManager;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-review-test-'));
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

function makeValidated(overrides: Partial<ValidatedProposal> = {}): ValidatedProposal {
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
// buildProposalReviewPrompt
// ---------------------------------------------------------------------------

describe('buildProposalReviewPrompt', () => {
  it('includes all proposal titles', () => {
    const proposals = [
      makeValidated({ title: 'Fix auth bypass' }),
      makeValidated({ title: 'Add missing tests' }),
    ];

    const prompt = buildProposalReviewPrompt(proposals);

    expect(prompt).toContain('Fix auth bypass');
    expect(prompt).toContain('Add missing tests');
  });

  it('asks feasibility questions', () => {
    const prompt = buildProposalReviewPrompt([makeValidated()]);

    expect(prompt).toContain('confidence inflated');
    expect(prompt).toContain('verification commands');
    expect(prompt).toContain('edge cases');
    expect(prompt).toContain('Feasibility');
  });

  it('includes confidence and impact for each proposal', () => {
    const prompt = buildProposalReviewPrompt([
      makeValidated({ confidence: 92, impact_score: 8 }),
    ]);

    expect(prompt).toContain('92');
    expect(prompt).toContain('8/10');
  });
});

// ---------------------------------------------------------------------------
// SCOUT_OUTPUT stores proposals as pending
// ---------------------------------------------------------------------------

describe('SCOUT_OUTPUT stores proposals as pending', () => {
  it('stores proposals in pending_proposals instead of creating tickets', async () => {
    const s = run.require();
    s.phase = 'SCOUT';

    const result = await processEvent(run, db, 'SCOUT_OUTPUT', {
      proposals: [makeProposal({ title: 'Good proposal' })],
    });

    expect(result.phase_changed).toBe(false);
    expect(result.message).toContain('pending adversarial review');
    expect(s.pending_proposals).toHaveLength(1);
    expect(s.pending_proposals![0].title).toBe('Good proposal');
  });

  it('advance returns review prompt when pending_proposals exist', async () => {
    const s = run.require();
    s.phase = 'SCOUT';
    s.pending_proposals = [makeProposal({ title: 'Needs review' })];

    const resp = await advance({ run, db, project });

    expect(resp.phase).toBe('SCOUT');
    expect(resp.prompt).toContain('Adversarial Proposal Review');
    expect(resp.prompt).toContain('Needs review');
  });
});

// ---------------------------------------------------------------------------
// PROPOSALS_REVIEWED creates tickets
// ---------------------------------------------------------------------------

describe('PROPOSALS_REVIEWED creates tickets from reviewed proposals', () => {
  it('creates tickets after review', async () => {
    const s = run.require();
    s.phase = 'SCOUT';
    s.pending_proposals = [makeProposal({ title: 'Reviewed proposal', confidence: 85, impact_score: 7 })];

    const result = await processEvent(run, db, 'PROPOSALS_REVIEWED', {
      reviewed_proposals: [
        { title: 'Reviewed proposal', confidence: 80, impact_score: 7 },
      ],
    });

    expect(result.phase_changed).toBe(true);
    expect(result.new_phase).toBe('NEXT_TICKET');
    expect(result.message).toContain('Created 1');
    expect(s.pending_proposals).toBeNull();
  });

  it('filters out proposals whose confidence was lowered below threshold', async () => {
    const s = run.require();
    s.phase = 'SCOUT';
    s.pending_proposals = [
      makeProposal({ title: 'Will survive', confidence: 85, impact_score: 7 }),
      makeProposal({ title: 'Will be filtered', confidence: 85, impact_score: 7 }),
    ];

    const result = await processEvent(run, db, 'PROPOSALS_REVIEWED', {
      reviewed_proposals: [
        { title: 'Will survive', confidence: 80, impact_score: 7 },
        { title: 'Will be filtered', confidence: 30, impact_score: 2 }, // below min_confidence=70
      ],
    });

    expect(result.phase_changed).toBe(true);
    expect(result.new_phase).toBe('NEXT_TICKET');
    // Only 1 ticket created (the other was filtered)
    expect(result.message).toContain('Created 1');
  });

  it('retries when all proposals rejected after review', async () => {
    const s = run.require();
    s.phase = 'SCOUT';
    s.scout_retries = 0;
    s.pending_proposals = [
      makeProposal({ title: 'Weak proposal', confidence: 85 }),
    ];

    const result = await processEvent(run, db, 'PROPOSALS_REVIEWED', {
      reviewed_proposals: [
        { title: 'Weak proposal', confidence: 10 }, // lowered below threshold
      ],
    });

    expect(result.phase_changed).toBe(false);
    expect(s.scout_retries).toBe(1);
    expect(s.pending_proposals).toBeNull();
  });
});
