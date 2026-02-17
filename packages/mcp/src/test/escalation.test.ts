/**
 * Tests for better escalation — "knowing everything you know now" pattern.
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
import type { RawProposal } from '../proposals.js';

let db: DatabaseAdapter;
let project: Project;
let tmpDir: string;
let run: RunManager;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-esc-test-'));
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

// ---------------------------------------------------------------------------
// Escalation includes exploration log
// ---------------------------------------------------------------------------

describe('escalation with exploration log', () => {
  it('includes exploration log entries in escalation prompt', async () => {
    const s = run.require();
    s.phase = 'SCOUT';
    s.scout_retries = 1;
    s.scout_exploration_log = [
      'Attempt 1: Explored src/services/, src/api/. Found 0 proposals.',
    ];

    const resp = await advance({ run, db, project });

    expect(resp.phase).toBe('SCOUT');
    expect(resp.prompt).toContain('Previous Attempts Found Nothing');
    expect(resp.prompt).toContain('Attempt 1: Explored src/services/, src/api/');
    expect(resp.prompt).toContain('completely different angle');
  });

  it('references unexplored modules from codebase index', async () => {
    // Create actual directories so hasStructuralChanges doesn't detect removal
    fs.mkdirSync(path.join(tmpDir, 'src', 'services'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'src', 'utils'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'src', 'handlers'), { recursive: true });

    const s = run.require();
    s.phase = 'SCOUT';
    s.scout_retries = 1;
    s.scouted_dirs = ['src/services'];
    s.scout_exploration_log = [
      'Attempt 1: Explored src/services. Found 0 proposals.',
    ];
    // Set index with future timestamp so hasStructuralChanges returns false
    s.codebase_index = {
      built_at: new Date(Date.now() + 60000).toISOString(),
      modules: [
        { path: 'src/services', file_count: 5, purpose: 'services' },
        { path: 'src/utils', file_count: 3, purpose: 'utils' },
        { path: 'src/handlers', file_count: 4, purpose: 'api' },
      ],
      dependency_edges: {},
      untested_modules: [],
      large_files: [],
      entrypoints: [],
      sampled_file_mtimes: {},
    };
    s.codebase_index_dirty = false;

    const resp = await advance({ run, db, project });

    expect(resp.prompt).toContain('src/utils');
    expect(resp.prompt).toContain('src/handlers');
    // Should NOT suggest already-explored src/services
    expect(resp.prompt).toContain('unexplored areas');
  });

  it('falls back to basic escalation with empty exploration log', async () => {
    const s = run.require();
    s.phase = 'SCOUT';
    s.scout_retries = 1;
    s.scout_exploration_log = [];

    const resp = await advance({ run, db, project });

    expect(resp.prompt).toContain('Previous Attempts Found Nothing');
    expect(resp.prompt).toContain('completely different angle');
    // Should not contain "What Was Already Tried" section if log is empty
    expect(resp.prompt).not.toContain('What Was Already Tried');
  });
});

// ---------------------------------------------------------------------------
// Exploration log is populated by SCOUT_OUTPUT
// ---------------------------------------------------------------------------

describe('SCOUT_OUTPUT populates exploration log', () => {
  it('adds entry to scout_exploration_log', async () => {
    const s = run.require();
    s.phase = 'SCOUT';

    await processEvent(run, db, 'SCOUT_OUTPUT', {
      proposals: [{
        category: 'refactor',
        title: 'Test',
        description: 'test',
        acceptance_criteria: [],
        verification_commands: ['npm test'],
        allowed_paths: ['src/'],
        files: ['src/foo.ts'],
        confidence: 85,
        impact_score: 7,
        risk: 'low',
        touched_files_estimate: 1,
        rollback_note: 'revert',
      } satisfies RawProposal],
      explored_dirs: ['src/services/', 'src/api/'],
    });

    expect(s.scout_exploration_log).toHaveLength(1);
    expect(s.scout_exploration_log[0]).toContain('src/services/');
    expect(s.scout_exploration_log[0]).toContain('Found 1 proposals');
  });

  it('uses exploration_summary if provided', async () => {
    const s = run.require();
    s.phase = 'SCOUT';

    await processEvent(run, db, 'SCOUT_OUTPUT', {
      proposals: [],
      explored_dirs: ['src/utils/'],
      exploration_summary: 'Codebase well-maintained, no issues found.',
    });

    expect(s.scout_exploration_log).toHaveLength(1);
    expect(s.scout_exploration_log[0]).toContain('Codebase well-maintained');
  });
});
