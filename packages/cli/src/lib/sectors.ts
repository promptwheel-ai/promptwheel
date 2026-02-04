/**
 * Sector-based scout scanning with staleness-based rotation.
 *
 * Flat list of scan records (one per codebase-index module). No splitting,
 * no parent/child hierarchy, no cross-ref bumps, no SHA-1 hashing.
 * Persists to `.blockspool/sectors.json`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

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
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STATE_DIR = '.blockspool';
const STATE_FILE = 'sectors.json';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function norm(p: string): string {
  const s = p.trim().replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '');
  return s || '.';
}

function defaultSectorsFile(repoRoot: string): string {
  return path.join(repoRoot, STATE_DIR, STATE_FILE);
}

function ensureStateDir(repoRoot: string): void {
  const d = path.join(repoRoot, STATE_DIR);
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

// ---------------------------------------------------------------------------
// Scope conversion
// ---------------------------------------------------------------------------

export function sectorToScope(sector: Sector): string {
  const p = norm(sector.path);
  if (p === '.') return './{*,.*}';
  return `${p}/**`;
}

// ---------------------------------------------------------------------------
// Build sectors from codebase-index modules
// ---------------------------------------------------------------------------

function buildSectors(modules: CodebaseModuleLike[]): Sector[] {
  const seen = new Set<string>();
  const sectors: Sector[] = [];

  for (const m of modules) {
    const p = norm(m.path);
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
    });
  }

  // Root sector only if no modules cover it (and don't add with fileCount 0 — it'd be dead)
  // Callers that need a root fallback use the '**' broad scan in solo-auto.

  return sectors;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export function saveSectors(repoRoot: string, state: SectorState): void {
  ensureStateDir(repoRoot);
  const filePath = defaultSectorsFile(repoRoot);
  const tmpPath = filePath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmpPath, filePath);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function loadOrBuildSectors(
  repoRoot: string,
  modules: CodebaseModuleLike[],
): SectorState {
  const sectorsFile = defaultSectorsFile(repoRoot);

  if (fs.existsSync(sectorsFile)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(sectorsFile, 'utf8'));
      if (parsed?.version === 2 && Array.isArray(parsed.sectors)) {
        // Normalize fields
        for (const s of parsed.sectors) {
          s.path = norm(s.path ?? '.');
          s.purpose ??= '';
          s.fileCount ??= 0;
          s.lastScannedAt ??= 0;
          s.lastScannedCycle ??= 0;
          s.production ??= true;
          s.productionFileCount ??= s.fileCount ?? 0;
          s.classificationConfidence ??= 'low';
          s.scanCount ??= 0;
          s.proposalYield ??= 0;
          s.successCount ??= 0;
          s.failureCount ??= 0;
          s.polishedAt ??= 0;
        }
        return parsed as SectorState;
      }
    } catch {
      // fallthrough to rebuild
    }
  }

  // Build fresh (v1 files are discarded — not worth migrating)
  const state: SectorState = {
    version: 2,
    builtAt: new Date().toISOString(),
    sectors: buildSectors(modules),
  };
  saveSectors(repoRoot, state);
  return state;
}

export function refreshSectors(
  repoRoot: string,
  previous: SectorState,
  modules: CodebaseModuleLike[],
): SectorState {
  const fresh = buildSectors(modules);
  const prevByPath = new Map(previous.sectors.map(s => [s.path, s]));

  const merged = fresh.map(s => {
    const prev = prevByPath.get(s.path);
    if (!prev) return s;
    // Reset polishedAt if file count changed significantly (>20%)
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

  const state: SectorState = {
    version: 2,
    builtAt: new Date().toISOString(),
    sectors: merged,
  };
  saveSectors(repoRoot, state);
  return state;
}

export function getSectorDifficulty(sector: Sector): 'easy' | 'moderate' | 'hard' {
  const total = sector.successCount + sector.failureCount;
  if (total < 3) return 'easy';
  const failRate = sector.failureCount / total;
  if (failRate > 0.6) return 'hard';
  if (failRate > 0.3) return 'moderate';
  return 'easy';
}

export function getSectorMinConfidence(sector: Sector, base: number): number {
  const difficulty = getSectorDifficulty(sector);
  if (difficulty === 'hard') return base + 20;
  if (difficulty === 'moderate') return base + 10;
  return base;
}

export function pickNextSector(state: SectorState, currentCycle: number): { sector: Sector; scope: string } | null {
  if (state.sectors.length === 0) return null;

  const primary = state.sectors.filter(s => s.fileCount > 0 && s.production);
  const candidates =
    primary.some(s => s.lastScannedAt === 0) ? primary
    : primary.some(s => currentCycle - s.lastScannedCycle >= 2) ? primary
    : state.sectors.filter(s => s.fileCount > 0); // include non-production as fallback

  if (candidates.length === 0) return null;

  // Detect polished sectors: scanned many times with low yield and low success
  for (const s of candidates) {
    const total = s.successCount + s.failureCount;
    const successRate = total > 0 ? s.successCount / total : 0;
    if (s.scanCount >= 5 && s.proposalYield < 0.3 && (total < 2 || successRate < 0.3)) {
      if (!s.polishedAt) s.polishedAt = Date.now();
    }
  }

  const now = Date.now();
  candidates.sort((a, b) => {
    // 0. Polished sectors sort after everything (massive deprioritization)
    const aPolished = (a.polishedAt ?? 0) > 0 ? 1 : 0;
    const bPolished = (b.polishedAt ?? 0) > 0 ? 1 : 0;
    if (aPolished !== bPolished) return aPolished - bPolished;

    // 1. Never-scanned first
    if ((a.lastScannedAt === 0) !== (b.lastScannedAt === 0)) return a.lastScannedAt === 0 ? -1 : 1;
    // 2. Cycle staleness (lower lastScannedCycle first)
    if (a.lastScannedCycle !== b.lastScannedCycle) return a.lastScannedCycle - b.lastScannedCycle;
    // 3. Temporal decay: if |daysDiff| > 7, older sector first
    const aDays = (now - a.lastScannedAt) / 86400000;
    const bDays = (now - b.lastScannedAt) / 86400000;
    if (aDays > 7 && bDays > 7 && Math.abs(aDays - bDays) > 1) return bDays - aDays > 0 ? -1 : 1;
    // 4. Low-confidence sectors first
    const aLow = a.classificationConfidence === 'low' ? 1 : 0;
    const bLow = b.classificationConfidence === 'low' ? 1 : 0;
    if (aLow !== bLow) return bLow - aLow;
    // 5. Barren deprioritization: scanCount > 2 && proposalYield < 0.5 → sort later
    const aBarren = a.scanCount > 2 && a.proposalYield < 0.5 ? 1 : 0;
    const bBarren = b.scanCount > 2 && b.proposalYield < 0.5 ? 1 : 0;
    if (aBarren !== bBarren) return aBarren - bBarren;
    // 6. High failure rate deprioritization
    const aFail = a.failureCount >= 3 && a.failureCount / (a.failureCount + a.successCount) > 0.6 ? 1 : 0;
    const bFail = b.failureCount >= 3 && b.failureCount / (b.failureCount + b.successCount) > 0.6 ? 1 : 0;
    if (aFail !== bFail) return aFail - bFail;
    // 7. Higher proposalYield first
    if (a.proposalYield !== b.proposalYield) return b.proposalYield - a.proposalYield;
    // 8. Higher successCount first (tiebreaker)
    if (a.successCount !== b.successCount) return b.successCount - a.successCount;
    // 9. Alphabetical
    return a.path.localeCompare(b.path);
  });

  const sector = candidates[0];
  return { sector, scope: sectorToScope(sector) };
}

export function computeCoverage(state: SectorState): {
  scannedSectors: number;
  totalSectors: number;
  scannedFiles: number;
  totalFiles: number;
  percent: number;
  sectorPercent: number;
  unclassifiedSectors: number;
} {
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

export function recordTicketOutcome(state: SectorState, sectorPath: string, success: boolean, category?: string): void {
  const s = state.sectors.find(x => x.path === sectorPath);
  if (!s) return;
  if (success) s.successCount++; else s.failureCount++;
  const total = s.successCount + s.failureCount;
  if (total > 0 && total % 20 === 0) {
    s.successCount = Math.round(s.successCount * 0.7);
    s.failureCount = Math.round(s.failureCount * 0.7);
  }
  // Category×Sector affinity tracking
  if (category) {
    s.categoryStats ??= {};
    const cs = s.categoryStats[category] ??= { success: 0, failure: 0 };
    if (success) cs.success++; else cs.failure++;
  }
}

export function updateProposalYield(state: SectorState, sectorPath: string, acceptedCount: number): void {
  const s = state.sectors.find(x => x.path === sectorPath);
  if (!s) return;
  s.proposalYield = 0.7 * s.proposalYield + 0.3 * acceptedCount;
}

export function recordScanResult(
  state: SectorState,
  sectorPath: string,
  currentCycle: number,
  proposalCount: number,
  reclassification?: { production?: boolean; confidence?: string },
): void {
  const s = state.sectors.find(x => x.path === sectorPath);
  if (!s) return;

  s.lastScannedAt = Date.now();
  s.lastScannedCycle = currentCycle;
  s.scanCount = (s.scanCount ?? 0) + 1;
  s.proposalYield = 0.7 * (s.proposalYield ?? 0) + 0.3 * proposalCount;

  // Apply reclassification if confidence is medium or high
  if (reclassification && (reclassification.confidence === 'medium' || reclassification.confidence === 'high')) {
    if (reclassification.production !== undefined) {
      s.production = reclassification.production;
    }
    s.classificationConfidence = reclassification.confidence;
  }
}

/**
 * Record a PR merge/close outcome on a sector.
 */
export function recordMergeOutcome(state: SectorState, sectorPath: string, merged: boolean): void {
  const s = state.sectors.find(x => x.path === sectorPath);
  if (!s) return;
  if (merged) {
    s.mergeCount = (s.mergeCount ?? 0) + 1;
  } else {
    s.closedCount = (s.closedCount ?? 0) + 1;
  }
}

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
    if (total < 3) continue;
    const rate = stats.success / total;
    if (rate > 0.6) boost.push(cat);
    else if (rate < 0.3) suppress.push(cat);
  }
  return { boost, suppress };
}

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
  if (avg < 0.3) return 'widen';

  // Check if top 3 have much higher yield
  const topAvg = yields.slice(0, 3).reduce((s, v) => s + v, 0) / Math.min(3, yields.length);
  if (avg > 0 && topAvg > avg * 2) return 'narrow';

  return 'stable';
}
