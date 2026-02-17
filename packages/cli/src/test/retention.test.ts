import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  pruneRunFolders,
  pruneHistory,
  pruneArtifacts,
  pruneSpoolArchives,
  pruneMetrics,
  pruneArtifactsByAge,
  pruneDeferredProposals,
  rotateLogs,
  acquireSessionLock,
  releaseSessionLock,
  formatPruneReport,
  getRetentionConfig,
  type PruneReport,
} from '../lib/retention.js';
import { DEFAULT_RETENTION_CONFIG, type SoloConfig } from '../lib/solo-config.js';
import { writeRunState, readRunState } from '../lib/run-state.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

function bsDir(): string {
  return path.join(tmpDir, '.promptwheel');
}

function mkBsSubdir(...segments: string[]): string {
  const dir = path.join(bsDir(), ...segments);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Create a file with a specific mtime offset (ms before now). */
function touchFile(filePath: string, ageMs = 0): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, 'data');
  if (ageMs > 0) {
    const mtime = new Date(Date.now() - ageMs);
    fs.utimesSync(filePath, mtime, mtime);
  }
}

/** Create a directory with a specific mtime offset. */
function touchDir(dirPath: string, ageMs = 0): void {
  fs.mkdirSync(dirPath, { recursive: true });
  if (ageMs > 0) {
    const mtime = new Date(Date.now() - ageMs);
    fs.utimesSync(dirPath, mtime, mtime);
  }
}

function emptyReport(): PruneReport {
  return {
    runFoldersRemoved: 0,
    historyLinesRemoved: 0,
    artifactsRemoved: 0,
    spoolArchivesRemoved: 0,
    deferredProposalsRemoved: 0,
    completedTicketsRemoved: 0,
    mergedBranchesRemoved: 0,
    staleBranchesRemoved: 0,
    staleWorktreesRemoved: 0,
    logsRotated: 0,
    metricsLinesRemoved: 0,
    artifactsByAgeRemoved: 0,
    totalPruned: 0,
  };
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'retention-test-'));
  fs.mkdirSync(bsDir(), { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// pruneRunFolders
// ---------------------------------------------------------------------------

describe('pruneRunFolders', () => {
  it('returns 0 when runs dir does not exist', () => {
    expect(pruneRunFolders(tmpDir, 5)).toBe(0);
  });

  it('returns 0 when under the cap', () => {
    const runsDir = mkBsSubdir('runs');
    touchDir(path.join(runsDir, 'run_1'));
    touchDir(path.join(runsDir, 'run_2'));
    expect(pruneRunFolders(tmpDir, 5)).toBe(0);
  });

  it('removes oldest folders beyond cap', () => {
    const runsDir = mkBsSubdir('runs');
    // Create 5 run folders with staggered ages
    for (let i = 0; i < 5; i++) {
      touchDir(path.join(runsDir, `run_${i}`), (5 - i) * 10_000);
    }

    const removed = pruneRunFolders(tmpDir, 3);
    expect(removed).toBe(2);
    // Should keep the 3 newest
    const remaining = fs.readdirSync(runsDir);
    expect(remaining).toHaveLength(3);
  });

  it('dryRun does not delete', () => {
    const runsDir = mkBsSubdir('runs');
    for (let i = 0; i < 5; i++) {
      touchDir(path.join(runsDir, `run_${i}`), (5 - i) * 10_000);
    }

    const removed = pruneRunFolders(tmpDir, 3, true);
    expect(removed).toBe(2);
    // All 5 should still exist
    expect(fs.readdirSync(runsDir)).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------
// pruneHistory
// ---------------------------------------------------------------------------

describe('pruneHistory', () => {
  it('returns 0 when file does not exist', () => {
    expect(pruneHistory(tmpDir, 100)).toBe(0);
  });

  it('returns 0 when under the cap', () => {
    const histPath = path.join(bsDir(), 'history.ndjson');
    fs.writeFileSync(histPath, '{"a":1}\n{"a":2}\n');
    expect(pruneHistory(tmpDir, 100)).toBe(0);
  });

  it('trims oldest lines beyond cap', () => {
    const histPath = path.join(bsDir(), 'history.ndjson');
    const lines = Array.from({ length: 10 }, (_, i) => JSON.stringify({ idx: i }));
    fs.writeFileSync(histPath, lines.join('\n') + '\n');

    const removed = pruneHistory(tmpDir, 3);
    expect(removed).toBe(7);

    const content = fs.readFileSync(histPath, 'utf-8');
    const remaining = content.split('\n').filter(l => l.trim());
    expect(remaining).toHaveLength(3);
    // Should keep the last 3
    expect(JSON.parse(remaining[0])).toEqual({ idx: 7 });
  });

  it('dryRun does not rewrite file', () => {
    const histPath = path.join(bsDir(), 'history.ndjson');
    const lines = Array.from({ length: 10 }, (_, i) => JSON.stringify({ idx: i }));
    fs.writeFileSync(histPath, lines.join('\n') + '\n');

    const removed = pruneHistory(tmpDir, 3, true);
    expect(removed).toBe(7);

    // File should be unchanged
    const content = fs.readFileSync(histPath, 'utf-8');
    const remaining = content.split('\n').filter(l => l.trim());
    expect(remaining).toHaveLength(10);
  });
});

// ---------------------------------------------------------------------------
// pruneArtifacts
// ---------------------------------------------------------------------------

describe('pruneArtifacts', () => {
  it('returns 0 when runs dir does not exist', () => {
    expect(pruneArtifacts(tmpDir, 5)).toBe(0);
  });

  it('returns 0 when each run is under the cap', () => {
    const runsDir = mkBsSubdir('runs');
    const runDir = path.join(runsDir, 'run_1');
    fs.mkdirSync(runDir, { recursive: true });
    touchFile(path.join(runDir, 'a.json'));
    touchFile(path.join(runDir, 'b.json'));
    expect(pruneArtifacts(tmpDir, 5)).toBe(0);
  });

  it('removes oldest artifact files per run beyond cap', () => {
    const runsDir = mkBsSubdir('runs');
    const runDir = path.join(runsDir, 'run_1');
    fs.mkdirSync(runDir, { recursive: true });

    for (let i = 0; i < 5; i++) {
      touchFile(path.join(runDir, `file_${i}.json`), (5 - i) * 10_000);
    }

    const removed = pruneArtifacts(tmpDir, 2);
    expect(removed).toBe(3);
    expect(fs.readdirSync(runDir)).toHaveLength(2);
  });

  it('dryRun does not delete', () => {
    const runsDir = mkBsSubdir('runs');
    const runDir = path.join(runsDir, 'run_1');
    fs.mkdirSync(runDir, { recursive: true });

    for (let i = 0; i < 5; i++) {
      touchFile(path.join(runDir, `file_${i}.json`), (5 - i) * 10_000);
    }

    const removed = pruneArtifacts(tmpDir, 2, true);
    expect(removed).toBe(3);
    expect(fs.readdirSync(runDir)).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------
// pruneSpoolArchives
// ---------------------------------------------------------------------------

describe('pruneSpoolArchives', () => {
  it('returns 0 when spool dir does not exist', () => {
    expect(pruneSpoolArchives(tmpDir, 5)).toBe(0);
  });

  it('returns 0 when under the cap', () => {
    const spoolDir = mkBsSubdir('spool');
    touchFile(path.join(spoolDir, 'a.archived.ndjson'));
    expect(pruneSpoolArchives(tmpDir, 5)).toBe(0);
  });

  it('removes oldest archives beyond cap', () => {
    const spoolDir = mkBsSubdir('spool');
    for (let i = 0; i < 5; i++) {
      touchFile(path.join(spoolDir, `arc_${i}.archived.ndjson`), (5 - i) * 10_000);
    }

    const removed = pruneSpoolArchives(tmpDir, 2);
    expect(removed).toBe(3);
    const remaining = fs.readdirSync(spoolDir).filter(f => f.endsWith('.archived.ndjson'));
    expect(remaining).toHaveLength(2);
  });

  it('ignores non-archived files', () => {
    const spoolDir = mkBsSubdir('spool');
    touchFile(path.join(spoolDir, 'active.ndjson'));
    touchFile(path.join(spoolDir, 'a.archived.ndjson'));
    expect(pruneSpoolArchives(tmpDir, 5)).toBe(0);
  });

  it('dryRun does not delete', () => {
    const spoolDir = mkBsSubdir('spool');
    for (let i = 0; i < 5; i++) {
      touchFile(path.join(spoolDir, `arc_${i}.archived.ndjson`), (5 - i) * 10_000);
    }

    const removed = pruneSpoolArchives(tmpDir, 2, true);
    expect(removed).toBe(3);
    expect(fs.readdirSync(spoolDir).filter(f => f.endsWith('.archived.ndjson'))).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------
// rotateLogs
// ---------------------------------------------------------------------------

describe('rotateLogs', () => {
  it('returns 0 when log does not exist', () => {
    expect(rotateLogs(tmpDir, 1024)).toBe(0);
  });

  it('returns 0 when log is under maxBytes', () => {
    const logPath = path.join(bsDir(), 'tui.log');
    fs.writeFileSync(logPath, 'short');
    expect(rotateLogs(tmpDir, 1024)).toBe(0);
  });

  it('rotates log exceeding maxBytes', () => {
    const logPath = path.join(bsDir(), 'tui.log');
    fs.writeFileSync(logPath, 'x'.repeat(2000));

    const rotated = rotateLogs(tmpDir, 1024);
    expect(rotated).toBe(1);
    expect(fs.existsSync(logPath)).toBe(false);
    expect(fs.existsSync(path.join(bsDir(), 'tui.log.1'))).toBe(true);
  });

  it('overwrites previous backup', () => {
    const logPath = path.join(bsDir(), 'tui.log');
    const backupPath = path.join(bsDir(), 'tui.log.1');
    fs.writeFileSync(backupPath, 'old backup');
    fs.writeFileSync(logPath, 'x'.repeat(2000));

    rotateLogs(tmpDir, 1024);
    const content = fs.readFileSync(backupPath, 'utf-8');
    expect(content).toBe('x'.repeat(2000));
  });

  it('dryRun does not rotate', () => {
    const logPath = path.join(bsDir(), 'tui.log');
    fs.writeFileSync(logPath, 'x'.repeat(2000));

    const rotated = rotateLogs(tmpDir, 1024, true);
    expect(rotated).toBe(1);
    expect(fs.existsSync(logPath)).toBe(true);
  });

  it('returns 0 when maxBytes is 0', () => {
    const logPath = path.join(bsDir(), 'tui.log');
    fs.writeFileSync(logPath, 'x'.repeat(2000));
    expect(rotateLogs(tmpDir, 0)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// pruneMetrics
// ---------------------------------------------------------------------------

describe('pruneMetrics', () => {
  it('returns 0 when file does not exist', () => {
    expect(pruneMetrics(tmpDir, 100)).toBe(0);
  });

  it('returns 0 when under the cap', () => {
    const metricsPath = path.join(bsDir(), 'metrics.ndjson');
    fs.writeFileSync(metricsPath, '{"a":1}\n{"a":2}\n');
    expect(pruneMetrics(tmpDir, 100)).toBe(0);
  });

  it('trims oldest lines beyond cap', () => {
    const metricsPath = path.join(bsDir(), 'metrics.ndjson');
    const lines = Array.from({ length: 10 }, (_, i) => JSON.stringify({ idx: i }));
    fs.writeFileSync(metricsPath, lines.join('\n') + '\n');

    const removed = pruneMetrics(tmpDir, 4);
    expect(removed).toBe(6);

    const content = fs.readFileSync(metricsPath, 'utf-8');
    const remaining = content.split('\n').filter(l => l.trim());
    expect(remaining).toHaveLength(4);
    expect(JSON.parse(remaining[0])).toEqual({ idx: 6 });
  });

  it('dryRun does not rewrite', () => {
    const metricsPath = path.join(bsDir(), 'metrics.ndjson');
    const lines = Array.from({ length: 10 }, (_, i) => JSON.stringify({ idx: i }));
    fs.writeFileSync(metricsPath, lines.join('\n') + '\n');

    const removed = pruneMetrics(tmpDir, 4, true);
    expect(removed).toBe(6);
    const content = fs.readFileSync(metricsPath, 'utf-8');
    expect(content.split('\n').filter(l => l.trim())).toHaveLength(10);
  });

  it('returns 0 when maxEntries is 0', () => {
    const metricsPath = path.join(bsDir(), 'metrics.ndjson');
    fs.writeFileSync(metricsPath, '{"a":1}\n');
    expect(pruneMetrics(tmpDir, 0)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// pruneArtifactsByAge
// ---------------------------------------------------------------------------

describe('pruneArtifactsByAge', () => {
  it('returns 0 when artifacts dir does not exist', () => {
    expect(pruneArtifactsByAge(tmpDir, 14)).toBe(0);
  });

  it('returns 0 when maxDays is 0', () => {
    mkBsSubdir('artifacts', 'diffs');
    expect(pruneArtifactsByAge(tmpDir, 0)).toBe(0);
  });

  it('returns 0 when all files are recent', () => {
    const diffsDir = mkBsSubdir('artifacts', 'diffs');
    touchFile(path.join(diffsDir, 'diff_1.json'));
    touchFile(path.join(diffsDir, 'diff_2.json'));
    expect(pruneArtifactsByAge(tmpDir, 14)).toBe(0);
  });

  it('removes files older than maxDays', () => {
    const diffsDir = mkBsSubdir('artifacts', 'diffs');
    const day = 24 * 60 * 60 * 1000;
    touchFile(path.join(diffsDir, 'old.json'), 20 * day);
    touchFile(path.join(diffsDir, 'recent.json'), 1 * day);

    const removed = pruneArtifactsByAge(tmpDir, 14);
    expect(removed).toBe(1);
    expect(fs.existsSync(path.join(diffsDir, 'recent.json'))).toBe(true);
    expect(fs.existsSync(path.join(diffsDir, 'old.json'))).toBe(false);
  });

  it('removes across multiple subdirectories', () => {
    const day = 24 * 60 * 60 * 1000;
    const diffsDir = mkBsSubdir('artifacts', 'diffs');
    const execDir = mkBsSubdir('artifacts', 'executions');
    touchFile(path.join(diffsDir, 'old.json'), 20 * day);
    touchFile(path.join(execDir, 'old.json'), 20 * day);
    touchFile(path.join(diffsDir, 'recent.json'));

    const removed = pruneArtifactsByAge(tmpDir, 14);
    expect(removed).toBe(2);
  });

  it('removes empty subdirectories after pruning', () => {
    const day = 24 * 60 * 60 * 1000;
    const emptySubdir = mkBsSubdir('artifacts', 'violations');
    touchFile(path.join(emptySubdir, 'old.json'), 20 * day);

    pruneArtifactsByAge(tmpDir, 14);
    expect(fs.existsSync(emptySubdir)).toBe(false);
  });

  it('dryRun does not delete', () => {
    const day = 24 * 60 * 60 * 1000;
    const diffsDir = mkBsSubdir('artifacts', 'diffs');
    touchFile(path.join(diffsDir, 'old.json'), 20 * day);

    const removed = pruneArtifactsByAge(tmpDir, 14, true);
    expect(removed).toBe(1);
    expect(fs.existsSync(path.join(diffsDir, 'old.json'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// acquireSessionLock / releaseSessionLock
// ---------------------------------------------------------------------------

describe('acquireSessionLock', () => {
  it('acquires lock when no lock file exists', () => {
    const result = acquireSessionLock(tmpDir);
    expect(result.acquired).toBe(true);
    const lockPath = path.join(bsDir(), 'session.pid');
    expect(fs.existsSync(lockPath)).toBe(true);
    expect(fs.readFileSync(lockPath, 'utf-8').trim()).toBe(String(process.pid));
  });

  it('acquires lock when previous holder is dead (stale PID)', () => {
    const lockPath = path.join(bsDir(), 'session.pid');
    // Use a PID that almost certainly doesn't exist
    fs.writeFileSync(lockPath, '999999999');

    const result = acquireSessionLock(tmpDir);
    expect(result.acquired).toBe(true);
    expect(result.stalePid).toBe(999999999);
  });

  it('fails to acquire when current process holds it', () => {
    const lockPath = path.join(bsDir(), 'session.pid');
    // Write current PID — simulates another live session
    fs.writeFileSync(lockPath, String(process.pid));

    const result = acquireSessionLock(tmpDir);
    // Current PID is alive, so it should fail
    expect(result.acquired).toBe(false);
  });

  it('handles corrupt lock file', () => {
    const lockPath = path.join(bsDir(), 'session.pid');
    fs.writeFileSync(lockPath, 'not-a-number');

    const result = acquireSessionLock(tmpDir);
    expect(result.acquired).toBe(true);
  });
});

describe('releaseSessionLock', () => {
  it('removes lock file owned by current process', () => {
    const lockPath = path.join(bsDir(), 'session.pid');
    fs.writeFileSync(lockPath, String(process.pid));

    releaseSessionLock(tmpDir);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('does not remove lock file owned by another process', () => {
    const lockPath = path.join(bsDir(), 'session.pid');
    fs.writeFileSync(lockPath, '12345');

    releaseSessionLock(tmpDir);
    expect(fs.existsSync(lockPath)).toBe(true);
  });

  it('is a no-op when lock file does not exist', () => {
    // Should not throw
    releaseSessionLock(tmpDir);
  });
});

// ---------------------------------------------------------------------------
// formatPruneReport
// ---------------------------------------------------------------------------

describe('formatPruneReport', () => {
  it('returns "Nothing to prune" for empty report', () => {
    const report = emptyReport();
    expect(formatPruneReport(report)).toBe('  Nothing to prune.');
  });

  it('uses "Removed" prefix for non-dry run', () => {
    const report = emptyReport();
    report.runFoldersRemoved = 3;
    const output = formatPruneReport(report);
    expect(output).toContain('Removed 3 run folder(s)');
  });

  it('uses "Would remove" prefix for dry run', () => {
    const report = emptyReport();
    report.runFoldersRemoved = 3;
    const output = formatPruneReport(report, true);
    expect(output).toContain('Would remove 3 run folder(s)');
  });

  it('lists all non-zero fields', () => {
    const report: PruneReport = {
      runFoldersRemoved: 1,
      historyLinesRemoved: 2,
      artifactsRemoved: 3,
      spoolArchivesRemoved: 4,
      deferredProposalsRemoved: 5,
      completedTicketsRemoved: 6,
      mergedBranchesRemoved: 7,
      staleBranchesRemoved: 8,
      staleWorktreesRemoved: 9,
      logsRotated: 1,
      metricsLinesRemoved: 10,
      artifactsByAgeRemoved: 11,
      totalPruned: 67,
    };

    const output = formatPruneReport(report);
    expect(output).toContain('run folder(s)');
    expect(output).toContain('history line(s)');
    expect(output).toContain('artifact file(s)');
    expect(output).toContain('spool archive(s)');
    expect(output).toContain('deferred proposal(s)');
    expect(output).toContain('completed ticket(s)');
    expect(output).toContain('merged branch(es)');
    expect(output).toContain('stale ticket branch(es)');
    expect(output).toContain('stale worktree(s)');
    expect(output).toContain('Rotated tui.log');
    expect(output).toContain('metrics line(s)');
    expect(output).toContain('expired artifact(s)');
  });

  it('omits zero-value fields', () => {
    const report = emptyReport();
    report.runFoldersRemoved = 2;
    const output = formatPruneReport(report);
    expect(output).not.toContain('history');
    expect(output).not.toContain('artifact');
    expect(output).not.toContain('spool');
  });
});

// ---------------------------------------------------------------------------
// getRetentionConfig
// ---------------------------------------------------------------------------

describe('getRetentionConfig', () => {
  it('returns defaults when config is null', () => {
    const result = getRetentionConfig(null);
    expect(result).toEqual(DEFAULT_RETENTION_CONFIG);
  });

  it('returns defaults when config has no retention field', () => {
    const config = { version: 1, repoRoot: '/tmp', createdAt: '', dbPath: '' } as SoloConfig;
    const result = getRetentionConfig(config);
    expect(result).toEqual(DEFAULT_RETENTION_CONFIG);
  });

  it('merges partial overrides with defaults', () => {
    const config = {
      version: 1,
      repoRoot: '/tmp',
      createdAt: '',
      dbPath: '',
      retention: { maxRuns: 10, maxHistoryEntries: 25 },
    } as SoloConfig;

    const result = getRetentionConfig(config);
    expect(result.maxRuns).toBe(10);
    expect(result.maxHistoryEntries).toBe(25);
    // Non-overridden fields stay at defaults
    expect(result.maxArtifactsPerRun).toBe(DEFAULT_RETENTION_CONFIG.maxArtifactsPerRun);
    expect(result.maxSpoolArchives).toBe(DEFAULT_RETENTION_CONFIG.maxSpoolArchives);
    expect(result.maxDeferredProposals).toBe(DEFAULT_RETENTION_CONFIG.maxDeferredProposals);
  });

  it('overrides a single field while keeping the rest', () => {
    const config = {
      version: 1,
      repoRoot: '/tmp',
      createdAt: '',
      dbPath: '',
      retention: { maxLogSizeBytes: 512 },
    } as SoloConfig;

    const result = getRetentionConfig(config);
    expect(result.maxLogSizeBytes).toBe(512);
    expect(result.maxRuns).toBe(DEFAULT_RETENTION_CONFIG.maxRuns);
  });
});

// ---------------------------------------------------------------------------
// pruneDeferredProposals
// ---------------------------------------------------------------------------

describe('pruneDeferredProposals', () => {
  function seedDeferred(count: number): void {
    const state = readRunState(tmpDir);
    state.deferredProposals = Array.from({ length: count }, (_, i) => ({
      category: 'test',
      title: `Proposal ${i}`,
      description: `Description ${i}`,
      files: [`file_${i}.ts`],
      allowed_paths: [`src/file_${i}.ts`],
      confidence: 80,
      impact_score: 5,
      original_scope: 'src/**',
      deferredAt: Date.now() - (count - i) * 1000, // oldest first
    }));
    writeRunState(tmpDir, state);
  }

  it('returns 0 when no deferred proposals exist', () => {
    expect(pruneDeferredProposals(tmpDir, 10)).toBe(0);
  });

  it('returns 0 when under the cap', () => {
    seedDeferred(3);
    expect(pruneDeferredProposals(tmpDir, 10)).toBe(0);
  });

  it('returns 0 when exactly at the cap', () => {
    seedDeferred(5);
    expect(pruneDeferredProposals(tmpDir, 5)).toBe(0);
  });

  it('trims oldest proposals beyond cap', () => {
    seedDeferred(10);
    const removed = pruneDeferredProposals(tmpDir, 3);
    expect(removed).toBe(7);

    const state = readRunState(tmpDir);
    expect(state.deferredProposals).toHaveLength(3);
    // Should keep the newest 3 (last added = highest index)
    expect(state.deferredProposals[0].title).toBe('Proposal 7');
    expect(state.deferredProposals[1].title).toBe('Proposal 8');
    expect(state.deferredProposals[2].title).toBe('Proposal 9');
  });

  it('dryRun reports count without deleting', () => {
    seedDeferred(8);
    const removed = pruneDeferredProposals(tmpDir, 3, true);
    expect(removed).toBe(5);

    // All 8 should still exist
    const state = readRunState(tmpDir);
    expect(state.deferredProposals).toHaveLength(8);
  });

  it('keeps one when maxDeferred is 1', () => {
    seedDeferred(5);
    const removed = pruneDeferredProposals(tmpDir, 1);
    expect(removed).toBe(4);

    const state = readRunState(tmpDir);
    expect(state.deferredProposals).toHaveLength(1);
    expect(state.deferredProposals[0].title).toBe('Proposal 4');
  });
});
