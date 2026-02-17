/**
 * Sector-based scout scanning with staleness-based rotation.
 *
 * Pure algorithms (rotation, classification, coverage, recording) live in
 * @promptwheel/core/sectors/shared. This file provides I/O wrappers
 * (persistence to `.promptwheel/sectors.json`) and re-exports.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { metric } from './metrics.js';

// Re-export everything from core
export {
  type Sector,
  type SectorState,
  type CodebaseModuleLike,
  type CoverageMetrics,
  normalizeSectorPath,
  sectorToScope,
  buildSectors,
  normalizeSectorFields,
  mergeSectors,
  getSectorDifficulty,
  getSectorMinConfidence,
  computeCoverage,
  buildSectorSummary,
  recordScanResult,
  recordTicketOutcome,
  updateProposalYield,
  recordMergeOutcome,
  getSectorCategoryAffinity,
  suggestScopeAdjustment,
} from '@promptwheel/core/sectors/shared';

// Import for local use
import type { Sector, SectorState, CodebaseModuleLike } from '@promptwheel/core/sectors/shared';
import {
  buildSectors,
  normalizeSectorFields,
  mergeSectors,
  pickNextSector as pickNextSectorCore,
} from '@promptwheel/core/sectors/shared';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STATE_DIR = '.promptwheel';
const STATE_FILE = 'sectors.json';

// ---------------------------------------------------------------------------
// I/O helpers
// ---------------------------------------------------------------------------

function defaultSectorsFile(repoRoot: string): string {
  return path.join(repoRoot, STATE_DIR, STATE_FILE);
}

function ensureStateDir(repoRoot: string): void {
  const d = path.join(repoRoot, STATE_DIR);
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
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
// Public API — I/O wrappers
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
        // Normalize fields using core function
        parsed.sectors = parsed.sectors.map((s: Partial<Sector>) => normalizeSectorFields(s));
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
  const merged = mergeSectors(fresh, previous.sectors);

  const state: SectorState = {
    version: 2,
    builtAt: new Date().toISOString(),
    sectors: merged,
  };
  saveSectors(repoRoot, state);
  return state;
}

/**
 * Pick next sector with CLI metric instrumentation.
 * Wraps the core pure algorithm and adds metric() call.
 */
export function pickNextSector(state: SectorState, currentCycle: number): { sector: Sector; scope: string } | null {
  const result = pickNextSectorCore(state, currentCycle);
  if (!result) return null;

  // Instrument: track sector selection
  metric('sectors', 'picked', {
    path: result.sector.path,
    scanCount: result.sector.scanCount,
    proposalYield: result.sector.proposalYield,
    candidateCount: state.sectors.filter(s => s.fileCount > 0).length,
    totalSectors: state.sectors.length,
  });

  return result;
}
