/**
 * SARIF 2.1.0 output for scan results.
 *
 * Converts Finding[] to Static Analysis Results Interchange Format,
 * compatible with GitHub Code Scanning, VS Code SARIF Viewer, and
 * other SARIF consumers.
 *
 * Spec: https://docs.oasis-open.org/sarif/sarif/v2.1.0/sarif-v2.1.0.html
 */

import type { ScanResult, Finding } from './finding.js';
import type { ProposalSeverity } from '../proposals/shared.js';

// ---------------------------------------------------------------------------
// SARIF types (minimal subset)
// ---------------------------------------------------------------------------

interface SarifLog {
  $schema: string;
  version: '2.1.0';
  runs: SarifRun[];
}

interface SarifRun {
  tool: {
    driver: {
      name: string;
      version: string;
      informationUri: string;
      rules: SarifRule[];
    };
  };
  results: SarifResult[];
}

interface SarifRule {
  id: string;
  name: string;
  shortDescription: { text: string };
  defaultConfiguration: { level: SarifLevel };
  properties?: { tags?: string[] };
}

interface SarifResult {
  ruleId: string;
  level: SarifLevel;
  message: { text: string };
  locations: SarifLocation[];
  properties?: Record<string, unknown>;
}

interface SarifLocation {
  physicalLocation: {
    artifactLocation: { uri: string };
    region?: { startLine: number };
  };
}

type SarifLevel = 'error' | 'warning' | 'note' | 'none';

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

const SEVERITY_TO_SARIF_LEVEL: Record<ProposalSeverity, SarifLevel> = {
  blocking: 'error',
  degrading: 'warning',
  polish: 'note',
  speculative: 'none',
};

const CATEGORY_TAGS: Record<string, string[]> = {
  security: ['security', 'vulnerability'],
  fix: ['bug', 'correctness'],
  perf: ['performance'],
  refactor: ['maintainability'],
  test: ['test', 'coverage'],
  types: ['type-safety'],
  cleanup: ['maintainability', 'dead-code'],
  docs: ['documentation'],
};

function ruleId(category: string): string {
  return `PW-${category.toUpperCase()}`;
}

function buildRules(findings: Finding[]): SarifRule[] {
  const seen = new Set<string>();
  const rules: SarifRule[] = [];

  for (const f of findings) {
    const id = ruleId(f.category);
    if (seen.has(id)) continue;
    seen.add(id);

    rules.push({
      id,
      name: f.category,
      shortDescription: { text: `PromptWheel ${f.category} finding` },
      defaultConfiguration: { level: SEVERITY_TO_SARIF_LEVEL[f.severity] },
      properties: { tags: CATEGORY_TAGS[f.category] },
    });
  }

  return rules;
}

function findingToResult(f: Finding): SarifResult {
  const locations: SarifLocation[] = f.files.map(file => ({
    physicalLocation: {
      artifactLocation: { uri: file },
    },
  }));

  // Ensure at least one location (SARIF requires it for most consumers)
  if (locations.length === 0) {
    locations.push({
      physicalLocation: {
        artifactLocation: { uri: '.' },
      },
    });
  }

  return {
    ruleId: ruleId(f.category),
    level: SEVERITY_TO_SARIF_LEVEL[f.severity],
    message: { text: `${f.title}\n\n${f.description}` },
    locations,
    properties: {
      findingId: f.id,
      confidence: f.confidence,
      impact: f.impact,
      complexity: f.complexity,
      severity: f.severity,
      fixAvailable: f.fix_available,
      ...(f.risk_assessment && { riskAssessment: f.risk_assessment }),
    },
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Convert a ScanResult to a SARIF 2.1.0 log. */
export function toSarif(result: ScanResult, version: string = '0.0.0'): SarifLog {
  return {
    $schema: 'https://raw.githubusercontent.com/oasis-tcs/sarif-spec/main/sarif-2.1/schema/sarif-schema-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'PromptWheel',
            version,
            informationUri: 'https://github.com/promptwheel-ai/promptwheel',
            rules: buildRules(result.findings),
          },
        },
        results: result.findings.map(findingToResult),
      },
    ],
  };
}
