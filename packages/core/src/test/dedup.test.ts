/**
 * Dedup algorithm tests — ported from archived scripts:
 *   - scripts/archive/test-word-similarity.ts
 *   - scripts/archive/test-word-similarity-04.ts
 *   - scripts/archive/test-dedup.ts
 *
 * Tests pure functions only (no database, no filesystem).
 */

import { describe, it, expect } from 'vitest';
import {
  normalizeTitle,
  titleSimilarity,
  bigramSimilarity,
  isDuplicate,
  applyDecay,
  matchAgainstMemory,
  recordEntry,
  recordEntries,
  formatDedupForPrompt,
  DEDUP_DEFAULTS,
  type DedupEntry,
} from '../dedup/shared.js';

// ---------------------------------------------------------------------------
// normalizeTitle
// ---------------------------------------------------------------------------

describe('normalizeTitle', () => {
  it('lowercases and removes punctuation', () => {
    expect(normalizeTitle('Fix Login-Bug!')).toBe('fix login bug');
  });

  it('collapses whitespace', () => {
    expect(normalizeTitle('  hello   world  ')).toBe('hello world');
  });

  it('handles empty string', () => {
    expect(normalizeTitle('')).toBe('');
  });

  it('preserves underscored words', () => {
    expect(normalizeTitle('fix_the_bug')).toBe('fix_the_bug');
  });
});

// ---------------------------------------------------------------------------
// titleSimilarity (word overlap — from test-word-similarity.ts)
// ---------------------------------------------------------------------------

describe('titleSimilarity', () => {
  // Test pairs from archived test-word-similarity.ts
  // Note: word-overlap Jaccard has varying sensitivity depending on shared word count.
  // The original archived tests used a different DB-level similarity function.
  // Here we verify all pairs produce non-zero similarity (semantically related).
  const pairs: [string, string, number][] = [
    ['Extract duplicated PR row mapping to helper function', 'Extract PR row-to-object mapping helper', 0.15],
    ['Extract SqlConditionBuilder to shared utility module', 'Extract SqlConditionBuilder for reuse across API routes', 0.15],
    ['Extract duplicate authentication and access control logic', 'Extract Duplicated Authentication Helper', 0.15],
    ['Extract client query binding helper pattern', 'Extract common query function binding pattern', 0.15],
    ['Extract duplicated plan statistics SQL to a reusable fragment', 'Extract plan statistics calculation helper', 0.15],
  ];

  for (const [a, b, minSim] of pairs) {
    it(`"${a.slice(0, 40)}..." vs "${b.slice(0, 40)}..." → nonzero similarity`, () => {
      const sim = titleSimilarity(a, b);
      expect(sim).toBeGreaterThanOrEqual(minSim);
      // Always between 0 and 1
      expect(sim).toBeGreaterThanOrEqual(0);
      expect(sim).toBeLessThanOrEqual(1);
    });
  }

  it('identical titles → 1.0', () => {
    expect(titleSimilarity('Fix the login bug', 'Fix the login bug')).toBe(1);
  });

  it('completely different → low score', () => {
    const sim = titleSimilarity('Fix authentication', 'Refactor database schema');
    expect(sim).toBeLessThan(0.3);
  });

  it('empty strings → 0', () => {
    expect(titleSimilarity('', '')).toBe(0);
    expect(titleSimilarity('hello', '')).toBe(0);
  });

  it('short words are filtered out', () => {
    // "a" and "is" are <= 2 chars, so they're filtered
    const sim = titleSimilarity('a is', 'a is');
    expect(sim).toBe(0); // All words filtered
  });
});

// ---------------------------------------------------------------------------
// titleSimilarity threshold tests (from test-word-similarity-04.ts)
// ---------------------------------------------------------------------------

describe('titleSimilarity vs bigramSimilarity', () => {
  // These pairs are semantically similar but use different phrasing.
  // bigramSimilarity (character-level) is more resilient to word reordering.
  const pairs: [string, string][] = [
    ['Extract duplicated PR row mapping to helper function', 'Extract PR row-to-object mapping helper'],
    ['Extract SqlConditionBuilder to shared utility module', 'Extract SqlConditionBuilder for reuse across API routes'],
    ['Extract duplicate authentication and access control logic', 'Extract Duplicated Authentication Helper'],
    ['Extract client query binding helper pattern', 'Extract common query function binding pattern'],
    ['Extract duplicated plan statistics SQL to a reusable fragment', 'Extract plan statistics calculation helper'],
  ];

  for (const [a, b] of pairs) {
    it(`bigramSimilarity captures "${a.slice(0, 30)}..."`, () => {
      const wordSim = titleSimilarity(a, b);
      const bSim = bigramSimilarity(a, b);
      // Both should produce non-zero similarity for related titles
      expect(wordSim).toBeGreaterThan(0);
      expect(bSim).toBeGreaterThan(0);
      // Bigram is generally more sensitive
      expect(bSim).toBeGreaterThanOrEqual(0.3);
    });
  }
});

// ---------------------------------------------------------------------------
// bigramSimilarity
// ---------------------------------------------------------------------------

describe('bigramSimilarity', () => {
  it('identical strings → 1.0', () => {
    expect(bigramSimilarity('hello world', 'hello world')).toBe(1);
  });

  it('empty strings → 1.0', () => {
    expect(bigramSimilarity('', '')).toBe(1);
  });

  it('one empty → 0', () => {
    expect(bigramSimilarity('hello', '')).toBe(0);
  });

  it('similar strings → high score', () => {
    const sim = bigramSimilarity(
      'Extract duplicated PR mapping',
      'Extract PR row-to-object mapping',
    );
    expect(sim).toBeGreaterThan(0.3);
  });

  it('different strings → low score', () => {
    const sim = bigramSimilarity('authentication fix', 'database schema refactor');
    expect(sim).toBeLessThan(0.3);
  });
});

// ---------------------------------------------------------------------------
// isDuplicate (from test-dedup.ts concepts)
// ---------------------------------------------------------------------------

describe('isDuplicate', () => {
  const existing = [
    'Test duplicate detection (Part 1/2)',
    'Fix login validation error',
    'Refactor database connection pooling',
  ];

  it('detects exact match', () => {
    const result = isDuplicate('Test duplicate detection (Part 1/2)', existing);
    expect(result.isDuplicate).toBe(true);
    expect(result.reason).toContain('Exact match');
  });

  it('detects case-insensitive exact match', () => {
    const result = isDuplicate('test duplicate detection (part 1/2)', existing);
    expect(result.isDuplicate).toBe(true);
    expect(result.reason).toContain('Exact match');
  });

  it('detects similar title', () => {
    const result = isDuplicate('Test duplicate detection (Part 2/2)', existing, 0.5);
    expect(result.isDuplicate).toBe(true);
    expect(result.reason).toContain('Similar');
  });

  it('no match for unrelated title', () => {
    const result = isDuplicate('Some completely new task', existing);
    expect(result.isDuplicate).toBe(false);
  });

  it('respects custom threshold', () => {
    // High threshold = less matching
    const strict = isDuplicate('Test duplicate detection variant', existing, 0.99);
    expect(strict.isDuplicate).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// applyDecay
// ---------------------------------------------------------------------------

describe('applyDecay', () => {
  function makeEntry(overrides: Partial<DedupEntry> = {}): DedupEntry {
    return {
      title: 'Test entry',
      weight: 60,
      created_at: new Date().toISOString(),
      last_seen_at: new Date().toISOString(),
      hit_count: 1,
      completed: false,
      ...overrides,
    };
  }

  it('reduces weight by decay rate', () => {
    const entries = [makeEntry({ weight: 60 })];
    const result = applyDecay(entries, 5, Date.now());
    expect(result).toHaveLength(1);
    expect(result[0].weight).toBeLessThan(60);
  });

  it('removes entries with weight <= 0', () => {
    // Use old last_seen_at and not completed to avoid decay halving
    const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    const entries = [makeEntry({ weight: 3, last_seen_at: old, completed: false })];
    const result = applyDecay(entries, 5, Date.now());
    expect(result).toHaveLength(0);
  });

  it('completed entries decay slower', () => {
    const now = Date.now();
    const old = new Date(now - 10 * 24 * 60 * 60 * 1000).toISOString(); // 10 days ago

    const normalEntry = makeEntry({ weight: 60, completed: false, last_seen_at: old });
    const completedEntry = makeEntry({ weight: 60, completed: true, last_seen_at: old });

    const [normal] = applyDecay([normalEntry], 5, now);
    const [completed] = applyDecay([completedEntry], 5, now);

    // Completed should have higher weight (less decay)
    expect(completed.weight).toBeGreaterThan(normal.weight);
  });

  it('recently seen entries decay slower', () => {
    const now = Date.now();
    const recent = new Date(now - 1 * 24 * 60 * 60 * 1000).toISOString(); // 1 day ago
    const old = new Date(now - 10 * 24 * 60 * 60 * 1000).toISOString(); // 10 days ago

    const recentEntry = makeEntry({ weight: 60, last_seen_at: recent });
    const oldEntry = makeEntry({ weight: 60, last_seen_at: old });

    const [recentResult] = applyDecay([recentEntry], 5, now);
    const [oldResult] = applyDecay([oldEntry], 5, now);

    expect(recentResult.weight).toBeGreaterThan(oldResult.weight);
  });
});

// ---------------------------------------------------------------------------
// matchAgainstMemory
// ---------------------------------------------------------------------------

describe('matchAgainstMemory', () => {
  const memory: DedupEntry[] = [
    {
      title: 'Fix authentication bug',
      weight: 80,
      created_at: '2025-01-01',
      last_seen_at: '2025-01-01',
      hit_count: 3,
      completed: true,
    },
    {
      title: 'Refactor database layer',
      weight: 50,
      created_at: '2025-01-01',
      last_seen_at: '2025-01-01',
      hit_count: 1,
      completed: false,
    },
  ];

  it('finds exact match', () => {
    const match = matchAgainstMemory('Fix authentication bug', memory);
    expect(match).not.toBeNull();
    expect(match!.similarity).toBe(1.0);
    expect(match!.entry.title).toBe('Fix authentication bug');
  });

  it('finds similar match above threshold', () => {
    const match = matchAgainstMemory('Fix auth bug in login', memory, 0.3);
    expect(match).not.toBeNull();
  });

  it('returns null for unrelated title', () => {
    const match = matchAgainstMemory('Add new API endpoint', memory);
    expect(match).toBeNull();
  });

  it('catches word-reordering via bigramSimilarity fallback', () => {
    // "Fix auth token refresh" vs "Refresh auth token fix" share all the same
    // words so titleSimilarity is 1.0.  But with *partial* word overlap —
    // e.g., "authentication" vs "authenticator" — word-Jaccard scores low
    // because the full words differ, while bigrams overlap heavily.
    const memoryWithPartial: DedupEntry[] = [
      {
        title: 'Fix authentication handler',
        weight: 70,
        created_at: '2025-01-01',
        last_seen_at: '2025-01-01',
        hit_count: 1,
        completed: false,
      },
    ];

    const query = 'Fix authenticator handling';

    // Word-Jaccard should be below the default threshold (0.6)
    // because "authentication" !== "authenticator" and "handler" !== "handling"
    const wordSim = titleSimilarity(query, memoryWithPartial[0].title);
    expect(wordSim).toBeLessThan(DEDUP_DEFAULTS.SIMILARITY_THRESHOLD);

    // Bigram similarity should be higher due to shared character bigrams
    const bSim = bigramSimilarity(query, memoryWithPartial[0].title);
    expect(bSim).toBeGreaterThanOrEqual(DEDUP_DEFAULTS.SIMILARITY_THRESHOLD);

    // matchAgainstMemory should find the match via bigramSimilarity fallback
    const match = matchAgainstMemory(query, memoryWithPartial);
    expect(match).not.toBeNull();
    expect(match!.entry.title).toBe('Fix authentication handler');
  });
});

// ---------------------------------------------------------------------------
// recordEntry / recordEntries
// ---------------------------------------------------------------------------

describe('recordEntry', () => {
  it('adds new entry', () => {
    const entries: DedupEntry[] = [];
    recordEntry(entries, 'New task', false);
    expect(entries).toHaveLength(1);
    expect(entries[0].title).toBe('New task');
    expect(entries[0].weight).toBe(DEDUP_DEFAULTS.DEFAULT_WEIGHT);
    expect(entries[0].completed).toBe(false);
  });

  it('bumps existing entry', () => {
    const entries: DedupEntry[] = [{
      title: 'Existing task',
      weight: 60,
      created_at: '2025-01-01',
      last_seen_at: '2025-01-01',
      hit_count: 1,
      completed: false,
    }];
    recordEntry(entries, 'existing task', true);
    expect(entries).toHaveLength(1);
    expect(entries[0].weight).toBe(60 + DEDUP_DEFAULTS.BUMP_AMOUNT);
    expect(entries[0].hit_count).toBe(2);
    expect(entries[0].completed).toBe(true);
  });

  it('completed entries start heavier', () => {
    const entries: DedupEntry[] = [];
    recordEntry(entries, 'Completed work', true);
    expect(entries[0].weight).toBe(DEDUP_DEFAULTS.COMPLETED_WEIGHT);
  });
});

describe('recordEntries', () => {
  it('batch-records multiple titles', () => {
    const entries: DedupEntry[] = [];
    recordEntries(entries, [
      { title: 'Task A', completed: true },
      { title: 'Task B', completed: false },
      { title: 'Task A', completed: false }, // duplicate within batch
    ]);
    expect(entries).toHaveLength(2);
    // Task A should be bumped
    const taskA = entries.find(e => e.title === 'Task A')!;
    expect(taskA.hit_count).toBe(2);
    expect(taskA.completed).toBe(true); // stays true once set
  });
});

// ---------------------------------------------------------------------------
// formatDedupForPrompt
// ---------------------------------------------------------------------------

describe('formatDedupForPrompt', () => {
  it('returns empty string for no entries', () => {
    expect(formatDedupForPrompt([])).toBe('');
  });

  it('includes XML tags', () => {
    const entries: DedupEntry[] = [{
      title: 'Fix tests',
      weight: 80,
      created_at: '2025-01-01',
      last_seen_at: '2025-01-01',
      hit_count: 2,
      completed: true,
    }];
    const result = formatDedupForPrompt(entries);
    expect(result).toContain('<already-completed>');
    expect(result).toContain('</already-completed>');
    expect(result).toContain('Fix tests');
    expect(result).toContain('✓ done');
  });

  it('sorts by weight descending', () => {
    const entries: DedupEntry[] = [
      { title: 'Low weight', weight: 20, created_at: '', last_seen_at: '', hit_count: 1, completed: false },
      { title: 'High weight', weight: 90, created_at: '', last_seen_at: '', hit_count: 1, completed: true },
    ];
    const result = formatDedupForPrompt(entries);
    const highIdx = result.indexOf('High weight');
    const lowIdx = result.indexOf('Low weight');
    expect(highIdx).toBeLessThan(lowIdx);
  });

  it('respects budget', () => {
    const entries: DedupEntry[] = Array.from({ length: 100 }, (_, i) => ({
      title: `Entry ${i} with a reasonably long title to consume budget quickly`,
      weight: 100 - i,
      created_at: '',
      last_seen_at: '',
      hit_count: 1,
      completed: false,
    }));
    const result = formatDedupForPrompt(entries, 500);
    expect(result.length).toBeLessThanOrEqual(500);
  });

  it('returns empty when budget too small for any entry', () => {
    const entries: DedupEntry[] = [{
      title: 'Some title',
      weight: 80,
      created_at: '',
      last_seen_at: '',
      hit_count: 1,
      completed: false,
    }];
    // Budget so small even the header doesn't fit an entry
    const result = formatDedupForPrompt(entries, 10);
    expect(result).toBe('');
  });
});
