import { describe, it, expect } from 'vitest';
import {
  formatDoctorReport,
  formatDoctorReportJson,
  type DoctorReport,
  type CheckResult,
} from '../lib/doctor.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCheck(overrides: Partial<CheckResult> = {}): CheckResult {
  return {
    name: 'test-check',
    status: 'pass',
    message: 'Everything is fine',
    ...overrides,
  };
}

function makeReport(overrides: Partial<DoctorReport> = {}): DoctorReport {
  return {
    checks: [],
    canScout: true,
    canRun: true,
    canPr: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// formatDoctorReport
// ---------------------------------------------------------------------------

describe('formatDoctorReport', () => {
  it('renders header', () => {
    const output = formatDoctorReport(makeReport());
    expect(output).toContain('PromptWheel Doctor');
  });

  it('renders pass checks with checkmark icon', () => {
    const report = makeReport({
      checks: [makeCheck({ status: 'pass', message: 'git found (2.40)' })],
    });
    const output = formatDoctorReport(report);
    expect(output).toContain('✅');
    expect(output).toContain('git found (2.40)');
  });

  it('renders warn checks with warning icon', () => {
    const report = makeReport({
      checks: [makeCheck({ status: 'warn', message: 'ripgrep not found', fix: 'Install rg' })],
    });
    const output = formatDoctorReport(report);
    expect(output).toContain('⚠️');
    expect(output).toContain('ripgrep not found');
    expect(output).toContain('fix: Install rg');
  });

  it('renders fail checks with X icon', () => {
    const report = makeReport({
      checks: [makeCheck({ status: 'fail', message: 'git not found', fix: 'Install git' })],
    });
    const output = formatDoctorReport(report);
    expect(output).toContain('❌');
    expect(output).toContain('git not found');
    expect(output).toContain('fix: Install git');
  });

  it('does not show fix for passing checks', () => {
    const report = makeReport({
      checks: [makeCheck({ status: 'pass', message: 'All good', fix: 'No fix needed' })],
    });
    const output = formatDoctorReport(report);
    expect(output).not.toContain('fix: No fix needed');
  });

  it('renders capabilities section', () => {
    const report = makeReport({ canScout: true, canRun: false, canPr: false });
    const output = formatDoctorReport(report);
    expect(output).toContain('Capabilities:');
    expect(output).toContain('solo scout');
    expect(output).toContain('solo run');
    expect(output).toContain('solo run --pr');
  });

  it('shows checkmark for enabled capabilities', () => {
    const report = makeReport({ canScout: true, canRun: true, canPr: true });
    const output = formatDoctorReport(report);
    // All three capabilities should have checkmarks
    const lines = output.split('\n').filter(l => l.includes('solo'));
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(line).toContain('✅');
    }
  });

  it('shows X for disabled capabilities', () => {
    const report = makeReport({ canScout: false, canRun: false, canPr: false });
    const output = formatDoctorReport(report);
    const lines = output.split('\n').filter(l => l.includes('solo'));
    for (const line of lines) {
      expect(line).toContain('❌');
    }
  });

  it('shows action required section when there are failures', () => {
    const report = makeReport({
      checks: [
        makeCheck({ status: 'fail', message: 'git not found', fix: 'Install git' }),
        makeCheck({ status: 'fail', message: 'node too old', fix: 'Upgrade to Node 18+' }),
      ],
    });
    const output = formatDoctorReport(report);
    expect(output).toContain('Action required:');
    expect(output).toContain('Install git');
    expect(output).toContain('Upgrade to Node 18+');
  });

  it('shows optional improvements when only warnings (no failures)', () => {
    const report = makeReport({
      checks: [
        makeCheck({ status: 'pass', message: 'git OK' }),
        makeCheck({ status: 'warn', message: 'ripgrep missing', fix: 'Install rg' }),
      ],
    });
    const output = formatDoctorReport(report);
    expect(output).toContain('Optional improvements:');
    expect(output).toContain('Install rg');
    expect(output).not.toContain('Action required:');
  });

  it('does not show optional improvements when there are failures', () => {
    const report = makeReport({
      checks: [
        makeCheck({ status: 'fail', message: 'git missing', fix: 'Install git' }),
        makeCheck({ status: 'warn', message: 'rg missing', fix: 'Install rg' }),
      ],
    });
    const output = formatDoctorReport(report);
    expect(output).toContain('Action required:');
    expect(output).not.toContain('Optional improvements:');
  });

  it('handles empty checks array', () => {
    const report = makeReport({ checks: [] });
    const output = formatDoctorReport(report);
    expect(output).toContain('PromptWheel Doctor');
    expect(output).toContain('Capabilities:');
  });

  it('handles mixed pass/warn/fail statuses', () => {
    const report = makeReport({
      checks: [
        makeCheck({ name: 'git', status: 'pass', message: 'git found' }),
        makeCheck({ name: 'rg', status: 'warn', message: 'ripgrep missing', fix: 'Install rg' }),
        makeCheck({ name: 'claude', status: 'fail', message: 'Claude not found', fix: 'Install Claude' }),
      ],
    });
    const output = formatDoctorReport(report);
    expect(output).toContain('✅');
    expect(output).toContain('⚠️');
    expect(output).toContain('❌');
    expect(output).toContain('Action required:');
  });
});

// ---------------------------------------------------------------------------
// formatDoctorReportJson
// ---------------------------------------------------------------------------

describe('formatDoctorReportJson', () => {
  it('returns valid JSON', () => {
    const report = makeReport({ checks: [] });
    const json = formatDoctorReportJson(report);
    expect(() => JSON.parse(json)).not.toThrow();
  });

  it('includes capabilities object', () => {
    const report = makeReport({ canScout: true, canRun: false, canPr: true });
    const parsed = JSON.parse(formatDoctorReportJson(report));
    expect(parsed.capabilities).toEqual({
      scout: true,
      run: false,
      pr: true,
    });
  });

  it('includes checks array with all fields', () => {
    const report = makeReport({
      checks: [
        makeCheck({
          name: 'git',
          status: 'pass',
          message: 'git found',
          fix: 'Install git',
          details: 'v2.40',
        }),
      ],
    });
    const parsed = JSON.parse(formatDoctorReportJson(report));
    expect(parsed.checks).toHaveLength(1);
    expect(parsed.checks[0]).toEqual({
      name: 'git',
      status: 'pass',
      message: 'git found',
      fix: 'Install git',
      details: 'v2.40',
    });
  });

  it('handles empty checks array', () => {
    const report = makeReport({ checks: [] });
    const parsed = JSON.parse(formatDoctorReportJson(report));
    expect(parsed.checks).toEqual([]);
  });

  it('preserves undefined fix and details as undefined in JSON', () => {
    const report = makeReport({
      checks: [makeCheck({ name: 'node', status: 'pass', message: 'Node OK' })],
    });
    const parsed = JSON.parse(formatDoctorReportJson(report));
    // undefined fields are omitted by JSON.stringify
    expect(parsed.checks[0].fix).toBeUndefined();
    expect(parsed.checks[0].details).toBeUndefined();
  });

  it('handles multiple checks with different statuses', () => {
    const report = makeReport({
      checks: [
        makeCheck({ name: 'a', status: 'pass', message: 'OK' }),
        makeCheck({ name: 'b', status: 'warn', message: 'Warning' }),
        makeCheck({ name: 'c', status: 'fail', message: 'Failed' }),
      ],
      canScout: true,
      canRun: false,
      canPr: false,
    });
    const parsed = JSON.parse(formatDoctorReportJson(report));
    expect(parsed.checks).toHaveLength(3);
    expect(parsed.checks.map((c: any) => c.status)).toEqual(['pass', 'warn', 'fail']);
    expect(parsed.capabilities.scout).toBe(true);
    expect(parsed.capabilities.run).toBe(false);
    expect(parsed.capabilities.pr).toBe(false);
  });

  it('outputs pretty-printed JSON (2 spaces)', () => {
    const report = makeReport({ checks: [] });
    const json = formatDoctorReportJson(report);
    // Pretty-printed JSON contains newlines and indentation
    expect(json).toContain('\n');
    expect(json).toContain('  ');
  });
});
