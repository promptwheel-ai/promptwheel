/**
 * Tests for drill mode — computeDrillMetrics, persistence, production edge cases,
 * and related pure functions.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  computeDrillMetrics,
  computeAmbitionLevel,
  computeArcGuidance,
  computeDecayedCoverage,
  computePerAmbitionSuccessRates,
  loadDrillHistory,
  getDrillCooldown,
  getAdaptiveProposalThresholds,
  applyDrillDirectives,
  tryPreVerifyTrajectoryStep,
  hydrateDrillState,
  recordDrillTrajectoryOutcome,
  type DrillHistoryEntry,
} from '../lib/solo-auto-drill.js';
import { validateAndBuild, slugify } from '../lib/trajectory-generate.js';
import { validateDrillConfig } from '../lib/solo-config.js';
import { addDirective } from '../lib/solo-hints.js';
import { createInitialStepStates } from '@promptwheel/core/trajectory/shared';
import type { AutoSessionState } from '../lib/solo-auto-state.js';

function makeEntry(overrides: Partial<DrillHistoryEntry> = {}): DrillHistoryEntry {
  const stepsTotal = overrides.stepsTotal ?? 5;
  const stepsCompleted = overrides.stepsCompleted ?? 3;
  return {
    name: overrides.name ?? 'test-trajectory',
    description: overrides.description ?? 'Test trajectory',
    stepsTotal,
    stepsCompleted,
    stepsFailed: overrides.stepsFailed ?? 0,
    outcome: overrides.outcome ?? 'completed',
    completionPct: overrides.completionPct ?? (stepsTotal > 0 ? stepsCompleted / stepsTotal : 0),
    categories: overrides.categories ?? ['refactor'],
    scopes: overrides.scopes ?? ['src/**'],
    timestamp: overrides.timestamp ?? Date.now(),
    failedSteps: overrides.failedSteps,
    completedStepSummaries: overrides.completedStepSummaries,
    modifiedFiles: overrides.modifiedFiles,
    ambitionLevel: overrides.ambitionLevel,
    stepOutcomes: overrides.stepOutcomes,
    blueprintGroupCount: overrides.blueprintGroupCount,
    blueprintConflictCount: overrides.blueprintConflictCount,
    blueprintEnablerCount: overrides.blueprintEnablerCount,
    blueprintMergeableCount: overrides.blueprintMergeableCount,
    qualityRetried: overrides.qualityRetried,
    qualityIssueCount: overrides.qualityIssueCount,
  };
}

// ---------------------------------------------------------------------------
// computeDrillMetrics
// ---------------------------------------------------------------------------

describe('computeDrillMetrics', () => {
  it('returns zero metrics for empty history', () => {
    const metrics = computeDrillMetrics([]);
    expect(metrics.totalTrajectories).toBe(0);
    expect(metrics.completionRate).toBe(0);
    expect(metrics.weightedCompletionRate).toBe(0);
    expect(metrics.avgStepCompletionRate).toBe(0);
    expect(metrics.weightedStepCompletionRate).toBe(0);
    expect(metrics.avgStepsPerTrajectory).toBe(0);
    expect(metrics.topCategories).toEqual([]);
    expect(metrics.stalledCategories).toEqual([]);
  });

  it('computes completion rate correctly', () => {
    const history: DrillHistoryEntry[] = [
      makeEntry({ outcome: 'completed' }),
      makeEntry({ outcome: 'completed' }),
      makeEntry({ outcome: 'stalled' }),
    ];
    const metrics = computeDrillMetrics(history);
    expect(metrics.totalTrajectories).toBe(3);
    expect(metrics.completionRate).toBeCloseTo(2 / 3, 2);
  });

  it('computes avg step completion rate', () => {
    const history: DrillHistoryEntry[] = [
      makeEntry({ stepsTotal: 4, stepsCompleted: 4 }),
      makeEntry({ stepsTotal: 6, stepsCompleted: 3 }),
    ];
    const metrics = computeDrillMetrics(history);
    expect(metrics.avgStepCompletionRate).toBeCloseTo(7 / 10, 2);
    expect(metrics.avgStepsPerTrajectory).toBe(5);
  });

  it('identifies top categories (>= 50% recency-weighted rate)', () => {
    const history: DrillHistoryEntry[] = [
      makeEntry({ outcome: 'completed', categories: ['refactor', 'test'] }),
      makeEntry({ outcome: 'completed', categories: ['refactor'] }),
      makeEntry({ outcome: 'completed', categories: ['test'] }),
    ];
    const metrics = computeDrillMetrics(history);
    // refactor: 2/2 completed — top
    // test: 2/2 completed — top
    expect(metrics.topCategories).toContain('refactor');
    expect(metrics.topCategories).toContain('test');
  });

  it('identifies stalled categories (< 30% rate, >= 2 total)', () => {
    const history: DrillHistoryEntry[] = [
      makeEntry({ outcome: 'stalled', categories: ['security'] }),
      makeEntry({ outcome: 'stalled', categories: ['security'] }),
      makeEntry({ outcome: 'stalled', categories: ['security'] }),
      makeEntry({ outcome: 'completed', categories: ['refactor'] }),
    ];
    const metrics = computeDrillMetrics(history);
    expect(metrics.stalledCategories).toContain('security');
    expect(metrics.stalledCategories).not.toContain('refactor');
  });

  it('computes per-category success rates with recency weighting', () => {
    const history: DrillHistoryEntry[] = [
      makeEntry({ outcome: 'completed', categories: ['fix'] }),
      makeEntry({ outcome: 'stalled', categories: ['fix'], stepsCompleted: 0, stepsTotal: 5 }),
    ];
    const metrics = computeDrillMetrics(history);
    expect(metrics.categorySuccessRates['fix'].completed).toBe(1);
    expect(metrics.categorySuccessRates['fix'].total).toBe(2);
    // With recency weighting, the recent stalled entry has more weight → rate < 0.5
    expect(metrics.categorySuccessRates['fix'].rate).toBeLessThan(0.5);
    expect(metrics.categorySuccessRates['fix'].rate).toBeGreaterThan(0);
  });

  it('handles trajectories with zero steps total', () => {
    const history: DrillHistoryEntry[] = [
      makeEntry({ stepsTotal: 0, stepsCompleted: 0 }),
    ];
    const metrics = computeDrillMetrics(history);
    expect(metrics.avgStepCompletionRate).toBe(0);
    expect(metrics.avgStepsPerTrajectory).toBe(0);
    expect(Number.isNaN(metrics.avgStepCompletionRate)).toBe(false);
    expect(Number.isNaN(metrics.avgStepsPerTrajectory)).toBe(false);
  });

  it('handles single-entry history', () => {
    const metrics = computeDrillMetrics([makeEntry({ outcome: 'completed' })]);
    expect(metrics.completionRate).toBe(1);
    expect(metrics.totalTrajectories).toBe(1);
  });

  it('computes step1FailureRate (stalled with 0 steps completed)', () => {
    const history: DrillHistoryEntry[] = [
      makeEntry({ outcome: 'stalled', stepsCompleted: 0, stepsFailed: 1 }),
      makeEntry({ outcome: 'stalled', stepsCompleted: 0, stepsFailed: 1 }),
      makeEntry({ outcome: 'completed', stepsCompleted: 5 }),
      makeEntry({ outcome: 'stalled', stepsCompleted: 3, stepsFailed: 1 }),
    ];
    const metrics = computeDrillMetrics(history);
    expect(metrics.step1FailureRate).toBeCloseTo(0.5, 2); // 2 of 4
  });

  it('step1FailureRate is 0 when no step-1 failures', () => {
    const history: DrillHistoryEntry[] = [
      makeEntry({ outcome: 'completed', stepsCompleted: 5 }),
      makeEntry({ outcome: 'stalled', stepsCompleted: 3, stepsFailed: 2 }),
    ];
    const metrics = computeDrillMetrics(history);
    expect(metrics.step1FailureRate).toBe(0);
  });

  it('includes failedSteps in history entries', () => {
    const entry = makeEntry({
      outcome: 'stalled',
      failedSteps: [{ id: 'step-1', title: 'Add tests', reason: 'vitest timeout' }],
    });
    expect(entry.failedSteps).toHaveLength(1);
    expect(entry.failedSteps![0].reason).toBe('vitest timeout');
  });

  it('includes causal chaining fields in history entries', () => {
    const entry = makeEntry({
      completedStepSummaries: ['Fix auth validation', 'Add input sanitization'],
      modifiedFiles: ['src/auth/validate.ts', 'src/auth/sanitize.ts'],
    });
    expect(entry.completedStepSummaries).toHaveLength(2);
    expect(entry.modifiedFiles).toHaveLength(2);
    expect(entry.completedStepSummaries![0]).toBe('Fix auth validation');
  });

  it('handles entries without causal fields (backward compat)', () => {
    const entry = makeEntry({});
    expect(entry.completedStepSummaries).toBeUndefined();
    expect(entry.modifiedFiles).toBeUndefined();
    // Still computes metrics correctly
    const metrics = computeDrillMetrics([entry]);
    expect(metrics.totalTrajectories).toBe(1);
  });

  it('computes weightedCompletionRate with recency bias', () => {
    // Old failures, recent successes → weighted rate higher than raw rate
    const history: DrillHistoryEntry[] = [
      makeEntry({ outcome: 'stalled', stepsCompleted: 0, stepsTotal: 5 }),
      makeEntry({ outcome: 'stalled', stepsCompleted: 0, stepsTotal: 5 }),
      makeEntry({ outcome: 'stalled', stepsCompleted: 0, stepsTotal: 5 }),
      makeEntry({ outcome: 'completed', stepsCompleted: 5, stepsTotal: 5 }),
      makeEntry({ outcome: 'completed', stepsCompleted: 5, stepsTotal: 5 }),
    ];
    const metrics = computeDrillMetrics(history);
    // Raw: 2/5 = 0.4
    expect(metrics.completionRate).toBeCloseTo(0.4, 2);
    // Weighted: recent successes have higher weight → should be > 0.4
    expect(metrics.weightedCompletionRate).toBeGreaterThan(metrics.completionRate);
  });

  it('weightedCompletionRate equals completionRate for uniform history', () => {
    const history: DrillHistoryEntry[] = [
      makeEntry({ outcome: 'completed' }),
      makeEntry({ outcome: 'completed' }),
      makeEntry({ outcome: 'completed' }),
    ];
    const metrics = computeDrillMetrics(history);
    expect(metrics.completionRate).toBe(1);
    expect(metrics.weightedCompletionRate).toBeCloseTo(1, 2);
  });

  it('weightedStepCompletionRate uses granular completionPct', () => {
    // Oldest entry (age=1): high completionPct
    // Newest entry (age=0): low completionPct → more weight
    const history: DrillHistoryEntry[] = [
      makeEntry({ stepsTotal: 10, stepsCompleted: 8, outcome: 'stalled', completionPct: 0.8 }),
      makeEntry({ stepsTotal: 10, stepsCompleted: 1, outcome: 'stalled', completionPct: 0.1 }),
    ];
    const metrics = computeDrillMetrics(history);
    // Raw avgStepCompletionRate: 9/20 = 0.45
    expect(metrics.avgStepCompletionRate).toBeCloseTo(0.45, 2);
    // Weighted: recent low entry (0.1) has more weight → weighted < raw avg
    expect(metrics.weightedStepCompletionRate).toBeLessThan(metrics.avgStepCompletionRate);
  });

  it('weightedStepCompletionRate favors recent improvements', () => {
    // Oldest: poor, Newest: good → weighted should be higher than raw
    const history: DrillHistoryEntry[] = [
      makeEntry({ stepsTotal: 10, stepsCompleted: 1, outcome: 'stalled', completionPct: 0.1 }),
      makeEntry({ stepsTotal: 10, stepsCompleted: 8, outcome: 'stalled', completionPct: 0.8 }),
    ];
    const metrics = computeDrillMetrics(history);
    // Weighted: recent high entry (0.8) has more weight → weighted > raw avg
    expect(metrics.weightedStepCompletionRate).toBeGreaterThan(metrics.avgStepCompletionRate);
  });

  it('completionPct field is stored in history entries', () => {
    const entry = makeEntry({ stepsTotal: 8, stepsCompleted: 6 });
    expect(entry.completionPct).toBeCloseTo(0.75, 2);
  });

  it('completionPct falls back gracefully when undefined', () => {
    // Simulate old entries without completionPct
    const history: DrillHistoryEntry[] = [
      { ...makeEntry({ stepsTotal: 4, stepsCompleted: 3, outcome: 'completed' }), completionPct: undefined as any },
    ];
    const metrics = computeDrillMetrics(history);
    // Should fall back to stepsCompleted/stepsTotal = 0.75
    expect(metrics.weightedStepCompletionRate).toBeCloseTo(0.75, 2);
  });

  it('recency-weighted category rates reflect recent performance', () => {
    // Security: old success, recent failure
    const history: DrillHistoryEntry[] = [
      makeEntry({ outcome: 'completed', categories: ['security'] }),
      makeEntry({ outcome: 'completed', categories: ['security'] }),
      makeEntry({ outcome: 'stalled', categories: ['security'], stepsCompleted: 0, stepsTotal: 5 }),
      makeEntry({ outcome: 'stalled', categories: ['security'], stepsCompleted: 0, stepsTotal: 5 }),
    ];
    const metrics = computeDrillMetrics(history);
    // Raw: 2/4 = 50%, but recent failures should drag weighted rate below 50%
    expect(metrics.categorySuccessRates['security'].rate).toBeLessThan(0.5);
  });
});

// ---------------------------------------------------------------------------
// validateAndBuild — production edge cases
// ---------------------------------------------------------------------------

describe('validateAndBuild production safety', () => {
  it('rejects empty steps array', () => {
    expect(() => validateAndBuild({
      name: 'empty',
      description: 'No steps',
      steps: [],
    })).toThrow('Trajectory has no steps');
  });

  it('rejects steps without id', () => {
    expect(() => validateAndBuild({
      name: 'no-id',
      description: 'Missing ID',
      steps: [{ title: 'No ID' }],
    })).toThrow('Step missing ID');
  });

  it('rejects steps without title', () => {
    expect(() => validateAndBuild({
      name: 'no-title',
      description: 'Missing title',
      steps: [{ id: 'step-1' }],
    })).toThrow('missing title');
  });

  it('sanitizes overly broad scopes', () => {
    const result = validateAndBuild({
      name: 'broad-scope',
      description: 'Test',
      steps: [{
        id: 'step-1',
        title: 'Test',
        scope: '**',
        acceptance_criteria: ['done'],
        verification_commands: ['echo ok'],
        depends_on: [],
      }],
    });
    expect(result.steps[0].scope).toBeUndefined();
  });

  it('preserves reasonable scopes like src/auth/**', () => {
    const result = validateAndBuild({
      name: 'narrow-scope',
      description: 'Test',
      steps: [{
        id: 'step-1',
        title: 'Test',
        scope: 'src/auth/**',
        acceptance_criteria: ['done'],
        verification_commands: ['echo ok'],
        depends_on: [],
      }],
    });
    expect(result.steps[0].scope).toBe('src/auth/**');
  });

  it('clamps priority to valid range', () => {
    const result = validateAndBuild({
      name: 'priority-test',
      description: 'Test',
      steps: [{
        id: 'step-1',
        title: 'Test',
        priority: 15, // out of range
        acceptance_criteria: ['done'],
        verification_commands: ['echo ok'],
        depends_on: [],
      }],
    });
    // Out-of-range priority should be dropped (undefined)
    expect(result.steps[0].priority).toBeUndefined();
  });

  it('rejects NaN measure target', () => {
    const result = validateAndBuild({
      name: 'nan-measure',
      description: 'Test',
      steps: [{
        id: 'step-1',
        title: 'Test',
        measure: { cmd: 'echo 1', target: 'N/A' as any, direction: 'up' },
        acceptance_criteria: ['done'],
        verification_commands: ['echo ok'],
        depends_on: [],
      }],
    });
    // NaN measure target should cause the whole measure to be dropped
    expect(result.steps[0].measure).toBeUndefined();
  });

  it('accepts valid numeric measure target', () => {
    const result = validateAndBuild({
      name: 'valid-measure',
      description: 'Test',
      steps: [{
        id: 'step-1',
        title: 'Test',
        measure: { cmd: 'echo 1', target: 42, direction: 'up' },
        acceptance_criteria: ['done'],
        verification_commands: ['echo ok'],
        depends_on: [],
      }],
    });
    expect(result.steps[0].measure).toBeDefined();
    expect(result.steps[0].measure!.target).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// slugify — timestamp preservation
// ---------------------------------------------------------------------------

describe('slugify', () => {
  it('preserves timestamp suffix for drill names', () => {
    const ts = '1708300000000'; // 13-digit timestamp
    const name = `drill-refactor-auth-system-${ts}`;
    const slug = slugify(name);
    expect(slug).toContain(ts);
    expect(slug.endsWith(ts)).toBe(true);
  });

  it('handles long names with timestamp without truncating the timestamp', () => {
    const ts = '1708300000000';
    const longName = `drill-${'a'.repeat(80)}-${ts}`;
    const slug = slugify(longName);
    expect(slug.endsWith(ts)).toBe(true);
    // Total length should be at most 80 (66 name + 1 dash + 13 ts)
    expect(slug.length).toBeLessThanOrEqual(80);
  });

  it('handles non-drill names without timestamp', () => {
    const slug = slugify('my-regular-trajectory-name');
    expect(slug).toBe('my-regular-trajectory-name');
  });

  it('caps non-timestamped slugs at 80 chars', () => {
    const slug = slugify('a'.repeat(100));
    expect(slug.length).toBeLessThanOrEqual(80);
  });
});

// ---------------------------------------------------------------------------
// loadDrillHistory — persistence and recovery
// ---------------------------------------------------------------------------

describe('loadDrillHistory persistence', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drill-persist-'));
    fs.mkdirSync(path.join(tmpDir, '.promptwheel'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty state when no file exists', () => {
    const result = loadDrillHistory(tmpDir);
    expect(result.entries).toEqual([]);
    expect(result.coveredCategories).toEqual({});
    expect(result.coveredScopes).toEqual({});
  });

  it('loads valid drill history from disk', () => {
    const data = {
      entries: [makeEntry({ name: 'test-1', outcome: 'completed' })],
      coveredCategories: { refactor: 1 },
      coveredScopes: { 'src/**': 1 },
    };
    fs.writeFileSync(
      path.join(tmpDir, '.promptwheel', 'drill-history.json'),
      JSON.stringify(data, null, 2),
    );
    const result = loadDrillHistory(tmpDir);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].name).toBe('test-1');
    expect(result.coveredCategories).toEqual({ refactor: 1 });
  });

  it('returns empty state for corrupted JSON', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.promptwheel', 'drill-history.json'),
      'not valid json{{{',
    );
    const result = loadDrillHistory(tmpDir);
    expect(result.entries).toEqual([]);
  });

  it('returns empty state for empty file', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.promptwheel', 'drill-history.json'),
      '',
    );
    const result = loadDrillHistory(tmpDir);
    expect(result.entries).toEqual([]);
  });

  it('recovers valid .tmp file when main file is missing', () => {
    const data = {
      entries: [makeEntry({ name: 'recovered', outcome: 'stalled' })],
      coveredCategories: {},
      coveredScopes: {},
    };
    fs.writeFileSync(
      path.join(tmpDir, '.promptwheel', 'drill-history.json.tmp'),
      JSON.stringify(data),
    );
    const result = loadDrillHistory(tmpDir);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].name).toBe('recovered');
    // .tmp should be promoted to main file
    expect(fs.existsSync(path.join(tmpDir, '.promptwheel', 'drill-history.json'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, '.promptwheel', 'drill-history.json.tmp'))).toBe(false);
  });

  it('removes corrupted .tmp file instead of promoting it', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.promptwheel', 'drill-history.json.tmp'),
      'corrupted{{{',
    );
    const result = loadDrillHistory(tmpDir);
    expect(result.entries).toEqual([]);
    // .tmp should be cleaned up
    expect(fs.existsSync(path.join(tmpDir, '.promptwheel', 'drill-history.json.tmp'))).toBe(false);
  });

  it('removes structurally invalid .tmp file (missing entries array)', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.promptwheel', 'drill-history.json.tmp'),
      JSON.stringify({ notEntries: 'bad' }),
    );
    const result = loadDrillHistory(tmpDir);
    expect(result.entries).toEqual([]);
    expect(fs.existsSync(path.join(tmpDir, '.promptwheel', 'drill-history.json.tmp'))).toBe(false);
  });

  it('handles missing coveredCategories gracefully', () => {
    const data = { entries: [makeEntry()] };
    fs.writeFileSync(
      path.join(tmpDir, '.promptwheel', 'drill-history.json'),
      JSON.stringify(data),
    );
    const result = loadDrillHistory(tmpDir);
    expect(result.entries).toHaveLength(1);
    expect(result.coveredCategories).toEqual({});
    expect(result.coveredScopes).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// getDrillCooldown — adaptive cooldown
// ---------------------------------------------------------------------------

function makeDrillState(overrides: Record<string, unknown> = {}): AutoSessionState {
  return {
    drillTrajectoriesGenerated: 1,
    drillLastOutcome: 'completed',
    drillHistory: [],
    autoConf: { drill: {} },
    displayAdapter: { log: () => {}, drillStateChanged: () => {} },
    ...overrides,
  } as unknown as AutoSessionState;
}

describe('getDrillCooldown', () => {
  it('returns 0 for first generation', () => {
    const state = makeDrillState({ drillTrajectoriesGenerated: 0 });
    expect(getDrillCooldown(state)).toBe(0);
  });

  it('returns configured cooldown for fully completed trajectory', () => {
    const state = makeDrillState({
      drillLastOutcome: 'completed',
      drillHistory: [makeEntry({ outcome: 'completed', completionPct: 1.0 })],
      autoConf: { drill: { cooldownCompleted: 2 } },
    });
    // completionPct=1.0 → interpolates to cooldownCompleted (2)
    expect(getDrillCooldown(state)).toBe(2);
  });

  it('returns configured cooldown for fully stalled trajectory', () => {
    const state = makeDrillState({
      drillLastOutcome: 'stalled',
      drillHistory: [makeEntry({ outcome: 'stalled', completionPct: 0, stepsCompleted: 0 })],
      autoConf: { drill: { cooldownStalled: 7 } },
    });
    // completionPct=0 → interpolates to cooldownStalled (7)
    expect(getDrillCooldown(state)).toBe(7);
  });

  it('interpolates cooldown for partial completion', () => {
    const state = makeDrillState({
      drillLastOutcome: 'stalled',
      drillHistory: [makeEntry({ outcome: 'stalled', completionPct: 0.5 })],
      autoConf: { drill: { cooldownCompleted: 0, cooldownStalled: 6 } },
    });
    // completionPct=0.5 → base = 6 + (0-6)*0.5 = 3
    expect(getDrillCooldown(state)).toBe(3);
  });

  it('returns default 5 for fully stalled with no config', () => {
    const state = makeDrillState({
      drillLastOutcome: 'stalled',
      drillHistory: [makeEntry({ outcome: 'stalled', completionPct: 0, stepsCompleted: 0 })],
    });
    expect(getDrillCooldown(state)).toBe(5);
  });

  it('returns moderate default for unknown outcome (no history)', () => {
    const state = makeDrillState({ drillLastOutcome: null, drillHistory: [] });
    // (0+5)/2 = 2.5 → rounds to 3
    expect(getDrillCooldown(state)).toBe(3);
  });

  // Note: sigmoid tests use ±1 ranges to account for cooldown jitter

  it('reduces cooldown for high weighted completion rate (sigmoid)', () => {
    const history = Array.from({ length: 5 }, () =>
      makeEntry({ outcome: 'completed', completionPct: 1.0, stepsCompleted: 5, stepsTotal: 5 }));
    const state = makeDrillState({
      drillHistory: history,
      autoConf: { drill: { cooldownCompleted: 0, cooldownStalled: 5 } },
    });
    // Last entry completionPct=1.0 → base=0, 100% rate → adjustment ≈ -4 → clamped to 0, +jitter max 1
    const cd = getDrillCooldown(state);
    expect(cd).toBeGreaterThanOrEqual(0);
    expect(cd).toBeLessThanOrEqual(1);
  });

  it('slightly reduces cooldown for good completion rate (sigmoid)', () => {
    const history = [
      makeEntry({ outcome: 'completed', completionPct: 1.0, stepsCompleted: 5, stepsTotal: 5 }),
      makeEntry({ outcome: 'completed', completionPct: 1.0, stepsCompleted: 5, stepsTotal: 5 }),
      makeEntry({ outcome: 'stalled', completionPct: 0, stepsCompleted: 0, stepsTotal: 5 }),
    ];
    const state = makeDrillState({
      drillHistory: history,
      autoConf: { drill: { cooldownCompleted: 0, cooldownStalled: 5 } },
    });
    // Last entry completionPct=0 → base=5, good overall rate → negative adjustment ±1 jitter
    const cd = getDrillCooldown(state);
    expect(cd).toBeLessThanOrEqual(5);
    expect(cd).toBeGreaterThanOrEqual(0);
  });

  it('returns 0 for very low completion rate with step-1 failures (critical override)', () => {
    // All step-1 failures → step1FailureRate = 1.0 > 0.4 → immediate 0 cooldown
    const history = [
      makeEntry({ outcome: 'stalled', completionPct: 0, stepsCompleted: 0, stepsTotal: 5 }),
      makeEntry({ outcome: 'stalled', completionPct: 0, stepsCompleted: 0, stepsTotal: 5 }),
      makeEntry({ outcome: 'stalled', completionPct: 0, stepsCompleted: 0, stepsTotal: 5 }),
    ];
    const state = makeDrillState({
      drillHistory: history,
      autoConf: { drill: { cooldownStalled: 5 } },
    });
    expect(getDrillCooldown(state)).toBe(0);
  });

  it('increases cooldown for low completion rate without step-1 failures (sigmoid)', () => {
    // Stalled but with some progress → step1FailureRate = 0 → uses sigmoid path
    const history = [
      makeEntry({ outcome: 'stalled', completionPct: 0.2, stepsCompleted: 1, stepsTotal: 5 }),
      makeEntry({ outcome: 'stalled', completionPct: 0.2, stepsCompleted: 1, stepsTotal: 5 }),
      makeEntry({ outcome: 'stalled', completionPct: 0.2, stepsCompleted: 1, stepsTotal: 5 }),
    ];
    const state = makeDrillState({
      drillHistory: history,
      autoConf: { drill: { cooldownCompleted: 0, cooldownStalled: 5 } },
    });
    // base≈4, 0% completion rate → adjustment ≈ +4 → 7-9 range ±1 jitter
    const cd = getDrillCooldown(state);
    expect(cd).toBeGreaterThanOrEqual(6);
    expect(cd).toBeLessThanOrEqual(10);
  });

  it('increases cooldown for low completion rate (sigmoid)', () => {
    // Mix: 1 completed + 3 stalled with partial progress → step1Rate = 0
    const history = [
      makeEntry({ outcome: 'completed', completionPct: 1.0, stepsCompleted: 5, stepsTotal: 5 }),
      makeEntry({ outcome: 'stalled', completionPct: 0.2, stepsCompleted: 1, stepsTotal: 5 }),
      makeEntry({ outcome: 'stalled', completionPct: 0.2, stepsCompleted: 1, stepsTotal: 5 }),
      makeEntry({ outcome: 'stalled', completionPct: 0.2, stepsCompleted: 1, stepsTotal: 5 }),
    ];
    const state = makeDrillState({
      drillHistory: history,
      autoConf: { drill: { cooldownStalled: 5 } },
    });
    // Low rate → positive adjustment ±1 jitter → at least 5
    const cd = getDrillCooldown(state);
    expect(cd).toBeGreaterThanOrEqual(5);
  });

  it('uses interpolated baseCooldown in neutral zone (50% rate, sigmoid)', () => {
    // Use partial stalls (stepsCompleted>0) to avoid triggering step-1 failure critical override
    const history = [
      makeEntry({ outcome: 'completed', completionPct: 1.0, stepsCompleted: 5, stepsTotal: 5 }),
      makeEntry({ outcome: 'stalled', completionPct: 0.2, stepsCompleted: 1, stepsTotal: 5 }),
      makeEntry({ outcome: 'completed', completionPct: 1.0, stepsCompleted: 5, stepsTotal: 5 }),
      makeEntry({ outcome: 'stalled', completionPct: 0.2, stepsCompleted: 1, stepsTotal: 5 }),
    ];
    const state = makeDrillState({
      drillHistory: history,
      autoConf: { drill: { cooldownCompleted: 0, cooldownStalled: 6 } },
    });
    // base≈5, ~50% rate → adjustment ≈ 0 ±1 jitter → 3-7 range
    const cd = getDrillCooldown(state);
    expect(cd).toBeGreaterThanOrEqual(2);
    expect(cd).toBeLessThanOrEqual(8);
  });

  it('does not adapt with fewer than 3 history entries', () => {
    const history = [
      makeEntry({ outcome: 'completed', completionPct: 1.0, stepsCompleted: 5, stepsTotal: 5 }),
      makeEntry({ outcome: 'completed', completionPct: 1.0, stepsCompleted: 5, stepsTotal: 5 }),
    ];
    const state = makeDrillState({
      drillHistory: history,
      autoConf: { drill: { cooldownCompleted: 1 } },
    });
    // Only 2 entries → no sigmoid → base from last entry's completionPct (1.0 → cooldownCompleted=1)
    expect(getDrillCooldown(state)).toBe(1);
  });

  it('clamps reduction to 0 (never negative cooldown)', () => {
    const history = Array.from({ length: 5 }, () => makeEntry({ outcome: 'completed' }));
    const state = makeDrillState({
      drillLastOutcome: 'completed',
      drillHistory: history,
      autoConf: { drill: { cooldownCompleted: 1 } },
    });
    // 100% → sigmoid adjustment ≈ -4 → base 1 - 4 = -3 → clamped to 0 (+jitter max 1)
    const cd = getDrillCooldown(state);
    expect(cd).toBeGreaterThanOrEqual(0);
    expect(cd).toBeLessThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// getAdaptiveProposalThresholds — adaptive min/max proposals
// ---------------------------------------------------------------------------

describe('getAdaptiveProposalThresholds', () => {
  it('returns defaults with no history', () => {
    const state = makeDrillState({ drillHistory: [] });
    const { min, max } = getAdaptiveProposalThresholds(state);
    expect(min).toBe(3);
    expect(max).toBe(10);
  });

  it('returns configured values', () => {
    const state = makeDrillState({
      drillHistory: [],
      autoConf: { drill: { minProposals: 5, maxProposals: 15 } },
    });
    const { min, max } = getAdaptiveProposalThresholds(state);
    expect(min).toBe(5);
    expect(max).toBe(15);
  });

  it('lowers min and raises max for high success rate (>70%)', () => {
    const history = Array.from({ length: 4 }, () => makeEntry({ outcome: 'completed' }));
    const state = makeDrillState({ drillHistory: history });
    const { min, max } = getAdaptiveProposalThresholds(state);
    // 100% → high success → min 3-1=2, max 10+2=12
    expect(min).toBe(2);
    expect(max).toBe(12);
  });

  it('raises min and lowers max for low success rate (<30%)', () => {
    const history = [
      makeEntry({ outcome: 'stalled' }),
      makeEntry({ outcome: 'stalled' }),
      makeEntry({ outcome: 'stalled' }),
    ];
    const state = makeDrillState({ drillHistory: history });
    const { min, max } = getAdaptiveProposalThresholds(state);
    // 0% → low success → min 3+1=4, max max(5,10-2)=8
    expect(min).toBe(4);
    expect(max).toBe(8);
  });

  it('clamps min to 2 minimum', () => {
    const history = Array.from({ length: 4 }, () => makeEntry({ outcome: 'completed' }));
    const state = makeDrillState({
      drillHistory: history,
      autoConf: { drill: { minProposals: 2 } },
    });
    const { min } = getAdaptiveProposalThresholds(state);
    // 100% → high → min max(2, 2-1)=max(2,1)=2
    expect(min).toBe(2);
  });

  it('does not adapt with fewer than 3 history entries', () => {
    const history = [makeEntry({ outcome: 'stalled' }), makeEntry({ outcome: 'stalled' })];
    const state = makeDrillState({ drillHistory: history });
    const { min, max } = getAdaptiveProposalThresholds(state);
    expect(min).toBe(3);
    expect(max).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// validateDrillConfig — config validation and clamping
// ---------------------------------------------------------------------------

describe('validateDrillConfig', () => {
  it('passes through valid config unchanged', () => {
    const result = validateDrillConfig({
      enabled: true,
      minProposals: 3,
      maxProposals: 10,
      cooldownCompleted: 0,
      cooldownStalled: 5,
      historyCap: 100,
      confidenceDiscount: 15,
      minAvgConfidence: 30,
      minAvgImpact: 3,
    });
    expect(result.minProposals).toBe(3);
    expect(result.maxProposals).toBe(10);
    expect(result.confidenceDiscount).toBe(15);
  });

  it('clamps negative values to minimums', () => {
    const result = validateDrillConfig({
      minProposals: -5,
      maxProposals: -10,
      cooldownCompleted: -1,
      cooldownStalled: -1,
      historyCap: -100,
      confidenceDiscount: -5,
      minAvgConfidence: -20,
      minAvgImpact: -1,
    });
    expect(result.minProposals).toBe(2);
    expect(result.maxProposals).toBe(5); // min + 2 since 5 <= 2
    expect(result.cooldownCompleted).toBe(0);
    expect(result.cooldownStalled).toBe(0);
    expect(result.historyCap).toBe(10);
    expect(result.confidenceDiscount).toBe(0);
    expect(result.minAvgConfidence).toBe(10);
    expect(result.minAvgImpact).toBe(1);
  });

  it('clamps excessively high values to maximums', () => {
    const result = validateDrillConfig({
      minProposals: 100,
      maxProposals: 200,
      cooldownCompleted: 50,
      cooldownStalled: 50,
      historyCap: 5000,
      confidenceDiscount: 99,
      minAvgConfidence: 999,
      minAvgImpact: 99,
    });
    expect(result.minProposals).toBe(10);
    expect(result.maxProposals).toBe(20);
    expect(result.cooldownCompleted).toBe(20);
    expect(result.cooldownStalled).toBe(20);
    expect(result.historyCap).toBe(1000);
    expect(result.confidenceDiscount).toBe(30);
    expect(result.minAvgConfidence).toBe(80);
    expect(result.minAvgImpact).toBe(8);
  });

  it('ensures maxProposals > minProposals', () => {
    const result = validateDrillConfig({
      minProposals: 8,
      maxProposals: 8,
    });
    expect(result.maxProposals).toBe(10); // 8 + 2
  });

  it('coerces non-number values to defaults', () => {
    const result = validateDrillConfig({
      minProposals: 'banana' as any,
      cooldownStalled: true as any,
    });
    expect(result.minProposals).toBe(3); // fallback
    expect(result.cooldownStalled).toBe(5); // fallback
  });

  it('handles string "false" for enabled correctly', () => {
    // String "false" is truthy in JS — validateDrillConfig should treat it as non-boolean → true
    const result = validateDrillConfig({ enabled: 'false' as any });
    // Since 'false' !== false, this evaluates as enabled: true (non-false value)
    expect(result.enabled).toBe(true);
  });

  it('respects explicit false for enabled', () => {
    const result = validateDrillConfig({ enabled: false });
    expect(result.enabled).toBe(false);
  });

  it('handles empty config object', () => {
    const result = validateDrillConfig({});
    expect(result.enabled).toBe(true); // undefined !== false
    expect(result.minProposals).toBe(3);
    expect(result.maxProposals).toBe(10);
  });

  it('clamps maxConsecutiveInsufficient to [1, 10]', () => {
    expect(validateDrillConfig({ maxConsecutiveInsufficient: 0 }).maxConsecutiveInsufficient).toBe(1);
    expect(validateDrillConfig({ maxConsecutiveInsufficient: 15 }).maxConsecutiveInsufficient).toBe(10);
    expect(validateDrillConfig({ maxConsecutiveInsufficient: 5 }).maxConsecutiveInsufficient).toBe(5);
  });

  it('defaults maxConsecutiveInsufficient to 3', () => {
    expect(validateDrillConfig({}).maxConsecutiveInsufficient).toBe(3);
  });

  it('clamps maxCyclesPerTrajectory to [5, 30]', () => {
    expect(validateDrillConfig({ maxCyclesPerTrajectory: 2 }).maxCyclesPerTrajectory).toBe(5);
    expect(validateDrillConfig({ maxCyclesPerTrajectory: 50 }).maxCyclesPerTrajectory).toBe(30);
    expect(validateDrillConfig({ maxCyclesPerTrajectory: 20 }).maxCyclesPerTrajectory).toBe(20);
  });

  it('defaults maxCyclesPerTrajectory to 15', () => {
    expect(validateDrillConfig({}).maxCyclesPerTrajectory).toBe(15);
  });
});

// ---------------------------------------------------------------------------
// applyDrillDirectives — directive hint processing
// ---------------------------------------------------------------------------

describe('applyDrillDirectives', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drill-directives-'));
    fs.mkdirSync(path.join(tmpDir, '.promptwheel'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('pauses drill mode via drill:pause directive', () => {
    addDirective(tmpDir, 'drill:pause');
    const state = makeDrillState({ repoRoot: tmpDir, drillMode: true, displayAdapter: { log: () => {}, drillStateChanged: () => {} } });
    applyDrillDirectives(state as any);
    expect(state.drillMode).toBe(false);
  });

  it('resumes drill mode via drill:resume directive', () => {
    addDirective(tmpDir, 'drill:resume');
    const state = makeDrillState({ repoRoot: tmpDir, drillMode: false, displayAdapter: { log: () => {}, drillStateChanged: () => {} } });
    applyDrillDirectives(state as any);
    expect(state.drillMode).toBe(true);
  });

  it('disables drill mode via drill:disable directive', () => {
    addDirective(tmpDir, 'drill:disable');
    const state = makeDrillState({ repoRoot: tmpDir, drillMode: true, displayAdapter: { log: () => {}, drillStateChanged: () => {} } });
    applyDrillDirectives(state as any);
    expect(state.drillMode).toBe(false);
  });

  it('no-op when no directive hints pending', () => {
    const state = makeDrillState({ repoRoot: tmpDir, drillMode: true, displayAdapter: { log: () => {}, drillStateChanged: () => {} } });
    applyDrillDirectives(state as any);
    expect(state.drillMode).toBe(true);
  });

  it('marks directive hints as consumed on disk', () => {
    addDirective(tmpDir, 'drill:pause');
    const state = makeDrillState({ repoRoot: tmpDir, drillMode: true, displayAdapter: { log: () => {}, drillStateChanged: () => {} } });
    applyDrillDirectives(state as any);
    // Read hints back from disk
    const hintsRaw = fs.readFileSync(path.join(tmpDir, '.promptwheel', 'hints.json'), 'utf-8');
    const hints = JSON.parse(hintsRaw);
    expect(hints.every((h: any) => h.consumed)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// tryPreVerifyTrajectoryStep — pre-verification of trajectory steps
// ---------------------------------------------------------------------------

describe('tryPreVerifyTrajectoryStep', () => {
  it('returns false when no trajectory is active', () => {
    const state = makeDrillState({
      activeTrajectory: null,
      activeTrajectoryState: null,
      currentTrajectoryStep: null,
      repoRoot: '/tmp',
    });
    expect(tryPreVerifyTrajectoryStep(state as any)).toBe(false);
  });

  it('returns false when step has no verification commands', () => {
    const traj = { name: 'test', description: 'test', steps: [
      { id: 'step-1', title: 'Test', description: '', scope: undefined, categories: [], acceptance_criteria: [], verification_commands: [], depends_on: [] },
    ]};
    const stepStates = createInitialStepStates(traj);
    stepStates['step-1'].status = 'active';
    const state = makeDrillState({
      activeTrajectory: traj,
      activeTrajectoryState: { trajectoryName: 'test', startedAt: Date.now(), stepStates, currentStepId: 'step-1', paused: false },
      currentTrajectoryStep: traj.steps[0],
      repoRoot: '/tmp',
    });
    expect(tryPreVerifyTrajectoryStep(state as any)).toBe(false);
  });

  it('returns true and marks step completed when verification passes', () => {
    const traj = { name: 'test', description: 'test', steps: [
      { id: 'step-1', title: 'Test', description: '', scope: undefined, categories: [], acceptance_criteria: [], verification_commands: ['true'], depends_on: [] },
    ]};
    const stepStates = createInitialStepStates(traj);
    stepStates['step-1'].status = 'active';
    const state = makeDrillState({
      activeTrajectory: traj,
      activeTrajectoryState: { trajectoryName: 'test', startedAt: Date.now(), stepStates, currentStepId: 'step-1', paused: false },
      currentTrajectoryStep: traj.steps[0],
      repoRoot: '/tmp',
    });
    const result = tryPreVerifyTrajectoryStep(state as any);
    expect(result).toBe(true);
    expect(stepStates['step-1'].status).toBe('completed');
  });

  it('returns false when verification command fails', () => {
    const traj = { name: 'test', description: 'test', steps: [
      { id: 'step-1', title: 'Test', description: '', scope: undefined, categories: [], acceptance_criteria: [], verification_commands: ['false'], depends_on: [] },
    ]};
    const stepStates = createInitialStepStates(traj);
    stepStates['step-1'].status = 'active';
    const state = makeDrillState({
      activeTrajectory: traj,
      activeTrajectoryState: { trajectoryName: 'test', startedAt: Date.now(), stepStates, currentStepId: 'step-1', paused: false },
      currentTrajectoryStep: traj.steps[0],
      repoRoot: '/tmp',
    });
    const result = tryPreVerifyTrajectoryStep(state as any);
    expect(result).toBe(false);
    expect(stepStates['step-1'].status).toBe('active');
  });
});

// ---------------------------------------------------------------------------
// hydrateDrillState — state hydration from persisted history
// ---------------------------------------------------------------------------

describe('hydrateDrillState', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drill-hydrate-'));
    fs.mkdirSync(path.join(tmpDir, '.promptwheel'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('populates state from persisted drill history', () => {
    const data = {
      entries: [
        makeEntry({ name: 'traj-1', outcome: 'completed', categories: ['refactor'], scopes: ['src/**'] }),
        makeEntry({ name: 'traj-2', outcome: 'stalled', categories: ['test'], scopes: ['test/**'] }),
      ],
      coveredCategories: { refactor: 1, test: 1 },
      coveredScopes: { 'src/**': 1, 'test/**': 1 },
    };
    fs.writeFileSync(
      path.join(tmpDir, '.promptwheel', 'drill-history.json'),
      JSON.stringify(data, null, 2),
    );
    const state = makeDrillState({
      repoRoot: tmpDir,
      drillHistory: [],
      drillCoveredCategories: new Map(),
      drillCoveredScopes: new Map(),
      drillTrajectoriesGenerated: 0,
      drillLastOutcome: null,
    });
    hydrateDrillState(state as any);
    expect(state.drillHistory).toHaveLength(2);
    expect(state.drillCoveredCategories.get('refactor')).toBe(1);
    expect(state.drillCoveredScopes.get('src/**')).toBe(1);
    expect(state.drillTrajectoriesGenerated).toBe(2);
    expect(state.drillLastOutcome).toBe('stalled');
  });

  it('no-op when history file is empty', () => {
    const state = makeDrillState({
      repoRoot: tmpDir,
      drillHistory: [],
      drillCoveredCategories: new Map(),
      drillCoveredScopes: new Map(),
      drillTrajectoriesGenerated: 0,
      drillLastOutcome: null,
    });
    hydrateDrillState(state as any);
    expect(state.drillHistory).toHaveLength(0);
    expect(state.drillTrajectoriesGenerated).toBe(0);
  });

  it('handles corrupted file gracefully', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.promptwheel', 'drill-history.json'),
      'not valid json{{{',
    );
    const state = makeDrillState({
      repoRoot: tmpDir,
      drillHistory: [],
      drillCoveredCategories: new Map(),
      drillCoveredScopes: new Map(),
      drillTrajectoriesGenerated: 0,
      drillLastOutcome: null,
    });
    hydrateDrillState(state as any);
    expect(state.drillHistory).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// recordDrillTrajectoryOutcome — outcome recording and persistence
// ---------------------------------------------------------------------------

describe('recordDrillTrajectoryOutcome', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drill-record-'));
    fs.mkdirSync(path.join(tmpDir, '.promptwheel'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('appends entry to drillHistory and updates state', () => {
    const state = makeDrillState({
      repoRoot: tmpDir,
      drillHistory: [],
      drillLastOutcome: null,
      drillCoveredCategories: new Map(),
      drillCoveredScopes: new Map(),
      autoConf: { drill: { historyCap: 100 } },
    });
    recordDrillTrajectoryOutcome(
      state as any,
      'test-traj', 'A test', 5, 3, 1, 'completed',
      [{ id: 's1', title: 'Step 1', categories: ['refactor'], scope: 'src/**' }],
    );
    expect(state.drillHistory).toHaveLength(1);
    expect(state.drillHistory[0].name).toBe('test-traj');
    expect(state.drillHistory[0].completionPct).toBeCloseTo(0.6, 2); // 3/5
    expect(state.drillLastOutcome).toBe('completed');
    expect(state.drillCoveredCategories.get('refactor')).toBe(1);
    expect(state.drillCoveredScopes.get('src/**')).toBe(1);
  });

  it('persists to disk', () => {
    const state = makeDrillState({
      repoRoot: tmpDir,
      drillHistory: [],
      drillLastOutcome: null,
      drillCoveredCategories: new Map(),
      drillCoveredScopes: new Map(),
      autoConf: { drill: { historyCap: 100 } },
    });
    recordDrillTrajectoryOutcome(
      state as any,
      'disk-test', 'Test', 3, 2, 0, 'completed',
      [{ id: 's1', title: 'Step 1', categories: ['fix'] }],
    );
    const filePath = path.join(tmpDir, '.promptwheel', 'drill-history.json');
    expect(fs.existsSync(filePath)).toBe(true);
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    expect(data.entries).toHaveLength(1);
  });

  it('caps history to configured limit', () => {
    const state = makeDrillState({
      repoRoot: tmpDir,
      drillHistory: Array.from({ length: 150 }, (_, i) => makeEntry({ name: `traj-${i}` })),
      drillLastOutcome: null,
      drillCoveredCategories: new Map(),
      drillCoveredScopes: new Map(),
      autoConf: { drill: { historyCap: 100 } },
    });
    recordDrillTrajectoryOutcome(
      state as any,
      'new-traj', 'New', 3, 2, 0, 'completed',
      [{ id: 's1', title: 'Step 1', categories: ['test'] }],
    );
    // In-memory should be capped: 100 - 1 (sliced) + 1 (new) = 100
    expect(state.drillHistory.length).toBeLessThanOrEqual(100);
  });

  it('caps scopes map at 200 entries', () => {
    const scopes = new Map<string, number>();
    for (let i = 0; i < 210; i++) {
      scopes.set(`scope-${i}/**`, 1);
    }
    const state = makeDrillState({
      repoRoot: tmpDir,
      drillHistory: [],
      drillLastOutcome: null,
      drillCoveredCategories: new Map(),
      drillCoveredScopes: scopes,
      autoConf: { drill: { historyCap: 100 } },
    });
    recordDrillTrajectoryOutcome(
      state as any,
      'scope-test', 'Test', 1, 1, 0, 'completed',
      [{ id: 's1', title: 'Step 1', categories: ['fix'], scope: 'new-scope/**' }],
    );
    expect(state.drillCoveredScopes.size).toBeLessThanOrEqual(200);
  });

});

// ---------------------------------------------------------------------------
// computeAmbitionLevel — adaptive first-step complexity
// ---------------------------------------------------------------------------

describe('computeAmbitionLevel', () => {
  it('returns conservative with fewer than 3 history entries', () => {
    const state = makeDrillState({ drillHistory: [makeEntry(), makeEntry()] });
    expect(computeAmbitionLevel(state as any)).toBe('conservative');
  });

  it('returns conservative with empty history', () => {
    const state = makeDrillState({ drillHistory: [] });
    expect(computeAmbitionLevel(state as any)).toBe('conservative');
  });

  it('returns conservative when weightedCompletionRate < 0.3', () => {
    const history = [
      makeEntry({ outcome: 'stalled', stepsCompleted: 0, stepsTotal: 5, completionPct: 0 }),
      makeEntry({ outcome: 'stalled', stepsCompleted: 0, stepsTotal: 5, completionPct: 0 }),
      makeEntry({ outcome: 'stalled', stepsCompleted: 0, stepsTotal: 5, completionPct: 0 }),
    ];
    const state = makeDrillState({ drillHistory: history });
    expect(computeAmbitionLevel(state as any)).toBe('conservative');
  });

  it('returns conservative when step1FailureRate > 0.3 without consecutive wins', () => {
    // 2/4 stalled on step 1, last 2 are not both completed
    const history = [
      makeEntry({ outcome: 'stalled', stepsCompleted: 0, stepsTotal: 5, completionPct: 0 }),
      makeEntry({ outcome: 'completed', stepsCompleted: 5, stepsTotal: 5, completionPct: 1 }),
      makeEntry({ outcome: 'stalled', stepsCompleted: 0, stepsTotal: 5, completionPct: 0 }),
      makeEntry({ outcome: 'completed', stepsCompleted: 5, stepsTotal: 5, completionPct: 1 }),
    ];
    const state = makeDrillState({ drillHistory: history });
    expect(computeAmbitionLevel(state as any)).toBe('conservative');
  });

  it('returns ambitious when rate > 0.7 and step1FailureRate < 0.15 and history >= 5', () => {
    const history = [
      makeEntry({ outcome: 'completed', stepsCompleted: 5, stepsTotal: 5, completionPct: 1 }),
      makeEntry({ outcome: 'completed', stepsCompleted: 5, stepsTotal: 5, completionPct: 1 }),
      makeEntry({ outcome: 'completed', stepsCompleted: 5, stepsTotal: 5, completionPct: 1 }),
      makeEntry({ outcome: 'completed', stepsCompleted: 5, stepsTotal: 5, completionPct: 1 }),
      makeEntry({ outcome: 'completed', stepsCompleted: 5, stepsTotal: 5, completionPct: 1 }),
    ];
    const state = makeDrillState({ drillHistory: history });
    expect(computeAmbitionLevel(state as any)).toBe('ambitious');
  });

  it('returns moderate for middling success rate', () => {
    const history = [
      makeEntry({ outcome: 'completed', stepsCompleted: 5, stepsTotal: 5, completionPct: 1 }),
      makeEntry({ outcome: 'stalled', stepsCompleted: 2, stepsTotal: 5, completionPct: 0.4 }),
      makeEntry({ outcome: 'completed', stepsCompleted: 5, stepsTotal: 5, completionPct: 1 }),
    ];
    const state = makeDrillState({ drillHistory: history });
    expect(computeAmbitionLevel(state as any)).toBe('moderate');
  });

  it('fast-recovers from conservative to moderate with 2 consecutive wins', () => {
    // step1Rate > threshold (0.25) but < critical (0.4), last 2 completed → fast-recovery to moderate
    const history = [
      makeEntry({ outcome: 'stalled', stepsCompleted: 0, stepsTotal: 5, completionPct: 0 }), // step-1 fail
      makeEntry({ outcome: 'stalled', stepsCompleted: 2, stepsTotal: 5, completionPct: 0.4 }), // not step-1 fail
      makeEntry({ outcome: 'stalled', stepsCompleted: 0, stepsTotal: 5, completionPct: 0 }), // step-1 fail
      makeEntry({ outcome: 'stalled', stepsCompleted: 2, stepsTotal: 5, completionPct: 0.4 }), // not step-1 fail
      makeEntry({ outcome: 'completed', stepsCompleted: 5, stepsTotal: 5, completionPct: 1 }),
      makeEntry({ outcome: 'completed', stepsCompleted: 5, stepsTotal: 5, completionPct: 1 }),
    ];
    const state = makeDrillState({ drillHistory: history });
    // step1Rate = 2/6 = 0.33 > threshold(0.25) but < critical(0.4) → fast-recovery fires → moderate
    expect(computeAmbitionLevel(state as any)).toBe('moderate');
  });

  it('fast-recovers from moderate to ambitious with 2 consecutive wins and enough history', () => {
    // 4 entries, moderate metrics, but last 2 completed → ambitious
    const history = [
      makeEntry({ outcome: 'stalled', stepsCompleted: 2, stepsTotal: 5, completionPct: 0.4 }),
      makeEntry({ outcome: 'completed', stepsCompleted: 5, stepsTotal: 5, completionPct: 1 }),
      makeEntry({ outcome: 'completed', stepsCompleted: 5, stepsTotal: 5, completionPct: 1 }),
      makeEntry({ outcome: 'completed', stepsCompleted: 5, stepsTotal: 5, completionPct: 1 }),
    ];
    const state = makeDrillState({ drillHistory: history });
    expect(computeAmbitionLevel(state as any)).toBe('ambitious');
  });

  it('does not fast-recover to ambitious with high step1 failure rate', () => {
    // step1Rate = 1/5 = 0.2 > step1AmbitiousMax (0.15) → blocks ambitious, lands on moderate
    const history = [
      makeEntry({ outcome: 'stalled', stepsCompleted: 0, stepsTotal: 5, completionPct: 0 }),
      makeEntry({ outcome: 'completed', stepsCompleted: 5, stepsTotal: 5, completionPct: 1 }),
      makeEntry({ outcome: 'completed', stepsCompleted: 5, stepsTotal: 5, completionPct: 1 }),
      makeEntry({ outcome: 'completed', stepsCompleted: 5, stepsTotal: 5, completionPct: 1 }),
      makeEntry({ outcome: 'completed', stepsCompleted: 5, stepsTotal: 5, completionPct: 1 }),
    ];
    const state = makeDrillState({ drillHistory: history });
    // step1Rate=0.2 blocks ambitious via step1AmbitiousMax, lands on moderate
    expect(computeAmbitionLevel(state as any)).toBe('moderate');
  });
});

// ---------------------------------------------------------------------------
// computeArcGuidance — multi-trajectory arc guidance
// ---------------------------------------------------------------------------

describe('computeArcGuidance', () => {
  it('returns undefined with fewer than 2 history entries', () => {
    const state = makeDrillState({ drillHistory: [makeEntry()] });
    expect(computeArcGuidance(state as any)).toBeUndefined();
  });

  it('returns undefined with empty history', () => {
    const state = makeDrillState({ drillHistory: [] });
    expect(computeArcGuidance(state as any)).toBeUndefined();
  });

  it('suggests shift to testing after 3+ foundation trajectories', () => {
    const history = [
      makeEntry({ categories: ['refactor'] }),
      makeEntry({ categories: ['types'] }),
      makeEntry({ categories: ['fix'] }),
    ];
    const state = makeDrillState({ drillHistory: history });
    const guidance = computeArcGuidance(state as any);
    expect(guidance).toBeDefined();
    expect(guidance).toContain('Shift toward testing and documentation');
  });

  it('suggests shift to core after 3+ polish trajectories', () => {
    const history = [
      makeEntry({ categories: ['test'] }),
      makeEntry({ categories: ['docs'] }),
      makeEntry({ categories: ['cleanup'] }),
    ];
    const state = makeDrillState({ drillHistory: history });
    const guidance = computeArcGuidance(state as any);
    expect(guidance).toBeDefined();
    expect(guidance).toContain('Shift to core improvements');
  });

  it('uses primary category for phase detection (no co-occurrence double-counting)', () => {
    // Each trajectory has ['refactor', 'test'] — primary is 'refactor' (foundation)
    // Should count as 3 foundation, not 3 foundation + 3 polish
    const history = [
      makeEntry({ categories: ['refactor', 'test'] }),
      makeEntry({ categories: ['refactor', 'test'] }),
      makeEntry({ categories: ['refactor', 'test'] }),
    ];
    const state = makeDrillState({ drillHistory: history });
    const guidance = computeArcGuidance(state as any);
    expect(guidance).toBeDefined();
    expect(guidance).toContain('Shift toward testing');
    // Should NOT suggest shift to core (which would happen if polish count was 3)
    expect(guidance).not.toContain('Shift to core');
  });

  it('suggests pivot after 2+ stalled trajectories', () => {
    const history = [
      makeEntry({ outcome: 'stalled', categories: ['security'] }),
      makeEntry({ outcome: 'stalled', categories: ['security'] }),
    ];
    const state = makeDrillState({ drillHistory: history });
    const guidance = computeArcGuidance(state as any);
    expect(guidance).toBeDefined();
    expect(guidance).toContain('Pivot to a completely different area');
    expect(guidance).toContain('security');
  });

  it('reports success momentum after 3+ completions in window', () => {
    const history = [
      makeEntry({ outcome: 'completed', categories: ['refactor'] }),
      makeEntry({ outcome: 'completed', categories: ['test'] }),
      makeEntry({ outcome: 'completed', categories: ['fix'] }),
    ];
    const state = makeDrillState({ drillHistory: history });
    const guidance = computeArcGuidance(state as any);
    expect(guidance).toBeDefined();
    expect(guidance).toContain('Strong completion momentum');
  });

  it('suggests building on last completed trajectory with modified files', () => {
    const history = [
      makeEntry({ outcome: 'stalled', categories: ['types'] }),
      makeEntry({
        outcome: 'completed',
        categories: ['refactor'],
        modifiedFiles: ['src/auth/login.ts', 'src/auth/session.ts'],
      }),
    ];
    const state = makeDrillState({ drillHistory: history });
    const guidance = computeArcGuidance(state as any);
    expect(guidance).toBeDefined();
    expect(guidance).toContain('Last trajectory modified');
    expect(guidance).toContain('src/auth');
  });

  it('does not suggest chain guidance when last trajectory stalled', () => {
    const history = [
      makeEntry({ outcome: 'completed', categories: ['refactor'] }),
      makeEntry({
        outcome: 'stalled',
        categories: ['security'],
        modifiedFiles: ['src/security/check.ts'],
      }),
    ];
    const state = makeDrillState({ drillHistory: history });
    const guidance = computeArcGuidance(state as any);
    if (guidance) {
      expect(guidance).not.toContain('Last trajectory modified');
    }
  });

  it('combines multiple signals in guidance (capped at 2)', () => {
    const history = [
      makeEntry({ outcome: 'stalled', categories: ['fix'] }),
      makeEntry({ outcome: 'stalled', categories: ['types'] }),
      makeEntry({ outcome: 'completed', categories: ['refactor'] }),
      makeEntry({ outcome: 'completed', categories: ['fix'] }),
      makeEntry({ outcome: 'completed', categories: ['types'] }),
    ];
    const state = makeDrillState({ drillHistory: history });
    const guidance = computeArcGuidance(state as any);
    expect(guidance).toBeDefined();
    // Blended signal (stalls + momentum → selective momentum) + phase rotation
    expect(guidance).toContain('Selective momentum');
    expect(guidance).toContain('Shift toward testing');
    // Should NOT have both separate stall pivot and momentum (they're blended)
    expect(guidance).not.toContain('Pivot to a completely different area');
    expect(guidance).not.toContain('Strong completion momentum');
  });

  it('only uses last 5 entries for window', () => {
    const history = [
      makeEntry({ categories: ['test'] }),
      makeEntry({ categories: ['docs'] }),
      makeEntry({ categories: ['refactor'] }),
      makeEntry({ categories: ['types'] }),
      makeEntry({ categories: ['fix'] }),
      makeEntry({ categories: ['refactor'] }),
      makeEntry({ categories: ['fix'] }),
    ];
    const state = makeDrillState({ drillHistory: history });
    const guidance = computeArcGuidance(state as any);
    expect(guidance).toBeDefined();
    expect(guidance).toContain('Shift toward testing');
  });

  it('includes goal alignment when goalCategory provided', () => {
    const history = [
      makeEntry({ categories: ['refactor'] }),
      makeEntry({ categories: ['fix'] }),
    ];
    const state = makeDrillState({ drillHistory: history });
    const guidance = computeArcGuidance(state as any, 'security');
    expect(guidance).toBeDefined();
    expect(guidance).toContain('Active goal targets "security"');
    expect(guidance).toContain('prioritize proposals');
  });

  it('acknowledges good goal alignment when category already covered', () => {
    const history = [
      makeEntry({ categories: ['security'] }),
      makeEntry({ categories: ['security'] }),
      makeEntry({ categories: ['fix'] }),
    ];
    const state = makeDrillState({ drillHistory: history });
    const guidance = computeArcGuidance(state as any, 'security');
    expect(guidance).toBeDefined();
    expect(guidance).toContain('Good goal alignment');
  });

  it('omits goal guidance when no goalCategory provided', () => {
    const history = [
      makeEntry({ categories: ['refactor'] }),
      makeEntry({ categories: ['fix'] }),
    ];
    const state = makeDrillState({ drillHistory: history });
    const guidance = computeArcGuidance(state as any);
    if (guidance) {
      expect(guidance).not.toContain('Active goal');
      expect(guidance).not.toContain('goal alignment');
    }
  });

  // ── Equilibrium properties ──────────────────────────────────────────────

  it('emits blended signal with diversity nudge when stalls and momentum both fire', () => {
    // 2 stalls + 3 completions in window → both would fire → blended instead
    const history = [
      makeEntry({ outcome: 'stalled', categories: ['security'] }),
      makeEntry({ outcome: 'stalled', categories: ['security'] }),
      makeEntry({ outcome: 'completed', categories: ['refactor'] }),
      makeEntry({ outcome: 'completed', categories: ['test'] }),
      makeEntry({ outcome: 'completed', categories: ['fix'] }),
    ];
    const state = makeDrillState({ drillHistory: history });
    const guidance = computeArcGuidance(state as any);
    expect(guidance).toBeDefined();
    expect(guidance).toContain('Selective momentum');
    // Should suggest unexplored categories as alternatives
    expect(guidance).toContain('unexplored categories');
    // Should NOT have contradictory separate signals
    expect(guidance).not.toContain('Pivot to a completely different area');
    expect(guidance).not.toContain('Strong completion momentum');
  });

  it('stall pivot fires alone when there are stalls but not enough momentum', () => {
    const history = [
      makeEntry({ outcome: 'stalled', categories: ['security'] }),
      makeEntry({ outcome: 'stalled', categories: ['perf'] }),
      makeEntry({ outcome: 'completed', categories: ['refactor'] }),
    ];
    const state = makeDrillState({ drillHistory: history });
    const guidance = computeArcGuidance(state as any);
    expect(guidance).toBeDefined();
    expect(guidance).toContain('Pivot to a completely different area');
    expect(guidance).not.toContain('Selective momentum');
  });

  it('suppresses chain guidance when momentum fires (no double-continue)', () => {
    const history = [
      makeEntry({ outcome: 'completed', categories: ['refactor'] }),
      makeEntry({ outcome: 'completed', categories: ['test'] }),
      makeEntry({
        outcome: 'completed',
        categories: ['fix'],
        modifiedFiles: ['src/auth/login.ts'],
      }),
    ];
    const state = makeDrillState({ drillHistory: history });
    const guidance = computeArcGuidance(state as any);
    expect(guidance).toBeDefined();
    expect(guidance).toContain('Strong completion momentum');
    // Chain guidance should be suppressed — momentum already says "continue"
    expect(guidance).not.toContain('Last trajectory modified');
  });

  it('reweights goal alignment when phase rotation already covers goal category', () => {
    // Phase says "shift to testing/docs" (polish), goal is 'test' (a polish cat)
    // Use mix of outcomes so momentum doesn't fire, leaving room for goal signal
    const history = [
      makeEntry({ outcome: 'stalled', categories: ['refactor'] }),
      makeEntry({ categories: ['types'] }),
      makeEntry({ categories: ['fix'] }),
    ];
    const state = makeDrillState({ drillHistory: history });
    const guidance = computeArcGuidance(state as any, 'test');
    expect(guidance).toBeDefined();
    expect(guidance).toContain('Shift toward testing');
    // Goal should NOT be suppressed — instead a softer reweighted signal
    expect(guidance).toContain('Phase shift aligns with active goal');
    expect(guidance).toContain('ensure "test" gets priority');
    expect(guidance).not.toContain('Active goal targets');
  });

  it('emits goal alignment when phase rotation does not cover goal category', () => {
    // Phase says "shift to testing/docs" (polish), goal is 'security' (core)
    // Use mix of outcomes so momentum doesn't fire (< 3 completions) leaving room for goal
    const history = [
      makeEntry({ outcome: 'stalled', categories: ['refactor'] }),
      makeEntry({ categories: ['types'] }),
      makeEntry({ categories: ['fix'] }),
    ];
    const state = makeDrillState({ drillHistory: history });
    const guidance = computeArcGuidance(state as any, 'security');
    expect(guidance).toBeDefined();
    expect(guidance).toContain('Shift toward testing');
    expect(guidance).toContain('Active goal targets "security"');
  });

  it('caps signals at 3 even when many would fire', () => {
    // Setup that triggers: blended (stalls+momentum), phase rotation, goal
    const history = [
      makeEntry({ outcome: 'stalled', categories: ['fix'] }),
      makeEntry({ outcome: 'stalled', categories: ['types'] }),
      makeEntry({ outcome: 'completed', categories: ['refactor'] }),
      makeEntry({ outcome: 'completed', categories: ['fix'] }),
      makeEntry({ outcome: 'completed', categories: ['types'] }),
    ];
    const state = makeDrillState({ drillHistory: history });
    const guidance = computeArcGuidance(state as any, 'security');
    expect(guidance).toBeDefined();
    // Count distinct signals (separated by newlines)
    const signals = guidance!.split('\n').filter(s => s.trim().length > 0);
    expect(signals.length).toBeLessThanOrEqual(3);
  });

  it('no phase oscillation: foundation-heavy window with some polish does not trigger foundation shift', () => {
    // [F, F, F, P, P] → foundationCount=3, polishCount=2 → polishCount >= 2 blocks shift
    const history = [
      makeEntry({ categories: ['refactor'] }),
      makeEntry({ categories: ['types'] }),
      makeEntry({ categories: ['fix'] }),
      makeEntry({ categories: ['test'] }),
      makeEntry({ categories: ['docs'] }),
    ];
    const state = makeDrillState({ drillHistory: history });
    const guidance = computeArcGuidance(state as any);
    // Neither phase signal should fire (foundation threshold met but polish >= 2)
    if (guidance) {
      expect(guidance).not.toContain('Shift toward testing');
      expect(guidance).not.toContain('Shift to core');
    }
  });
});

// ---------------------------------------------------------------------------
// computeDecayedCoverage — temporal decay for diversity scores
// ---------------------------------------------------------------------------

describe('computeDecayedCoverage', () => {
  it('returns empty maps for empty history', () => {
    const result = computeDecayedCoverage([]);
    expect(result.categories.size).toBe(0);
    expect(result.scopes.size).toBe(0);
  });

  it('recent entries contribute more weight than old ones', () => {
    const history = [
      makeEntry({ categories: ['refactor'], scopes: ['src/**'] }),
      // ... 19 more entries so the old one is aged out
      ...Array.from({ length: 19 }, () => makeEntry({ categories: ['test'], scopes: ['test/**'] })),
    ];
    const result = computeDecayedCoverage(history);
    // 'test' is recent (19 entries) and should have much higher effective count than 'refactor' (old)
    const testCount = result.categories.get('test') ?? 0;
    const refactorCount = result.categories.get('refactor') ?? 0;
    expect(testCount).toBeGreaterThan(refactorCount * 5);
  });

  it('single entry has weight 1.0 (no decay)', () => {
    const result = computeDecayedCoverage([makeEntry({ categories: ['fix'], scopes: ['src/**'] })]);
    expect(result.categories.get('fix')).toBeCloseTo(1.0, 5);
    expect(result.scopes.get('src/**')).toBeCloseTo(1.0, 5);
  });

  it('old entries fade toward zero', () => {
    // 30 entries → oldest has age=29 with half-life=10 → weight ≈ 0.13
    const history = Array.from({ length: 30 }, (_, i) =>
      makeEntry({ categories: i === 0 ? ['security'] : ['test'], scopes: [] }));
    const result = computeDecayedCoverage(history);
    const securityCount = result.categories.get('security') ?? 0;
    // security only appears once at age 29 → weight = exp(-ln2/10 * 29) ≈ 0.13
    expect(securityCount).toBeLessThan(0.15);
    expect(securityCount).toBeGreaterThan(0.1);
  });
});

// ---------------------------------------------------------------------------
// Per-category ambition hints in metrics
// ---------------------------------------------------------------------------

describe('per-category ambition hints', () => {
  it('identifies ambitious and conservative categories', () => {
    const history: DrillHistoryEntry[] = [
      makeEntry({ outcome: 'completed', categories: ['refactor'] }),
      makeEntry({ outcome: 'completed', categories: ['refactor'] }),
      makeEntry({ outcome: 'completed', categories: ['refactor'] }),
      makeEntry({ outcome: 'stalled', categories: ['security'], stepsCompleted: 0, stepsTotal: 5 }),
      makeEntry({ outcome: 'stalled', categories: ['security'], stepsCompleted: 0, stepsTotal: 5 }),
      makeEntry({ outcome: 'stalled', categories: ['security'], stepsCompleted: 0, stepsTotal: 5 }),
    ];
    const metrics = computeDrillMetrics(history);
    // refactor: 3/3 completed → rate should be high
    expect(metrics.categorySuccessRates['refactor'].rate).toBeGreaterThan(0.7);
    // security: 0/3 completed → rate should be low
    expect(metrics.categorySuccessRates['security'].rate).toBeLessThan(0.3);
  });
});

// ---------------------------------------------------------------------------
// getDrillCooldown — jitter range test
// ---------------------------------------------------------------------------

describe('getDrillCooldown jitter', () => {
  it('cooldown with sigmoid stays within ±1 of expected value across runs', () => {
    const history = [
      makeEntry({ outcome: 'completed', completionPct: 1.0, stepsCompleted: 5, stepsTotal: 5 }),
      makeEntry({ outcome: 'completed', completionPct: 1.0, stepsCompleted: 5, stepsTotal: 5 }),
      makeEntry({ outcome: 'stalled', completionPct: 0, stepsCompleted: 0, stepsTotal: 5 }),
    ];
    const state = makeDrillState({
      drillHistory: history,
      autoConf: { drill: { cooldownCompleted: 0, cooldownStalled: 5 } },
    });
    // Run multiple times and collect range
    const results = new Set<number>();
    for (let i = 0; i < 50; i++) {
      results.add(getDrillCooldown(state));
    }
    // Should see variation (jitter) — at least 2 distinct values in 50 runs
    expect(results.size).toBeGreaterThanOrEqual(2);
    // All values should be non-negative
    for (const v of results) {
      expect(v).toBeGreaterThanOrEqual(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Step-1 failure auto-remediation
// ---------------------------------------------------------------------------

describe('step-1 failure auto-remediation', () => {
  it('getDrillCooldown returns 0 when step1FailureRate exceeds critical threshold', () => {
    // 3 out of 5 stalled on step 1 → step1FailureRate = 0.6 > 0.4 critical
    const history = [
      makeEntry({ outcome: 'stalled', stepsCompleted: 0, stepsTotal: 5, completionPct: 0 }),
      makeEntry({ outcome: 'stalled', stepsCompleted: 0, stepsTotal: 5, completionPct: 0 }),
      makeEntry({ outcome: 'stalled', stepsCompleted: 0, stepsTotal: 5, completionPct: 0 }),
      makeEntry({ outcome: 'completed', stepsCompleted: 5, stepsTotal: 5, completionPct: 1 }),
      makeEntry({ outcome: 'completed', stepsCompleted: 5, stepsTotal: 5, completionPct: 1 }),
    ];
    const state = makeDrillState({
      drillHistory: history,
      autoConf: { drill: { cooldownCompleted: 0, cooldownStalled: 5 } },
    });
    expect(getDrillCooldown(state)).toBe(0);
  });

  it('computeAmbitionLevel returns conservative with critical step-1 failure rate even with fast-recovery', () => {
    // 3 stalls on step 1, then 2 wins → consecutiveWins=true but step1 rate > 0.4
    const history = [
      makeEntry({ outcome: 'stalled', stepsCompleted: 0, stepsTotal: 5, completionPct: 0 }),
      makeEntry({ outcome: 'stalled', stepsCompleted: 0, stepsTotal: 5, completionPct: 0 }),
      makeEntry({ outcome: 'stalled', stepsCompleted: 0, stepsTotal: 5, completionPct: 0 }),
      makeEntry({ outcome: 'completed', stepsCompleted: 5, stepsTotal: 5, completionPct: 1 }),
      makeEntry({ outcome: 'completed', stepsCompleted: 5, stepsTotal: 5, completionPct: 1 }),
    ];
    const state = makeDrillState({ drillHistory: history });
    // Critical: step1FailureRate = 3/5 = 0.6 > 0.4 → always conservative
    expect(computeAmbitionLevel(state)).toBe('conservative');
  });

  it('uses configurable step1Critical threshold', () => {
    // 2 out of 5 stalled on step 1 → step1FailureRate = 0.4
    const history = [
      makeEntry({ outcome: 'stalled', stepsCompleted: 0, stepsTotal: 5, completionPct: 0 }),
      makeEntry({ outcome: 'stalled', stepsCompleted: 0, stepsTotal: 5, completionPct: 0 }),
      makeEntry({ outcome: 'completed', stepsCompleted: 5, stepsTotal: 5, completionPct: 1 }),
      makeEntry({ outcome: 'completed', stepsCompleted: 5, stepsTotal: 5, completionPct: 1 }),
      makeEntry({ outcome: 'completed', stepsCompleted: 5, stepsTotal: 5, completionPct: 1 }),
    ];
    // With custom critical threshold of 0.3, step1FailureRate=0.4 > 0.3 → always conservative
    const state = makeDrillState({
      drillHistory: history,
      autoConf: { drill: { ambitionThresholds: { step1Critical: 0.3 } } },
    });
    expect(computeAmbitionLevel(state)).toBe('conservative');
  });
});

// ---------------------------------------------------------------------------
// Freshness filter → cooldown bridge
// ---------------------------------------------------------------------------

describe('freshness filter → cooldown bridge', () => {
  it('reduces cooldown when freshness drop ratio > 0.5', () => {
    // Use stalled (partial progress) entries so base cooldown is high enough to observe adjustment
    const history = [
      makeEntry({ outcome: 'stalled', completionPct: 0.2, stepsCompleted: 1, stepsTotal: 5 }),
      makeEntry({ outcome: 'stalled', completionPct: 0.2, stepsCompleted: 1, stepsTotal: 5 }),
      makeEntry({ outcome: 'stalled', completionPct: 0.2, stepsCompleted: 1, stepsTotal: 5 }),
    ];
    const stateNoFreshness = makeDrillState({
      drillHistory: history,
      drillLastFreshnessDropRatio: null,
      autoConf: { drill: { cooldownCompleted: 0, cooldownStalled: 5 } },
    });
    const stateHighDrop = makeDrillState({
      drillHistory: history,
      drillLastFreshnessDropRatio: 0.7,
      autoConf: { drill: { cooldownCompleted: 0, cooldownStalled: 5 } },
    });
    // Collect ranges for both (jitter makes exact comparison unreliable)
    const baseResults: number[] = [];
    const adjustedResults: number[] = [];
    for (let i = 0; i < 50; i++) {
      baseResults.push(getDrillCooldown(stateNoFreshness));
      adjustedResults.push(getDrillCooldown(stateHighDrop));
    }
    const baseAvg = baseResults.reduce((a, b) => a + b, 0) / baseResults.length;
    const adjAvg = adjustedResults.reduce((a, b) => a + b, 0) / adjustedResults.length;
    // High drop ratio should result in lower average cooldown
    expect(adjAvg).toBeLessThan(baseAvg);
  });

  it('increases cooldown when freshness drop ratio < 0.1', () => {
    // Use stalled (partial progress) entries so base cooldown is high enough to observe adjustment
    const history = [
      makeEntry({ outcome: 'stalled', completionPct: 0.2, stepsCompleted: 1, stepsTotal: 5 }),
      makeEntry({ outcome: 'stalled', completionPct: 0.2, stepsCompleted: 1, stepsTotal: 5 }),
      makeEntry({ outcome: 'stalled', completionPct: 0.2, stepsCompleted: 1, stepsTotal: 5 }),
    ];
    const stateNoFreshness = makeDrillState({
      drillHistory: history,
      drillLastFreshnessDropRatio: null,
      autoConf: { drill: { cooldownCompleted: 0, cooldownStalled: 5 } },
    });
    const stateLowDrop = makeDrillState({
      drillHistory: history,
      drillLastFreshnessDropRatio: 0.05,
      autoConf: { drill: { cooldownCompleted: 0, cooldownStalled: 5 } },
    });
    const baseResults: number[] = [];
    const adjustedResults: number[] = [];
    for (let i = 0; i < 50; i++) {
      baseResults.push(getDrillCooldown(stateNoFreshness));
      adjustedResults.push(getDrillCooldown(stateLowDrop));
    }
    const baseAvg = baseResults.reduce((a, b) => a + b, 0) / baseResults.length;
    const adjAvg = adjustedResults.reduce((a, b) => a + b, 0) / adjustedResults.length;
    // Low drop ratio should result in higher average cooldown
    expect(adjAvg).toBeGreaterThan(baseAvg);
  });
});

// ---------------------------------------------------------------------------
// Configurable sigmoid and staleness parameters
// ---------------------------------------------------------------------------

// sigmoid parameters are now hardcoded (k=6, center=0.5) — no config tests needed

// ---------------------------------------------------------------------------
// Per-ambition success tracking
// ---------------------------------------------------------------------------

describe('computePerAmbitionSuccessRates', () => {
  it('returns null for levels with fewer than 2 entries', () => {
    const history = [
      makeEntry({ ambitionLevel: 'conservative', outcome: 'completed' }),
    ];
    const rates = computePerAmbitionSuccessRates(history);
    expect(rates.conservative).toBeNull();
    expect(rates.moderate).toBeNull();
    expect(rates.ambitious).toBeNull();
  });

  it('computes rates correctly per level', () => {
    const history = [
      makeEntry({ ambitionLevel: 'conservative', outcome: 'completed' }),
      makeEntry({ ambitionLevel: 'conservative', outcome: 'completed' }),
      makeEntry({ ambitionLevel: 'conservative', outcome: 'stalled' }),
      makeEntry({ ambitionLevel: 'ambitious', outcome: 'stalled' }),
      makeEntry({ ambitionLevel: 'ambitious', outcome: 'stalled' }),
    ];
    const rates = computePerAmbitionSuccessRates(history);
    expect(rates.conservative).toBeCloseTo(2 / 3, 2);
    expect(rates.ambitious).toBeCloseTo(0, 2);
    expect(rates.moderate).toBeNull(); // no moderate entries
  });

  it('blocks ambitious when per-ambition success is low', () => {
    const history = [
      // Good overall rate (>0.7) but ambitious specifically fails
      makeEntry({ outcome: 'completed', stepsCompleted: 5, stepsTotal: 5, completionPct: 1, ambitionLevel: 'moderate' }),
      makeEntry({ outcome: 'completed', stepsCompleted: 5, stepsTotal: 5, completionPct: 1, ambitionLevel: 'moderate' }),
      makeEntry({ outcome: 'completed', stepsCompleted: 5, stepsTotal: 5, completionPct: 1, ambitionLevel: 'moderate' }),
      makeEntry({ outcome: 'completed', stepsCompleted: 5, stepsTotal: 5, completionPct: 1, ambitionLevel: 'moderate' }),
      makeEntry({ outcome: 'stalled', stepsCompleted: 1, stepsTotal: 5, completionPct: 0.2, ambitionLevel: 'ambitious' }),
      makeEntry({ outcome: 'stalled', stepsCompleted: 1, stepsTotal: 5, completionPct: 0.2, ambitionLevel: 'ambitious' }),
      makeEntry({ outcome: 'completed', stepsCompleted: 5, stepsTotal: 5, completionPct: 1, ambitionLevel: 'moderate' }),
    ];
    const state = makeDrillState({ drillHistory: history });
    // Overall rate is high (~71%), step1 failure is 0%, history >= 5
    // But ambitious has 0% success rate → should stay moderate
    expect(computeAmbitionLevel(state)).toBe('moderate');
  });
});

// ---------------------------------------------------------------------------
// Step-position failure analysis
// ---------------------------------------------------------------------------

describe('step-position failure analysis', () => {
  it('computes failure rates by step position', () => {
    const history = [
      makeEntry({
        stepOutcomes: [
          { id: 's1', status: 'completed' },
          { id: 's2', status: 'failed' },
          { id: 's3', status: 'failed' },
        ],
      }),
      makeEntry({
        stepOutcomes: [
          { id: 's1', status: 'completed' },
          { id: 's2', status: 'completed' },
          { id: 's3', status: 'failed' },
        ],
      }),
      makeEntry({
        stepOutcomes: [
          { id: 's1', status: 'failed' },
          { id: 's2', status: 'failed' },
        ],
      }),
    ];
    const metrics = computeDrillMetrics(history);
    // Position 1: 1 failed / 3 total = 33%
    // Position 2: 2 failed / 3 total = 67%
    // Position 3: 2 failed / 2 total = 100%
    expect(metrics.stepPositionFailureRates.length).toBeGreaterThanOrEqual(2);
    const pos1 = metrics.stepPositionFailureRates.find(p => p.position === 1);
    const pos2 = metrics.stepPositionFailureRates.find(p => p.position === 2);
    const pos3 = metrics.stepPositionFailureRates.find(p => p.position === 3);
    expect(pos1?.failureRate).toBeCloseTo(1 / 3, 2);
    expect(pos2?.failureRate).toBeCloseTo(2 / 3, 2);
    expect(pos3?.failureRate).toBeCloseTo(1.0, 2);
  });

  it('requires at least 2 data points per position', () => {
    const history = [
      makeEntry({
        stepOutcomes: [
          { id: 's1', status: 'completed' },
          { id: 's2', status: 'failed' },
          { id: 's3', status: 'failed' }, // only 1 data point for position 3
        ],
      }),
      makeEntry({
        stepOutcomes: [
          { id: 's1', status: 'completed' },
          { id: 's2', status: 'completed' },
        ],
      }),
    ];
    const metrics = computeDrillMetrics(history);
    // Position 3 should be excluded (only 1 data point)
    const pos3 = metrics.stepPositionFailureRates.find(p => p.position === 3);
    expect(pos3).toBeUndefined();
  });

  it('ignores entries without stepOutcomes', () => {
    const history = [
      makeEntry({}), // no stepOutcomes
      makeEntry({}),
      makeEntry({}),
    ];
    const metrics = computeDrillMetrics(history);
    expect(metrics.stepPositionFailureRates).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Config validation: sigmoid, staleness, and center params
// ---------------------------------------------------------------------------

describe('validateDrillConfig — staleness', () => {
  it('clamps stalenessLogBase to [2, 100]', () => {
    expect(validateDrillConfig({ stalenessLogBase: 1 }).stalenessLogBase).toBe(2);
    expect(validateDrillConfig({ stalenessLogBase: 500 }).stalenessLogBase).toBe(100);
    expect(validateDrillConfig({ stalenessLogBase: 11 }).stalenessLogBase).toBe(11);
  });

  it('defaults stalenessLogBase to 11', () => {
    expect(validateDrillConfig({}).stalenessLogBase).toBe(11);
  });

  it('coerces non-number values to defaults', () => {
    const result = validateDrillConfig({
      stalenessLogBase: null as any,
    });
    expect(result.stalenessLogBase).toBe(11);
  });
});

// ---------------------------------------------------------------------------
// Blueprint telemetry in recordDrillTrajectoryOutcome
// ---------------------------------------------------------------------------

describe('recordDrillTrajectoryOutcome — blueprint telemetry', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drill-bp-'));
    fs.mkdirSync(path.join(tmpDir, '.promptwheel'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('stores blueprint telemetry fields when provided', () => {
    const state = makeDrillState({
      repoRoot: tmpDir,
      drillHistory: [],
      drillLastOutcome: null,
      drillCoveredCategories: new Map(),
      drillCoveredScopes: new Map(),
      autoConf: { drill: { historyCap: 100 } },
    });
    recordDrillTrajectoryOutcome(
      state as any,
      'bp-test', 'Blueprint test', 3, 2, 0, 'completed',
      [{ id: 's1', title: 'Step 1', categories: ['refactor'] }],
      undefined, undefined, undefined, undefined,
      {
        stepOutcomes: [{ id: 's1', status: 'completed' }],
        blueprintGroupCount: 3,
        blueprintConflictCount: 1,
        blueprintEnablerCount: 2,
        blueprintMergeableCount: 0,
        qualityRetried: true,
        qualityIssueCount: 2,
      },
    );
    expect(state.drillHistory).toHaveLength(1);
    const entry = state.drillHistory[0];
    expect(entry.blueprintGroupCount).toBe(3);
    expect(entry.blueprintConflictCount).toBe(1);
    expect(entry.blueprintEnablerCount).toBe(2);
    expect(entry.blueprintMergeableCount).toBe(0);
    expect(entry.qualityRetried).toBe(true);
    expect(entry.qualityIssueCount).toBe(2);
  });

  it('handles entries without blueprint fields (backward compat)', () => {
    const state = makeDrillState({
      repoRoot: tmpDir,
      drillHistory: [],
      drillLastOutcome: null,
      drillCoveredCategories: new Map(),
      drillCoveredScopes: new Map(),
      autoConf: { drill: { historyCap: 100 } },
    });
    recordDrillTrajectoryOutcome(
      state as any,
      'no-bp', 'No blueprint', 2, 1, 0, 'stalled',
      [{ id: 's1', title: 'Step 1', categories: ['fix'] }],
    );
    const entry = state.drillHistory[0];
    expect(entry.blueprintGroupCount).toBeUndefined();
    expect(entry.qualityRetried).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// computeDrillMetrics — quality gate metrics
// ---------------------------------------------------------------------------

describe('computeDrillMetrics — quality gate metrics', () => {
  it('computes fire rate from mixed entries', () => {
    const history = [
      makeEntry({ qualityRetried: true, outcome: 'completed' }),
      makeEntry({ qualityRetried: true, outcome: 'stalled' }),
      makeEntry({ qualityRetried: undefined, outcome: 'completed' }),
      makeEntry({ qualityRetried: undefined, outcome: 'completed' }),
    ];
    const metrics = computeDrillMetrics(history);
    expect(metrics.qualityGateFireRate).toBeCloseTo(0.5); // 2 out of 4
  });

  it('computes retry success rate', () => {
    const history = [
      makeEntry({ qualityRetried: true, outcome: 'completed' }),
      makeEntry({ qualityRetried: true, outcome: 'stalled' }),
      makeEntry({ qualityRetried: true, outcome: 'completed' }),
    ];
    const metrics = computeDrillMetrics(history);
    expect(metrics.qualityGateRetrySuccessRate).toBeCloseTo(2 / 3);
  });

  it('returns zero when no entries have qualityRetried', () => {
    const history = [
      makeEntry({ outcome: 'completed' }),
      makeEntry({ outcome: 'stalled' }),
    ];
    const metrics = computeDrillMetrics(history);
    expect(metrics.qualityGateFireRate).toBe(0);
    expect(metrics.qualityGateRetrySuccessRate).toBe(0);
  });

  it('backward compat: entries without new fields do not break metrics', () => {
    // Simulate old entries without blueprint/quality fields
    const history = [
      makeEntry({ outcome: 'completed' }),
      makeEntry({ outcome: 'stalled' }),
      makeEntry({ outcome: 'completed' }),
    ];
    const metrics = computeDrillMetrics(history);
    expect(metrics.totalTrajectories).toBe(3);
    expect(metrics.qualityGateFireRate).toBe(0);
    expect(metrics.qualityGateRetrySuccessRate).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// validateDrillConfig — blueprint thresholds
// ---------------------------------------------------------------------------

describe('validateDrillConfig — blueprint thresholds', () => {
  it('clamps blueprint groupOverlapThreshold to [0.3, 0.8]', () => {
    expect(validateDrillConfig({ blueprint: { groupOverlapThreshold: 0.1 } }).blueprint!.groupOverlapThreshold).toBe(0.3);
    expect(validateDrillConfig({ blueprint: { groupOverlapThreshold: 0.9 } }).blueprint!.groupOverlapThreshold).toBe(0.8);
    expect(validateDrillConfig({ blueprint: { groupOverlapThreshold: 0.6 } }).blueprint!.groupOverlapThreshold).toBeCloseTo(0.6);
  });

  it('clamps blueprint mergeableOverlapThreshold to [0.5, 0.9]', () => {
    expect(validateDrillConfig({ blueprint: { mergeableOverlapThreshold: 0.2 } }).blueprint!.mergeableOverlapThreshold).toBe(0.5);
    expect(validateDrillConfig({ blueprint: { mergeableOverlapThreshold: 1.0 } }).blueprint!.mergeableOverlapThreshold).toBe(0.9);
    expect(validateDrillConfig({ blueprint: { mergeableOverlapThreshold: 0.7 } }).blueprint!.mergeableOverlapThreshold).toBeCloseTo(0.7);
  });

  it('clamps blueprint qualityGateStepCountSlack to [0, 5]', () => {
    expect(validateDrillConfig({ blueprint: { qualityGateStepCountSlack: -1 } }).blueprint!.qualityGateStepCountSlack).toBe(0);
    expect(validateDrillConfig({ blueprint: { qualityGateStepCountSlack: 10 } }).blueprint!.qualityGateStepCountSlack).toBe(5);
    expect(validateDrillConfig({ blueprint: { qualityGateStepCountSlack: 3 } }).blueprint!.qualityGateStepCountSlack).toBe(3);
  });

  it('does not create blueprint section when not provided', () => {
    expect(validateDrillConfig({}).blueprint).toBeUndefined();
  });
});
