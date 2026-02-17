/**
 * I/O tests for sectors.ts — saveSectors, loadOrBuildSectors, refreshSectors.
 *
 * Exercises the persistence layer that wraps the pure core algorithms.
 * Uses real temp directories for file I/O.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  saveSectors,
  loadOrBuildSectors,
  refreshSectors,
  type SectorState,
  type CodebaseModuleLike,
} from '../lib/sectors.js';

let tmpDir: string;

function sectorsFile(): string {
  return path.join(tmpDir, '.promptwheel', 'sectors.json');
}

function makeModules(...names: string[]): CodebaseModuleLike[] {
  return names.map(name => ({
    path: name,
    file_count: 5,
    production_file_count: 3,
    purpose: 'source',
    production: true,
    classification_confidence: 'high',
  }));
}

function makeSectorState(sectorPaths: string[]): SectorState {
  return {
    version: 2,
    builtAt: new Date().toISOString(),
    sectors: sectorPaths.map(p => ({
      path: p,
      purpose: 'source',
      production: true,
      fileCount: 5,
      productionFileCount: 3,
      classificationConfidence: 'high',
      lastScannedAt: 0,
      lastScannedCycle: 0,
      scanCount: 0,
      proposalYield: 0,
      successCount: 0,
      failureCount: 0,
    })),
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sectors-io-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// saveSectors
// ---------------------------------------------------------------------------

describe('saveSectors', () => {
  it('creates .promptwheel directory and writes sectors.json', () => {
    const state = makeSectorState(['src/lib']);
    saveSectors(tmpDir, state);

    expect(fs.existsSync(sectorsFile())).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(sectorsFile(), 'utf8'));
    expect(parsed.version).toBe(2);
    expect(parsed.sectors).toHaveLength(1);
    expect(parsed.sectors[0].path).toBe('src/lib');
  });

  it('overwrites existing file atomically (no .tmp left behind)', () => {
    const state1 = makeSectorState(['alpha']);
    const state2 = makeSectorState(['beta']);

    saveSectors(tmpDir, state1);
    saveSectors(tmpDir, state2);

    const parsed = JSON.parse(fs.readFileSync(sectorsFile(), 'utf8'));
    expect(parsed.sectors).toHaveLength(1);
    expect(parsed.sectors[0].path).toBe('beta');

    // No .tmp file should remain
    expect(fs.existsSync(sectorsFile() + '.tmp')).toBe(false);
  });

  it('preserves all sector fields through JSON round-trip', () => {
    const state = makeSectorState(['src']);
    state.sectors[0].scanCount = 3;
    state.sectors[0].proposalYield = 2.5;
    state.sectors[0].successCount = 7;
    state.sectors[0].failureCount = 1;
    state.sectors[0].lastScannedAt = 1700000000000;
    state.sectors[0].lastScannedCycle = 5;

    saveSectors(tmpDir, state);
    const parsed = JSON.parse(fs.readFileSync(sectorsFile(), 'utf8'));

    expect(parsed.sectors[0].scanCount).toBe(3);
    expect(parsed.sectors[0].proposalYield).toBe(2.5);
    expect(parsed.sectors[0].successCount).toBe(7);
    expect(parsed.sectors[0].failureCount).toBe(1);
    expect(parsed.sectors[0].lastScannedAt).toBe(1700000000000);
    expect(parsed.sectors[0].lastScannedCycle).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// loadOrBuildSectors
// ---------------------------------------------------------------------------

describe('loadOrBuildSectors', () => {
  it('builds fresh when no file exists', () => {
    const modules = makeModules('src/lib', 'src/test');
    const state = loadOrBuildSectors(tmpDir, modules);

    expect(state.version).toBe(2);
    expect(state.sectors).toHaveLength(2);
    // Should also persist to disk
    expect(fs.existsSync(sectorsFile())).toBe(true);
  });

  it('loads existing version 2 file', () => {
    // Pre-write a valid state
    const existing = makeSectorState(['src/lib']);
    existing.sectors[0].scanCount = 10;
    fs.mkdirSync(path.dirname(sectorsFile()), { recursive: true });
    fs.writeFileSync(sectorsFile(), JSON.stringify(existing), 'utf8');

    const state = loadOrBuildSectors(tmpDir, makeModules('src/lib'));

    expect(state.sectors).toHaveLength(1);
    expect(state.sectors[0].scanCount).toBe(10);
  });

  it('rebuilds on corrupt JSON', () => {
    fs.mkdirSync(path.dirname(sectorsFile()), { recursive: true });
    fs.writeFileSync(sectorsFile(), 'not valid json!!!', 'utf8');

    const modules = makeModules('src/lib');
    const state = loadOrBuildSectors(tmpDir, modules);

    expect(state.version).toBe(2);
    expect(state.sectors).toHaveLength(1);
    expect(state.sectors[0].path).toBe('src/lib');
  });

  it('rebuilds when version is not 2', () => {
    fs.mkdirSync(path.dirname(sectorsFile()), { recursive: true });
    fs.writeFileSync(sectorsFile(), JSON.stringify({ version: 1, sectors: [] }), 'utf8');

    const modules = makeModules('src/api');
    const state = loadOrBuildSectors(tmpDir, modules);

    expect(state.version).toBe(2);
    expect(state.sectors).toHaveLength(1);
    expect(state.sectors[0].path).toBe('src/api');
  });

  it('rebuilds when sectors field is missing', () => {
    fs.mkdirSync(path.dirname(sectorsFile()), { recursive: true });
    fs.writeFileSync(sectorsFile(), JSON.stringify({ version: 2 }), 'utf8');

    const modules = makeModules('src/core');
    const state = loadOrBuildSectors(tmpDir, modules);

    expect(state.sectors).toHaveLength(1);
    expect(state.sectors[0].path).toBe('src/core');
  });

  it('normalizes fields on loaded sectors', () => {
    // Write a sector missing some fields that normalizeSectorFields should fill in
    fs.mkdirSync(path.dirname(sectorsFile()), { recursive: true });
    fs.writeFileSync(sectorsFile(), JSON.stringify({
      version: 2,
      builtAt: new Date().toISOString(),
      sectors: [{
        path: 'src/lib',
        // Missing many fields — normalizeSectorFields should add defaults
      }],
    }), 'utf8');

    const state = loadOrBuildSectors(tmpDir, makeModules('src/lib'));

    expect(state.sectors).toHaveLength(1);
    expect(state.sectors[0].path).toBe('src/lib');
    // normalizeSectorFields should provide defaults for missing fields
    expect(typeof state.sectors[0].fileCount).toBe('number');
    expect(typeof state.sectors[0].scanCount).toBe('number');
    expect(typeof state.sectors[0].production).toBe('boolean');
  });
});

// ---------------------------------------------------------------------------
// refreshSectors
// ---------------------------------------------------------------------------

describe('refreshSectors', () => {
  it('merges fresh modules with previous state', () => {
    const previous = makeSectorState(['src/lib', 'src/old']);
    previous.sectors[0].scanCount = 5;
    previous.sectors[0].successCount = 3;

    const modules = makeModules('src/lib', 'src/new');
    const state = refreshSectors(tmpDir, previous, modules);

    expect(state.version).toBe(2);
    // Should contain both the preserved sector and new sector
    const paths = state.sectors.map(s => s.path).sort();
    expect(paths).toContain('src/lib');
    expect(paths).toContain('src/new');
    // Preserved sector should retain scanCount from merge
    const lib = state.sectors.find(s => s.path === 'src/lib');
    expect(lib).toBeDefined();
    expect(lib!.scanCount).toBe(5);
  });

  it('persists merged state to disk', () => {
    const previous = makeSectorState(['src/lib']);
    const modules = makeModules('src/lib', 'src/api');

    refreshSectors(tmpDir, previous, modules);

    expect(fs.existsSync(sectorsFile())).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(sectorsFile(), 'utf8'));
    expect(parsed.version).toBe(2);
    expect(parsed.sectors.length).toBeGreaterThanOrEqual(2);
  });

  it('handles empty previous state', () => {
    const previous: SectorState = {
      version: 2,
      builtAt: new Date().toISOString(),
      sectors: [],
    };

    const modules = makeModules('src/lib');
    const state = refreshSectors(tmpDir, previous, modules);

    expect(state.sectors).toHaveLength(1);
    expect(state.sectors[0].path).toBe('src/lib');
  });

  it('handles empty modules list', () => {
    const previous = makeSectorState(['src/lib']);
    const state = refreshSectors(tmpDir, previous, []);

    // No fresh modules — merge result depends on core mergeSectors behavior
    // (stale sectors may be kept or dropped depending on implementation)
    expect(state.version).toBe(2);
    expect(Array.isArray(state.sectors)).toBe(true);
  });
});
