import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createBaseline,
  loadBaseline,
  saveBaseline,
  suppressFinding,
  unsuppressFinding,
  filterByBaseline,
  baselineSize,
  baselinePath,
  parseDuration,
  countExpired,
} from '../scout/baseline.js';
import type { Finding } from '../scout/finding.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-baseline-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function finding(id: string, overrides: Partial<Finding> = {}): Finding {
  return {
    id,
    title: `Finding ${id}`,
    category: 'fix',
    severity: 'degrading',
    description: 'desc',
    files: ['src/a.ts'],
    confidence: 80,
    impact: 7,
    complexity: 'simple',
    fix_available: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

describe('baseline persistence', () => {
  it('returns null when no baseline exists', () => {
    expect(loadBaseline(tmpDir)).toBeNull();
  });

  it('saves and loads a baseline', () => {
    const bl = createBaseline([finding('a'), finding('b')], 'initial');
    saveBaseline(tmpDir, bl);

    const loaded = loadBaseline(tmpDir);
    expect(loaded).not.toBeNull();
    expect(loaded!.version).toBe('1.0');
    expect(Object.keys(loaded!.entries)).toHaveLength(2);
    expect(loaded!.entries['a'].title).toBe('Finding a');
    expect(loaded!.entries['a'].reason).toBe('initial');
  });

  it('creates directory if missing', () => {
    const nested = path.join(tmpDir, 'sub', 'dir');
    const bl = createBaseline([]);
    saveBaseline(nested, bl);
    expect(fs.existsSync(baselinePath(nested))).toBe(true);
  });

  it('returns null for malformed file', () => {
    fs.writeFileSync(baselinePath(tmpDir), '{"bad json');
    expect(loadBaseline(tmpDir)).toBeNull();
  });

  it('returns null for wrong version', () => {
    fs.writeFileSync(baselinePath(tmpDir), JSON.stringify({ version: '2.0', entries: {} }));
    expect(loadBaseline(tmpDir)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// createBaseline
// ---------------------------------------------------------------------------

describe('createBaseline', () => {
  it('creates baseline from findings', () => {
    const bl = createBaseline(
      [finding('a', { severity: 'blocking' }), finding('b')],
      'tech debt',
      'alice',
    );

    expect(bl.version).toBe('1.0');
    expect(Object.keys(bl.entries)).toHaveLength(2);
    expect(bl.entries['a'].severity).toBe('blocking');
    expect(bl.entries['a'].reason).toBe('tech debt');
    expect(bl.entries['a'].suppressed_by).toBe('alice');
    expect(bl.entries['b'].suppressed_by).toBe('alice');
  });

  it('creates empty baseline', () => {
    const bl = createBaseline([]);
    expect(Object.keys(bl.entries)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// suppress / unsuppress
// ---------------------------------------------------------------------------

describe('suppressFinding', () => {
  it('adds finding to baseline', () => {
    const bl = createBaseline([]);
    suppressFinding(bl, finding('x', { severity: 'blocking' }), 'known issue', 'bob');

    expect(bl.entries['x'].title).toBe('Finding x');
    expect(bl.entries['x'].severity).toBe('blocking');
    expect(bl.entries['x'].reason).toBe('known issue');
    expect(bl.entries['x'].suppressed_by).toBe('bob');
  });

  it('overwrites existing entry', () => {
    const bl = createBaseline([finding('x')], 'old reason');
    suppressFinding(bl, finding('x'), 'new reason');

    expect(bl.entries['x'].reason).toBe('new reason');
    expect(Object.keys(bl.entries)).toHaveLength(1);
  });
});

describe('unsuppressFinding', () => {
  it('removes finding from baseline', () => {
    const bl = createBaseline([finding('a'), finding('b')]);
    const removed = unsuppressFinding(bl, 'a');

    expect(removed).toBe(true);
    expect(Object.keys(bl.entries)).toHaveLength(1);
    expect(bl.entries['b']).toBeDefined();
  });

  it('returns false for unknown finding', () => {
    const bl = createBaseline([finding('a')]);
    expect(unsuppressFinding(bl, 'z')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// filterByBaseline
// ---------------------------------------------------------------------------

describe('filterByBaseline', () => {
  it('splits findings into active and baselined', () => {
    const bl = createBaseline([finding('a'), finding('b')]);
    const findings = [finding('a'), finding('b'), finding('c')];

    const { active, baselined } = filterByBaseline(findings, bl);
    expect(active.map(f => f.id)).toEqual(['c']);
    expect(baselined.map(f => f.id)).toEqual(['a', 'b']);
  });

  it('returns all active when no baseline', () => {
    const findings = [finding('a'), finding('b')];
    const { active, baselined } = filterByBaseline(findings, null);

    expect(active).toHaveLength(2);
    expect(baselined).toHaveLength(0);
  });

  it('returns all active when baseline is empty', () => {
    const bl = createBaseline([]);
    const findings = [finding('a')];
    const { active, baselined } = filterByBaseline(findings, bl);

    expect(active).toHaveLength(1);
    expect(baselined).toHaveLength(0);
  });

  it('handles findings all in baseline', () => {
    const bl = createBaseline([finding('a'), finding('b')]);
    const { active, baselined } = filterByBaseline([finding('a'), finding('b')], bl);

    expect(active).toHaveLength(0);
    expect(baselined).toHaveLength(2);
  });

  it('handles stale baseline entries (finding no longer in scan)', () => {
    const bl = createBaseline([finding('a'), finding('old')]);
    const { active, baselined } = filterByBaseline([finding('a'), finding('c')], bl);

    expect(active.map(f => f.id)).toEqual(['c']);
    expect(baselined.map(f => f.id)).toEqual(['a']);
    // 'old' is in baseline but not in findings — it's just ignored
  });
});

// ---------------------------------------------------------------------------
// baselineSize
// ---------------------------------------------------------------------------

describe('baselineSize', () => {
  it('returns 0 for null baseline', () => {
    expect(baselineSize(null)).toBe(0);
  });

  it('returns entry count', () => {
    const bl = createBaseline([finding('a'), finding('b'), finding('c')]);
    expect(baselineSize(bl)).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Suppression expiration
// ---------------------------------------------------------------------------

describe('parseDuration', () => {
  it('parses days', () => {
    expect(parseDuration('90d')).toBe(90 * 86400000);
  });

  it('parses weeks', () => {
    expect(parseDuration('4w')).toBe(4 * 7 * 86400000);
  });

  it('parses months (30d)', () => {
    expect(parseDuration('6m')).toBe(6 * 30 * 86400000);
  });

  it('returns null for invalid input', () => {
    expect(parseDuration('abc')).toBeNull();
    expect(parseDuration('90')).toBeNull();
    expect(parseDuration('')).toBeNull();
    expect(parseDuration('90x')).toBeNull();
  });

  it('is case-insensitive', () => {
    expect(parseDuration('90D')).toBe(90 * 86400000);
    expect(parseDuration('4W')).toBe(4 * 7 * 86400000);
  });
});

describe('filterByBaseline — expiration', () => {
  it('treats expired suppressions as active', () => {
    const bl = createBaseline([finding('a'), finding('b')]);
    // Set 'a' to already expired
    bl.entries['a'].expires_at = new Date(Date.now() - 1000).toISOString();

    const { active, baselined, expired } = filterByBaseline(
      [finding('a'), finding('b'), finding('c')],
      bl,
    );

    expect(active.map(f => f.id)).toEqual(['a', 'c']);
    expect(baselined.map(f => f.id)).toEqual(['b']);
    expect(expired.map(f => f.id)).toEqual(['a']);
  });

  it('keeps non-expired suppressions as baselined', () => {
    const bl = createBaseline([finding('a')]);
    bl.entries['a'].expires_at = new Date(Date.now() + 86400000).toISOString();

    const { active, baselined, expired } = filterByBaseline([finding('a')], bl);

    expect(active).toHaveLength(0);
    expect(baselined).toHaveLength(1);
    expect(expired).toHaveLength(0);
  });

  it('suppressions without expires_at never expire', () => {
    const bl = createBaseline([finding('a')]);
    // No expires_at set

    const { baselined, expired } = filterByBaseline([finding('a')], bl);

    expect(baselined).toHaveLength(1);
    expect(expired).toHaveLength(0);
  });
});

describe('countExpired', () => {
  it('returns 0 for null baseline', () => {
    expect(countExpired(null)).toBe(0);
  });

  it('counts expired entries', () => {
    const bl = createBaseline([finding('a'), finding('b'), finding('c')]);
    bl.entries['a'].expires_at = new Date(Date.now() - 1000).toISOString();
    bl.entries['b'].expires_at = new Date(Date.now() - 1000).toISOString();
    // 'c' has no expiration

    expect(countExpired(bl)).toBe(2);
  });

  it('does not count future expirations', () => {
    const bl = createBaseline([finding('a')]);
    bl.entries['a'].expires_at = new Date(Date.now() + 86400000).toISOString();

    expect(countExpired(bl)).toBe(0);
  });
});
