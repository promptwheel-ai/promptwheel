import { describe, it, expect } from 'vitest';
import {
  normalizeSectorPath,
  sectorToScope,
  buildSectors,
  normalizeSectorFields,
  mergeSectors,
  getSectorDifficulty,
  getSectorMinConfidence,
  pickNextSector,
  computeCoverage,
  buildSectorSummary,
  recordScanResult,
  recordTicketOutcome,
  updateProposalYield,
  recordMergeOutcome,
  getSectorCategoryAffinity,
  suggestScopeAdjustment,
  EMA_OLD_WEIGHT,
  OUTCOME_DECAY_INTERVAL,
  OUTCOME_DECAY_FACTOR,
  POLISHED_MIN_SCANS,
  POLISHED_YIELD_THRESHOLD,
  TEMPORAL_DECAY_DAYS,
  BARREN_YIELD_THRESHOLD,
  BARREN_MIN_SCANS,
  HIGH_FAILURE_MIN,
  HIGH_FAILURE_RATE,
  AFFINITY_BOOST_RATE,
  AFFINITY_SUPPRESS_RATE,
  AFFINITY_MIN_ATTEMPTS,
} from '../sectors/shared.js';
import type { Sector, SectorState, CodebaseModuleLike } from '../sectors/shared.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSector(overrides: Partial<Sector> = {}): Sector {
  return {
    path: 'src/lib',
    purpose: 'services',
    production: true,
    fileCount: 10,
    productionFileCount: 10,
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

function makeState(sectors: Sector[]): SectorState {
  return { version: 2, builtAt: new Date().toISOString(), sectors };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('constants', () => {
  it('EMA_OLD_WEIGHT is 0.7', () => {
    expect(EMA_OLD_WEIGHT).toBe(0.7);
  });

  it('OUTCOME_DECAY_INTERVAL is 20', () => {
    expect(OUTCOME_DECAY_INTERVAL).toBe(20);
  });

  it('OUTCOME_DECAY_FACTOR is 0.7', () => {
    expect(OUTCOME_DECAY_FACTOR).toBe(0.7);
  });

  it('POLISHED thresholds', () => {
    expect(POLISHED_MIN_SCANS).toBe(5);
    expect(POLISHED_YIELD_THRESHOLD).toBe(0.3);
  });

  it('TEMPORAL_DECAY_DAYS is 7', () => {
    expect(TEMPORAL_DECAY_DAYS).toBe(7);
  });

  it('barren thresholds', () => {
    expect(BARREN_YIELD_THRESHOLD).toBe(0.5);
    expect(BARREN_MIN_SCANS).toBe(2);
  });

  it('high failure thresholds', () => {
    expect(HIGH_FAILURE_MIN).toBe(3);
    expect(HIGH_FAILURE_RATE).toBe(0.6);
  });

  it('affinity thresholds', () => {
    expect(AFFINITY_BOOST_RATE).toBe(0.6);
    expect(AFFINITY_SUPPRESS_RATE).toBe(0.3);
    expect(AFFINITY_MIN_ATTEMPTS).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// normalizeSectorPath
// ---------------------------------------------------------------------------

describe('normalizeSectorPath', () => {
  it('trims whitespace', () => {
    expect(normalizeSectorPath('  src/lib  ')).toBe('src/lib');
  });

  it('converts backslashes to forward slashes', () => {
    expect(normalizeSectorPath('src\\lib\\utils')).toBe('src/lib/utils');
  });

  it('strips leading ./', () => {
    expect(normalizeSectorPath('./src/lib')).toBe('src/lib');
  });

  it('strips trailing /', () => {
    expect(normalizeSectorPath('src/lib/')).toBe('src/lib');
  });

  it('returns . for empty string', () => {
    expect(normalizeSectorPath('')).toBe('.');
    expect(normalizeSectorPath('./')).toBe('.');
  });
});

// ---------------------------------------------------------------------------
// sectorToScope
// ---------------------------------------------------------------------------

describe('sectorToScope', () => {
  it('converts normal path to glob', () => {
    expect(sectorToScope(makeSector({ path: 'src/lib' }))).toBe('src/lib/**');
  });

  it('handles root path', () => {
    expect(sectorToScope(makeSector({ path: '.' }))).toBe('./{*,.*}');
  });

  it('normalizes path before converting', () => {
    expect(sectorToScope(makeSector({ path: './src/lib/' }))).toBe('src/lib/**');
  });
});

// ---------------------------------------------------------------------------
// buildSectors
// ---------------------------------------------------------------------------

describe('buildSectors', () => {
  it('creates sectors from modules', () => {
    const modules: CodebaseModuleLike[] = [
      { path: 'src/lib', file_count: 10, purpose: 'services', production: true, classification_confidence: 'high' },
      { path: 'src/test', file_count: 5, purpose: 'tests', production: false },
    ];
    const sectors = buildSectors(modules);
    expect(sectors).toHaveLength(2);
    expect(sectors[0].path).toBe('src/lib');
    expect(sectors[0].fileCount).toBe(10);
    expect(sectors[0].purpose).toBe('services');
    expect(sectors[0].production).toBe(true);
    expect(sectors[0].scanCount).toBe(0);
    expect(sectors[1].path).toBe('src/test');
    expect(sectors[1].production).toBe(false);
  });

  it('deduplicates by normalized path', () => {
    const modules: CodebaseModuleLike[] = [
      { path: 'src/lib' },
      { path: './src/lib/' },
    ];
    const sectors = buildSectors(modules);
    expect(sectors).toHaveLength(1);
  });

  it('defaults missing fields', () => {
    const sectors = buildSectors([{ path: 'src/unknown' }]);
    expect(sectors[0].purpose).toBe('');
    expect(sectors[0].production).toBe(true);
    expect(sectors[0].fileCount).toBe(0);
    expect(sectors[0].classificationConfidence).toBe('low');
  });
});

// ---------------------------------------------------------------------------
// normalizeSectorFields
// ---------------------------------------------------------------------------

describe('normalizeSectorFields', () => {
  it('fills all missing fields with defaults', () => {
    const s = normalizeSectorFields({ path: 'src/lib' });
    expect(s.purpose).toBe('');
    expect(s.production).toBe(true);
    expect(s.fileCount).toBe(0);
    expect(s.lastScannedAt).toBe(0);
    expect(s.scanCount).toBe(0);
    expect(s.proposalYield).toBe(0);
    expect(s.successCount).toBe(0);
    expect(s.failureCount).toBe(0);
  });

  it('normalizes path', () => {
    const s = normalizeSectorFields({ path: './src/lib/' });
    expect(s.path).toBe('src/lib');
  });

  it('preserves existing values', () => {
    const s = normalizeSectorFields({
      path: 'src/lib',
      scanCount: 5,
      proposalYield: 2.5,
      successCount: 3,
    });
    expect(s.scanCount).toBe(5);
    expect(s.proposalYield).toBe(2.5);
    expect(s.successCount).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// mergeSectors
// ---------------------------------------------------------------------------

describe('mergeSectors', () => {
  it('preserves scan history from previous state', () => {
    const fresh = [makeSector({ path: 'src/lib', fileCount: 12 })];
    const previous = [makeSector({ path: 'src/lib', scanCount: 3, proposalYield: 1.5, successCount: 2 })];
    const merged = mergeSectors(fresh, previous);
    expect(merged).toHaveLength(1);
    expect(merged[0].fileCount).toBe(12); // fresh value
    expect(merged[0].scanCount).toBe(3); // preserved
    expect(merged[0].proposalYield).toBe(1.5);
    expect(merged[0].successCount).toBe(2);
  });

  it('returns fresh sector if no previous match', () => {
    const fresh = [makeSector({ path: 'src/new' })];
    const previous = [makeSector({ path: 'src/old', scanCount: 5 })];
    const merged = mergeSectors(fresh, previous);
    expect(merged).toHaveLength(1);
    expect(merged[0].path).toBe('src/new');
    expect(merged[0].scanCount).toBe(0);
  });

  it('resets polishedAt when file count changes >20%', () => {
    const fresh = [makeSector({ path: 'src/lib', fileCount: 15 })]; // 50% change
    const previous = [makeSector({ path: 'src/lib', fileCount: 10, polishedAt: 1000 })];
    const merged = mergeSectors(fresh, previous);
    expect(merged[0].polishedAt).toBe(0);
  });

  it('preserves polishedAt when file count is stable', () => {
    const fresh = [makeSector({ path: 'src/lib', fileCount: 11 })]; // 10% change
    const previous = [makeSector({ path: 'src/lib', fileCount: 10, polishedAt: 1000 })];
    const merged = mergeSectors(fresh, previous);
    expect(merged[0].polishedAt).toBe(1000);
  });
});

// ---------------------------------------------------------------------------
// getSectorDifficulty
// ---------------------------------------------------------------------------

describe('getSectorDifficulty', () => {
  it('returns easy with insufficient data', () => {
    expect(getSectorDifficulty(makeSector({ successCount: 1, failureCount: 1 }))).toBe('easy');
  });

  it('returns easy with low failure rate', () => {
    expect(getSectorDifficulty(makeSector({ successCount: 8, failureCount: 2 }))).toBe('easy');
  });

  it('returns moderate with 30-60% failure rate', () => {
    expect(getSectorDifficulty(makeSector({ successCount: 5, failureCount: 4 }))).toBe('moderate');
  });

  it('returns hard with >60% failure rate', () => {
    expect(getSectorDifficulty(makeSector({ successCount: 1, failureCount: 4 }))).toBe('hard');
  });
});

// ---------------------------------------------------------------------------
// getSectorMinConfidence
// ---------------------------------------------------------------------------

describe('getSectorMinConfidence', () => {
  it('returns base for easy sectors', () => {
    expect(getSectorMinConfidence(makeSector({ successCount: 10, failureCount: 0 }), 70)).toBe(70);
  });

  it('adds 10 for moderate sectors', () => {
    expect(getSectorMinConfidence(makeSector({ successCount: 5, failureCount: 4 }), 70)).toBe(80);
  });

  it('adds 20 for hard sectors', () => {
    expect(getSectorMinConfidence(makeSector({ successCount: 1, failureCount: 4 }), 70)).toBe(90);
  });
});

// ---------------------------------------------------------------------------
// pickNextSector
// ---------------------------------------------------------------------------

describe('pickNextSector', () => {
  it('returns null for empty state', () => {
    expect(pickNextSector(makeState([]), 1)).toBeNull();
  });

  it('returns null when all sectors have fileCount 0', () => {
    expect(pickNextSector(makeState([makeSector({ fileCount: 0 })]), 1)).toBeNull();
  });

  it('prioritizes never-scanned sectors', () => {
    const state = makeState([
      makeSector({ path: 'scanned', lastScannedAt: 1000, lastScannedCycle: 1, scanCount: 1 }),
      makeSector({ path: 'unscanned', lastScannedAt: 0, scanCount: 0 }),
    ]);
    const result = pickNextSector(state, 2);
    expect(result?.sector.path).toBe('unscanned');
  });

  it('picks cycle-stale sectors over recently-scanned', () => {
    const state = makeState([
      makeSector({ path: 'recent', lastScannedAt: 1000, lastScannedCycle: 5, scanCount: 1 }),
      makeSector({ path: 'stale', lastScannedAt: 900, lastScannedCycle: 2, scanCount: 1 }),
    ]);
    const result = pickNextSector(state, 5);
    expect(result?.sector.path).toBe('stale');
  });

  it('deprioritizes polished sectors', () => {
    const state = makeState([
      makeSector({ path: 'polished', lastScannedAt: 1000, lastScannedCycle: 1, scanCount: 6, proposalYield: 0.1, successCount: 0, failureCount: 0 }),
      makeSector({ path: 'active', lastScannedAt: 1000, lastScannedCycle: 1, scanCount: 2, proposalYield: 1.0 }),
    ]);
    const result = pickNextSector(state, 3);
    expect(result?.sector.path).toBe('active');
  });

  it('marks sectors as polished when thresholds met', () => {
    const s = makeSector({
      path: 'exhausted', lastScannedAt: 1000, lastScannedCycle: 1,
      scanCount: 6, proposalYield: 0.1, successCount: 0, failureCount: 0,
    });
    const state = makeState([s]);
    pickNextSector(state, 3, 5000);
    expect(s.polishedAt).toBe(5000);
  });

  it('clears polishedAt when sector no longer meets thresholds', () => {
    const s = makeSector({
      path: 'recovering', lastScannedAt: 1000, lastScannedCycle: 1,
      scanCount: 6, proposalYield: 2.0, successCount: 5, failureCount: 1,
      polishedAt: 3000,
    });
    const state = makeState([s]);
    pickNextSector(state, 3);
    expect(s.polishedAt).toBe(0);
  });

  it('deprioritizes barren sectors (scanCount > 2, yield < 0.5)', () => {
    const state = makeState([
      makeSector({ path: 'barren', lastScannedAt: 100, lastScannedCycle: 1, scanCount: 4, proposalYield: 0.2 }),
      makeSector({ path: 'productive', lastScannedAt: 100, lastScannedCycle: 1, scanCount: 4, proposalYield: 1.5 }),
    ]);
    const result = pickNextSector(state, 3);
    expect(result?.sector.path).toBe('productive');
  });

  it('deprioritizes high-failure sectors', () => {
    const state = makeState([
      makeSector({ path: 'failing', lastScannedAt: 100, lastScannedCycle: 1, scanCount: 1, failureCount: 4, successCount: 1 }),
      makeSector({ path: 'stable', lastScannedAt: 100, lastScannedCycle: 1, scanCount: 1, failureCount: 0, successCount: 3 }),
    ]);
    const result = pickNextSector(state, 3);
    expect(result?.sector.path).toBe('stable');
  });

  it('prefers higher proposalYield as tiebreaker', () => {
    const state = makeState([
      makeSector({ path: 'low-yield', lastScannedAt: 100, lastScannedCycle: 1, scanCount: 1, proposalYield: 0.5 }),
      makeSector({ path: 'high-yield', lastScannedAt: 100, lastScannedCycle: 1, scanCount: 1, proposalYield: 2.0 }),
    ]);
    const result = pickNextSector(state, 3);
    expect(result?.sector.path).toBe('high-yield');
  });

  it('uses alphabetical order as final tiebreaker', () => {
    const state = makeState([
      makeSector({ path: 'zzz', lastScannedAt: 100, lastScannedCycle: 1, scanCount: 1 }),
      makeSector({ path: 'aaa', lastScannedAt: 100, lastScannedCycle: 1, scanCount: 1 }),
    ]);
    const result = pickNextSector(state, 3);
    expect(result?.sector.path).toBe('aaa');
  });

  it('falls back to non-production sectors when all primary scanned', () => {
    const state = makeState([
      makeSector({ path: 'tests', production: false, lastScannedAt: 0, scanCount: 0 }),
      makeSector({ path: 'prod', production: true, lastScannedAt: 100, lastScannedCycle: 1, scanCount: 1 }),
    ]);
    // All production sectors scanned, none stale (cycle 1, current 1) → fallback includes non-production
    const result = pickNextSector(state, 1);
    expect(result?.sector.path).toBe('tests');
  });

  it('returns scope with the selected sector', () => {
    const state = makeState([makeSector({ path: 'src/lib' })]);
    const result = pickNextSector(state, 1);
    expect(result?.scope).toBe('src/lib/**');
  });

  it('prioritizes low-confidence sectors over high-confidence', () => {
    const state = makeState([
      makeSector({ path: 'confident', lastScannedAt: 100, lastScannedCycle: 1, scanCount: 1, classificationConfidence: 'high' }),
      makeSector({ path: 'uncertain', lastScannedAt: 100, lastScannedCycle: 1, scanCount: 1, classificationConfidence: 'low' }),
    ]);
    const result = pickNextSector(state, 3);
    expect(result?.sector.path).toBe('uncertain');
  });

  it('applies temporal decay tiebreaker when both >7 days stale', () => {
    const now = Date.now();
    const tenDaysAgo = now - 10 * 86400000;
    const eightDaysAgo = now - 8 * 86400000;
    const state = makeState([
      makeSector({ path: 'older', lastScannedAt: tenDaysAgo, lastScannedCycle: 1, scanCount: 1 }),
      makeSector({ path: 'newer', lastScannedAt: eightDaysAgo, lastScannedCycle: 1, scanCount: 1 }),
    ]);
    const result = pickNextSector(state, 3, now);
    // Both > 7 days stale with >1 day difference — staler sector sorts first (higher priority)
    expect(result?.sector.path).toBe('older');
  });

  it('temporal decay sorts staler sectors before newer ones', () => {
    const now = Date.now();
    const twentyDaysAgo = now - 20 * 86400000;
    const tenDaysAgo = now - 10 * 86400000;
    const state = makeState([
      makeSector({ path: 'recently-stale', lastScannedAt: tenDaysAgo, lastScannedCycle: 1, scanCount: 1 }),
      makeSector({ path: 'very-stale', lastScannedAt: twentyDaysAgo, lastScannedCycle: 1, scanCount: 1 }),
    ]);
    const result = pickNextSector(state, 3, now);
    // Both > 7 days stale, 10 day difference — the staler sector should sort first
    expect(result?.sector.path).toBe('very-stale');
  });

  it('ignores temporal decay when difference is small (<1 day)', () => {
    const now = Date.now();
    const eightDaysAgo = now - 8 * 86400000;
    const eightDaysAgoPlus = now - 8 * 86400000 + 3600000; // +1 hour
    const state = makeState([
      makeSector({ path: 'a', lastScannedAt: eightDaysAgo, lastScannedCycle: 1, scanCount: 1 }),
      makeSector({ path: 'b', lastScannedAt: eightDaysAgoPlus, lastScannedCycle: 1, scanCount: 1 }),
    ]);
    const result = pickNextSector(state, 3, now);
    // Difference < 1 day → falls through to next tiebreaker (alphabetical)
    expect(result?.sector.path).toBe('a');
  });
});

// ---------------------------------------------------------------------------
// computeCoverage
// ---------------------------------------------------------------------------

describe('computeCoverage', () => {
  it('computes coverage for production sectors only', () => {
    const state = makeState([
      makeSector({ path: 'scanned', production: true, productionFileCount: 20, scanCount: 1 }),
      makeSector({ path: 'unscanned', production: true, productionFileCount: 30, scanCount: 0 }),
      makeSector({ path: 'tests', production: false, productionFileCount: 10, scanCount: 1 }),
    ]);
    const cov = computeCoverage(state);
    expect(cov.scannedSectors).toBe(1);
    expect(cov.totalSectors).toBe(2); // only production
    expect(cov.scannedFiles).toBe(20);
    expect(cov.totalFiles).toBe(50);
    expect(cov.percent).toBe(40);
    expect(cov.sectorPercent).toBe(50);
  });

  it('returns 0% for empty state', () => {
    const cov = computeCoverage(makeState([]));
    expect(cov.percent).toBe(0);
    expect(cov.sectorPercent).toBe(0);
  });

  it('counts unclassified sectors', () => {
    const state = makeState([
      makeSector({ classificationConfidence: 'low', production: true }),
      makeSector({ path: 'src/api', classificationConfidence: 'high', production: true }),
    ]);
    expect(computeCoverage(state).unclassifiedSectors).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// buildSectorSummary
// ---------------------------------------------------------------------------

describe('buildSectorSummary', () => {
  it('shows recently scanned and top unscanned', () => {
    const state = makeState([
      makeSector({ path: 'current', scanCount: 1, lastScannedAt: 3000 }),
      makeSector({ path: 'recent', scanCount: 2, lastScannedAt: 2000, proposalYield: 1.5 }),
      makeSector({ path: 'unscanned', scanCount: 0, fileCount: 20 }),
    ]);
    const summary = buildSectorSummary(state, 'current');
    expect(summary).toContain('### Nearby Sectors');
    expect(summary).toContain('`recent`');
    expect(summary).toContain('yield: 1.5');
    expect(summary).toContain('`unscanned`');
    expect(summary).toContain('20 files');
    expect(summary).not.toContain('`current`'); // excludes current
  });

  it('respects limit parameter', () => {
    const sectors = Array.from({ length: 10 }, (_, i) =>
      makeSector({ path: `mod-${i}`, scanCount: 1, lastScannedAt: 1000 + i }),
    );
    const summary = buildSectorSummary(makeState(sectors), 'other', 2);
    const matches = summary.match(/`mod-/g);
    expect(matches?.length).toBeLessThanOrEqual(2);
  });

  it('handles state with no scanned or unscanned', () => {
    const summary = buildSectorSummary(makeState([]), 'anywhere');
    expect(summary).toBe('### Nearby Sectors');
  });
});

// ---------------------------------------------------------------------------
// recordScanResult
// ---------------------------------------------------------------------------

describe('recordScanResult', () => {
  it('updates scan counters and yield', () => {
    const state = makeState([makeSector({ path: 'src/lib' })]);
    recordScanResult(state, 'src/lib', 3, 5, undefined, 1000);
    const s = state.sectors[0];
    expect(s.lastScannedAt).toBe(1000);
    expect(s.lastScannedCycle).toBe(3);
    expect(s.scanCount).toBe(1);
    expect(s.proposalYield).toBeCloseTo(0.7 * 0 + 0.3 * 5);
  });

  it('applies EMA to proposalYield', () => {
    const state = makeState([makeSector({ path: 'src/lib', proposalYield: 2.0, scanCount: 1 })]);
    recordScanResult(state, 'src/lib', 4, 4, undefined, 2000);
    expect(state.sectors[0].proposalYield).toBeCloseTo(0.7 * 2.0 + 0.3 * 4);
  });

  it('applies reclassification when confidence is medium', () => {
    const state = makeState([makeSector({ path: 'src/lib', production: true, classificationConfidence: 'low' })]);
    recordScanResult(state, 'src/lib', 1, 0, { production: false, confidence: 'medium' }, 1000);
    expect(state.sectors[0].production).toBe(false);
    expect(state.sectors[0].classificationConfidence).toBe('medium');
  });

  it('applies reclassification when confidence is high', () => {
    const state = makeState([makeSector({ path: 'src/lib' })]);
    recordScanResult(state, 'src/lib', 1, 0, { confidence: 'high' }, 1000);
    expect(state.sectors[0].classificationConfidence).toBe('high');
  });

  it('ignores reclassification when confidence is low', () => {
    const state = makeState([makeSector({ path: 'src/lib', classificationConfidence: 'high' })]);
    recordScanResult(state, 'src/lib', 1, 0, { production: false, confidence: 'low' }, 1000);
    expect(state.sectors[0].classificationConfidence).toBe('high'); // unchanged
    expect(state.sectors[0].production).toBe(true); // unchanged
  });

  it('is a no-op for unknown sector path', () => {
    const state = makeState([makeSector({ path: 'src/lib' })]);
    recordScanResult(state, 'src/unknown', 1, 5, undefined, 1000);
    expect(state.sectors[0].scanCount).toBe(0); // unchanged
  });
});

// ---------------------------------------------------------------------------
// recordTicketOutcome
// ---------------------------------------------------------------------------

describe('recordTicketOutcome', () => {
  it('increments successCount on success', () => {
    const state = makeState([makeSector({ path: 'src/lib' })]);
    recordTicketOutcome(state, 'src/lib', true);
    expect(state.sectors[0].successCount).toBe(1);
    expect(state.sectors[0].failureCount).toBe(0);
  });

  it('increments failureCount on failure', () => {
    const state = makeState([makeSector({ path: 'src/lib' })]);
    recordTicketOutcome(state, 'src/lib', false);
    expect(state.sectors[0].successCount).toBe(0);
    expect(state.sectors[0].failureCount).toBe(1);
  });

  it('applies decay every 20 outcomes', () => {
    const state = makeState([makeSector({ path: 'src/lib', successCount: 14, failureCount: 5 })]);
    // This is outcome #20 (14+5+1=20), triggers decay
    recordTicketOutcome(state, 'src/lib', true);
    expect(state.sectors[0].successCount).toBe(Math.round(15 * 0.7));
    expect(state.sectors[0].failureCount).toBe(Math.round(5 * 0.7));
  });

  it('tracks category affinity', () => {
    const state = makeState([makeSector({ path: 'src/lib' })]);
    recordTicketOutcome(state, 'src/lib', true, 'security');
    recordTicketOutcome(state, 'src/lib', false, 'security');
    expect(state.sectors[0].categoryStats).toEqual({
      security: { success: 1, failure: 1 },
    });
  });

  it('is a no-op for unknown sector', () => {
    const state = makeState([makeSector({ path: 'src/lib' })]);
    recordTicketOutcome(state, 'unknown', true);
    expect(state.sectors[0].successCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// updateProposalYield
// ---------------------------------------------------------------------------

describe('updateProposalYield', () => {
  it('applies EMA update', () => {
    const state = makeState([makeSector({ path: 'src/lib', proposalYield: 2.0 })]);
    updateProposalYield(state, 'src/lib', 4);
    expect(state.sectors[0].proposalYield).toBeCloseTo(0.7 * 2.0 + 0.3 * 4);
  });

  it('is a no-op for unknown sector', () => {
    const state = makeState([makeSector({ path: 'src/lib', proposalYield: 2.0 })]);
    updateProposalYield(state, 'unknown', 10);
    expect(state.sectors[0].proposalYield).toBe(2.0);
  });
});

// ---------------------------------------------------------------------------
// recordMergeOutcome
// ---------------------------------------------------------------------------

describe('recordMergeOutcome', () => {
  it('increments mergeCount on merge', () => {
    const state = makeState([makeSector({ path: 'src/lib' })]);
    recordMergeOutcome(state, 'src/lib', true);
    expect(state.sectors[0].mergeCount).toBe(1);
  });

  it('increments closedCount on close', () => {
    const state = makeState([makeSector({ path: 'src/lib' })]);
    recordMergeOutcome(state, 'src/lib', false);
    expect(state.sectors[0].closedCount).toBe(1);
  });

  it('accumulates over multiple calls', () => {
    const state = makeState([makeSector({ path: 'src/lib', mergeCount: 2, closedCount: 1 })]);
    recordMergeOutcome(state, 'src/lib', true);
    recordMergeOutcome(state, 'src/lib', false);
    expect(state.sectors[0].mergeCount).toBe(3);
    expect(state.sectors[0].closedCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// getSectorCategoryAffinity
// ---------------------------------------------------------------------------

describe('getSectorCategoryAffinity', () => {
  it('returns empty for no categoryStats', () => {
    const { boost, suppress } = getSectorCategoryAffinity(makeSector());
    expect(boost).toEqual([]);
    expect(suppress).toEqual([]);
  });

  it('boosts categories with >60% success rate (min 3 attempts)', () => {
    const { boost } = getSectorCategoryAffinity(makeSector({
      categoryStats: {
        security: { success: 4, failure: 1 }, // 80%
        cleanup: { success: 2, failure: 0 },  // only 2 attempts, skip
      },
    }));
    expect(boost).toEqual(['security']);
  });

  it('suppresses categories with <30% success rate (min 3 attempts)', () => {
    const { suppress } = getSectorCategoryAffinity(makeSector({
      categoryStats: {
        refactor: { success: 0, failure: 4 }, // 0%
      },
    }));
    expect(suppress).toEqual(['refactor']);
  });

  it('ignores categories with insufficient data', () => {
    const { boost, suppress } = getSectorCategoryAffinity(makeSector({
      categoryStats: {
        test: { success: 1, failure: 1 }, // only 2 attempts
      },
    }));
    expect(boost).toEqual([]);
    expect(suppress).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// suggestScopeAdjustment
// ---------------------------------------------------------------------------

describe('suggestScopeAdjustment', () => {
  it('returns stable with fewer than 3 scanned sectors', () => {
    const state = makeState([
      makeSector({ scanCount: 1, production: true }),
      makeSector({ path: 'b', scanCount: 1, production: true }),
    ]);
    expect(suggestScopeAdjustment(state)).toBe('stable');
  });

  it('returns widen when all sectors are barren', () => {
    const state = makeState([
      makeSector({ path: 'a', scanCount: 1, production: true, proposalYield: 0.1 }),
      makeSector({ path: 'b', scanCount: 1, production: true, proposalYield: 0.2 }),
      makeSector({ path: 'c', scanCount: 1, production: true, proposalYield: 0.1 }),
    ]);
    expect(suggestScopeAdjustment(state)).toBe('widen');
  });

  it('returns narrow when top sectors far outperform average', () => {
    // topAvg must be > avg * 2, so need many low-yield sectors to dilute average
    // top 3: yield=10 each, bottom 6: yield=0.1 each
    // avg = (30 + 0.6) / 9 = 3.4, topAvg = 10, 10 > 3.4*2 = 6.8 ✓
    const state = makeState([
      makeSector({ path: 'a', scanCount: 1, production: true, proposalYield: 10.0 }),
      makeSector({ path: 'b', scanCount: 1, production: true, proposalYield: 10.0 }),
      makeSector({ path: 'c', scanCount: 1, production: true, proposalYield: 10.0 }),
      makeSector({ path: 'd', scanCount: 1, production: true, proposalYield: 0.1 }),
      makeSector({ path: 'e', scanCount: 1, production: true, proposalYield: 0.1 }),
      makeSector({ path: 'f', scanCount: 1, production: true, proposalYield: 0.1 }),
      makeSector({ path: 'g', scanCount: 1, production: true, proposalYield: 0.1 }),
      makeSector({ path: 'h', scanCount: 1, production: true, proposalYield: 0.1 }),
      makeSector({ path: 'i', scanCount: 1, production: true, proposalYield: 0.1 }),
    ]);
    expect(suggestScopeAdjustment(state)).toBe('narrow');
  });

  it('returns stable for normal distribution', () => {
    const state = makeState([
      makeSector({ path: 'a', scanCount: 1, production: true, proposalYield: 2.0 }),
      makeSector({ path: 'b', scanCount: 1, production: true, proposalYield: 1.5 }),
      makeSector({ path: 'c', scanCount: 1, production: true, proposalYield: 1.0 }),
    ]);
    expect(suggestScopeAdjustment(state)).toBe('stable');
  });

  it('ignores non-production sectors', () => {
    const state = makeState([
      makeSector({ path: 'a', scanCount: 1, production: false, proposalYield: 0.1 }),
      makeSector({ path: 'b', scanCount: 1, production: false, proposalYield: 0.1 }),
      makeSector({ path: 'c', scanCount: 1, production: false, proposalYield: 0.1 }),
    ]);
    // All non-production → fewer than 3 scanned production → stable
    expect(suggestScopeAdjustment(state)).toBe('stable');
  });
});
