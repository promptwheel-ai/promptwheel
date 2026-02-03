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
  /** Coverage context injected to give the scout awareness of scan progress */
  coverageContext?: {
    sectorPath: string;
    scannedSectors: number;
    totalSectors: number;
    percent: number;
    sectorPercent: number;
    classificationConfidence: string;
    scanCount: number;
    proposalYield: number;
    sectorSummary?: string;
    sectorDifficulty?: 'easy' | 'moderate' | 'hard';
    sectorCategoryAffinity?: { boost: string[]; suppress: string[] };
  };
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
    coverageContext,
  } = options;

  const protectedNote = protectedFiles?.length
    ? `\n\n**DO NOT propose changes to these files** (read-only context): ${protectedFiles.join(', ')}\n`
    : '';

  const categoryFilter = types?.length
    ? `Focus ONLY on these categories: ${types.join(', ')}`
    : excludeTypes?.length
      ? `EXCLUDE these categories: ${excludeTypes.join(', ')}`
      : 'Consider all categories';

  const coverageBlock = coverageContext
    ? (() => {
        const { sectorPath, scannedSectors, totalSectors, percent, sectorPercent, classificationConfidence, scanCount, proposalYield, sectorSummary } = coverageContext;
        const lines = [
          `\n## Coverage Context\n`,
          `You are scanning sector "${sectorPath}" (scan #${scanCount + 1}).`,
          `Classification confidence: ${classificationConfidence}.${classificationConfidence === 'low' ? ' This sector has not been reliably classified — pay attention to whether files are production code, tests, config, or generated.' : ''}`,
          `Overall codebase coverage: ${scannedSectors}/${totalSectors} sectors scanned (${sectorPercent}% of sectors, ${percent}% of files).`,
          `This sector's historical proposal density: ${proposalYield.toFixed(1)} proposals/scan.`,
          '',
        ];
        if (coverageContext.sectorDifficulty === 'hard') {
          lines.push('');
          lines.push('**WARNING:** This sector has a HIGH failure rate. Propose only HIGH-confidence changes. Prefer simple fixes over complex refactors.');
        }
        if (coverageContext.sectorCategoryAffinity) {
          const { boost, suppress } = coverageContext.sectorCategoryAffinity;
          if (boost.length > 0) {
            lines.push(`Categories that work well in this sector: ${boost.join(', ')}.`);
          }
          if (suppress.length > 0) {
            lines.push(`Categories ${suppress.join(', ')} have low success in this sector — only propose if HIGH confidence.`);
          }
        }
        if (percent < 50) {
          lines.push('Many sectors remain unscanned. Focus on high-impact issues rather than minor cleanups.');
        }
        if (sectorSummary) {
          lines.push('');
          lines.push(sectorSummary);
        }
        return lines.join('\n') + '\n';
      })()
    : '';

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
${coverageBlock}
## Categories

- **refactor**: Code quality, readability, maintainability improvements (DRY violations, dead code, over-engineering, inconsistent patterns)
- **fix**: Bug fixes, incorrect logic, broken edge cases
- **cleanup**: Dead code removal, unused imports, bloat reduction
- **types**: Type safety improvements, missing types, type narrowing
- **perf**: Performance optimizations, algorithmic improvements
- **security**: Security vulnerabilities, input validation, auth issues
- **docs**: Missing/outdated documentation, comments, README updates
- **test**: Missing tests, edge cases, coverage gaps

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

${protectedNote}${strategicFocus}${recentContext}

## Files to Analyze

${fileContents}

## Output Format

Respond with ONLY a JSON object (no markdown, no explanation):

{
  "proposals": [
    {
      "category": "refactor|fix|cleanup|types|perf|security|docs|test",
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

If no improvements are needed, return: {"proposals": []}${coverageContext ? `

If this sector appears misclassified (e.g., labeled as production but contains only tests/config/generated code, or vice versa), add to the JSON:
"sector_reclassification": { "production": true/false, "confidence": "medium"|"high" }` : ''}`;
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
