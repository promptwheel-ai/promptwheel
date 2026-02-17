/**
 * Project Taste Profile — learns what the codebase responds to.
 *
 * Persisted in `.promptwheel/taste-profile.json`, rebuilt every 10 cycles.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SectorState } from './sectors.js';
import type { Learning } from './learnings.js';
import type { FormulaStats } from './run-state.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TasteProfile {
  preferredCategories: string[];
  avoidCategories: string[];
  preferredComplexity: 'trivial' | 'simple' | 'moderate';
  styleNotes: string[];
  updatedAt: number;
}

const TASTE_FILE = 'taste-profile.json';

function tastePath(projectRoot: string): string {
  return path.join(projectRoot, '.promptwheel', TASTE_FILE);
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

/**
 * Build a taste profile from sector data, learnings, and formula stats.
 */
export function buildTasteProfile(
  sectorState: SectorState,
  learnings: Learning[],
  _formulaStats: Record<string, FormulaStats>,
): TasteProfile {
  // Aggregate category success/failure across all sectors
  const catTotals: Record<string, { success: number; failure: number }> = {};
  for (const s of sectorState.sectors) {
    if (!s.categoryStats) continue;
    for (const [cat, stats] of Object.entries(s.categoryStats)) {
      const t = catTotals[cat] ??= { success: 0, failure: 0 };
      t.success += stats.success;
      t.failure += stats.failure;
    }
  }

  const preferred: string[] = [];
  const avoid: string[] = [];
  for (const [cat, totals] of Object.entries(catTotals)) {
    const total = totals.success + totals.failure;
    if (total < 3) continue;
    const rate = totals.success / total;
    // Boost categories with strong success volume (not just rate)
    const volumeBoost = total >= 8 && rate > 0.5 ? 0.1 : 0;
    if (rate + volumeBoost > 0.6) preferred.push(cat);
    else if (rate < 0.3) avoid.push(cat);
  }

  // Determine preferred complexity from successful tickets
  const complexityCounts: Record<string, number> = { trivial: 0, simple: 0, moderate: 0 };
  // Use learnings from ticket_success to infer complexity preference
  const successLearnings = learnings.filter(l => l.source.type === 'ticket_success');
  for (const l of successLearnings) {
    // Simple heuristic: short titles tend to be trivial/simple
    if (l.text.length < 40) complexityCounts['trivial']++;
    else if (l.text.length < 80) complexityCounts['simple']++;
    else complexityCounts['moderate']++;
  }
  const preferredComplexity = (
    complexityCounts['simple'] >= complexityCounts['trivial'] &&
    complexityCounts['simple'] >= complexityCounts['moderate']
  ) ? 'simple'
    : (complexityCounts['trivial'] >= complexityCounts['moderate'])
    ? 'trivial'
    : 'moderate';

  // Extract style notes from reviewer feedback learnings
  const styleNotes: string[] = learnings
    .filter(l => l.source.type === 'reviewer_feedback' && l.weight > 20)
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 5)
    .map(l => l.text);

  return {
    preferredCategories: preferred,
    avoidCategories: avoid,
    preferredComplexity,
    styleNotes,
    updatedAt: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export function loadTasteProfile(projectRoot: string): TasteProfile | null {
  const fp = tastePath(projectRoot);
  if (!fs.existsSync(fp)) return null;
  try {
    return JSON.parse(fs.readFileSync(fp, 'utf8'));
  } catch {
    return null;
  }
}

export function saveTasteProfile(projectRoot: string, profile: TasteProfile): void {
  const fp = tastePath(projectRoot);
  const dir = path.dirname(fp);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(fp, JSON.stringify(profile, null, 2) + '\n', 'utf8');
}

// ---------------------------------------------------------------------------
// Prompt formatting
// ---------------------------------------------------------------------------

/**
 * Format the taste profile as an XML block for scout prompt injection.
 */
export function formatTasteForPrompt(profile: TasteProfile): string {
  const lines: string[] = ['<project-taste>'];
  if (profile.preferredCategories.length > 0) {
    lines.push(`This project responds well to: ${profile.preferredCategories.join(', ')}.`);
  }
  if (profile.avoidCategories.length > 0) {
    lines.push(`Avoid: ${profile.avoidCategories.join(', ')}.`);
  }
  lines.push(`Preferred complexity: ${profile.preferredComplexity}.`);
  if (profile.styleNotes.length > 0) {
    lines.push('Style notes from reviewers:');
    for (const note of profile.styleNotes) {
      lines.push(`- ${note}`);
    }
  }
  lines.push('</project-taste>');
  return lines.join('\n');
}
