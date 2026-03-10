import { describe, it, expect } from 'vitest';
import { parseSarif, ingestToScanResult } from '../scout/ingest.js';
import { findingToProposal } from '../scout/finding.js';

// Minimal SARIF 2.1.0 from CodeQL-style output
const CODEQL_SARIF = JSON.stringify({
  $schema: 'https://raw.githubusercontent.com/oasis-tcs/sarif-spec/main/sarif-2.1/schema/sarif-schema-2.1.0.json',
  version: '2.1.0',
  runs: [{
    tool: {
      driver: {
        name: 'CodeQL',
        version: '2.16.0',
        rules: [
          {
            id: 'js/sql-injection',
            name: 'SqlInjection',
            shortDescription: { text: 'SQL injection vulnerability' },
            fullDescription: { text: 'User-controlled data is used in a SQL query without sanitization.' },
            defaultConfiguration: { level: 'error' },
            properties: { tags: ['security', 'cwe-089'] },
          },
          {
            id: 'js/unused-variable',
            name: 'UnusedVariable',
            shortDescription: { text: 'Unused variable' },
            defaultConfiguration: { level: 'note' },
            properties: { tags: ['maintainability'] },
          },
        ],
      },
    },
    results: [
      {
        ruleId: 'js/sql-injection',
        level: 'error',
        message: { text: 'This query depends on a user-provided value in req.params.id.' },
        locations: [{
          physicalLocation: {
            artifactLocation: { uri: 'src/api/users.ts' },
            region: { startLine: 42 },
          },
        }],
      },
      {
        ruleId: 'js/unused-variable',
        level: 'note',
        message: { text: 'Variable "tmp" is declared but never used.' },
        locations: [{
          physicalLocation: {
            artifactLocation: { uri: 'src/utils/helpers.ts' },
            region: { startLine: 10 },
          },
        }],
      },
    ],
  }],
});

// Semgrep-style SARIF
const SEMGREP_SARIF = JSON.stringify({
  version: '2.1.0',
  runs: [{
    tool: {
      driver: {
        name: 'Semgrep',
        rules: [{
          id: 'typescript.express.security.audit.xss.mustache-escape',
          shortDescription: { text: 'Potential XSS via unescaped template' },
          defaultConfiguration: { level: 'warning' },
          properties: { tags: ['security', 'vulnerability'] },
        }],
      },
    },
    results: [{
      ruleId: 'typescript.express.security.audit.xss.mustache-escape',
      level: 'warning',
      message: { text: 'Detected unescaped output in template rendering.' },
      locations: [{
        physicalLocation: {
          artifactLocation: { uri: 'src/views/profile.ts' },
        },
      }],
    }],
  }],
});

describe('parseSarif', () => {
  it('parses CodeQL SARIF with rules and results', () => {
    const result = parseSarif(CODEQL_SARIF);

    expect(result.source).toBe('CodeQL');
    expect(result.findings).toHaveLength(2);
    expect(result.skipped).toBe(0);
    expect(result.warnings).toHaveLength(0);

    const sqlInj = result.findings[0];
    expect(sqlInj.title).toBe('SQL injection vulnerability');
    expect(sqlInj.category).toBe('security');
    expect(sqlInj.severity).toBe('blocking');
    expect(sqlInj.files).toEqual(['src/api/users.ts']);
    expect(sqlInj.confidence).toBe(90);
    expect(sqlInj.source).toBe('CodeQL');
    expect(sqlInj.external_rule_id).toBe('js/sql-injection');
    expect(sqlInj.fix_available).toBe(true);

    const unused = result.findings[1];
    expect(unused.title).toBe('Unused variable');
    expect(unused.category).toBe('refactor'); // maintainability tag
    expect(unused.severity).toBe('polish');
    expect(unused.confidence).toBe(60);
  });

  it('respects minLevel filter', () => {
    const result = parseSarif(CODEQL_SARIF, { minLevel: 'warning' });

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].external_rule_id).toBe('js/sql-injection');
    expect(result.skipped).toBe(1);
  });

  it('allows source override', () => {
    const result = parseSarif(CODEQL_SARIF, { source: 'my-scanner' });

    expect(result.source).toBe('my-scanner');
    expect(result.findings[0].source).toBe('my-scanner');
  });

  it('parses Semgrep SARIF', () => {
    const result = parseSarif(SEMGREP_SARIF);

    expect(result.source).toBe('Semgrep');
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].category).toBe('security');
    expect(result.findings[0].severity).toBe('degrading');
    expect(result.findings[0].external_rule_id).toBe('typescript.express.security.audit.xss.mustache-escape');
  });

  it('generates deterministic IDs', () => {
    const r1 = parseSarif(CODEQL_SARIF);
    const r2 = parseSarif(CODEQL_SARIF);

    expect(r1.findings[0].id).toBe(r2.findings[0].id);
    expect(r1.findings[1].id).toBe(r2.findings[1].id);
    // Different findings get different IDs
    expect(r1.findings[0].id).not.toBe(r1.findings[1].id);
  });

  it('handles invalid JSON', () => {
    const result = parseSarif('not json');

    expect(result.findings).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('Invalid JSON');
  });

  it('handles empty runs', () => {
    const result = parseSarif(JSON.stringify({ version: '2.1.0', runs: [] }));

    expect(result.findings).toHaveLength(0);
    expect(result.warnings).toContain('No runs found in SARIF log');
  });

  it('handles results without locations', () => {
    const sarif = JSON.stringify({
      version: '2.1.0',
      runs: [{
        tool: { driver: { name: 'test' } },
        results: [{
          ruleId: 'test-rule',
          message: { text: 'A finding without location' },
        }],
      }],
    });

    const result = parseSarif(sarif);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].files).toEqual([]);
    expect(result.findings[0].fix_available).toBe(false);
  });

  it('deduplicates identical findings', () => {
    const sarif = JSON.stringify({
      version: '2.1.0',
      runs: [{
        tool: { driver: { name: 'test' } },
        results: [
          { ruleId: 'r1', message: { text: 'same' }, locations: [{ physicalLocation: { artifactLocation: { uri: 'a.ts' } } }] },
          { ruleId: 'r1', message: { text: 'same' }, locations: [{ physicalLocation: { artifactLocation: { uri: 'a.ts' } } }] },
        ],
      }],
    });

    const result = parseSarif(sarif);
    expect(result.findings).toHaveLength(1);
  });

  it('uses categoryMap override', () => {
    const result = parseSarif(CODEQL_SARIF, {
      categoryMap: { 'sql-injection': 'fix', 'unused': 'cleanup' },
    });

    expect(result.findings[0].category).toBe('fix');
    expect(result.findings[1].category).toBe('cleanup');
  });

  it('resolves rules by ruleIndex when ruleId is missing', () => {
    const sarif = JSON.stringify({
      version: '2.1.0',
      runs: [{
        tool: {
          driver: {
            name: 'test',
            rules: [
              { id: 'rule-zero', shortDescription: { text: 'First rule' }, defaultConfiguration: { level: 'error' } },
            ],
          },
        },
        results: [{
          ruleIndex: 0,
          message: { text: 'Found by index' },
          locations: [{ physicalLocation: { artifactLocation: { uri: 'x.ts' } } }],
        }],
      }],
    });

    const result = parseSarif(sarif);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].title).toBe('First rule');
    expect(result.findings[0].severity).toBe('blocking');
  });
});

describe('ingestToScanResult', () => {
  it('builds a valid ScanResult from ingested findings', () => {
    const ingest = parseSarif(CODEQL_SARIF);
    const scan = ingestToScanResult(ingest, 'my-project');

    expect(scan.schema_version).toBe('1.0');
    expect(scan.project).toBe('my-project');
    expect(scan.findings).toHaveLength(2);
    expect(scan.summary.total).toBe(2);
    expect(scan.summary.by_severity['blocking']).toBe(1);
    expect(scan.summary.by_severity['polish']).toBe(1);
    expect(scan.summary.by_category['security']).toBe(1);
    expect(scan.scanned_files).toBe(2); // two unique files
  });
});

describe('findingToProposal', () => {
  it('converts an ingested finding to a TicketProposal', () => {
    const ingest = parseSarif(CODEQL_SARIF);
    const finding = ingest.findings[0]; // SQL injection
    const proposal = findingToProposal(finding);

    expect(proposal.title).toBe(finding.title);
    expect(proposal.category).toBe('security');
    expect(proposal.severity).toBe('blocking');
    expect(proposal.description).toBe(finding.description);
    expect(proposal.files).toEqual(['src/api/users.ts']);
    expect(proposal.allowed_paths).toEqual(['src/api/users.ts']);
    expect(proposal.confidence).toBe(90);
    expect(proposal.impact_score).toBe(8);
    expect(proposal.estimated_complexity).toBe('moderate');
    expect(proposal.id).toMatch(/^ingest-/);
    expect(proposal.metadata?.source).toBe('CodeQL');
    expect(proposal.metadata?.external_rule_id).toBe('js/sql-injection');
    expect(proposal.metadata?.finding_id).toBe(finding.id);
  });

  it('preserves finding ID in metadata for fix journal linking', () => {
    const ingest = parseSarif(CODEQL_SARIF);
    for (const finding of ingest.findings) {
      const proposal = findingToProposal(finding);
      expect(proposal.metadata?.finding_id).toBe(finding.id);
    }
  });
});
