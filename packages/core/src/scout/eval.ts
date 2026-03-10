/**
 * Scan accuracy evaluation framework.
 *
 * Compares scan results against curated expected findings to measure:
 * - Precision: what % of reported findings are correct
 * - Recall: what % of expected findings were found
 * - Severity accuracy: how often severity matches expected
 *
 * Internal tool — not user-facing.
 */

import type { Finding, ScanResult } from './finding.js';
import type { ProposalSeverity } from '../proposals/shared.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A curated expected finding for eval comparison. */
export interface ExpectedFinding {
  /** Title pattern (case-insensitive substring match). */
  title_pattern: string;
  /** Expected severity. */
  severity: ProposalSeverity;
  /** Expected category. */
  category: string;
  /** At least one file must match (substring). */
  file_pattern?: string;
}

/** An eval case: expected findings for a specific project. */
export interface EvalCase {
  /** Project name (matches ScanResult.project). */
  project: string;
  /** Curated expected findings. */
  expected: ExpectedFinding[];
  /** Tolerance thresholds. */
  tolerance: {
    /** How many severity levels off is acceptable (0 = exact, 1 = ±1). */
    severity_drift: number;
    /** Minimum recall (0-1). */
    min_recall: number;
    /** Maximum false positive rate (0-1). */
    max_false_positive_rate: number;
  };
}

/** Match between an expected finding and an actual finding. */
export interface FindingMatch {
  expected: ExpectedFinding;
  actual: Finding | null;
  severity_match: boolean;
  category_match: boolean;
}

/** Eval result for a single project. */
export interface EvalResult {
  project: string;
  /** Findings in scan result that matched an expected finding. */
  true_positives: FindingMatch[];
  /** Expected findings not found in scan result. */
  false_negatives: ExpectedFinding[];
  /** Scan findings not matching any expected finding. */
  unmatched_findings: Finding[];
  /** Precision: true_positives / (true_positives + unmatched_findings). */
  precision: number;
  /** Recall: true_positives / (true_positives + false_negatives). */
  recall: number;
  /** % of matched findings where severity is correct. */
  severity_accuracy: number;
  /** Whether the eval passed all tolerance thresholds. */
  passed: boolean;
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

const SEVERITY_ORDER: ProposalSeverity[] = ['speculative', 'polish', 'degrading', 'blocking'];

function severityDistance(a: ProposalSeverity, b: ProposalSeverity): number {
  return Math.abs(SEVERITY_ORDER.indexOf(a) - SEVERITY_ORDER.indexOf(b));
}

function matchesFinding(expected: ExpectedFinding, actual: Finding): boolean {
  const titleMatch = actual.title.toLowerCase().includes(expected.title_pattern.toLowerCase());
  if (!titleMatch) return false;

  if (expected.file_pattern) {
    const fileMatch = actual.files.some(f =>
      f.toLowerCase().includes(expected.file_pattern!.toLowerCase())
    );
    if (!fileMatch) return false;
  }

  return true;
}

// ---------------------------------------------------------------------------
// Eval runner
// ---------------------------------------------------------------------------

/** Run eval for a single project. */
export function evalProject(
  scanResult: ScanResult,
  evalCase: EvalCase,
): EvalResult {
  const matched = new Set<number>(); // indices of matched actual findings
  const truePositives: FindingMatch[] = [];
  const falseNegatives: ExpectedFinding[] = [];

  for (const expected of evalCase.expected) {
    let bestMatch: Finding | null = null;
    let bestIdx = -1;

    for (let i = 0; i < scanResult.findings.length; i++) {
      if (matched.has(i)) continue;
      if (matchesFinding(expected, scanResult.findings[i])) {
        bestMatch = scanResult.findings[i];
        bestIdx = i;
        break; // first match wins
      }
    }

    if (bestMatch && bestIdx >= 0) {
      matched.add(bestIdx);
      truePositives.push({
        expected,
        actual: bestMatch,
        severity_match: bestMatch.severity === expected.severity ||
          severityDistance(bestMatch.severity, expected.severity) <= evalCase.tolerance.severity_drift,
        category_match: bestMatch.category === expected.category,
      });
    } else {
      falseNegatives.push(expected);
    }
  }

  const unmatchedFindings = scanResult.findings.filter((_, i) => !matched.has(i));

  const tp = truePositives.length;
  const fp = unmatchedFindings.length;
  const fn = falseNegatives.length;

  const precision = tp + fp > 0 ? tp / (tp + fp) : 1;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 1;
  const severityCorrect = truePositives.filter(m => m.severity_match).length;
  const severityAccuracy = tp > 0 ? severityCorrect / tp : 1;

  const falsePositiveRate = tp + fp > 0 ? fp / (tp + fp) : 0;

  const passed =
    recall >= evalCase.tolerance.min_recall &&
    falsePositiveRate <= evalCase.tolerance.max_false_positive_rate;

  return {
    project: evalCase.project,
    true_positives: truePositives,
    false_negatives: falseNegatives,
    unmatched_findings: unmatchedFindings,
    precision,
    recall,
    severity_accuracy: severityAccuracy,
    passed,
  };
}

/** Format eval result as a human-readable string. */
export function formatEvalResult(result: EvalResult): string {
  const lines = [
    `## ${result.project}`,
    `Precision: ${(result.precision * 100).toFixed(0)}%  Recall: ${(result.recall * 100).toFixed(0)}%  Severity: ${(result.severity_accuracy * 100).toFixed(0)}%`,
    `Result: ${result.passed ? 'PASS' : 'FAIL'}`,
    '',
  ];

  if (result.true_positives.length > 0) {
    lines.push('Matched:');
    for (const m of result.true_positives) {
      const sevIcon = m.severity_match ? '+' : '~';
      lines.push(`  [${sevIcon}] ${m.expected.title_pattern} → ${m.actual?.title ?? '?'} (${m.actual?.severity})`);
    }
    lines.push('');
  }

  if (result.false_negatives.length > 0) {
    lines.push('Missed:');
    for (const fn of result.false_negatives) {
      lines.push(`  [-] ${fn.title_pattern} (expected ${fn.severity})`);
    }
    lines.push('');
  }

  if (result.unmatched_findings.length > 0) {
    lines.push(`Unmatched (${result.unmatched_findings.length} extra findings)`);
  }

  return lines.join('\n');
}
