/**
 * SARIF 2.1.0 ingestion — convert external tool findings into canonical Findings.
 *
 * Supports any SARIF 2.1.0 source (CodeQL, Semgrep, custom security tools).
 * Each ingested finding gets a deterministic ID based on ruleId + file + message,
 * so repeated ingestion of the same SARIF file is idempotent.
 */

import { createHash } from 'node:crypto';
import type { Finding, ScanResult } from './finding.js';
import type { ProposalCategory } from './types.js';
import type { ProposalSeverity } from '../proposals/shared.js';

// ---------------------------------------------------------------------------
// SARIF 2.1.0 types (read-side, permissive)
// ---------------------------------------------------------------------------

interface SarifLog {
  $schema?: string;
  version: string;
  runs: SarifRun[];
}

interface SarifRun {
  tool: {
    driver: {
      name: string;
      version?: string;
      rules?: SarifRule[];
    };
    extensions?: Array<{
      name: string;
      rules?: SarifRule[];
    }>;
  };
  results: SarifResult[];
}

interface SarifRule {
  id: string;
  name?: string;
  shortDescription?: { text: string };
  fullDescription?: { text: string };
  defaultConfiguration?: { level?: string };
  properties?: Record<string, unknown>;
}

interface SarifResult {
  ruleId?: string;
  ruleIndex?: number;
  rule?: { id?: string; index?: number };
  level?: string;
  message: { text?: string; markdown?: string };
  locations?: SarifLocation[];
  properties?: Record<string, unknown>;
}

interface SarifLocation {
  physicalLocation?: {
    artifactLocation?: { uri?: string; uriBaseId?: string };
    region?: { startLine?: number; startColumn?: number; endLine?: number };
  };
}

// ---------------------------------------------------------------------------
// Ingestion options
// ---------------------------------------------------------------------------

export interface IngestOptions {
  /** Override source name (default: extracted from SARIF tool.driver.name). */
  source?: string;
  /** Map SARIF categories/tags to PromptWheel categories. */
  categoryMap?: Record<string, ProposalCategory>;
  /** Minimum SARIF level to import (default: 'note'). */
  minLevel?: 'error' | 'warning' | 'note' | 'none';
}

export interface IngestResult {
  /** Source tool name extracted or overridden. */
  source: string;
  /** Findings successfully ingested. */
  findings: Finding[];
  /** Results skipped (unparseable, below min level, etc.). */
  skipped: number;
  /** Human-readable warnings. */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Level / severity / category mapping
// ---------------------------------------------------------------------------

const SARIF_LEVEL_TO_SEVERITY: Record<string, ProposalSeverity> = {
  error: 'blocking',
  warning: 'degrading',
  note: 'polish',
  none: 'speculative',
};

const LEVEL_RANK: Record<string, number> = {
  error: 3,
  warning: 2,
  note: 1,
  none: 0,
};

/** Best-effort category inference from SARIF rule metadata. */
function inferCategory(
  rule: SarifRule | undefined,
  result: SarifResult,
  categoryMap?: Record<string, ProposalCategory>,
): ProposalCategory {
  // Check user-provided mapping first
  const ruleId = result.ruleId ?? result.rule?.id ?? rule?.id ?? '';
  if (categoryMap) {
    for (const [pattern, category] of Object.entries(categoryMap)) {
      if (ruleId.includes(pattern)) return category;
    }
  }

  // Check SARIF tags
  const tags = (rule?.properties?.['tags'] as string[] | undefined) ?? [];
  const tagSet = new Set(tags.map(t => t.toLowerCase()));

  if (tagSet.has('security') || tagSet.has('vulnerability') || tagSet.has('cwe'))
    return 'security';
  if (tagSet.has('correctness') || tagSet.has('bug'))
    return 'fix';
  if (tagSet.has('performance'))
    return 'perf';
  if (tagSet.has('maintainability'))
    return 'refactor';
  if (tagSet.has('test') || tagSet.has('coverage'))
    return 'test';
  if (tagSet.has('documentation'))
    return 'docs';

  // Infer from rule ID patterns (common across tools)
  const idLower = ruleId.toLowerCase();
  if (idLower.includes('security') || idLower.includes('injection') || idLower.includes('xss') || idLower.includes('csrf'))
    return 'security';
  if (idLower.includes('bug') || idLower.includes('error') || idLower.includes('null'))
    return 'fix';
  if (idLower.includes('perf') || idLower.includes('complexity'))
    return 'perf';

  // Default: treat as fix for errors, refactor for everything else
  const level = result.level ?? rule?.defaultConfiguration?.level ?? 'warning';
  return level === 'error' ? 'fix' : 'refactor';
}

/** Generate a stable ID for an ingested finding. Different from native findingId
 *  because we incorporate the external rule ID for cross-tool stability. */
function ingestFindingId(source: string, ruleId: string, files: string[], message: string): string {
  const key = [source, ruleId, ...files.sort(), message.slice(0, 200)].join('\0');
  return createHash('sha256').update(key).digest('hex').slice(0, 12);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Parse a SARIF 2.1.0 JSON string into canonical Findings. */
export function parseSarif(json: string, options: IngestOptions = {}): IngestResult {
  const minLevel = options.minLevel ?? 'note';
  const minRank = LEVEL_RANK[minLevel] ?? 1;
  const warnings: string[] = [];

  let log: SarifLog;
  try {
    log = JSON.parse(json) as SarifLog;
  } catch (e) {
    return { source: options.source ?? 'unknown', findings: [], skipped: 0, warnings: [`Invalid JSON: ${(e as Error).message}`] };
  }

  if (!log.version?.startsWith('2.1')) {
    warnings.push(`SARIF version ${log.version} may not be fully supported (expected 2.1.x)`);
  }

  if (!Array.isArray(log.runs) || log.runs.length === 0) {
    return { source: options.source ?? 'unknown', findings: [], skipped: 0, warnings: ['No runs found in SARIF log'] };
  }

  const findings: Finding[] = [];
  let skipped = 0;

  for (const run of log.runs) {
    const toolName = options.source ?? run.tool.driver.name ?? 'unknown';

    // Build rule index (driver + extensions)
    const ruleMap = new Map<string, SarifRule>();
    const rulesByIndex: SarifRule[] = [];
    for (const rule of run.tool.driver.rules ?? []) {
      ruleMap.set(rule.id, rule);
      rulesByIndex.push(rule);
    }
    for (const ext of run.tool.extensions ?? []) {
      for (const rule of ext.rules ?? []) {
        ruleMap.set(rule.id, rule);
      }
    }

    for (const result of run.results) {
      // Resolve rule
      const ruleId = result.ruleId ?? result.rule?.id ?? '';
      const ruleIndex = result.ruleIndex ?? result.rule?.index;
      const rule = ruleMap.get(ruleId)
        ?? (ruleIndex !== undefined ? rulesByIndex[ruleIndex] : undefined);

      // Resolve level
      const level = result.level ?? rule?.defaultConfiguration?.level ?? 'warning';
      const levelRank = LEVEL_RANK[level] ?? 1;
      if (levelRank < minRank) {
        skipped++;
        continue;
      }

      // Extract message
      const message = result.message?.text ?? result.message?.markdown ?? '';
      if (!message) {
        skipped++;
        continue;
      }

      // Extract files from locations
      const files: string[] = [];
      for (const loc of result.locations ?? []) {
        const uri = loc.physicalLocation?.artifactLocation?.uri;
        if (uri) {
          // Strip file:// prefix and normalize
          const filePath = uri.replace(/^file:\/\//, '').replace(/^\/+/, '');
          if (filePath && filePath !== '.') {
            files.push(filePath);
          }
        }
      }

      // Build title from rule name or first line of message
      const title = rule?.shortDescription?.text
        ?? rule?.name
        ?? message.split('\n')[0].slice(0, 120);

      // Build description
      const description = rule?.fullDescription?.text
        ? `${rule.fullDescription.text}\n\n${message}`
        : message;

      const severity = SARIF_LEVEL_TO_SEVERITY[level] ?? 'polish';
      const category = inferCategory(rule, result, options.categoryMap);

      findings.push({
        id: ingestFindingId(toolName, ruleId || title, files, message),
        title,
        category,
        severity,
        description,
        files,
        confidence: level === 'error' ? 90 : level === 'warning' ? 75 : 60,
        impact: level === 'error' ? 8 : level === 'warning' ? 5 : 3,
        complexity: 'moderate',
        fix_available: files.length > 0,
        source: toolName,
        external_rule_id: ruleId || undefined,
      });
    }
  }

  // Deduplicate by ID (same rule + same file = same finding)
  const seen = new Set<string>();
  const deduped: Finding[] = [];
  for (const f of findings) {
    if (!seen.has(f.id)) {
      seen.add(f.id);
      deduped.push(f);
    }
  }

  return {
    source: options.source ?? log.runs[0]?.tool.driver.name ?? 'unknown',
    findings: deduped,
    skipped,
    warnings,
  };
}

/** Build a ScanResult from ingested findings for storage in scan history. */
export function ingestToScanResult(
  ingestResult: IngestResult,
  project: string,
): ScanResult {
  const by_severity: Record<string, number> = {};
  const by_category: Record<string, number> = {};
  for (const f of ingestResult.findings) {
    by_severity[f.severity] = (by_severity[f.severity] ?? 0) + 1;
    by_category[f.category] = (by_category[f.category] ?? 0) + 1;
  }

  return {
    schema_version: '1.0',
    project,
    scanned_files: new Set(ingestResult.findings.flatMap(f => f.files)).size,
    duration_ms: 0,
    findings: ingestResult.findings,
    summary: {
      total: ingestResult.findings.length,
      by_severity,
      by_category,
    },
  };
}
