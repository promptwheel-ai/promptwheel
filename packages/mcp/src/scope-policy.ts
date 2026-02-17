/**
 * Scope Policy — derives and enforces file-level constraints for tickets.
 *
 * Used by the plan validator and PreToolUse hook to ensure
 * agents only touch files they're allowed to.
 *
 * Shared constants (ALWAYS_DENIED, CREDENTIAL_PATTERNS, FILE_DENY_PATTERNS)
 * and pure algorithms live in @promptwheel/core/scope/shared.
 * This file adds MCP-specific policy derivation and minimatch-based validation.
 */

import * as nodePath from 'node:path';
import { minimatch } from 'minimatch';
import {
  ALWAYS_DENIED,
  FILE_DENY_PATTERNS,
} from '@promptwheel/core/scope/shared';
import {
  assessAdaptiveRisk,
  type Learning,
  type AdaptiveRiskAssessment,
} from '@promptwheel/core/learnings/shared';

// Re-export for existing consumers
export { detectCredentialInContent as containsCredentials } from '@promptwheel/core/scope/shared';

/**
 * Normalize an allowed_path for minimatch:
 * - Directory-style paths ending with `/` become `dir/**` (match anything inside)
 * - Paths without globs or extensions that look like directories get `/**` appended
 * - Everything else is left as-is
 */
function normalizeAllowedGlob(glob: string): string {
  if (glob.endsWith('/')) return glob + '**';
  return glob;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ScopePolicy {
  allowed_paths: string[];
  denied_paths: string[];
  denied_patterns: RegExp[];
  max_files: number;
  max_lines: number;
  plan_required: boolean;
  /** When set, file writes are only allowed inside this worktree directory */
  worktree_root?: string;
  /** Adaptive risk assessment when learnings are provided */
  risk_assessment?: AdaptiveRiskAssessment;
}

// ---------------------------------------------------------------------------
// Derive scope policy from ticket + config
// ---------------------------------------------------------------------------

export interface DeriveScopeInput {
  allowedPaths: string[];
  category: string;
  maxLinesPerTicket: number;
  /** When set, restricts file writes to this worktree directory */
  worktreeRoot?: string;
  /** Cross-run learnings for adaptive trust (optional, backward compatible) */
  learnings?: Learning[];
}

export function deriveScopePolicy(input: DeriveScopeInput): ScopePolicy {
  let maxFiles = 10;
  let maxLines = input.category === 'test' ? 1000 : input.maxLinesPerTicket;
  let planRequired = input.category !== 'docs';
  let riskAssessment: AdaptiveRiskAssessment | undefined;

  // Adaptive trust: adjust constraints based on failure history in learnings
  if (input.learnings && input.learnings.length > 0) {
    riskAssessment = assessAdaptiveRisk(input.learnings, input.allowedPaths);

    switch (riskAssessment.level) {
      case 'low':
        maxFiles = 15;
        maxLines = Math.round(maxLines * 1.5);
        break;
      case 'normal':
        // No change — defaults
        break;
      case 'elevated':
        maxFiles = 7;
        planRequired = true;
        break;
      case 'high':
        maxFiles = 5;
        maxLines = Math.round(maxLines * 0.5);
        planRequired = true;
        break;
    }
  }

  return {
    allowed_paths: input.allowedPaths,
    denied_paths: ALWAYS_DENIED,
    denied_patterns: FILE_DENY_PATTERNS,
    max_files: maxFiles,
    max_lines: maxLines,
    plan_required: planRequired,
    worktree_root: input.worktreeRoot,
    risk_assessment: riskAssessment,
  };
}

// ---------------------------------------------------------------------------
// Validate a plan against scope policy
// ---------------------------------------------------------------------------

export interface PlanFile {
  path: string;
  action: string;
  reason: string;
}

export interface PlanValidationResult {
  valid: boolean;
  reason: string | null;
  /** All violations found (empty when valid). Joined into `reason` for backward compat. */
  violations: string[];
}

export function validatePlanScope(
  files: PlanFile[],
  estimatedLines: number,
  riskLevel: string,
  policy: ScopePolicy,
): PlanValidationResult {
  const violations: string[] = [];

  // 1. Must have files
  if (!files || files.length === 0) {
    return { valid: false, reason: 'Plan must include at least one file to touch', violations: ['Plan must include at least one file to touch'] };
  }

  // 2. Check estimated lines
  if (estimatedLines > policy.max_lines) {
    violations.push(`Estimated lines (${estimatedLines}) exceeds max (${policy.max_lines})`);
  }

  // 3. Check max files
  if (files.length > policy.max_files) {
    violations.push(`Plan touches ${files.length} files, max allowed is ${policy.max_files}`);
  }

  // 4. Valid risk level
  if (!riskLevel || !['low', 'medium', 'high'].includes(riskLevel)) {
    violations.push('Plan must specify risk_level: low, medium, or high');
  }

  // 5. Check each file against denied paths
  for (const f of files) {
    for (const deniedGlob of policy.denied_paths) {
      if (minimatch(f.path, deniedGlob, { dot: true })) {
        violations.push(`Plan touches denied path: ${f.path} (matches ${deniedGlob})`);
      }
    }
  }

  // 6. Check each file against denied patterns
  for (const f of files) {
    for (const pattern of policy.denied_patterns) {
      if (pattern.test(f.path)) {
        violations.push(`Plan touches sensitive file: ${f.path}`);
      }
    }
  }

  // 7. Check each file is within allowed_paths (if any specified)
  if (policy.allowed_paths.length > 0) {
    for (const f of files) {
      const isAllowed = policy.allowed_paths.some(glob =>
        minimatch(f.path, normalizeAllowedGlob(glob), { dot: true }),
      );
      if (!isAllowed) {
        violations.push(`File ${f.path} is outside allowed paths: ${policy.allowed_paths.join(', ')}`);
      }
    }
  }

  if (violations.length > 0) {
    return { valid: false, reason: violations.join('; '), violations };
  }
  return { valid: true, reason: null, violations: [] };
}

// ---------------------------------------------------------------------------
// Worktree isolation check
// ---------------------------------------------------------------------------

/**
 * Check if a file path is inside a worktree directory.
 * Normalizes both paths before comparison.
 */
export function isFileInWorktree(filePath: string, worktreeRoot: string): boolean {
  const normalizedFile = nodePath.normalize(filePath).replace(/\\/g, '/');
  const normalizedRoot = nodePath.normalize(worktreeRoot).replace(/\\/g, '/').replace(/\/$/, '');
  return normalizedFile === normalizedRoot || normalizedFile.startsWith(normalizedRoot + '/');
}

// ---------------------------------------------------------------------------
// Check a single file path (used by PreToolUse hook)
// ---------------------------------------------------------------------------

export function isFileAllowed(filePath: string, policy: ScopePolicy): boolean {
  // Worktree enforcement: if set, reject files outside the worktree
  if (policy.worktree_root) {
    if (!isFileInWorktree(filePath, policy.worktree_root)) {
      return false;
    }
  }

  // Check denied paths
  for (const deniedGlob of policy.denied_paths) {
    if (minimatch(filePath, deniedGlob, { dot: true })) {
      return false;
    }
  }

  // Check denied patterns
  for (const pattern of policy.denied_patterns) {
    if (pattern.test(filePath)) {
      return false;
    }
  }

  // Check allowed paths (empty = everything allowed)
  if (policy.allowed_paths.length > 0) {
    return policy.allowed_paths.some(glob =>
      minimatch(filePath, normalizeAllowedGlob(glob), { dot: true }),
    );
  }

  return true;
}

// containsCredentials is re-exported from core above

// ---------------------------------------------------------------------------
// Category Tool Policies — per-category auto-approve restrictions
// ---------------------------------------------------------------------------

export interface CategoryToolPolicy {
  auto_approve_patterns: string[];
  constraint_note?: string;
}

/**
 * Per-category tool restrictions. Categories not listed here use defaults.
 * - docs: can only edit markdown/text files
 * - test: can only edit test files
 * - security: full edit access but no npm install / arbitrary bash
 *
 * @deprecated Use ToolRegistry from @promptwheel/mcp/tool-registry instead.
 * Kept for backward compatibility during migration.
 */
export const CATEGORY_TOOL_POLICIES: Record<string, CategoryToolPolicy> = {
  docs: {
    auto_approve_patterns: [
      'Read(*)', 'Glob(*)', 'Grep(*)',
      'Edit(*.md)', 'Edit(*.mdx)', 'Edit(*.txt)', 'Edit(*.rst)',
      'Write(*.md)', 'Write(*.mdx)', 'Write(*.txt)', 'Write(*.rst)',
      'Bash(git diff*)', 'Bash(git status*)',
    ],
    constraint_note: 'This is a **docs** ticket. You may ONLY edit markdown and text files (*.md, *.mdx, *.txt, *.rst). Do NOT modify source code, config files, or any other file types.',
  },
  test: {
    auto_approve_patterns: [
      'Read(*)', 'Glob(*)', 'Grep(*)',
      'Edit(*.test.*)', 'Edit(*.spec.*)', 'Edit(*__tests__*)',
      'Edit(test_*)', 'Edit(*_test.go)', 'Edit(*_test.py)', 'Edit(*Test.java)',
      'Write(*.test.*)', 'Write(*.spec.*)', 'Write(*__tests__*)',
      'Write(test_*)', 'Write(*_test.go)', 'Write(*_test.py)', 'Write(*Test.java)',
      'Bash(npm test*)', 'Bash(npx vitest*)', 'Bash(npx jest*)', 'Bash(npx tsc*)',
      'Bash(pytest*)', 'Bash(cargo test*)', 'Bash(go test*)', 'Bash(mvn test*)',
      'Bash(./gradlew test*)', 'Bash(bundle exec rspec*)', 'Bash(mix test*)',
      'Bash(dotnet test*)', 'Bash(swift test*)', 'Bash(make test*)',
      'Bash(dart test*)', 'Bash(flutter test*)', 'Bash(sbt test*)',
      'Bash(stack test*)', 'Bash(cabal test*)', 'Bash(zig build test*)',
      'Bash(ctest*)', 'Bash(phpunit*)',
      'Bash(git diff*)', 'Bash(git status*)',
    ],
    constraint_note: 'This is a **test** ticket. You may ONLY edit test files (*.test.*, *.spec.*, __tests__/**, test_*.py, *_test.go, *Test.java, etc.). Do NOT modify production source code.',
  },
  security: {
    auto_approve_patterns: [
      'Read(*)', 'Glob(*)', 'Grep(*)', 'Edit(*)', 'Write(*)',
      'Bash(npm test*)', 'Bash(npx vitest*)', 'Bash(npx tsc*)',
      'Bash(pytest*)', 'Bash(cargo test*)', 'Bash(go test*)', 'Bash(mvn test*)',
      'Bash(./gradlew test*)', 'Bash(make test*)',
      'Bash(dart test*)', 'Bash(flutter test*)', 'Bash(sbt test*)',
      'Bash(stack test*)', 'Bash(cabal test*)', 'Bash(zig build test*)',
      'Bash(ctest*)', 'Bash(dotnet test*)', 'Bash(swift test*)',
      'Bash(mix test*)', 'Bash(bundle exec rspec*)', 'Bash(phpunit*)',
      'Bash(git diff*)', 'Bash(git status*)',
    ],
    constraint_note: 'This is a **security** ticket. You have full read/edit access but MUST NOT install new dependencies (`npm install`, `pip install`, `cargo add`, `go get`, `bundle add`, `composer require`, etc.). Do NOT run arbitrary shell commands beyond testing and type-checking.',
  },
};

/**
 * Get the tool policy for a given category.
 * Returns null if the category has no specific policy (use defaults).
 *
 * @deprecated Use ToolRegistry.getConstraintNote() instead.
 */
export function getCategoryToolPolicy(category: string | null): CategoryToolPolicy | null {
  if (!category) return null;
  return CATEGORY_TOOL_POLICIES[category] ?? null;
}

// ---------------------------------------------------------------------------
// Enforce category file-type restrictions
// ---------------------------------------------------------------------------

/**
 * Check if a file path is allowed by the category tool policy.
 * Returns true if no category policy exists (= everything allowed).
 * For docs: only *.md, *.mdx, *.txt, *.rst files.
 * For test: only *.test.*, *.spec.*, __tests__/** files.
 * Security has no file-type restrictions (only command restrictions).
 */
export function isCategoryFileAllowed(filePath: string, category: string | null): boolean {
  if (!category) return true;

  const CATEGORY_FILE_PATTERNS: Record<string, string[]> = {
    docs: ['*.md', '*.mdx', '*.txt', '*.rst', '**/*.md', '**/*.mdx', '**/*.txt', '**/*.rst'],
    test: [
      // JS/TS
      '*.test.*', '*.spec.*', '**/*.test.*', '**/*.spec.*', '**/__tests__/**', '__tests__/**',
      // Python
      'test_*', '**/test_*', '*_test.py', '**/*_test.py', '**/tests/**', 'tests/**', '**/conftest.py',
      // Go
      '*_test.go', '**/*_test.go',
      // Rust (tests/ dir)
      'tests/**', '**/tests/**',
      // Java/Kotlin
      '*Test.java', '**/*Test.java', '*Test.kt', '**/*Test.kt', '**/src/test/**',
      // Ruby
      '*_spec.rb', '**/*_spec.rb', '**/spec/**',
      // Elixir
      '*_test.exs', '**/*_test.exs',
      // Swift
      '*Tests.swift', '**/*Tests.swift',
      // PHP
      '*Test.php', '**/*Test.php',
    ],
  };

  const patterns = CATEGORY_FILE_PATTERNS[category];
  if (!patterns) return true; // no restrictions for this category (e.g. security, fix, refactor)

  return patterns.some(glob => minimatch(filePath, glob, { dot: true }));
}

// ---------------------------------------------------------------------------
// Serialize policy for MCP tool response (RegExp → string)
// ---------------------------------------------------------------------------

export function serializeScopePolicy(policy: ScopePolicy): Record<string, unknown> {
  const result: Record<string, unknown> = {
    allowed_paths: policy.allowed_paths,
    denied_paths: policy.denied_paths,
    denied_patterns: policy.denied_patterns.map(r => r.source),
    max_files: policy.max_files,
    max_lines: policy.max_lines,
    plan_required: policy.plan_required,
  };
  if (policy.worktree_root) {
    result.worktree_root = policy.worktree_root;
  }
  if (policy.risk_assessment) {
    result.risk_assessment = policy.risk_assessment;
  }
  return result;
}
