/**
 * Tests for CLI learnings module
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  loadLearnings,
  addLearning,
  confirmLearning,
  recordAccess,
  consolidateLearnings,
  formatLearningsForPrompt,
  selectRelevant,
  extractTags,
  type Learning,
} from '../lib/learnings.js';
import { buildTicketPrompt } from '../lib/solo-prompt-builder.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

function learningsFile(): string {
  return path.join(tmpDir, '.blockspool', 'learnings.json');
}

function writeLearningsRaw(learnings: Learning[]): void {
  const dir = path.join(tmpDir, '.blockspool');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(learningsFile(), JSON.stringify(learnings, null, 2));
}

function readLearningsRaw(): Learning[] {
  if (!fs.existsSync(learningsFile())) return [];
  return JSON.parse(fs.readFileSync(learningsFile(), 'utf8'));
}

function makeLearning(overrides: Partial<Learning> = {}): Learning {
  return {
    id: 'test-1',
    text: 'Test learning',
    category: 'gotcha',
    source: { type: 'qa_failure' },
    tags: [],
    weight: 50,
    created_at: new Date().toISOString(),
    last_confirmed_at: new Date().toISOString(),
    access_count: 0,
    ...overrides,
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'learnings-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// loadLearnings
// ---------------------------------------------------------------------------

describe('loadLearnings', () => {
  it('returns empty array when no file exists', () => {
    const result = loadLearnings(tmpDir);
    expect(result).toEqual([]);
  });

  it('applies decay and prunes dead entries', () => {
    writeLearningsRaw([
      makeLearning({ id: 'a', weight: 5 }),
      makeLearning({ id: 'b', weight: 50 }),
    ]);

    const result = loadLearnings(tmpDir, 10);
    // 'a' has weight 5 - 10 = -5, pruned
    // 'b' has weight 50 - 10 = 40 (but confirmed recently so decay halved to 5 → 45)
    expect(result.find(l => l.id === 'a')).toBeUndefined();
    expect(result.find(l => l.id === 'b')).toBeDefined();
  });

  it('halves decay for accessed learnings', () => {
    writeLearningsRaw([
      makeLearning({ id: 'a', weight: 10, access_count: 5 }),
    ]);

    const result = loadLearnings(tmpDir, 6);
    // decay = 6, access_count > 0 → 3, confirmed recently → 1.5
    // weight = 10 - 1.5 = 8.5
    expect(result).toHaveLength(1);
    expect(result[0].weight).toBeCloseTo(8.5);
  });

  it('writes surviving learnings back', () => {
    writeLearningsRaw([
      makeLearning({ id: 'a', weight: 1 }),
      makeLearning({ id: 'b', weight: 50 }),
    ]);

    loadLearnings(tmpDir, 3);
    const persisted = readLearningsRaw();
    // 'a' weight 1 - 1.5 (decay 3 halved for recent confirm) < 0 → pruned
    // Actually 1 - 1.5 = -0.5, so pruned
    expect(persisted.find(l => l.id === 'a')).toBeUndefined();
    expect(persisted.find(l => l.id === 'b')).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// addLearning
// ---------------------------------------------------------------------------

describe('addLearning', () => {
  it('creates a new learning with defaults', () => {
    const l = addLearning(tmpDir, {
      text: 'Test failure pattern',
      category: 'gotcha',
      source: { type: 'qa_failure', detail: 'lint failed' },
      tags: ['path:src/lib'],
    });

    expect(l.id).toBeTruthy();
    expect(l.text).toBe('Test failure pattern');
    expect(l.weight).toBe(50);
    expect(l.access_count).toBe(0);
    expect(l.tags).toEqual(['path:src/lib']);

    const persisted = readLearningsRaw();
    expect(persisted).toHaveLength(1);
    expect(persisted[0].id).toBe(l.id);
  });

  it('truncates text to 200 chars', () => {
    const longText = 'a'.repeat(300);
    const l = addLearning(tmpDir, {
      text: longText,
      category: 'warning',
      source: { type: 'ticket_failure' },
    });
    expect(l.text).toHaveLength(200);
  });

  it('appends to existing learnings', () => {
    writeLearningsRaw([makeLearning({ id: 'existing' })]);

    addLearning(tmpDir, {
      text: 'New learning',
      category: 'pattern',
      source: { type: 'manual' },
    });

    const persisted = readLearningsRaw();
    expect(persisted).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// confirmLearning
// ---------------------------------------------------------------------------

describe('confirmLearning', () => {
  it('bumps weight and updates timestamp', () => {
    const oldDate = '2020-01-01T00:00:00.000Z';
    writeLearningsRaw([makeLearning({ id: 'x', weight: 40, last_confirmed_at: oldDate })]);

    confirmLearning(tmpDir, 'x');

    const persisted = readLearningsRaw();
    expect(persisted[0].weight).toBe(50);
    expect(persisted[0].last_confirmed_at).not.toBe(oldDate);
  });

  it('caps weight at 100', () => {
    writeLearningsRaw([makeLearning({ id: 'x', weight: 95 })]);
    confirmLearning(tmpDir, 'x');
    expect(readLearningsRaw()[0].weight).toBe(100);
  });

  it('no-ops for unknown id', () => {
    writeLearningsRaw([makeLearning({ id: 'x' })]);
    confirmLearning(tmpDir, 'unknown');
    expect(readLearningsRaw()[0].weight).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// recordAccess
// ---------------------------------------------------------------------------

describe('recordAccess', () => {
  it('increments access_count for specified ids', () => {
    writeLearningsRaw([
      makeLearning({ id: 'a', access_count: 0 }),
      makeLearning({ id: 'b', access_count: 3 }),
    ]);

    recordAccess(tmpDir, ['a']);

    const persisted = readLearningsRaw();
    expect(persisted.find(l => l.id === 'a')!.access_count).toBe(1);
    expect(persisted.find(l => l.id === 'b')!.access_count).toBe(3);
  });

  it('no-ops for empty ids', () => {
    writeLearningsRaw([makeLearning({ id: 'a' })]);
    recordAccess(tmpDir, []);
    expect(readLearningsRaw()[0].access_count).toBe(0);
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
      makeLearning({ id: 'a', text: 'Low priority', weight: 10, category: 'warning' }),
      makeLearning({ id: 'b', text: 'High priority', weight: 90, category: 'gotcha' }),
    ];

    const result = formatLearningsForPrompt(learnings);
    expect(result).toContain('<project-learnings>');
    expect(result).toContain('</project-learnings>');
    expect(result).toContain('[GOTCHA] High priority');
    expect(result).toContain('[WARNING] Low priority');
    // High priority should come first
    expect(result.indexOf('High priority')).toBeLessThan(result.indexOf('Low priority'));
  });

  it('respects budget', () => {
    const learnings = Array.from({ length: 50 }, (_, i) =>
      makeLearning({ id: `l${i}`, text: `Learning number ${i} with some extra text`, weight: 50 - i })
    );

    const result = formatLearningsForPrompt(learnings, 300);
    expect(result.length).toBeLessThanOrEqual(300);
  });
});

// ---------------------------------------------------------------------------
// selectRelevant
// ---------------------------------------------------------------------------

describe('selectRelevant', () => {
  it('returns all learnings when no context tags', () => {
    const learnings = [makeLearning({ id: 'a' }), makeLearning({ id: 'b' })];
    const result = selectRelevant(learnings, {});
    expect(result).toHaveLength(2);
  });

  it('scores tag-matching learnings higher', () => {
    const learnings = [
      makeLearning({ id: 'a', tags: ['path:src/utils'], weight: 20 }),
      makeLearning({ id: 'b', tags: ['path:src/lib'], weight: 80 }),
    ];

    const result = selectRelevant(learnings, { paths: ['src/utils'] });
    // 'a' gets +20 tag bonus → score 40, 'b' stays at 80
    // So 'b' still wins due to high weight
    expect(result[0].id).toBe('b');

    // But with equal weights, tag match wins
    const equalWeight = [
      makeLearning({ id: 'a', tags: ['path:src/utils'], weight: 50 }),
      makeLearning({ id: 'b', tags: ['path:src/lib'], weight: 50 }),
    ];
    const result2 = selectRelevant(equalWeight, { paths: ['src/utils'] });
    expect(result2[0].id).toBe('a');
  });
});

// ---------------------------------------------------------------------------
// extractTags
// ---------------------------------------------------------------------------

describe('extractTags', () => {
  it('extracts path and command tags', () => {
    const tags = extractTags(['src/lib/**', 'tests'], ['npm run test']);
    expect(tags).toContain('path:src/lib');
    expect(tags).toContain('path:tests');
    expect(tags).toContain('cmd:npm run test');
  });

  it('strips trailing globs', () => {
    const tags = extractTags(['src/**', 'lib/*'], []);
    expect(tags).toContain('path:src');
    expect(tags).toContain('path:lib');
  });
});

// ---------------------------------------------------------------------------
// buildTicketPrompt integration
// ---------------------------------------------------------------------------

describe('buildTicketPrompt with learnings', () => {
  const ticket = {
    id: 'tkt-1',
    projectId: 'proj-1',
    title: 'Fix bug',
    description: 'Fix the bug',
    allowedPaths: ['src/lib'],
    forbiddenPaths: [],
    verificationCommands: ['npm test'],
    status: 'ready' as const,
    priority: 2,
    retryCount: 0,
    maxRetries: 3,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  it('includes learnings context when provided', () => {
    const learnings = [makeLearning({ text: 'Watch out for edge case' })];
    const learningsCtx = formatLearningsForPrompt(learnings);
    const prompt = buildTicketPrompt(ticket, undefined, learningsCtx);
    expect(prompt).toContain('Watch out for edge case');
    expect(prompt).toContain('<project-learnings>');
  });

  it('works without learnings context', () => {
    const prompt = buildTicketPrompt(ticket);
    expect(prompt).toContain('Fix bug');
    expect(prompt).not.toContain('project-learnings');
  });

  it('includes both guidelines and learnings', () => {
    const learnings = [makeLearning({ text: 'Learning content' })];
    const learningsCtx = formatLearningsForPrompt(learnings);
    const prompt = buildTicketPrompt(ticket, '<guidelines>Test</guidelines>', learningsCtx);
    expect(prompt).toContain('<guidelines>Test</guidelines>');
    expect(prompt).toContain('Learning content');
  });
});

// ---------------------------------------------------------------------------
// Config: learningsEnabled: false disables everything
// ---------------------------------------------------------------------------

describe('config integration', () => {
  it('DEFAULT_AUTO_CONFIG has learnings enabled', async () => {
    const { DEFAULT_AUTO_CONFIG } = await import('../lib/solo-config.js');
    expect(DEFAULT_AUTO_CONFIG.learningsEnabled).toBe(true);
    expect(DEFAULT_AUTO_CONFIG.learningsBudget).toBe(2000);
    expect(DEFAULT_AUTO_CONFIG.learningsDecayRate).toBe(3);
  });
});
