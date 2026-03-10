/**
 * Canonical Finding and ScanResult types.
 *
 * These are the public-facing output objects for `promptwheel scan`.
 * Everything downstream (CLI table, JSON, SARIF, CI, dashboard) consumes
 * these types. Internal types (TicketProposal, ValidatedProposal) are
 * converted to Findings before being shown to users.
 */

import { createHash } from 'node:crypto';
import type { RiskAssessment, ProposalSeverity, ValidatedProposal } from '../proposals/shared.js';
import type { TicketProposal, ProposalCategory, ComplexityLevel } from './types.js';

// ---------------------------------------------------------------------------
// Core types
// ---------------------------------------------------------------------------

/** A single finding — the canonical unit of scan output. */
export interface Finding {
  /** Deterministic ID: sha256(title + sorted files), truncated to 12 hex chars. */
  id: string;
  /** Short actionable title in imperative mood. */
  title: string;
  /** Category of improvement. */
  category: ProposalCategory;
  /** Severity tier derived from risk_assessment or inferred. */
  severity: ProposalSeverity;
  /** What needs to be done and why. */
  description: string;
  /** Files involved. */
  files: string[];
  /** Confidence score (0-100). */
  confidence: number;
  /** Impact score (1-10). */
  impact: number;
  /** Estimated complexity. */
  complexity: ComplexityLevel;
  /** Structured risk factors when available. */
  risk_assessment?: RiskAssessment;
  /** Whether auto-fix is available for this finding. */
  fix_available: boolean;
  /** Source tool that produced this finding (default: 'promptwheel'). */
  source?: string;
  /** Original external rule ID (e.g., 'java/sql-injection' from CodeQL). */
  external_rule_id?: string;
}

/** Summary counts for a scan result. */
export interface ScanSummary {
  total: number;
  by_severity: Record<string, number>;
  by_category: Record<string, number>;
}

/** Complete scan result — the top-level output of `promptwheel scan`. */
export interface ScanResult {
  /** Schema version for forward compatibility. */
  schema_version: '1.0';
  /** Project name (basename of repo root). */
  project: string;
  /** Number of files scanned. */
  scanned_files: number;
  /** Scan duration in milliseconds. */
  duration_ms: number;
  /** Ordered findings (highest severity/impact first). */
  findings: Finding[];
  /** Aggregate counts. */
  summary: ScanSummary;
}

// ---------------------------------------------------------------------------
// Converters
// ---------------------------------------------------------------------------

/** Generate a deterministic finding ID from title + files. */
export function findingId(title: string, files: string[]): string {
  const key = title.toLowerCase() + '\0' + [...files].sort().join('\0');
  return createHash('sha256').update(key).digest('hex').slice(0, 12);
}

/** Convert a ValidatedProposal to a Finding. */
export function validatedProposalToFinding(p: ValidatedProposal): Finding {
  return {
    id: findingId(p.title, p.files),
    title: p.title,
    category: p.category as ProposalCategory,
    severity: p.severity,
    description: p.description,
    files: p.files,
    confidence: p.confidence,
    impact: p.impact_score,
    complexity: p.estimated_complexity as ComplexityLevel,
    risk_assessment: p.risk_assessment,
    fix_available: p.files.length > 0 && p.confidence >= 70,
  };
}

/** Convert a TicketProposal to a Finding. */
export function proposalToFinding(p: TicketProposal): Finding {
  return {
    id: findingId(p.title, p.files),
    title: p.title,
    category: p.category,
    severity: p.severity ?? 'polish',
    description: p.description,
    files: p.files,
    confidence: p.confidence,
    impact: p.impact_score ?? 5,
    complexity: p.estimated_complexity,
    risk_assessment: p.risk_assessment,
    fix_available: p.files.length > 0 && p.confidence >= 70,
  };
}

/** Convert a Finding back to a TicketProposal (for ticket creation from ingested findings). */
export function findingToProposal(f: Finding): TicketProposal {
  return {
    id: `ingest-${Date.now()}-${f.id}`,
    category: f.category,
    title: f.title,
    description: f.description,
    acceptance_criteria: [`Fix: ${f.title}`],
    verification_commands: [],
    allowed_paths: [...f.files],
    files: f.files,
    confidence: f.confidence,
    impact_score: f.impact,
    rationale: f.description.split('\n')[0].slice(0, 200),
    estimated_complexity: f.complexity,
    severity: f.severity,
    risk_assessment: f.risk_assessment,
    metadata: {
      ...(f.source && { source: f.source }),
      ...(f.external_rule_id && { external_rule_id: f.external_rule_id }),
      finding_id: f.id,
    },
  };
}

/** Build a complete ScanResult from proposals and metadata. */
export function buildScanResult(
  proposals: TicketProposal[],
  metadata: { project: string; scannedFiles: number; durationMs: number },
): ScanResult {
  const findings = proposals.map(proposalToFinding);

  const by_severity: Record<string, number> = {};
  const by_category: Record<string, number> = {};
  for (const f of findings) {
    by_severity[f.severity] = (by_severity[f.severity] ?? 0) + 1;
    by_category[f.category] = (by_category[f.category] ?? 0) + 1;
  }

  return {
    schema_version: '1.0',
    project: metadata.project,
    scanned_files: metadata.scannedFiles,
    duration_ms: metadata.durationMs,
    findings,
    summary: {
      total: findings.length,
      by_severity,
      by_category,
    },
  };
}
