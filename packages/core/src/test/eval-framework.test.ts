import { describe, it, expect } from 'vitest';
import { evalProject, formatEvalResult, type EvalCase } from '../scout/eval.js';
import type { ScanResult, Finding } from '../scout/finding.js';

function finding(overrides: Partial<Finding> & { title: string }): Finding {
  return {
    id: 'test',
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

function scanResult(findings: Finding[]): ScanResult {
  return {
    schema_version: '1.0',
    project: 'test',
    scanned_files: 100,
    duration_ms: 3000,
    findings,
    summary: { total: findings.length, by_severity: {}, by_category: {} },
  };
}

const defaultTolerance = { severity_drift: 0, min_recall: 0.5, max_false_positive_rate: 0.5 };

describe('evalProject', () => {
  it('perfect match: all expected found', () => {
    const result = evalProject(
      scanResult([
        finding({ title: 'Fix null check in auth', severity: 'blocking', files: ['src/auth.ts'] }),
        finding({ title: 'Remove dead code in utils', severity: 'polish', files: ['src/utils.ts'] }),
      ]),
      {
        project: 'test',
        expected: [
          { title_pattern: 'null check', severity: 'blocking', file_pattern: 'auth' },
          { title_pattern: 'dead code', severity: 'polish', file_pattern: 'utils' },
        ],
        tolerance: defaultTolerance,
      },
    );

    expect(result.precision).toBe(1);
    expect(result.recall).toBe(1);
    expect(result.severity_accuracy).toBe(1);
    expect(result.passed).toBe(true);
    expect(result.true_positives).toHaveLength(2);
    expect(result.false_negatives).toHaveLength(0);
    expect(result.unmatched_findings).toHaveLength(0);
  });

  it('partial match: some expected missing', () => {
    const result = evalProject(
      scanResult([
        finding({ title: 'Fix null check in auth', severity: 'blocking' }),
      ]),
      {
        project: 'test',
        expected: [
          { title_pattern: 'null check', severity: 'blocking' },
          { title_pattern: 'dead code', severity: 'polish' },
        ],
        tolerance: defaultTolerance,
      },
    );

    expect(result.recall).toBe(0.5);
    expect(result.precision).toBe(1);
    expect(result.true_positives).toHaveLength(1);
    expect(result.false_negatives).toHaveLength(1);
    expect(result.passed).toBe(true); // min_recall=0.5, we have 0.5
  });

  it('extra findings: precision drops', () => {
    const result = evalProject(
      scanResult([
        finding({ title: 'Fix null check in auth', severity: 'blocking' }),
        finding({ title: 'Some extra finding', severity: 'polish' }),
        finding({ title: 'Another extra finding', severity: 'speculative' }),
      ]),
      {
        project: 'test',
        expected: [
          { title_pattern: 'null check', severity: 'blocking' },
        ],
        tolerance: defaultTolerance,
      },
    );

    expect(result.precision).toBeCloseTo(1 / 3);
    expect(result.recall).toBe(1);
    expect(result.unmatched_findings).toHaveLength(2);
  });

  it('severity mismatch: severity_accuracy drops', () => {
    const result = evalProject(
      scanResult([
        finding({ title: 'Fix null check', severity: 'polish' }), // expected blocking
        finding({ title: 'Remove dead code', severity: 'degrading' }), // expected polish
      ]),
      {
        project: 'test',
        expected: [
          { title_pattern: 'null check', severity: 'blocking' },
          { title_pattern: 'dead code', severity: 'polish' },
        ],
        tolerance: { severity_drift: 0, min_recall: 0, max_false_positive_rate: 1 },
      },
    );

    expect(result.severity_accuracy).toBe(0); // both wrong
    expect(result.recall).toBe(1);
  });

  it('severity_drift=1 allows ±1 tier', () => {
    const result = evalProject(
      scanResult([
        finding({ title: 'Fix null check', severity: 'degrading' }), // expected blocking, 1 off
      ]),
      {
        project: 'test',
        expected: [
          { title_pattern: 'null check', severity: 'blocking' },
        ],
        tolerance: { severity_drift: 1, min_recall: 0, max_false_positive_rate: 1 },
      },
    );

    expect(result.true_positives[0].severity_match).toBe(true);
    expect(result.severity_accuracy).toBe(1);
  });

  it('severity_drift=0 requires exact match', () => {
    const result = evalProject(
      scanResult([
        finding({ title: 'Fix null check', severity: 'degrading' }), // expected blocking
      ]),
      {
        project: 'test',
        expected: [
          { title_pattern: 'null check', severity: 'blocking' },
        ],
        tolerance: { severity_drift: 0, min_recall: 0, max_false_positive_rate: 1 },
      },
    );

    expect(result.true_positives[0].severity_match).toBe(false);
    expect(result.severity_accuracy).toBe(0);
  });

  it('fails when recall below threshold', () => {
    const result = evalProject(
      scanResult([]),
      {
        project: 'test',
        expected: [
          { title_pattern: 'something', severity: 'blocking' },
        ],
        tolerance: { severity_drift: 0, min_recall: 0.8, max_false_positive_rate: 1 },
      },
    );

    expect(result.recall).toBe(0);
    expect(result.passed).toBe(false);
  });

  it('fails when false positive rate above threshold', () => {
    const result = evalProject(
      scanResult([
        finding({ title: 'Expected finding', severity: 'blocking' }),
        finding({ title: 'Extra 1', severity: 'polish' }),
        finding({ title: 'Extra 2', severity: 'polish' }),
        finding({ title: 'Extra 3', severity: 'polish' }),
        finding({ title: 'Extra 4', severity: 'polish' }),
      ]),
      {
        project: 'test',
        expected: [
          { title_pattern: 'Expected finding', severity: 'blocking' },
        ],
        tolerance: { severity_drift: 0, min_recall: 0, max_false_positive_rate: 0.5 },
      },
    );

    expect(result.passed).toBe(false); // 4/5 = 80% FP rate > 50%
  });

  it('empty scan and empty expected: passes', () => {
    const result = evalProject(
      scanResult([]),
      { project: 'test', expected: [], tolerance: defaultTolerance },
    );

    expect(result.precision).toBe(1);
    expect(result.recall).toBe(1);
    expect(result.passed).toBe(true);
  });

  it('file_pattern filters matches', () => {
    const result = evalProject(
      scanResult([
        finding({ title: 'Fix null check in utils', files: ['src/utils.ts'], severity: 'blocking' }),
      ]),
      {
        project: 'test',
        expected: [
          { title_pattern: 'null check', severity: 'blocking', file_pattern: 'auth' },
        ],
        tolerance: { severity_drift: 0, min_recall: 0, max_false_positive_rate: 1 },
      },
    );

    // Title matches but file doesn't → no match
    expect(result.true_positives).toHaveLength(0);
    expect(result.false_negatives).toHaveLength(1);
    expect(result.unmatched_findings).toHaveLength(1);
  });
});

describe('formatEvalResult', () => {
  it('formats a passing result', () => {
    const result = evalProject(
      scanResult([finding({ title: 'Fix null check', severity: 'blocking' })]),
      {
        project: 'myproject',
        expected: [{ title_pattern: 'null check', severity: 'blocking' }],
        tolerance: defaultTolerance,
      },
    );

    const formatted = formatEvalResult(result);
    expect(formatted).toContain('myproject');
    expect(formatted).toContain('PASS');
    expect(formatted).toContain('100%');
    expect(formatted).toContain('null check');
  });

  it('formats a failing result with missed findings', () => {
    const result = evalProject(
      scanResult([]),
      {
        project: 'myproject',
        expected: [{ title_pattern: 'missing thing', severity: 'blocking' }],
        tolerance: { severity_drift: 0, min_recall: 0.8, max_false_positive_rate: 1 },
      },
    );

    const formatted = formatEvalResult(result);
    expect(formatted).toContain('FAIL');
    expect(formatted).toContain('missing thing');
    expect(formatted).toContain('Missed');
  });
});
