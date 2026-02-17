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
  recordApplication,
  recordOutcome,
  getLearningEffectiveness,
  consolidateLearnings,
  formatLearningsForPrompt,
  selectRelevant,
  extractTags,
  LEARNINGS_DEFAULTS,
  type Learning,
} from '../lib/learnings.js';
import { buildTicketPrompt } from '../lib/solo-prompt-builder.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

function learningsFile(): string {
  return path.join(tmpDir, '.promptwheel', 'learnings.json');
}

function writeLearningsRaw(learnings: Learning[]): void {
  const dir = path.join(tmpDir, '.promptwheel');
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

// ---------------------------------------------------------------------------
// recordOutcome
// ---------------------------------------------------------------------------

describe('recordOutcome', () => {
  it('boosts weight by 2 on success', () => {
    const learning = makeLearning({ id: 'out-1', weight: 50 });
    writeLearningsRaw([learning]);
    recordOutcome(tmpDir, ['out-1'], true);
    const result = readLearningsRaw();
    expect(result[0].weight).toBe(52);
  });

  it('increments success_count on success', () => {
    const learning = makeLearning({ id: 'out-2', weight: 50, success_count: 3 });
    writeLearningsRaw([learning]);
    recordOutcome(tmpDir, ['out-2'], true);
    const result = readLearningsRaw();
    expect(result[0].success_count).toBe(4);
  });

  it('initializes success_count from undefined', () => {
    const learning = makeLearning({ id: 'out-3', weight: 50 });
    delete (learning as any).success_count;
    writeLearningsRaw([learning]);
    recordOutcome(tmpDir, ['out-3'], true);
    const result = readLearningsRaw();
    expect(result[0].success_count).toBe(1);
  });

  it('decreases weight by 1 on failure', () => {
    const learning = makeLearning({ id: 'out-4', weight: 50 });
    writeLearningsRaw([learning]);
    recordOutcome(tmpDir, ['out-4'], false);
    const result = readLearningsRaw();
    expect(result[0].weight).toBe(49);
  });

  it('clamps weight to MAX_WEIGHT on success', () => {
    const learning = makeLearning({ id: 'out-5', weight: 99 });
    writeLearningsRaw([learning]);
    recordOutcome(tmpDir, ['out-5'], true);
    const result = readLearningsRaw();
    expect(result[0].weight).toBe(LEARNINGS_DEFAULTS.MAX_WEIGHT);
  });

  it('clamps weight to minimum 1 on failure', () => {
    const learning = makeLearning({ id: 'out-6', weight: 1 });
    writeLearningsRaw([learning]);
    recordOutcome(tmpDir, ['out-6'], false);
    const result = readLearningsRaw();
    expect(result[0].weight).toBe(1);
  });

  it('is a no-op for empty ids', () => {
    const learning = makeLearning({ id: 'out-7', weight: 50 });
    writeLearningsRaw([learning]);
    recordOutcome(tmpDir, [], true);
    const result = readLearningsRaw();
    expect(result[0].weight).toBe(50);
  });

  it('only affects matching ids', () => {
    writeLearningsRaw([
      makeLearning({ id: 'match', weight: 50 }),
      makeLearning({ id: 'no-match', weight: 50 }),
    ]);
    recordOutcome(tmpDir, ['match'], true);
    const result = readLearningsRaw();
    expect(result[0].weight).toBe(52);
    expect(result[1].weight).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// getLearningEffectiveness
// ---------------------------------------------------------------------------

describe('getLearningEffectiveness', () => {
  it('returns zero stats for empty learnings', () => {
    // No file written — empty state
    const result = getLearningEffectiveness(tmpDir);
    expect(result.total).toBe(0);
    expect(result.applied).toBe(0);
    expect(result.successRate).toBe(0);
    expect(result.topPerformers).toEqual([]);
  });

  it('returns zero stats when no learnings have been applied', () => {
    writeLearningsRaw([
      makeLearning({ id: 'e-1', applied_count: 0, success_count: 0 }),
      makeLearning({ id: 'e-2' }),
    ]);
    const result = getLearningEffectiveness(tmpDir);
    expect(result.total).toBe(2);
    expect(result.applied).toBe(0);
    expect(result.successRate).toBe(0);
    expect(result.topPerformers).toEqual([]);
  });

  it('calculates success rate correctly', () => {
    writeLearningsRaw([
      makeLearning({ id: 'e-3', applied_count: 4, success_count: 3 }),
      makeLearning({ id: 'e-4', applied_count: 6, success_count: 3 }),
    ]);
    const result = getLearningEffectiveness(tmpDir);
    expect(result.applied).toBe(10);
    expect(result.successRate).toBe(0.6); // 6/10
  });

  it('filters top performers at >=2 applications', () => {
    writeLearningsRaw([
      makeLearning({ id: 'e-5', text: 'Applied once', applied_count: 1, success_count: 1 }),
      makeLearning({ id: 'e-6', text: 'Applied twice', applied_count: 2, success_count: 2 }),
    ]);
    const result = getLearningEffectiveness(tmpDir);
    expect(result.topPerformers).toHaveLength(1);
    expect(result.topPerformers[0].id).toBe('e-6');
    expect(result.topPerformers[0].effectiveness).toBe(1);
  });

  it('sorts top performers by effectiveness descending', () => {
    writeLearningsRaw([
      makeLearning({ id: 'lo', text: 'Low eff', applied_count: 4, success_count: 1 }),
      makeLearning({ id: 'hi', text: 'High eff', applied_count: 4, success_count: 4 }),
      makeLearning({ id: 'mid', text: 'Mid eff', applied_count: 4, success_count: 2 }),
    ]);
    const result = getLearningEffectiveness(tmpDir);
    expect(result.topPerformers).toHaveLength(3);
    expect(result.topPerformers[0].id).toBe('hi');
    expect(result.topPerformers[1].id).toBe('mid');
    expect(result.topPerformers[2].id).toBe('lo');
  });

  it('caps top performers at 5', () => {
    const learnings = Array.from({ length: 8 }, (_, i) =>
      makeLearning({ id: `perf-${i}`, text: `Learning ${i}`, applied_count: 3, success_count: i }),
    );
    writeLearningsRaw(learnings);
    const result = getLearningEffectiveness(tmpDir);
    expect(result.topPerformers).toHaveLength(5);
    // Highest effectiveness first
    expect(result.topPerformers[0].id).toBe('perf-7');
  });
});

// ---------------------------------------------------------------------------
// recordApplication
// ---------------------------------------------------------------------------

describe('recordApplication', () => {
  it('increments applied_count for matching ids', () => {
    writeLearningsRaw([
      makeLearning({ id: 'app-1', applied_count: 0 }),
      makeLearning({ id: 'app-2', applied_count: 2 }),
    ]);

    recordApplication(tmpDir, ['app-1']);

    const persisted = readLearningsRaw();
    expect(persisted.find(l => l.id === 'app-1')!.applied_count).toBe(1);
    expect(persisted.find(l => l.id === 'app-2')!.applied_count).toBe(2);
  });

  it('initializes applied_count from undefined', () => {
    const learning = makeLearning({ id: 'app-3' });
    delete (learning as any).applied_count;
    writeLearningsRaw([learning]);

    recordApplication(tmpDir, ['app-3']);

    const persisted = readLearningsRaw();
    expect(persisted[0].applied_count).toBe(1);
  });

  it('increments multiple ids in one call', () => {
    writeLearningsRaw([
      makeLearning({ id: 'app-4', applied_count: 0 }),
      makeLearning({ id: 'app-5', applied_count: 5 }),
    ]);

    recordApplication(tmpDir, ['app-4', 'app-5']);

    const persisted = readLearningsRaw();
    expect(persisted.find(l => l.id === 'app-4')!.applied_count).toBe(1);
    expect(persisted.find(l => l.id === 'app-5')!.applied_count).toBe(5 + 1);
  });

  it('is a no-op for empty ids', () => {
    writeLearningsRaw([makeLearning({ id: 'app-6', applied_count: 3 })]);
    recordApplication(tmpDir, []);
    expect(readLearningsRaw()[0].applied_count).toBe(3);
  });

  it('ignores ids not present in learnings', () => {
    writeLearningsRaw([makeLearning({ id: 'app-7', applied_count: 1 })]);
    recordApplication(tmpDir, ['no-such-id']);
    expect(readLearningsRaw()[0].applied_count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// consolidateLearnings
// ---------------------------------------------------------------------------

describe('consolidateLearnings', () => {
  it('no-ops when no file exists', () => {
    // Should not throw
    consolidateLearnings(tmpDir);
    expect(readLearningsRaw()).toEqual([]);
  });

  it('no-ops when learnings count is at or below consolidation threshold', () => {
    // CONSOLIDATION_THRESHOLD is 50 — write exactly 50
    const learnings = Array.from({ length: 50 }, (_, i) =>
      makeLearning({ id: `c-${i}`, text: `Unique learning number ${i} about a distinct topic` }),
    );
    writeLearningsRaw(learnings);

    consolidateLearnings(tmpDir);

    // Should remain unchanged (core returns null when <= threshold)
    expect(readLearningsRaw()).toHaveLength(50);
  });

  it('merges near-duplicate learnings when above threshold', () => {
    // Need >50 learnings, with some duplicates sharing same category and source type.
    // Each padding entry gets a unique category so they can NEVER merge with each other
    // (coreConsolidate guards: same category required for merge).
    const learnings: Learning[] = [];
    // Two entries with identical text → should merge
    learnings.push(makeLearning({
      id: 'dup-0',
      text: 'Always check null before accessing property',
      category: 'gotcha',
      source: { type: 'qa_failure' },
      weight: 30,
      access_count: 0,
    }));
    learnings.push(makeLearning({
      id: 'dup-1',
      text: 'Always check null before accessing property',
      category: 'gotcha',
      source: { type: 'qa_failure' },
      weight: 60,
      access_count: 0,
    }));
    // 49 padding entries with unique categories (prevents any cross-merge)
    for (let i = 0; i < 49; i++) {
      learnings.push(makeLearning({
        id: `pad-${i}`,
        text: `Padding entry number ${i}`,
        category: `unique-cat-${i}`,
        source: { type: 'manual' },
        weight: 40,
        access_count: 0,
      }));
    }
    writeLearningsRaw(learnings);

    consolidateLearnings(tmpDir);

    const persisted = readLearningsRaw();
    // The two identical entries should have been merged into one
    expect(persisted.length).toBeLessThan(51);
  });

  it('keeps higher weight entry text on merge', () => {
    const learnings: Learning[] = [];
    // Two near-identical entries with different weights
    learnings.push(makeLearning({
      id: 'merge-lo',
      text: 'Always validate input parameters before processing',
      weight: 20,
      category: 'gotcha',
      source: { type: 'qa_failure' },
      access_count: 0,
    }));
    learnings.push(makeLearning({
      id: 'merge-hi',
      text: 'Always validate input parameters before processing them',
      weight: 80,
      category: 'gotcha',
      source: { type: 'qa_failure' },
      access_count: 0,
    }));
    // Padding with unique categories
    for (let i = 0; i < 50; i++) {
      learnings.push(makeLearning({
        id: `pad-${i}`,
        text: `Padding entry number ${i}`,
        category: `unique-cat-${i}`,
        source: { type: 'manual' },
        weight: 40,
        access_count: 0,
      }));
    }
    writeLearningsRaw(learnings);

    consolidateLearnings(tmpDir);

    const persisted = readLearningsRaw();
    // The merged entry should keep the higher-weight text
    const merged = persisted.find(l => l.text.includes('Always validate input'));
    expect(merged).toBeDefined();
    expect(merged!.weight).toBe(80);
  });

  it('sums access_count on merge', () => {
    const learnings: Learning[] = [];
    learnings.push(makeLearning({
      id: 'acc-a',
      text: 'Check return values from async calls',
      weight: 50,
      category: 'gotcha',
      source: { type: 'qa_failure' },
      access_count: 2,
    }));
    learnings.push(makeLearning({
      id: 'acc-b',
      text: 'Check return values from async calls carefully',
      weight: 40,
      category: 'gotcha',
      source: { type: 'qa_failure' },
      access_count: 1,
    }));
    // Padding with unique categories
    for (let i = 0; i < 50; i++) {
      learnings.push(makeLearning({
        id: `pad2-${i}`,
        text: `Padding entry number ${i}`,
        category: `unique-cat-${i}`,
        source: { type: 'manual' },
        weight: 40,
        access_count: 0,
      }));
    }
    writeLearningsRaw(learnings);

    consolidateLearnings(tmpDir);

    const persisted = readLearningsRaw();
    const merged = persisted.find(l => l.text.includes('Check return values'));
    expect(merged).toBeDefined();
    expect(merged!.access_count).toBe(3); // 2 + 1
  });

  it('does not merge across different categories', () => {
    const words = [
      'alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel',
      'india', 'juliet', 'kilo', 'lima', 'mike', 'november', 'oscar', 'papa',
      'quebec', 'romeo', 'sierra', 'tango', 'uniform', 'victor', 'whiskey',
      'xray', 'yankee', 'zulu', 'fizz', 'buzz', 'quux', 'corge', 'grault',
      'garply', 'waldo', 'fred', 'plugh', 'thud', 'baz', 'qux', 'norf',
      'flob', 'zap', 'wham', 'blip', 'zing', 'snap', 'crisp', 'drift',
      'forge', 'gleam',
    ];
    const learnings: Learning[] = [];
    learnings.push(makeLearning({
      id: 'cat-a',
      text: 'Always check null before accessing property',
      weight: 50,
      category: 'gotcha',
      source: { type: 'qa_failure' },
      access_count: 0,
    }));
    learnings.push(makeLearning({
      id: 'cat-b',
      text: 'Always check null before accessing property',
      weight: 50,
      category: 'pattern',  // Different category
      source: { type: 'qa_failure' },
      access_count: 0,
    }));
    // Dissimilar padding
    for (let i = 0; i < 50; i++) {
      learnings.push(makeLearning({
        id: `cat-pad-${i}`,
        text: `${words[i % words.length]} integration requires special ${words[(i + 7) % words.length]} handling`,
        category: 'warning',
        source: { type: 'manual' },
        weight: 40,
        access_count: 0,
      }));
    }
    writeLearningsRaw(learnings);

    consolidateLearnings(tmpDir);

    const persisted = readLearningsRaw();
    // Both should still exist separately since they have different categories
    const matchingNullCheck = persisted.filter(l => l.text.includes('Always check null'));
    expect(matchingNullCheck.length).toBe(2);
  });
});
