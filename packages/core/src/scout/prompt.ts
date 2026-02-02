/**
 * Scout prompt template
 *
 * This prompt is sent to Claude to analyze code and generate improvement proposals.
 */

import type { ProposalCategory } from './types.js';

/**
 * Build the scout prompt for analyzing a batch of files
 */
export function buildScoutPrompt(options: {
  files: Array<{ path: string; content: string }>;
  scope: string;
  types?: ProposalCategory[];
  excludeTypes?: ProposalCategory[];
  maxProposals: number;
  minConfidence: number;
  recentlyCompletedTitles?: string[];
  customPrompt?: string;
  /** Files the scout can read but must NOT propose changes to */
  protectedFiles?: string[];
}): string {
  const {
    files,
    scope,
    types,
    excludeTypes,
    maxProposals,
    minConfidence,
    recentlyCompletedTitles,
    customPrompt,
    protectedFiles,
  } = options;

  const protectedNote = protectedFiles?.length
    ? `\n\n**DO NOT propose changes to these files** (read-only context): ${protectedFiles.join(', ')}\n`
    : '';

  const categoryFilter = types?.length
    ? `Focus ONLY on these categories: ${types.join(', ')}`
    : excludeTypes?.length
      ? `EXCLUDE these categories: ${excludeTypes.join(', ')}`
      : 'Consider all categories';

  const strategicFocus = customPrompt
    ? `\n## Strategic Focus\n\n${customPrompt}\n`
    : '';

  const recentContext = recentlyCompletedTitles?.length
    ? `\n\nAVOID proposing work similar to these recently completed tickets:\n${recentlyCompletedTitles.map(t => `- ${t}`).join('\n')}`
    : '';

  const fileContents = files
    .map(f => `### ${f.path}\n\`\`\`\n${f.content}\n\`\`\``)
    .join('\n\n');

  return `You are a senior software engineer reviewing code for improvement opportunities.

Analyze these files from scope "${scope}" and identify actionable improvements.

${categoryFilter}

## Categories

- **refactor**: Code quality, readability, maintainability improvements including:
  - DRY violations (duplicate code that should be consolidated)
  - Dead code removal (unused functions, imports, variables)
  - Over-engineering (unnecessary abstractions, premature optimization)
  - Inconsistent patterns (code that doesn't match surrounding conventions)
  - Bloat cleanup (removing complexity that doesn't add value)
- **docs**: Missing/outdated documentation, comments, README updates
- **test**: Missing tests, edge cases, coverage gaps
- **perf**: Performance optimizations, algorithmic improvements
- **security**: Security vulnerabilities, input validation, auth issues

## Requirements

1. Each proposal MUST be:
   - Specific and actionable (not vague)
   - Self-contained (completable in one PR)
   - Have at least one verification command
   - Have confidence >= ${minConfidence}

2. Verification commands should be:
   - Runnable without manual setup
   - NOT include grep/wc/file-specific test commands
   - Prefer "npm run build" for non-test categories
   - Prefer "npm test" for test categories

3. Generate at most ${maxProposals} proposals, prioritized by impact.

4. Diversify across categories. Aim for a balanced mix — do not generate
   more than 2 test proposals per batch. Prioritize refactors and performance
   improvements. Tests should complement code changes, not dominate.
${protectedNote}${strategicFocus}${recentContext}

## Files to Analyze

${fileContents}

## Output Format

Respond with ONLY a JSON object (no markdown, no explanation):

{
  "proposals": [
    {
      "category": "refactor|docs|test|perf|security",
      "title": "Short actionable title (imperative mood)",
      "description": "What needs to be done and why",
      "acceptance_criteria": ["Criterion 1", "Criterion 2"],
      "verification_commands": ["npm run build"],
      "allowed_paths": ["path/to/file.ts"],
      "files": ["path/to/file.ts"],
      "confidence": 75,
      "impact_score": 5,
      "rationale": "Why this improvement matters",
      "estimated_complexity": "trivial|simple|moderate|complex"
    }
  ]
}

If no improvements are needed, return: {"proposals": []}`;
}

/**
 * Build a focused prompt for a single category
 */
export function buildCategoryPrompt(
  category: ProposalCategory,
  files: Array<{ path: string; content: string }>,
  maxProposals: number = 5
): string {
  return buildScoutPrompt({
    files,
    scope: '*',
    types: [category],
    maxProposals,
    minConfidence: 50,
  });
}
