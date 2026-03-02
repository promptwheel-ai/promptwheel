import { describe, expect, it } from 'vitest';
import {
  AFFINITY_MIN_ATTEMPTS,
  EMA_OLD_WEIGHT,
  OUTCOME_DECAY_FACTOR,
  OUTCOME_DECAY_INTERVAL,
  POLISHED_YIELD_THRESHOLD,
  formatSectorDependencyContext,
  getSectorCategoryAffinity,
  pickNextSector,
  propagateStaleness,
  recordScanResult,
  recordTicketOutcome,
  suggestScopeAdjustment,
} from '../sectors/shared.js';
import type { Sector, SectorState } from '../sectors/shared.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const FIXED_NOW = Date.UTC(2025, 0, 15, 12, 0, 0);
const FIXED_CYCLE = 42;

function makeSector(overrides: Partial<Sector> = {}): Sector {
  return {
    path: 'src/default',
    purpose: 'default',
    production: true,
    fileCount: 10,
    productionFileCount: 10,
    classificationConfidence: 'high',
    lastScannedAt: FIXED_NOW - DAY_MS,
    lastScannedCycle: FIXED_CYCLE - 2,
    scanCount: 1,
    proposalYield: 1,
    successCount: 0,
    failureCount: 0,
    ...overrides,
  };
}

function makeState(sectors: Sector[]): SectorState {
  return {
    version: 2,
    builtAt: '2025-01-15T12:00:00.000Z',
    sectors,
  };
}

function pickPathsInOrder(state: SectorState): string[] {
  const paths: string[] = [];
  while (true) {
    const next = pickNextSector(state, FIXED_CYCLE, FIXED_NOW);
    if (!next) break;
    paths.push(next.sector.path);
    state.sectors = state.sectors.filter(s => s.path !== next.sector.path);
  }
  return paths;
}

describe('pickNextSector deterministic priority order', () => {
  it('orders sectors by never-scanned, hub/dead-export tie-breakers, high-failure, barren, then polished', () => {
    const polished = makeSector({
      path: 'f-polished',
      scanCount: 6,
      proposalYield: 0.1,
      successCount: 0,
      failureCount: 0,
    });

    const state = makeState([
      makeSector({
        path: 'a-never-scanned',
        lastScannedAt: 0,
        lastScannedCycle: 0,
        scanCount: 0,
        proposalYield: 0,
      }),
      makeSector({
        path: 'b-hub-dead-high',
        isHub: true,
        deadExportCount: 8,
        proposalYield: 1.1,
      }),
      makeSector({
        path: 'c-hub-dead-low',
        isHub: true,
        deadExportCount: 2,
        proposalYield: 1.1,
      }),
      makeSector({
        path: 'd-high-failure',
        successCount: 1,
        failureCount: 3,
        proposalYield: 1.1,
      }),
      makeSector({
        path: 'e-barren',
        scanCount: 4,
        proposalYield: 0.2,
        successCount: 4,
        failureCount: 0,
      }),
      polished,
    ]);

    expect(pickPathsInOrder(state)).toEqual([
      'a-never-scanned',
      'b-hub-dead-high',
      'c-hub-dead-low',
      'd-high-failure',
      'e-barren',
      'f-polished',
    ]);
    expect(polished.polishedAt).toBe(FIXED_NOW);
  });

  it('uses fixed timestamps for temporal decay tie-breaks', () => {
    const state = makeState([
      makeSector({
        path: 'older',
        lastScannedAt: FIXED_NOW - 12 * DAY_MS,
        lastScannedCycle: 10,
      }),
      makeSector({
        path: 'newer',
        lastScannedAt: FIXED_NOW - 9 * DAY_MS,
        lastScannedCycle: 10,
      }),
    ]);

    const next = pickNextSector(state, FIXED_CYCLE, FIXED_NOW);
    expect(next?.sector.path).toBe('older');
  });
});

describe('polished detection ignores success rate', () => {
  it('marks sector as polished when yield is low despite high success rate', () => {
    // Dashboard-like sector: 25 scans, yield 0.09, 19 successes, 0 failures
    const exhausted = makeSector({
      path: 'cloud/app/(dashboard)',
      scanCount: 25,
      proposalYield: 0.09,
      successCount: 19,
      failureCount: 0,
    });
    const fresh = makeSector({
      path: 'src/api',
      scanCount: 2,
      proposalYield: 1.5,
      successCount: 1,
      failureCount: 0,
    });

    const state = makeState([exhausted, fresh]);
    const order = pickPathsInOrder(state);

    // Fresh sector should come first; exhausted sector should be polished and sort last
    expect(order).toEqual(['src/api', 'cloud/app/(dashboard)']);
    expect(exhausted.polishedAt).toBe(FIXED_NOW);
  });

  it('does not mark sector as polished when yield is above threshold', () => {
    const active = makeSector({
      path: 'src/active',
      scanCount: 10,
      proposalYield: 0.5, // at threshold, not below
      successCount: 8,
      failureCount: 0,
    });

    const state = makeState([active]);
    pickNextSector(state, FIXED_CYCLE, FIXED_NOW);
    expect(active.polishedAt).toBeFalsy();
  });
});

describe('recordScanResult deterministic updates', () => {
  it('applies EMA and scan metadata with explicit timestamp/cycle', () => {
    const state = makeState([
      makeSector({
        path: 'src/scan',
        proposalYield: 2,
        scanCount: 5,
      }),
    ]);

    recordScanResult(state, 'src/scan', 50, 6, undefined, FIXED_NOW);
    const sector = state.sectors[0];

    expect(sector.lastScannedAt).toBe(FIXED_NOW);
    expect(sector.lastScannedCycle).toBe(50);
    expect(sector.scanCount).toBe(6);
    expect(sector.proposalYield).toBeCloseTo(EMA_OLD_WEIGHT * 2 + (1 - EMA_OLD_WEIGHT) * 6);
  });

  it('applies reclassification only for medium/high confidence', () => {
    const state = makeState([
      makeSector({
        path: 'src/reclass',
        production: true,
        classificationConfidence: 'high',
      }),
    ]);

    recordScanResult(
      state,
      'src/reclass',
      FIXED_CYCLE,
      0,
      { production: false, confidence: 'low' },
      FIXED_NOW,
    );
    expect(state.sectors[0].production).toBe(true);
    expect(state.sectors[0].classificationConfidence).toBe('high');

    recordScanResult(
      state,
      'src/reclass',
      FIXED_CYCLE + 1,
      0,
      { production: false, confidence: 'medium' },
      FIXED_NOW + 1,
    );
    expect(state.sectors[0].production).toBe(false);
    expect(state.sectors[0].classificationConfidence).toBe('medium');
  });
});

describe('recordTicketOutcome deterministic decay', () => {
  it('decays exactly at OUTCOME_DECAY_INTERVAL and not off-boundary', () => {
    const state = makeState([
      makeSector({
        path: 'src/outcomes',
        successCount: 9,
        failureCount: 10,
      }),
    ]);

    recordTicketOutcome(state, 'src/outcomes', true);
    expect(state.sectors[0].successCount).toBe(Math.round(10 * OUTCOME_DECAY_FACTOR));
    expect(state.sectors[0].failureCount).toBe(Math.round(10 * OUTCOME_DECAY_FACTOR));

    recordTicketOutcome(state, 'src/outcomes', false);
    expect(state.sectors[0].successCount).toBe(Math.round(10 * OUTCOME_DECAY_FACTOR));
    expect(state.sectors[0].failureCount).toBe(Math.round(10 * OUTCOME_DECAY_FACTOR) + 1);
  });

  it('updates category stats while tracking outcomes', () => {
    const state = makeState([makeSector({ path: 'src/categories' })]);

    recordTicketOutcome(state, 'src/categories', true, 'security');
    recordTicketOutcome(state, 'src/categories', false, 'security');

    expect(state.sectors[0].categoryStats).toEqual({
      security: { success: 1, failure: 1 },
    });
  });
});

describe('getSectorCategoryAffinity boundary thresholds', () => {
  it('uses strict >0.6 / <0.3 thresholds with minimum attempts', () => {
    const { boost, suppress } = getSectorCategoryAffinity(
      makeSector({
        categoryStats: {
          'boost-boundary': { success: 3, failure: 2 }, // 0.6: no boost
          'boost-above': { success: 2, failure: 1 }, // 0.666: boost
          'suppress-boundary': { success: 3, failure: 7 }, // 0.3: no suppress
          'suppress-below': { success: 0, failure: 3 }, // 0.0: suppress
          'insufficient-attempts': { success: 2, failure: 0 }, // < min attempts
        },
      }),
    );

    expect(AFFINITY_MIN_ATTEMPTS).toBe(3);
    expect(boost).toEqual(['boost-above']);
    expect(suppress).toEqual(['suppress-below']);
  });
});

describe('suggestScopeAdjustment boundary thresholds', () => {
  it('widens only when average yield is strictly below polished threshold', () => {
    const below = makeState([
      makeSector({ path: 'a', proposalYield: POLISHED_YIELD_THRESHOLD - 0.01 }),
      makeSector({ path: 'b', proposalYield: POLISHED_YIELD_THRESHOLD - 0.01 }),
      makeSector({ path: 'c', proposalYield: POLISHED_YIELD_THRESHOLD - 0.01 }),
    ]);
    expect(suggestScopeAdjustment(below)).toBe('widen');

    const atThreshold = makeState([
      makeSector({ path: 'a', proposalYield: POLISHED_YIELD_THRESHOLD }),
      makeSector({ path: 'b', proposalYield: POLISHED_YIELD_THRESHOLD }),
      makeSector({ path: 'c', proposalYield: POLISHED_YIELD_THRESHOLD }),
    ]);
    expect(suggestScopeAdjustment(atThreshold)).toBe('stable');
  });

  it('narrows only when top-3 average is strictly greater than 2x overall average', () => {
    const equalBoundary = makeState([
      makeSector({ path: 'a', proposalYield: 1.0 }),
      makeSector({ path: 'b', proposalYield: 1.0 }),
      makeSector({ path: 'c', proposalYield: 1.0 }),
      makeSector({ path: 'd', proposalYield: 0.25 }),
      makeSector({ path: 'e', proposalYield: 0.25 }),
      makeSector({ path: 'f', proposalYield: 0.25 }),
      makeSector({ path: 'g', proposalYield: 0.25 }),
      makeSector({ path: 'h', proposalYield: 0.25 }),
      makeSector({ path: 'i', proposalYield: 0.25 }),
    ]);
    expect(suggestScopeAdjustment(equalBoundary)).toBe('stable');

    const aboveBoundary = makeState([
      makeSector({ path: 'a', proposalYield: 1.0 }),
      makeSector({ path: 'b', proposalYield: 1.0 }),
      makeSector({ path: 'c', proposalYield: 1.0 }),
      makeSector({ path: 'd', proposalYield: 0.2 }),
      makeSector({ path: 'e', proposalYield: 0.2 }),
      makeSector({ path: 'f', proposalYield: 0.2 }),
      makeSector({ path: 'g', proposalYield: 0.2 }),
      makeSector({ path: 'h', proposalYield: 0.2 }),
      makeSector({ path: 'i', proposalYield: 0.2 }),
    ]);
    expect(suggestScopeAdjustment(aboveBoundary)).toBe('narrow');
  });
});

describe('sanity check', () => {
  it('keeps stable scope when scanned production sectors are fewer than three', () => {
    const state = makeState([
      makeSector({ path: 'a', scanCount: 1 }),
      makeSector({ path: 'b', scanCount: 1 }),
      makeSector({ path: 'non-prod', production: false, scanCount: 1 }),
    ]);
    expect(suggestScopeAdjustment(state)).toBe('stable');
  });

  it('uses OUTCOME_DECAY_INTERVAL constant in tests', () => {
    expect(OUTCOME_DECAY_INTERVAL).toBe(20);
  });
});

// ---------------------------------------------------------------------------
// propagateStaleness
// ---------------------------------------------------------------------------

describe('propagateStaleness', () => {
  it('resets lastScannedAt on dependent sectors', () => {
    const state = makeState([
      makeSector({ path: 'src/core', lastScannedAt: FIXED_NOW }),
      makeSector({ path: 'src/handlers', lastScannedAt: FIXED_NOW }),
      makeSector({ path: 'src/utils', lastScannedAt: FIXED_NOW }),
    ]);
    const reverseEdges = {
      'src/utils': ['src/core', 'src/handlers'],
    };
    const invalidated = propagateStaleness(state, 'src/utils', reverseEdges);
    expect(invalidated).toEqual(['src/core', 'src/handlers']);
    expect(state.sectors.find(s => s.path === 'src/core')!.lastScannedAt).toBe(0);
    expect(state.sectors.find(s => s.path === 'src/handlers')!.lastScannedAt).toBe(0);
    // Modified sector itself is not reset
    expect(state.sectors.find(s => s.path === 'src/utils')!.lastScannedAt).toBe(FIXED_NOW);
  });

  it('returns empty array when reverseEdges is undefined', () => {
    const state = makeState([
      makeSector({ path: 'src/core', lastScannedAt: FIXED_NOW }),
    ]);
    const invalidated = propagateStaleness(state, 'src/core', undefined);
    expect(invalidated).toEqual([]);
    expect(state.sectors.find(s => s.path === 'src/core')!.lastScannedAt).toBe(FIXED_NOW);
  });

  it('returns empty array when no dependents exist', () => {
    const state = makeState([
      makeSector({ path: 'src/leaf', lastScannedAt: FIXED_NOW }),
    ]);
    const reverseEdges = {
      'src/core': ['src/handlers'],
    };
    const invalidated = propagateStaleness(state, 'src/leaf', reverseEdges);
    expect(invalidated).toEqual([]);
  });

  it('skips sectors that were never scanned', () => {
    const state = makeState([
      makeSector({ path: 'src/core', lastScannedAt: FIXED_NOW }),
      makeSector({ path: 'src/new', lastScannedAt: 0 }),
    ]);
    const reverseEdges = {
      'src/utils': ['src/core', 'src/new'],
    };
    const invalidated = propagateStaleness(state, 'src/utils', reverseEdges);
    // Only src/core is invalidated; src/new was already at 0
    expect(invalidated).toEqual(['src/core']);
  });

  it('causes pickNextSector to prioritize invalidated sectors', () => {
    const state = makeState([
      makeSector({ path: 'src/core', lastScannedAt: FIXED_NOW, lastScannedCycle: FIXED_CYCLE }),
      makeSector({ path: 'src/api', lastScannedAt: FIXED_NOW, lastScannedCycle: FIXED_CYCLE }),
      makeSector({ path: 'src/utils', lastScannedAt: FIXED_NOW, lastScannedCycle: FIXED_CYCLE }),
    ]);
    const reverseEdges = { 'src/utils': ['src/core'] };
    propagateStaleness(state, 'src/utils', reverseEdges);
    // src/core now has lastScannedAt=0, should be picked first (never-scanned priority)
    const next = pickNextSector(state, FIXED_CYCLE + 1, FIXED_NOW);
    expect(next?.sector.path).toBe('src/core');
  });
});

// ---------------------------------------------------------------------------
// formatSectorDependencyContext
// ---------------------------------------------------------------------------

describe('formatSectorDependencyContext', () => {
  it('returns null when no graph data', () => {
    expect(formatSectorDependencyContext('src/core')).toBeNull();
    expect(formatSectorDependencyContext('src/core', undefined, undefined)).toBeNull();
  });

  it('returns null when no dependents or dependencies', () => {
    expect(formatSectorDependencyContext('src/leaf', {}, {})).toBeNull();
  });

  it('includes dependents list', () => {
    const result = formatSectorDependencyContext(
      'src/utils',
      { 'src/utils': ['src/core', 'src/handlers'] },
    );
    expect(result).toContain('Depended on by (2)');
    expect(result).toContain('src/core');
    expect(result).toContain('src/handlers');
    expect(result).toContain('cascading impact');
  });

  it('includes dependencies list', () => {
    const result = formatSectorDependencyContext(
      'src/handlers',
      {},
      { 'src/handlers': ['src/core', 'src/utils'] },
    );
    expect(result).toContain('Depends on (2)');
    expect(result).toContain('src/core');
  });

  it('includes sector metrics when provided', () => {
    const sector = makeSector({
      path: 'src/core',
      fanIn: 5,
      fanOut: 2,
      instability: 0.29,
      isHub: true,
    });
    const result = formatSectorDependencyContext(
      'src/core',
      { 'src/core': ['src/a'] },
      {},
      sector,
    );
    expect(result).toContain('fan-in: 5');
    expect(result).toContain('fan-out: 2');
    expect(result).toContain('instability: 0.29');
    expect(result).toContain('hub module');
  });

  it('truncates long dependents lists', () => {
    const deps = Array.from({ length: 15 }, (_, i) => `mod${i}`);
    const result = formatSectorDependencyContext(
      'src/shared',
      { 'src/shared': deps },
    );
    expect(result).toContain('(+5 more)');
  });
});
