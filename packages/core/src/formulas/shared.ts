/**
 * Pure formula algorithms — no filesystem.
 *
 * Shared by both @promptwheel/cli and @promptwheel/mcp.
 * Callers handle file I/O (reading YAML files from .promptwheel/formulas/).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Formula {
  name: string;
  version?: number;
  description: string;
  scope?: string;
  categories?: string[];
  minConfidence?: number;
  min_confidence?: number;
  prompt?: string;
  maxPrs?: number;
  max_prs?: number;
  maxTime?: string;
  model?: string;
  risk_tolerance?: 'low' | 'medium' | 'high';
  focusAreas?: string[];
  exclude?: string[];
  useRoadmap?: boolean;
  tags?: string[];
  measure?: {
    cmd: string;              // shell command that outputs a number
    target: number;           // target value
    direction: 'up' | 'down'; // 'up' = higher is better, 'down' = lower is better
  };
}

// ---------------------------------------------------------------------------
// Built-in Formulas
// ---------------------------------------------------------------------------

export const BUILTIN_FORMULAS: Formula[] = [
  {
    name: 'security-audit',
    version: 1,
    description: 'Find and fix security vulnerabilities',
    categories: ['security'],
    minConfidence: 80,
    min_confidence: 80,
    risk_tolerance: 'low',
    prompt: [
      'Look for OWASP Top 10 vulnerabilities, insecure defaults,',
      'missing input validation, credential exposure, and injection risks.',
      'Focus on real vulnerabilities, not style issues.',
    ].join(' '),
    maxPrs: 10,
    max_prs: 10,
    tags: ['security'],
  },
  {
    name: 'test-coverage',
    version: 1,
    description: 'Add missing unit tests for untested code',
    categories: ['test'],
    minConfidence: 70,
    min_confidence: 70,
    risk_tolerance: 'medium',
    prompt: [
      'Find functions and modules with no test coverage.',
      'Write focused unit tests with edge cases.',
      'Prioritize business logic over utility functions.',
    ].join(' '),
    maxPrs: 15,
    max_prs: 15,
    tags: ['quality'],
  },
  {
    name: 'type-safety',
    version: 1,
    description: 'Strengthen TypeScript types and remove any/unknown',
    categories: ['types'],
    minConfidence: 75,
    min_confidence: 75,
    risk_tolerance: 'medium',
    prompt: [
      'Find uses of any, unknown, or weak typing.',
      'Add proper type annotations, interfaces, and type guards.',
      'Do not change runtime behavior.',
    ].join(' '),
    maxPrs: 10,
    max_prs: 10,
    tags: ['quality'],
  },
  {
    name: 'cleanup',
    version: 1,
    description: 'Remove dead code, unused imports, and stale comments',
    categories: ['refactor'],
    minConfidence: 85,
    min_confidence: 85,
    risk_tolerance: 'low',
    prompt: [
      'Find dead code, unused imports, unreachable branches,',
      'commented-out code, and stale TODO comments.',
      'Only remove things that are clearly unused.',
    ].join(' '),
    maxPrs: 10,
    max_prs: 10,
    tags: ['cleanup'],
  },
  {
    name: 'deep',
    version: 1,
    description: 'Find high-impact structural and architectural improvements',
    categories: ['refactor', 'perf', 'security'],
    minConfidence: 60,
    min_confidence: 60,
    risk_tolerance: 'high',
    model: 'opus',
    maxPrs: 5,
    max_prs: 5,
    prompt: [
      'Principal engineer architecture review. Ignore trivial issues.',
      'Focus on: leaky abstractions, silent error swallowing, coupling/circular deps,',
      'mixed concerns (business logic + I/O), algorithmic perf issues,',
      'missing security boundaries, brittle integration points.',
      'Prefer moderate/complex complexity. Set impact_score 1-10.',
    ].join(' '),
    tags: ['architecture', 'deep'],
  },
  {
    name: 'docs',
    version: 1,
    description: 'Add or improve documentation for public APIs',
    categories: ['docs'],
    minConfidence: 70,
    min_confidence: 70,
    risk_tolerance: 'medium',
    prompt: [
      'Find exported functions, classes, and types missing JSDoc.',
      'Add clear, concise documentation that explains the purpose,',
      'parameters, and return values. Do not over-document obvious code.',
    ].join(' '),
    maxPrs: 10,
    max_prs: 10,
    tags: ['docs'],
  },
  {
    name: 'docs-audit',
    version: 1,
    description: 'Find stale, inaccurate, or missing documentation across code and markdown',
    scope: '.',
    categories: ['docs'],
    minConfidence: 70,
    min_confidence: 70,
    risk_tolerance: 'low',
    exclude: ['CLAUDE.md', '.claude/**'],
    prompt: [
      'Cross-reference documentation files (README.md, CLAUDE.md, docs/*.md, CONTRIBUTING.md)',
      'against the actual codebase to find inaccuracies.',
      'Look for: CLI flags/options documented that no longer exist or have changed,',
      'features described that have been renamed or removed,',
      'setup instructions that reference old paths or commands,',
      'outdated architecture descriptions that no longer match the code,',
      'missing documentation for recently added features or flags.',
      'Read both the markdown files AND the source code they reference to verify accuracy.',
      'Each proposal should fix one specific doc file with concrete corrections.',
      'Do NOT add new documentation — only fix what is wrong or outdated.',
    ].join(' '),
    maxPrs: 10,
    max_prs: 10,
    tags: ['docs', 'audit'],
  },
];

// ---------------------------------------------------------------------------
// YAML parsing (pure — no filesystem)
// ---------------------------------------------------------------------------

/**
 * Simple YAML-like parser for flat key: value files.
 * Handles single-line values and multi-line | blocks.
 * Does NOT handle nested objects, anchors, or complex YAML features.
 */
export function parseSimpleYaml(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  const lines = content.split('\n');
  let currentKey: string | null = null;
  let multilineValue: string[] = [];
  let multilineIndent = 0;

  for (const line of lines) {
    // Skip comments and empty lines (unless in multiline)
    if (!currentKey && (line.trim().startsWith('#') || line.trim() === '')) continue;

    // Check for multiline continuation
    if (currentKey) {
      const indent = line.length - line.trimStart().length;
      if (indent > multilineIndent && line.trim() !== '') {
        multilineValue.push(line.trim());
        continue;
      } else {
        // End of multiline block
        result[currentKey] = multilineValue.join(' ');
        currentKey = null;
        multilineValue = [];
      }
    }

    // Parse key: value
    const match = line.match(/^(\w[\w_-]*)\s*:\s*(.*)/);
    if (match) {
      const [, key, value] = match;
      const trimmedValue = value.trim();

      if (trimmedValue === '|' || trimmedValue === '>') {
        // Start multiline block
        currentKey = key;
        multilineIndent = line.length - line.trimStart().length;
        multilineValue = [];
      } else {
        result[key] = trimmedValue;
      }
    }
  }

  // Flush remaining multiline
  if (currentKey) {
    result[currentKey] = multilineValue.join(' ');
  }

  return result;
}

/**
 * Parse a YAML-style list string: "[a, b, c]" or "a, b, c" -> ["a", "b", "c"]
 */
export function parseStringList(value: string): string[] {
  const stripped = value.replace(/^\[/, '').replace(/\]$/, '');
  return stripped.split(',').map(s => s.trim()).filter(s => s.length > 0);
}
