/**
 * Sector rotation shared algorithms — pure functions for staleness-based
 * codebase scanning rotation.
 *
 * Flat list of scan records (one per codebase-index module). No splitting,
 * no parent/child hierarchy, no cross-ref bumps, no SHA-1 hashing.
 *
 * No filesystem, git, or child_process I/O. I/O-heavy functions
 * (loadOrBuildSectors, refreshSectors, saveSectors) stay in their
 * respective CLI/MCP packages.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Sector {
  path: string;            // module path from codebase-index ("src/lib")
  purpose: string;         // from codebase-index
  production: boolean;     // false for tests, config, fixtures, docs, scripts, generated
  fileCount: number;
  productionFileCount: number; // excludes test/story/fixture files within the sector
  classificationConfidence: string; // 'high' | 'medium' | 'low'
  lastScannedAt: number;   // epoch ms, 0 = never
  lastScannedCycle: number;
  scanCount: number;
  proposalYield: number;   // EMA of proposals per scan
  successCount: number;
  failureCount: number;
  polishedAt?: number;
  mergeCount?: number;
  closedCount?: number;
  categoryStats?: Record<string, { success: number; failure: number }>;
  /** Number of modules that import this module (from graph analysis). */
  fanIn?: number;
  /** Number of modules this module imports (from graph analysis). */
  fanOut?: number;
  /** True if this module is a hub (fan_in >= 3). */
  isHub?: boolean;
  /** Number of potentially dead exports in this module. */
  deadExportCount?: number;
  /** Martin instability metric: Ce / (Ca + Ce). 0=stable, 1=unstable. */
  instability?: number;
}

export interface SectorState {
  version: 2;
  builtAt: string;
  sectors: Sector[];
}

export interface CodebaseModuleLike {
  path: string;
  file_count?: number;
  production_file_count?: number;
  purpose?: string;
  production?: boolean;
  classification_confidence?: string;
  fan_in?: number;
  fan_out?: number;
}

export interface CoverageMetrics {
  scannedSectors: number;
  totalSectors: number;
  scannedFiles: number;
  totalFiles: number;
  percent: number;
  sectorPercent: number;
  unclassifiedSectors: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** EMA weight for old value (new = 1 - EMA_OLD_WEIGHT). */
export const EMA_OLD_WEIGHT = 0.7;

/** Outcome counts are decayed every N total outcomes. */
export const OUTCOME_DECAY_INTERVAL = 20;

/** Outcome decay multiplier. */
export const OUTCOME_DECAY_FACTOR = 0.7;

/** Minimum scans before a sector can be marked polished. */
export const POLISHED_MIN_SCANS = 5;

/** Yield threshold below which a sector may be polished. */
export const POLISHED_YIELD_THRESHOLD = 0.3;

/** Temporal decay threshold in days. */
export const TEMPORAL_DECAY_DAYS = 7;

/** Barren yield threshold. */
export const BARREN_YIELD_THRESHOLD = 0.5;

/** Minimum scans before barren detection. */
export const BARREN_MIN_SCANS = 2;

/** Minimum failures before high-failure deprioritization. */
export const HIGH_FAILURE_MIN = 3;

/** Failure rate above which a sector is deprioritized. */
export const HIGH_FAILURE_RATE = 0.6;

/** Affinity thresholds. */
export const AFFINITY_BOOST_RATE = 0.6;
export const AFFINITY_SUPPRESS_RATE = 0.3;
export const AFFINITY_MIN_ATTEMPTS = 3;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Normalize a path: trim, forward-slash, strip leading ./ and trailing /. */
export function normalizeSectorPath(p: string): string {
  const s = p.trim().replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '');
  return s || '.';
}

// ---------------------------------------------------------------------------
// Scope conversion
// ---------------------------------------------------------------------------

/** Convert a sector to a glob scope pattern. */
export function sectorToScope(sector: Sector): string {
  const p = normalizeSectorPath(sector.path);
  if (p === '.') return './{*,.*}';
  return `${p}/**`;
}

// ---------------------------------------------------------------------------
// Build sectors from codebase-index modules
// ---------------------------------------------------------------------------

/** Build fresh sector list from codebase-index modules. Deduplicates by normalized path. */
export function buildSectors(modules: CodebaseModuleLike[]): Sector[] {
  const seen = new Set<string>();
  const sectors: Sector[] = [];

  for (const m of modules) {
    const p = normalizeSectorPath(m.path);
    if (seen.has(p)) continue;
    seen.add(p);
    sectors.push({
      path: p,
      purpose: m.purpose ?? '',
      production: m.production ?? true,
      fileCount: m.file_count ?? 0,
      productionFileCount: m.production_file_count ?? m.file_count ?? 0,
      classificationConfidence: m.classification_confidence ?? 'low',
      lastScannedAt: 0,
      lastScannedCycle: 0,
      scanCount: 0,
      proposalYield: 0,
      successCount: 0,
      failureCount: 0,
      fanIn: m.fan_in,
      fanOut: m.fan_out,
      isHub: (m.fan_in ?? 0) >= 3,
    });
  }

  return sectors;
}

/**
 * Enrich sectors with analysis data from the codebase index.
 * Populates `deadExportCount` and `instability` from dead_exports and coupling metrics.
 */
export function enrichSectorsWithAnalysis(
  sectors: Sector[],
  deadExports?: Array<{ module: string }>,
  edges?: Record<string, string[]>,
  reverseEdges?: Record<string, string[]>,
): void {
  // Count dead exports per module
  if (deadExports && deadExports.length > 0) {
    const countByModule = new Map<string, number>();
    for (const d of deadExports) {
      countByModule.set(d.module, (countByModule.get(d.module) ?? 0) + 1);
    }
    for (const s of sectors) {
      const count = countByModule.get(s.path);
      if (count !== undefined) s.deadExportCount = count;
    }
  }

  // Compute instability per sector
  if (edges && reverseEdges) {
    for (const s of sectors) {
      const ca = (reverseEdges[s.path] ?? []).length;
      const ce = (edges[s.path] ?? []).length;
      const total = ca + ce;
      if (total > 0) s.instability = ce / total;
    }
  }
}

/** Normalize fields on a parsed sector (for loading from JSON). */
export function normalizeSectorFields(s: Partial<Sector> & { path?: string }): Sector {
  return {
    path: normalizeSectorPath(s.path ?? '.'),
    purpose: s.purpose ?? '',
    production: s.production ?? true,
    fileCount: s.fileCount ?? 0,
    productionFileCount: s.productionFileCount ?? s.fileCount ?? 0,
    classificationConfidence: s.classificationConfidence ?? 'low',
    lastScannedAt: s.lastScannedAt ?? 0,
    lastScannedCycle: s.lastScannedCycle ?? 0,
    scanCount: s.scanCount ?? 0,
    proposalYield: s.proposalYield ?? 0,
    successCount: s.successCount ?? 0,
    failureCount: s.failureCount ?? 0,
    polishedAt: s.polishedAt ?? 0,
    mergeCount: s.mergeCount,
    closedCount: s.closedCount,
    categoryStats: s.categoryStats,
  };
}

/**
 * Merge fresh sectors with previous state, preserving scan history.
 * Resets polishedAt when file count changes significantly (>20%).
 */
export function mergeSectors(fresh: Sector[], previous: Sector[]): Sector[] {
  const prevByPath = new Map(previous.map(s => [s.path, s]));

  return fresh.map(s => {
    const prev = prevByPath.get(s.path);
    if (!prev) return s;
    // If sector now has 0 files, don't carry forward stale scan stats —
    // this prevents empty sectors from accumulating scan counts and
    // being repeatedly selected by pickNextSector.
    if (s.fileCount === 0) return s;
    const fileCountChanged = prev.fileCount > 0 && Math.abs(s.fileCount - prev.fileCount) / prev.fileCount > 0.2;
    return {
      ...s,
      lastScannedAt: prev.lastScannedAt,
      lastScannedCycle: prev.lastScannedCycle,
      scanCount: prev.scanCount,
      proposalYield: prev.proposalYield,
      successCount: prev.successCount,
      failureCount: prev.failureCount,
      polishedAt: fileCountChanged ? 0 : (prev.polishedAt ?? 0),
      mergeCount: prev.mergeCount,
      closedCount: prev.closedCount,
      categoryStats: prev.categoryStats,
    };
  });
}

// ---------------------------------------------------------------------------
// Difficulty & confidence
// ---------------------------------------------------------------------------

export function getSectorDifficulty(sector: Sector): 'easy' | 'moderate' | 'hard' {
  const total = sector.successCount + sector.failureCount;
  if (total < 3) return 'easy';
  const failRate = sector.failureCount / total;
  if (failRate > HIGH_FAILURE_RATE) return 'hard';
  if (failRate > AFFINITY_SUPPRESS_RATE) return 'moderate';
  return 'easy';
}

export function getSectorMinConfidence(sector: Sector, base: number): number {
  const difficulty = getSectorDifficulty(sector);
  if (difficulty === 'hard') return base + 20;
  if (difficulty === 'moderate') return base + 10;
  return base;
}

// ---------------------------------------------------------------------------
// pickNextSector — main rotation algorithm
// ---------------------------------------------------------------------------

/**
 * Select the next sector to scan, rotating through them in priority order.
 *
 * Uses a multi-level sort tiebreaker:
 * 0. Polished sectors last (massive deprioritization)
 * 1. Never-scanned first
 * 2. Cycle staleness (lower lastScannedCycle first)
 * 3. Temporal decay (>7 days, older first)
 * 4. Low-confidence sectors first
 * 5. Barren deprioritization (scanCount > 2 && yield < 0.5)
 * 6. Hub modules first (high fan-in → more proposals likely)
 * 7. Dead export boost (easy cleanup wins)
 * 8. High failure rate deprioritization
 * 9. Higher proposalYield first
 * 10. Higher successCount first
 * 11. Alphabetical
 *
 * @param now - current timestamp in ms (defaults to Date.now()). Pass explicitly for testability.
 */
export function pickNextSector(
  state: SectorState,
  currentCycle: number,
  now?: number,
): { sector: Sector; scope: string } | null {
  if (state.sectors.length === 0) return null;

  const timestamp = now ?? Date.now();

  const primary = state.sectors.filter(s => s.fileCount > 0 && s.production);
  const candidates =
    primary.some(s => s.lastScannedAt === 0) ? primary
    : primary.some(s => currentCycle - s.lastScannedCycle >= 2) ? primary
    : state.sectors.filter(s => s.fileCount > 0); // include non-production as fallback

  if (candidates.length === 0) return null;

  // Detect polished sectors: scanned many times with consistently low yield
  for (const s of candidates) {
    if (s.scanCount >= POLISHED_MIN_SCANS && s.proposalYield < POLISHED_YIELD_THRESHOLD) {
      if (!s.polishedAt) s.polishedAt = timestamp;
    } else if (s.polishedAt) {
      s.polishedAt = 0;
    }
  }

  candidates.sort((a, b) => {
    // 0. Polished sectors sort after everything
    const aPolished = (a.polishedAt ?? 0) > 0 ? 1 : 0;
    const bPolished = (b.polishedAt ?? 0) > 0 ? 1 : 0;
    if (aPolished !== bPolished) return aPolished - bPolished;

    // 1. Never-scanned first
    if ((a.lastScannedAt === 0) !== (b.lastScannedAt === 0)) return a.lastScannedAt === 0 ? -1 : 1;
    // 2. Cycle staleness (lower lastScannedCycle first)
    if (a.lastScannedCycle !== b.lastScannedCycle) return a.lastScannedCycle - b.lastScannedCycle;
    // 3. Temporal decay: if |daysDiff| > 7, older sector first
    const aDays = (timestamp - a.lastScannedAt) / 86400000;
    const bDays = (timestamp - b.lastScannedAt) / 86400000;
    if (aDays > TEMPORAL_DECAY_DAYS && bDays > TEMPORAL_DECAY_DAYS && Math.abs(aDays - bDays) > 1) {
      return bDays - aDays > 0 ? 1 : -1;
    }
    // 4. Low-confidence sectors first
    const aLow = a.classificationConfidence === 'low' ? 1 : 0;
    const bLow = b.classificationConfidence === 'low' ? 1 : 0;
    if (aLow !== bLow) return bLow - aLow;
    // 5. Barren deprioritization: scanCount > 2 && proposalYield < 0.5 → sort later
    const aBarren = a.scanCount > BARREN_MIN_SCANS && a.proposalYield < BARREN_YIELD_THRESHOLD ? 1 : 0;
    const bBarren = b.scanCount > BARREN_MIN_SCANS && b.proposalYield < BARREN_YIELD_THRESHOLD ? 1 : 0;
    if (aBarren !== bBarren) return aBarren - bBarren;
    // 6. Hub modules first (high fan-in → more proposals likely)
    const aHub = a.isHub ? 1 : 0;
    const bHub = b.isHub ? 1 : 0;
    if (aHub !== bHub) return bHub - aHub;
    // 7. Dead export boost (easy cleanup wins)
    const aDead = a.deadExportCount ?? 0;
    const bDead = b.deadExportCount ?? 0;
    if (aDead !== bDead) return bDead - aDead;
    // 8. High failure rate deprioritization
    const aFail = a.failureCount >= HIGH_FAILURE_MIN && a.failureCount / (a.failureCount + a.successCount) > HIGH_FAILURE_RATE ? 1 : 0;
    const bFail = b.failureCount >= HIGH_FAILURE_MIN && b.failureCount / (b.failureCount + b.successCount) > HIGH_FAILURE_RATE ? 1 : 0;
    if (aFail !== bFail) return aFail - bFail;
    // 9. Higher proposalYield first
    if (a.proposalYield !== b.proposalYield) return b.proposalYield - a.proposalYield;
    // 10. Higher successCount first (tiebreaker)
    if (a.successCount !== b.successCount) return b.successCount - a.successCount;
    // 11. Alphabetical
    return a.path.localeCompare(b.path);
  });

  const sector = candidates[0];
  return { sector, scope: sectorToScope(sector) };
}

// ---------------------------------------------------------------------------
// Coverage metrics
// ---------------------------------------------------------------------------

export function computeCoverage(state: SectorState): CoverageMetrics {
  let scannedSectors = 0;
  let totalFiles = 0;
  let scannedFiles = 0;
  let unclassifiedSectors = 0;

  for (const s of state.sectors) {
    if (!s.production) continue;
    totalFiles += s.productionFileCount;
    if (s.scanCount > 0) {
      scannedSectors++;
      scannedFiles += s.productionFileCount;
    }
    if (s.classificationConfidence === 'low') {
      unclassifiedSectors++;
    }
  }

  const totalSectors = state.sectors.filter(s => s.production).length;
  const percent = totalFiles > 0 ? Math.round((scannedFiles / totalFiles) * 100) : 0;
  const sectorPercent = totalSectors > 0 ? Math.round((scannedSectors / totalSectors) * 100) : 0;

  return { scannedSectors, totalSectors, scannedFiles, totalFiles, percent, sectorPercent, unclassifiedSectors };
}

// ---------------------------------------------------------------------------
// Sector summary for prompt
// ---------------------------------------------------------------------------

export function buildSectorSummary(state: SectorState, currentPath: string, limit = 5): string {
  const lines: string[] = ['### Nearby Sectors'];

  // Recently scanned sectors (sorted by lastScannedAt desc)
  const scanned = state.sectors
    .filter(s => s.scanCount > 0 && s.path !== currentPath)
    .sort((a, b) => b.lastScannedAt - a.lastScannedAt)
    .slice(0, limit);

  if (scanned.length > 0) {
    lines.push('Recently scanned:');
    for (const s of scanned) {
      lines.push(`- \`${s.path}\` — yield: ${s.proposalYield.toFixed(1)}, scans: ${s.scanCount}`);
    }
  }

  // Top unscanned sectors (sorted by fileCount desc)
  const unscanned = state.sectors
    .filter(s => s.scanCount === 0 && s.fileCount > 0 && s.path !== currentPath)
    .sort((a, b) => b.fileCount - a.fileCount)
    .slice(0, limit);

  if (unscanned.length > 0) {
    lines.push('Top unscanned:');
    for (const s of unscanned) {
      lines.push(`- \`${s.path}\` (${s.fileCount} files)`);
    }
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Outcome recording (mutate state in place)
// ---------------------------------------------------------------------------

/**
 * Record scan completion for a sector.
 * @param now - current timestamp in ms (defaults to Date.now()). Pass explicitly for testability.
 */
export function recordScanResult(
  state: SectorState,
  sectorPath: string,
  currentCycle: number,
  proposalCount: number,
  reclassification?: { production?: boolean; confidence?: string },
  now?: number,
): void {
  const s = state.sectors.find(x => x.path === sectorPath);
  if (!s) return;

  s.lastScannedAt = now ?? Date.now();
  s.lastScannedCycle = currentCycle;
  s.scanCount = (s.scanCount ?? 0) + 1;
  s.proposalYield = EMA_OLD_WEIGHT * (s.proposalYield ?? 0) + (1 - EMA_OLD_WEIGHT) * proposalCount;

  // Apply reclassification if confidence is medium or high
  if (reclassification && (reclassification.confidence === 'medium' || reclassification.confidence === 'high')) {
    if (reclassification.production !== undefined) {
      s.production = reclassification.production;
    }
    s.classificationConfidence = reclassification.confidence;
  }
}

export function recordTicketOutcome(state: SectorState, sectorPath: string, success: boolean, category?: string): void {
  const s = state.sectors.find(x => x.path === sectorPath);
  if (!s) return;
  if (success) s.successCount++; else s.failureCount++;
  const total = s.successCount + s.failureCount;
  if (total > 0 && total % OUTCOME_DECAY_INTERVAL === 0) {
    s.successCount = Math.round(s.successCount * OUTCOME_DECAY_FACTOR);
    s.failureCount = Math.round(s.failureCount * OUTCOME_DECAY_FACTOR);
  }
  // Category×Sector affinity tracking
  if (category) {
    s.categoryStats ??= {};
    const cs = s.categoryStats[category] ??= { success: 0, failure: 0 };
    if (success) cs.success++; else cs.failure++;
  }
}

/**
 * Mark sectors that depend on a modified sector as stale by resetting
 * their lastScannedAt. This causes them to float up in pickNextSector's
 * staleness sort, ensuring consumers of changed code get re-scanned.
 *
 * No-op when reverseEdges is absent (backward compatible).
 */
export function propagateStaleness(
  state: SectorState,
  modifiedSectorPath: string,
  reverseEdges?: Record<string, string[]>,
): string[] {
  if (!reverseEdges) return [];
  const dependents = reverseEdges[modifiedSectorPath];
  if (!dependents || dependents.length === 0) return [];

  const invalidated: string[] = [];
  for (const depPath of dependents) {
    const sector = state.sectors.find(s => s.path === depPath);
    if (sector && sector.lastScannedAt > 0) {
      sector.lastScannedAt = 0;
      invalidated.push(depPath);
    }
  }
  return invalidated;
}

export function updateProposalYield(state: SectorState, sectorPath: string, acceptedCount: number): void {
  const s = state.sectors.find(x => x.path === sectorPath);
  if (!s) return;
  s.proposalYield = EMA_OLD_WEIGHT * s.proposalYield + (1 - EMA_OLD_WEIGHT) * acceptedCount;
}

export function recordMergeOutcome(state: SectorState, sectorPath: string, merged: boolean): void {
  const s = state.sectors.find(x => x.path === sectorPath);
  if (!s) return;
  if (merged) {
    s.mergeCount = (s.mergeCount ?? 0) + 1;
  } else {
    s.closedCount = (s.closedCount ?? 0) + 1;
  }
}

// ---------------------------------------------------------------------------
// Per-sector dependency context for scout prompts
// ---------------------------------------------------------------------------

/**
 * Format per-sector structural context for the scout prompt.
 * Shows which modules depend on this sector, fan-in/fan-out,
 * and instability metric — helping the scout prioritize changes
 * to highly-depended-upon code.
 *
 * Returns null when no graph context is available.
 */
export function formatSectorDependencyContext(
  sectorPath: string,
  reverseEdges?: Record<string, string[]>,
  edges?: Record<string, string[]>,
  sector?: Sector,
): string | null {
  if (!reverseEdges && !edges) return null;

  const dependents = reverseEdges?.[sectorPath] ?? [];
  const dependencies = edges?.[sectorPath] ?? [];

  // Nothing useful to show
  if (dependents.length === 0 && dependencies.length === 0 && !sector?.instability) return null;

  const lines: string[] = ['## Sector Structural Context'];

  if (dependents.length > 0) {
    lines.push(`**Depended on by (${dependents.length}):** ${dependents.slice(0, 10).join(', ')}${dependents.length > 10 ? ` (+${dependents.length - 10} more)` : ''}`);
    lines.push('Changes here have cascading impact — be thorough with verification.');
  }

  if (dependencies.length > 0) {
    lines.push(`**Depends on (${dependencies.length}):** ${dependencies.slice(0, 10).join(', ')}${dependencies.length > 10 ? ` (+${dependencies.length - 10} more)` : ''}`);
  }

  if (sector) {
    const parts: string[] = [];
    if (sector.fanIn !== undefined) parts.push(`fan-in: ${sector.fanIn}`);
    if (sector.fanOut !== undefined) parts.push(`fan-out: ${sector.fanOut}`);
    if (sector.instability !== undefined) parts.push(`instability: ${sector.instability.toFixed(2)}`);
    if (sector.isHub) parts.push('**hub module**');
    if (parts.length > 0) lines.push(`**Metrics:** ${parts.join(' | ')}`);
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Category affinity
// ---------------------------------------------------------------------------

/**
 * Get category affinity for a sector: which categories succeed vs fail.
 * boost: categories with >60% success rate (min 3 attempts)
 * suppress: categories with <30% success rate (min 3 attempts)
 */
export function getSectorCategoryAffinity(sector: Sector): { boost: string[]; suppress: string[] } {
  const boost: string[] = [];
  const suppress: string[] = [];
  if (!sector.categoryStats) return { boost, suppress };
  for (const [cat, stats] of Object.entries(sector.categoryStats)) {
    const total = stats.success + stats.failure;
    if (total < AFFINITY_MIN_ATTEMPTS) continue;
    const rate = stats.success / total;
    if (rate > AFFINITY_BOOST_RATE) boost.push(cat);
    else if (rate < AFFINITY_SUPPRESS_RATE) suppress.push(cat);
  }
  return { boost, suppress };
}

// ---------------------------------------------------------------------------
// Scope adjustment suggestion
// ---------------------------------------------------------------------------

/**
 * Suggest scope adjustment based on sector yield distribution.
 * narrow: top sectors have much higher yield than average (focus there)
 * widen: all sectors barren (need fresh territory)
 * stable: normal distribution
 */
export function suggestScopeAdjustment(state: SectorState): 'narrow' | 'widen' | 'stable' {
  const scanned = state.sectors.filter(s => s.production && s.scanCount > 0);
  if (scanned.length < 3) return 'stable';

  const yields = scanned.map(s => s.proposalYield).sort((a, b) => b - a);
  const avg = yields.reduce((s, v) => s + v, 0) / yields.length;

  // Check if all scanned sectors are barren
  if (avg < POLISHED_YIELD_THRESHOLD) return 'widen';

  // Check if top 3 have much higher yield
  const topAvg = yields.slice(0, 3).reduce((s, v) => s + v, 0) / Math.min(3, yields.length);
  if (avg > 0 && topAvg > avg * 2) return 'narrow';

  return 'stable';
}
