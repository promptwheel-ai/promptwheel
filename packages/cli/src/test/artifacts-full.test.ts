import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  writeJsonArtifact,
  readJsonArtifact,
  listArtifacts,
  getLatestArtifact,
  getArtifactsForRun,
  getArtifactByRunId,
  getAllArtifacts,
  ARTIFACT_TYPES,
} from '../lib/artifacts.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'artifacts-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('writeJsonArtifact', () => {
  it('creates file with correct path structure', () => {
    const filePath = writeJsonArtifact({
      baseDir: tmpDir,
      type: 'proposals',
      id: 'run-123',
      data: { hello: 'world' },
    });
    expect(filePath).toContain(path.join('artifacts', 'proposals'));
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it('includes timestamp in filename by default', () => {
    const filePath = writeJsonArtifact({
      baseDir: tmpDir,
      type: 'proposals',
      id: 'run-123',
      data: {},
    });
    const basename = path.basename(filePath);
    // Pattern: run-123-<timestamp>.json
    expect(basename).toMatch(/^run-123-\d+\.json$/);
  });

  it('without timestamp does not include timestamp', () => {
    const filePath = writeJsonArtifact({
      baseDir: tmpDir,
      type: 'proposals',
      id: 'run-123',
      data: {},
      timestamp: false,
    });
    expect(path.basename(filePath)).toBe('run-123.json');
  });

  it('data is valid JSON', () => {
    const data = { key: 'value', nested: { a: 1 } };
    const filePath = writeJsonArtifact({
      baseDir: tmpDir,
      type: 'runs',
      id: 'test',
      data,
      timestamp: false,
    });
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    expect(parsed).toEqual(data);
  });
});

describe('readJsonArtifact', () => {
  it('reads back written data', () => {
    const data = { foo: 'bar', num: 42 };
    const filePath = writeJsonArtifact({
      baseDir: tmpDir,
      type: 'proposals',
      id: 'read-test',
      data,
      timestamp: false,
    });
    expect(readJsonArtifact(filePath)).toEqual(data);
  });

  it('returns null for non-existent file', () => {
    expect(readJsonArtifact('/does/not/exist.json')).toBeNull();
  });
});

describe('listArtifacts', () => {
  it('returns empty for non-existent directory', () => {
    expect(listArtifacts(tmpDir, 'nonexistent')).toEqual([]);
  });

  it('returns sorted by timestamp desc', () => {
    // Write with explicit timestamps in filenames
    writeJsonArtifact({ baseDir: tmpDir, type: 'runs', id: 'a', data: {}, timestamp: false });
    // Small delay to get different timestamps
    writeJsonArtifact({ baseDir: tmpDir, type: 'runs', id: 'b', data: {}, timestamp: false });

    // Write with actual timestamps
    const p1 = writeJsonArtifact({ baseDir: tmpDir, type: 'proposals', id: 'x', data: {} });
    const p2 = writeJsonArtifact({ baseDir: tmpDir, type: 'proposals', id: 'y', data: {} });

    const list = listArtifacts(tmpDir, 'proposals');
    expect(list.length).toBe(2);
    // Most recent first
    expect(list[0].timestamp).toBeGreaterThanOrEqual(list[1].timestamp);
  });
});

describe('getLatestArtifact', () => {
  it('returns most recent', () => {
    writeJsonArtifact({ baseDir: tmpDir, type: 'runs', id: 'old', data: { v: 1 } });
    writeJsonArtifact({ baseDir: tmpDir, type: 'runs', id: 'new', data: { v: 2 } });

    const latest = getLatestArtifact(tmpDir, 'runs');
    expect(latest).not.toBeNull();
    expect(latest!.data).toHaveProperty('v');
  });

  it('returns null for empty type', () => {
    expect(getLatestArtifact(tmpDir, 'proposals')).toBeNull();
  });
});

describe('getArtifactsForRun', () => {
  it('finds artifacts across types', () => {
    writeJsonArtifact({ baseDir: tmpDir, type: 'proposals', id: 'run-abc', data: { p: 1 }, timestamp: false });
    writeJsonArtifact({ baseDir: tmpDir, type: 'executions', id: 'run-abc', data: { e: 1 }, timestamp: false });

    const result = getArtifactsForRun(tmpDir, 'run-abc');
    expect(result.proposals).not.toBeNull();
    expect(result.executions).not.toBeNull();
    expect(result.diffs).toBeNull();
  });
});

describe('getArtifactByRunId', () => {
  it('finds specific artifact', () => {
    writeJsonArtifact({ baseDir: tmpDir, type: 'diffs', id: 'run-xyz', data: { diff: '+foo' }, timestamp: false });

    const result = getArtifactByRunId(tmpDir, 'run-xyz', 'diffs');
    expect(result).not.toBeNull();
    expect(result!.data).toEqual({ diff: '+foo' });
  });
});

describe('getAllArtifacts', () => {
  it('returns all types', () => {
    writeJsonArtifact({ baseDir: tmpDir, type: 'proposals', id: 'a', data: {}, timestamp: false });
    writeJsonArtifact({ baseDir: tmpDir, type: 'runs', id: 'b', data: {}, timestamp: false });

    const all = getAllArtifacts(tmpDir);
    for (const type of ARTIFACT_TYPES) {
      expect(Array.isArray(all[type])).toBe(true);
    }
    expect(all.proposals.length).toBe(1);
    expect(all.runs.length).toBe(1);
    expect(all.diffs.length).toBe(0);
  });
});

describe('ARTIFACT_TYPES', () => {
  it('is correct', () => {
    expect(ARTIFACT_TYPES).toContain('proposals');
    expect(ARTIFACT_TYPES).toContain('executions');
    expect(ARTIFACT_TYPES).toContain('diffs');
    expect(ARTIFACT_TYPES).toContain('runs');
    expect(ARTIFACT_TYPES).toContain('violations');
    expect(ARTIFACT_TYPES).toContain('spindle');
    expect(ARTIFACT_TYPES).toContain('traces');
    expect(ARTIFACT_TYPES).toHaveLength(7);
  });
});
