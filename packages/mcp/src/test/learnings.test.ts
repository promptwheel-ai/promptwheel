/**
 * Tests for cross-run learnings mechanism.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createSQLiteAdapter } from '@blockspool/sqlite';
import { repos } from '@blockspool/core';
import type { DatabaseAdapter, Project } from '@blockspool/core';
import { RunManager } from '../run-manager.js';
import { processEvent } from '../event-processor.js';
import {
  loadLearnings,
  addLearning,
  confirmLearning,
  recordAccess,
  consolidateLearnings,
  formatLearningsForPrompt,
  selectRelevant,
  extractTags,
} from '../learnings.js';
import type { Learning } from '../learnings.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-learnings-test-'));
  fs.mkdirSync(path.join(tmpDir, '.blockspool'), { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function learningsPath(): string {
  return path.join(tmpDir, '.blockspool', 'learnings.json');
}

function writeLearningsFile(learnings: Learning[]): void {
  fs.writeFileSync(learningsPath(), JSON.stringify(learnings, null, 2), 'utf8');
}

function readLearningsFile(): Learning[] {
  return JSON.parse(fs.readFileSync(learningsPath(), 'utf8'));
}

function makeLearning(overrides: Partial<Learning> = {}): Learning {
  return {
    id: 'abcd1234',
    text: 'Test learning text',
    category: 'gotcha',
    source: { type: 'qa_failure' },
    tags: ['path:src/api'],
    weight: 50,
    created_at: new Date().toISOString(),
    last_confirmed_at: new Date().toISOString(),
    access_count: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// loadLearnings
// ---------------------------------------------------------------------------

describe('loadLearnings', () => {
  it('reads JSON, applies decay, prunes dead entries', () => {
    writeLearningsFile([
      makeLearning({ id: 'a', weight: 50, access_count: 0, last_confirmed_at: '2020-01-01T00:00:00Z' }),
      makeLearning({ id: 'b', weight: 5, access_count: 0, last_confirmed_at: '2020-01-01T00:00:00Z' }),
      makeLearning({ id: 'c', weight: 2, access_count: 0, last_confirmed_at: '2020-01-01T00:00:00Z' }),
    ]);

    const result = loadLearnings(tmpDir, 3);

    // 'a' survives (50-3=47), 'b' survives (5-3=2), 'c' pruned (2-3=-1)
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe('a');
    expect(result[0].weight).toBe(47);
    expect(result[1].id).toBe('b');
    expect(result[1].weight).toBe(2);
  });

  it('returns empty array when file does not exist', () => {
    const result = loadLearnings(tmpDir);
    expect(result).toEqual([]);
  });

  it('applies access bonus (halved decay)', () => {
    writeLearningsFile([
      makeLearning({ id: 'a', weight: 10, access_count: 5, last_confirmed_at: '2020-01-01T00:00:00Z' }),
    ]);

    const result = loadLearnings(tmpDir, 3);
    // decay = 3 / 2 = 1.5 (accessed), confirmed old so no further halving
    expect(result[0].weight).toBe(8.5);
  });

  it('applies confirmation bonus (halved again)', () => {
    const recentDate = new Date().toISOString();
    writeLearningsFile([
      makeLearning({ id: 'a', weight: 10, access_count: 5, last_confirmed_at: recentDate }),
    ]);

    const result = loadLearnings(tmpDir, 3);
    // decay = 3 / 2 (accessed) / 2 (confirmed recently) = 0.75
    expect(result[0].weight).toBe(9.25);
  });

  it('caps weight at 100', () => {
    writeLearningsFile([
      makeLearning({ id: 'a', weight: 100, access_count: 5, last_confirmed_at: new Date().toISOString() }),
    ]);

    const result = loadLearnings(tmpDir, 0);
    expect(result[0].weight).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// addLearning
// ---------------------------------------------------------------------------

describe('addLearning', () => {
  it('creates with correct defaults', () => {
    const l = addLearning(tmpDir, {
      text: 'Test learning',
      category: 'gotcha',
      source: { type: 'qa_failure' },
    });

    expect(l.weight).toBe(50);
    expect(l.access_count).toBe(0);
    expect(l.id).toHaveLength(8);
    expect(l.text).toBe('Test learning');
    expect(l.category).toBe('gotcha');

    const stored = readLearningsFile();
    expect(stored).toHaveLength(1);
    expect(stored[0].id).toBe(l.id);
  });

  it('truncates text to 200 chars', () => {
    const longText = 'a'.repeat(300);
    const l = addLearning(tmpDir, {
      text: longText,
      category: 'warning',
      source: { type: 'manual' },
    });
    expect(l.text).toHaveLength(200);
  });
});

// ---------------------------------------------------------------------------
// confirmLearning
// ---------------------------------------------------------------------------

describe('confirmLearning', () => {
  it('bumps weight +10 and updates timestamp', () => {
    const oldDate = '2020-01-01T00:00:00Z';
    writeLearningsFile([makeLearning({ id: 'x', weight: 40, last_confirmed_at: oldDate })]);

    confirmLearning(tmpDir, 'x');

    const stored = readLearningsFile();
    expect(stored[0].weight).toBe(50);
    expect(stored[0].last_confirmed_at).not.toBe(oldDate);
  });

  it('caps weight at 100', () => {
    writeLearningsFile([makeLearning({ id: 'x', weight: 95 })]);
    confirmLearning(tmpDir, 'x');
    const stored = readLearningsFile();
    expect(stored[0].weight).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// formatLearningsForPrompt
// ---------------------------------------------------------------------------

describe('formatLearningsForPrompt', () => {
  it('returns empty string for no learnings', () => {
    expect(formatLearningsForPrompt([])).toBe('');
  });

  it('formats learnings sorted by weight', () => {
    const learnings = [
      makeLearning({ text: 'low', weight: 10, category: 'warning' }),
      makeLearning({ text: 'high', weight: 90, category: 'gotcha' }),
    ];
    const result = formatLearningsForPrompt(learnings);
    expect(result).toContain('<project-learnings>');
    expect(result).toContain('</project-learnings>');
    expect(result).toContain('[GOTCHA] high (w:90)');
    expect(result).toContain('[WARNING] low (w:10)');
    // high should come first
    const highIdx = result.indexOf('[GOTCHA] high');
    const lowIdx = result.indexOf('[WARNING] low');
    expect(highIdx).toBeLessThan(lowIdx);
  });

  it('respects char budget', () => {
    const learnings = Array.from({ length: 50 }, (_, i) =>
      makeLearning({ text: `Learning number ${i} with some text padding here`, weight: 50 - i })
    );
    const result = formatLearningsForPrompt(learnings, 300);
    expect(result.length).toBeLessThanOrEqual(300);
  });
});

// ---------------------------------------------------------------------------
// selectRelevant
// ---------------------------------------------------------------------------

describe('selectRelevant', () => {
  it('scores by tag overlap and weight', () => {
    const learnings = [
      makeLearning({ id: 'a', text: 'A', weight: 10, tags: ['path:src/api'] }),
      makeLearning({ id: 'b', text: 'B', weight: 90, tags: ['path:src/other'] }),
      makeLearning({ id: 'c', text: 'C', weight: 30, tags: ['path:src/api', 'cmd:npm test'] }),
    ];

    const result = selectRelevant(learnings, { paths: ['src/api'], commands: ['npm test'] });

    // c gets 2 tag matches (40) + 30 weight = 70
    // a gets 1 tag match (20) + 10 weight = 30
    // b gets 0 tag matches (0) + 90 weight = 90
    expect(result[0].id).toBe('b'); // 90
    expect(result[1].id).toBe('c'); // 70
    expect(result[2].id).toBe('a'); // 30
  });

  it('returns all learnings when no context tags', () => {
    const learnings = [makeLearning()];
    const result = selectRelevant(learnings, {});
    expect(result).toEqual(learnings);
  });
});

// ---------------------------------------------------------------------------
// consolidateLearnings
// ---------------------------------------------------------------------------

describe('consolidateLearnings', () => {
  it('merges near-duplicate entries above threshold count', () => {
    // Need > 50 entries to trigger consolidation
    const learnings: Learning[] = [];
    for (let i = 0; i < 52; i++) {
      learnings.push(makeLearning({
        id: `id${i.toString().padStart(3, '0')}`,
        text: i < 2 ? 'QA fails on src/api tests require DATABASE_URL env var' : `xyzzy${i}${String.fromCharCode(97 + (i % 26))}${i * 7}plugh${i * 13}`,
        weight: i === 0 ? 30 : i === 1 ? 60 : 40,
        access_count: i === 0 ? 1 : i === 1 ? 2 : 0,
        tags: i < 2 ? ['path:src/api'] : [],
      }));
    }
    writeLearningsFile(learnings);

    consolidateLearnings(tmpDir);

    const result = readLearningsFile();
    // The two similar entries (indices 0,1) should be merged into one
    expect(result.length).toBe(51);
    // The surviving entry should have the higher weight and summed access_count
    const merged = result.find(l => l.text.includes('QA fails'));
    expect(merged).toBeDefined();
    expect(merged!.weight).toBe(60);
    expect(merged!.access_count).toBe(3); // 1 + 2
  });

  it('does nothing when count <= 50', () => {
    const learnings = [makeLearning({ id: 'a' }), makeLearning({ id: 'b', text: 'same text' })];
    writeLearningsFile(learnings);

    consolidateLearnings(tmpDir);

    const result = readLearningsFile();
    expect(result).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// extractTags
// ---------------------------------------------------------------------------

describe('extractTags', () => {
  it('builds tags from paths and commands', () => {
    const tags = extractTags(['src/api/**', 'src/auth'], ['npm test']);
    expect(tags).toContain('path:src/api');
    expect(tags).toContain('path:src/auth');
    expect(tags).toContain('cmd:npm test');
  });
});

// ---------------------------------------------------------------------------
// recordAccess
// ---------------------------------------------------------------------------

describe('recordAccess', () => {
  it('increments access_count for matching ids', () => {
    writeLearningsFile([
      makeLearning({ id: 'a', access_count: 0 }),
      makeLearning({ id: 'b', access_count: 2 }),
    ]);

    recordAccess(tmpDir, ['a']);

    const stored = readLearningsFile();
    expect(stored[0].access_count).toBe(1);
    expect(stored[1].access_count).toBe(2); // unchanged
  });
});

// ---------------------------------------------------------------------------
// Integration: event processor records learnings
// ---------------------------------------------------------------------------

describe('Integration: event processor', () => {
  let db: DatabaseAdapter;
  let project: Project;
  let run: RunManager;

  beforeEach(async () => {
    const dbPath = path.join(tmpDir, 'test.sqlite');
    db = await createSQLiteAdapter({ url: dbPath });
    project = await repos.projects.ensureForRepo(db, {
      name: 'test-project',
      rootPath: tmpDir,
    });
    run = new RunManager(tmpDir);
    run.create(project.id, {
      step_budget: 100,
      categories: ['refactor', 'test'],
      learnings: true,
    });
    // Mark learnings as already loaded so ensureLearningsLoaded() is a no-op
    // (tests manage learnings state manually via addLearning/readLearningsFile)
    run.require().learnings_loaded = true;
  });

  afterEach(() => {
    try { if (run.current) run.end(); } catch { /* ignore */ }
  });

  it('QA_FAILED records a gotcha learning on final retry', async () => {
    const s = run.require();
    s.phase = 'QA';
    s.qa_retries = 2; // next failure is the 3rd

    // Create a ticket for context
    const [ticket] = await repos.tickets.createMany(db, [{
      projectId: project.id,
      title: 'Fix API tests',
      description: 'Fix failing API tests',
      status: 'in_progress',
      priority: 5,
      category: 'test',
      allowedPaths: ['src/api/'],
      verificationCommands: ['npm test'],
    }]);
    s.current_ticket_id = ticket.id;

    await processEvent(run, db, 'QA_FAILED', {
      error: 'Missing DATABASE_URL',
      command: 'npm test',
    });

    const learnings = readLearningsFile();
    expect(learnings.length).toBeGreaterThanOrEqual(1);
    expect(learnings[0].category).toBe('gotcha');
    expect(learnings[0].source.type).toBe('qa_failure');
  });

  it('TICKET_RESULT done confirms injected learnings on QA_PASSED', async () => {
    const s = run.require();

    // Pre-seed a learning
    const l = addLearning(tmpDir, {
      text: 'API tests need DB',
      category: 'gotcha',
      source: { type: 'qa_failure' },
    });
    s.injected_learning_ids = [l.id];

    // Create a ticket
    const [ticket] = await repos.tickets.createMany(db, [{
      projectId: project.id,
      title: 'Fix something',
      description: 'desc',
      status: 'in_progress',
      priority: 5,
      category: 'refactor',
      allowedPaths: [],
      verificationCommands: [],
    }]);
    s.current_ticket_id = ticket.id;
    s.phase = 'QA';

    await processEvent(run, db, 'QA_PASSED', {});

    const learnings = readLearningsFile();
    const confirmed = learnings.find(x => x.id === l.id);
    expect(confirmed).toBeDefined();
    expect(confirmed!.weight).toBe(60); // 50 + 10
    expect(s.injected_learning_ids).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Config: learnings=false disables recording and injection
// ---------------------------------------------------------------------------

describe('Config: learnings disabled', () => {
  it('does not record learnings when disabled', async () => {
    const dbPath = path.join(tmpDir, 'test2.sqlite');
    const db = await createSQLiteAdapter({ url: dbPath });
    const project = await repos.projects.ensureForRepo(db, {
      name: 'test-project',
      rootPath: tmpDir,
    });
    const run = new RunManager(tmpDir);
    run.create(project.id, {
      step_budget: 100,
      categories: ['refactor'],
      learnings: false,
    });

    const s = run.require();
    expect(s.learnings_enabled).toBe(false);

    // Simulate plan rejection — should NOT create a learning
    s.phase = 'PLAN';
    s.current_ticket_id = 'fake-ticket';

    const [ticket] = await repos.tickets.createMany(db, [{
      projectId: project.id,
      title: 'Test',
      description: 'desc',
      status: 'in_progress',
      priority: 5,
      category: 'refactor',
      allowedPaths: [],
      verificationCommands: [],
    }]);
    s.current_ticket_id = ticket.id;

    // Ingest a plan that will be rejected (no files)
    await processEvent(run, db, 'PLAN_SUBMITTED', {
      files_to_touch: [{ path: '/etc/passwd', action: 'modify', reason: 'test' }],
      estimated_lines: 10,
      risk_level: 'low',
    });

    // Check no learnings file was created (or it's empty)
    const fp = path.join(tmpDir, '.blockspool', 'learnings.json');
    if (fs.existsSync(fp)) {
      const learnings = JSON.parse(fs.readFileSync(fp, 'utf8'));
      expect(learnings).toHaveLength(0);
    }

    run.end();
  });
});

// ---------------------------------------------------------------------------
// Multi-run lifecycle simulation
// ---------------------------------------------------------------------------

describe('Decay across multiple loads', () => {
  it('simulates multi-run lifecycle with decay', () => {
    // Add a learning and set last_confirmed_at to old date (no confirmation bonus)
    addLearning(tmpDir, {
      text: 'Unused learning',
      category: 'gotcha',
      source: { type: 'manual' },
    });
    const learningsInit = readLearningsFile();
    learningsInit[0].last_confirmed_at = '2020-01-01T00:00:00Z';
    writeLearningsFile(learningsInit);

    // Simulate 16 session loads (unused, old confirmation, decay=3 per load)
    for (let i = 0; i < 16; i++) {
      loadLearnings(tmpDir, 3);
    }

    // After 16 loads: 50 - (16 * 3) = 2, should still survive
    let learnings = readLearningsFile();
    expect(learnings.length).toBe(1);
    expect(learnings[0].weight).toBeLessThanOrEqual(2);

    // One more load should prune it
    loadLearnings(tmpDir, 3);
    learnings = readLearningsFile();
    expect(learnings.length).toBe(0);
  });

  it('accessed learnings survive longer', () => {
    const l = addLearning(tmpDir, {
      text: 'Accessed learning',
      category: 'pattern',
      source: { type: 'manual' },
    });

    // Mark as accessed
    recordAccess(tmpDir, [l.id]);

    // Simulate 30 loads (accessed, old confirmation → decay=1.5 per load)
    // But first set last_confirmed_at to old date
    const learnings = readLearningsFile();
    learnings[0].last_confirmed_at = '2020-01-01T00:00:00Z';
    writeLearningsFile(learnings);

    for (let i = 0; i < 30; i++) {
      loadLearnings(tmpDir, 3);
    }

    // After 30 loads: 50 - (30 * 1.5) = 5, should survive
    const result = readLearningsFile();
    expect(result.length).toBe(1);

    // Note: actual value depends on accumulated rounding, just verify it survives
    expect(result[0].weight).toBeGreaterThan(0);
  });
});
