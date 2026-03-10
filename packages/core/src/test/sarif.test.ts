import { describe, it, expect } from 'vitest';
import { toSarif } from '../scout/sarif.js';
import type { ScanResult, Finding } from '../scout/finding.js';

function finding(overrides: Partial<Finding> & { title: string }): Finding {
  return {
    id: 'abc123def456',
    category: 'fix',
    severity: 'degrading',
    description: 'Fix something broken',
    files: ['src/a.ts'],
    confidence: 80,
    impact: 7,
    complexity: 'simple',
    fix_available: true,
    ...overrides,
  };
}

function scanResult(findings: Finding[]): ScanResult {
  const by_severity: Record<string, number> = {};
  const by_category: Record<string, number> = {};
  for (const f of findings) {
    by_severity[f.severity] = (by_severity[f.severity] ?? 0) + 1;
    by_category[f.category] = (by_category[f.category] ?? 0) + 1;
  }
  return {
    schema_version: '1.0',
    project: 'test-project',
    scanned_files: 100,
    duration_ms: 3000,
    findings,
    summary: { total: findings.length, by_severity, by_category },
  };
}

describe('toSarif', () => {
  it('produces valid SARIF 2.1.0 structure', () => {
    const sarif = toSarif(scanResult([
      finding({ title: 'Fix null check', severity: 'blocking', category: 'security' }),
    ]), '0.8.0');

    expect(sarif.version).toBe('2.1.0');
    expect(sarif.$schema).toContain('sarif-schema-2.1.0');
    expect(sarif.runs).toHaveLength(1);
    expect(sarif.runs[0].tool.driver.name).toBe('PromptWheel');
    expect(sarif.runs[0].tool.driver.version).toBe('0.8.0');
  });

  it('maps severity to SARIF level correctly', () => {
    const sarif = toSarif(scanResult([
      finding({ title: 'A', severity: 'blocking' }),
      finding({ title: 'B', severity: 'degrading' }),
      finding({ title: 'C', severity: 'polish' }),
      finding({ title: 'D', severity: 'speculative' }),
    ]));

    const levels = sarif.runs[0].results.map(r => r.level);
    expect(levels).toEqual(['error', 'warning', 'note', 'none']);
  });

  it('creates rules for each unique category', () => {
    const sarif = toSarif(scanResult([
      finding({ title: 'A', category: 'security' }),
      finding({ title: 'B', category: 'fix' }),
      finding({ title: 'C', category: 'fix' }), // duplicate category
    ]));

    const rules = sarif.runs[0].tool.driver.rules;
    expect(rules).toHaveLength(2); // security + fix, not 3
    expect(rules.map(r => r.id)).toContain('PW-SECURITY');
    expect(rules.map(r => r.id)).toContain('PW-FIX');
  });

  it('includes file locations', () => {
    const sarif = toSarif(scanResult([
      finding({ title: 'A', files: ['src/auth.ts', 'src/middleware.ts'] }),
    ]));

    const locations = sarif.runs[0].results[0].locations;
    expect(locations).toHaveLength(2);
    expect(locations[0].physicalLocation.artifactLocation.uri).toBe('src/auth.ts');
    expect(locations[1].physicalLocation.artifactLocation.uri).toBe('src/middleware.ts');
  });

  it('adds fallback location when no files', () => {
    const sarif = toSarif(scanResult([
      finding({ title: 'A', files: [] }),
    ]));

    const locations = sarif.runs[0].results[0].locations;
    expect(locations).toHaveLength(1);
    expect(locations[0].physicalLocation.artifactLocation.uri).toBe('.');
  });

  it('includes finding properties', () => {
    const sarif = toSarif(scanResult([
      finding({
        title: 'A', id: 'abc123',
        confidence: 95, impact: 9, complexity: 'complex',
        fix_available: true, severity: 'blocking',
      }),
    ]));

    const props = sarif.runs[0].results[0].properties;
    expect(props?.findingId).toBe('abc123');
    expect(props?.confidence).toBe(95);
    expect(props?.impact).toBe(9);
    expect(props?.fixAvailable).toBe(true);
  });

  it('includes risk_assessment in properties when present', () => {
    const sarif = toSarif(scanResult([
      finding({
        title: 'A',
        risk_assessment: {
          user_impact: 'broken', exploitability: 'public',
          blast_radius: 'system_wide', data_risk: 'lost',
          confidence_basis: 'code_trace',
        },
      }),
    ]));

    const props = sarif.runs[0].results[0].properties;
    expect(props?.riskAssessment).toBeDefined();
    expect((props?.riskAssessment as Record<string, string>).user_impact).toBe('broken');
  });

  it('message includes title and description', () => {
    const sarif = toSarif(scanResult([
      finding({ title: 'Fix the bug', description: 'The bug is in auth.ts line 42' }),
    ]));

    const msg = sarif.runs[0].results[0].message.text;
    expect(msg).toContain('Fix the bug');
    expect(msg).toContain('The bug is in auth.ts line 42');
  });

  it('handles empty scan result', () => {
    const sarif = toSarif(scanResult([]));
    expect(sarif.runs[0].results).toHaveLength(0);
    expect(sarif.runs[0].tool.driver.rules).toHaveLength(0);
  });

  it('includes category tags on rules', () => {
    const sarif = toSarif(scanResult([
      finding({ title: 'A', category: 'security' }),
      finding({ title: 'B', category: 'perf' }),
    ]));

    const rules = sarif.runs[0].tool.driver.rules;
    const secRule = rules.find(r => r.id === 'PW-SECURITY');
    expect(secRule?.properties?.tags).toContain('security');
    expect(secRule?.properties?.tags).toContain('vulnerability');

    const perfRule = rules.find(r => r.id === 'PW-PERF');
    expect(perfRule?.properties?.tags).toContain('performance');
  });
});
