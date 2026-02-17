import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  buildTasteProfile,
  loadTasteProfile,
  saveTasteProfile,
  formatTasteForPrompt,
  type TasteProfile,
} from '../lib/taste-profile.js';
import type { SectorState, Sector } from '@promptwheel/core/sectors/shared';
import type { Learning } from '@promptwheel/core/learnings/shared';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

function makeSector(overrides: Partial<Sector> = {}): Sector {
  return {
    path: 'src/lib',
    purpose: 'library',
    production: true,
    fileCount: 10,
    productionFileCount: 8,
    classificationConfidence: 'high',
    lastScannedAt: 0,
    lastScannedCycle: 0,
    scanCount: 0,
    proposalYield: 0,
    successCount: 0,
    failureCount: 0,
    ...overrides,
  };
}

function makeLearning(overrides: Partial<Learning> = {}): Learning {
  return {
    id: 'l1',
    text: 'Some learning text',
    category: 'pattern',
    source: { type: 'ticket_success' },
    tags: [],
    weight: 50,
    created_at: new Date().toISOString(),
    last_confirmed_at: new Date().toISOString(),
    access_count: 0,
    ...overrides,
  };
}

function makeSectorState(sectors: Sector[]): SectorState {
  return { version: 2, builtAt: new Date().toISOString(), sectors };
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taste-profile-test-'));
  fs.mkdirSync(path.join(tmpDir, '.promptwheel'), { recursive: true });
});

afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// buildTasteProfile — category aggregation
// ---------------------------------------------------------------------------

describe('buildTasteProfile', () => {
  it('marks categories with >60% success rate as preferred', () => {
    const sectors = [makeSector({
      categoryStats: {
        test: { success: 8, failure: 1 },  // 89% — preferred
      },
    })];
    const profile = buildTasteProfile(makeSectorState(sectors), [], {});
    expect(profile.preferredCategories).toContain('test');
    expect(profile.avoidCategories).not.toContain('test');
  });

  it('marks categories with <30% success rate as avoid', () => {
    const sectors = [makeSector({
      categoryStats: {
        refactor: { success: 1, failure: 8 },  // 11% — avoid
      },
    })];
    const profile = buildTasteProfile(makeSectorState(sectors), [], {});
    expect(profile.avoidCategories).toContain('refactor');
    expect(profile.preferredCategories).not.toContain('refactor');
  });

  it('ignores categories with fewer than 3 total attempts', () => {
    const sectors = [makeSector({
      categoryStats: {
        security: { success: 2, failure: 0 },  // 100% but only 2 attempts
      },
    })];
    const profile = buildTasteProfile(makeSectorState(sectors), [], {});
    expect(profile.preferredCategories).not.toContain('security');
    expect(profile.avoidCategories).not.toContain('security');
  });

  it('aggregates category stats across multiple sectors', () => {
    const sectors = [
      makeSector({ path: 'src/a', categoryStats: { fix: { success: 3, failure: 0 } } }),
      makeSector({ path: 'src/b', categoryStats: { fix: { success: 2, failure: 0 } } }),
    ];
    // 5/5 = 100% — preferred
    const profile = buildTasteProfile(makeSectorState(sectors), [], {});
    expect(profile.preferredCategories).toContain('fix');
  });

  it('applies volume boost for high-volume categories', () => {
    // rate = 0.55 (below 0.6), but with 10 attempts and rate > 0.5 → +0.1 boost → 0.65 → preferred
    const sectors = [makeSector({
      categoryStats: {
        perf: { success: 6, failure: 5 },  // rate 0.545, total 11 → volume boost
      },
    })];
    const profile = buildTasteProfile(makeSectorState(sectors), [], {});
    expect(profile.preferredCategories).toContain('perf');
  });

  // ---------------------------------------------------------------------------
  // Complexity heuristic
  // ---------------------------------------------------------------------------

  it('prefers trivial when short ticket_success learnings dominate', () => {
    const learnings = [
      makeLearning({ text: 'short title', source: { type: 'ticket_success' } }),
      makeLearning({ text: 'also short', source: { type: 'ticket_success' } }),
      makeLearning({ text: 'tiny', source: { type: 'ticket_success' } }),
    ];
    const profile = buildTasteProfile(makeSectorState([]), learnings, {});
    expect(profile.preferredComplexity).toBe('trivial');
  });

  it('prefers simple when medium-length ticket_success learnings dominate', () => {
    const medium = 'A moderately long learning text that is between forty and eighty chars long yes';
    const learnings = [
      makeLearning({ text: medium, source: { type: 'ticket_success' } }),
      makeLearning({ text: medium, source: { type: 'ticket_success' } }),
      makeLearning({ text: 'short', source: { type: 'ticket_success' } }),
    ];
    const profile = buildTasteProfile(makeSectorState([]), learnings, {});
    expect(profile.preferredComplexity).toBe('simple');
  });

  it('prefers moderate when long ticket_success learnings dominate', () => {
    const long = 'A very long learning text that is definitely over eighty characters long because it describes a complex architectural change in great detail';
    const learnings = [
      makeLearning({ text: long, source: { type: 'ticket_success' } }),
      makeLearning({ text: long, source: { type: 'ticket_success' } }),
      makeLearning({ text: 'short', source: { type: 'ticket_success' } }),
    ];
    const profile = buildTasteProfile(makeSectorState([]), learnings, {});
    expect(profile.preferredComplexity).toBe('moderate');
  });

  it('ignores non-ticket_success learnings for complexity', () => {
    const long = 'A very long learning text that is definitely over eighty characters long because it describes a complex architectural change in great detail';
    const learnings = [
      makeLearning({ text: long, source: { type: 'qa_failure' } }),
      makeLearning({ text: long, source: { type: 'ticket_failure' } }),
    ];
    const profile = buildTasteProfile(makeSectorState([]), learnings, {});
    // No ticket_success → all counts 0, simple >= trivial (0 >= 0) is true → 'simple'
    expect(profile.preferredComplexity).toBe('simple');
  });

  // ---------------------------------------------------------------------------
  // Style notes extraction
  // ---------------------------------------------------------------------------

  it('extracts top 5 reviewer_feedback learnings sorted by weight', () => {
    const learnings = Array.from({ length: 8 }, (_, i) =>
      makeLearning({
        id: `l${i}`,
        text: `Style note ${i}`,
        source: { type: 'reviewer_feedback' },
        weight: 30 + i * 10, // 30, 40, 50, 60, 70, 80, 90, 100
      })
    );
    const profile = buildTasteProfile(makeSectorState([]), learnings, {});
    expect(profile.styleNotes).toHaveLength(5);
    // Should be sorted by weight descending → notes 7,6,5,4,3
    expect(profile.styleNotes[0]).toBe('Style note 7');
    expect(profile.styleNotes[4]).toBe('Style note 3');
  });

  it('excludes reviewer_feedback with weight <= 20', () => {
    const learnings = [
      makeLearning({ text: 'Low weight', source: { type: 'reviewer_feedback' }, weight: 15 }),
      makeLearning({ text: 'Also low', source: { type: 'reviewer_feedback' }, weight: 20 }),
    ];
    const profile = buildTasteProfile(makeSectorState([]), learnings, {});
    expect(profile.styleNotes).toHaveLength(0);
  });

  it('returns empty styleNotes when no reviewer_feedback exists', () => {
    const learnings = [
      makeLearning({ source: { type: 'ticket_success' } }),
    ];
    const profile = buildTasteProfile(makeSectorState([]), learnings, {});
    expect(profile.styleNotes).toEqual([]);
  });

  it('sets updatedAt to current time', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-06-01T00:00:00Z'));

    const profile = buildTasteProfile(makeSectorState([]), [], {});
    expect(profile.updatedAt).toBe(new Date('2025-06-01T00:00:00Z').getTime());
  });
});

// ---------------------------------------------------------------------------
// loadTasteProfile / saveTasteProfile
// ---------------------------------------------------------------------------

describe('loadTasteProfile / saveTasteProfile', () => {
  it('returns null when file does not exist', () => {
    expect(loadTasteProfile(tmpDir)).toBeNull();
  });

  it('round-trips through save and load', () => {
    const profile: TasteProfile = {
      preferredCategories: ['test', 'fix'],
      avoidCategories: ['refactor'],
      preferredComplexity: 'simple',
      styleNotes: ['Keep changes small'],
      updatedAt: 1700000000000,
    };

    saveTasteProfile(tmpDir, profile);
    const loaded = loadTasteProfile(tmpDir);
    expect(loaded).toEqual(profile);
  });

  it('creates .promptwheel directory if missing', () => {
    const freshDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taste-fresh-'));
    // No .promptwheel directory yet
    const profile: TasteProfile = {
      preferredCategories: [],
      avoidCategories: [],
      preferredComplexity: 'trivial',
      styleNotes: [],
      updatedAt: 0,
    };
    saveTasteProfile(freshDir, profile);
    expect(loadTasteProfile(freshDir)).toEqual(profile);
    fs.rmSync(freshDir, { recursive: true, force: true });
  });

  it('returns null for corrupted JSON', () => {
    const fp = path.join(tmpDir, '.promptwheel', 'taste-profile.json');
    fs.writeFileSync(fp, 'not valid json');
    expect(loadTasteProfile(tmpDir)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// formatTasteForPrompt
// ---------------------------------------------------------------------------

describe('formatTasteForPrompt', () => {
  it('includes preferred categories', () => {
    const profile: TasteProfile = {
      preferredCategories: ['test', 'fix'],
      avoidCategories: [],
      preferredComplexity: 'simple',
      styleNotes: [],
      updatedAt: 0,
    };
    const output = formatTasteForPrompt(profile);
    expect(output).toContain('<project-taste>');
    expect(output).toContain('</project-taste>');
    expect(output).toContain('responds well to: test, fix');
  });

  it('includes avoid categories', () => {
    const profile: TasteProfile = {
      preferredCategories: [],
      avoidCategories: ['refactor'],
      preferredComplexity: 'simple',
      styleNotes: [],
      updatedAt: 0,
    };
    const output = formatTasteForPrompt(profile);
    expect(output).toContain('Avoid: refactor');
  });

  it('includes preferred complexity', () => {
    const profile: TasteProfile = {
      preferredCategories: [],
      avoidCategories: [],
      preferredComplexity: 'moderate',
      styleNotes: [],
      updatedAt: 0,
    };
    const output = formatTasteForPrompt(profile);
    expect(output).toContain('Preferred complexity: moderate');
  });

  it('includes style notes', () => {
    const profile: TasteProfile = {
      preferredCategories: [],
      avoidCategories: [],
      preferredComplexity: 'simple',
      styleNotes: ['Keep PRs small', 'Add tests first'],
      updatedAt: 0,
    };
    const output = formatTasteForPrompt(profile);
    expect(output).toContain('Style notes from reviewers:');
    expect(output).toContain('- Keep PRs small');
    expect(output).toContain('- Add tests first');
  });

  it('omits sections with empty arrays', () => {
    const profile: TasteProfile = {
      preferredCategories: [],
      avoidCategories: [],
      preferredComplexity: 'trivial',
      styleNotes: [],
      updatedAt: 0,
    };
    const output = formatTasteForPrompt(profile);
    expect(output).not.toContain('responds well to');
    expect(output).not.toContain('Avoid');
    expect(output).not.toContain('Style notes');
    expect(output).toContain('Preferred complexity: trivial');
  });
});
