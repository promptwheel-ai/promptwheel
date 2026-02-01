/**
 * Scope Policy — derives and enforces file-level constraints for tickets.
 *
 * Used by the plan validator and PreToolUse hook to ensure
 * agents only touch files they're allowed to.
 */

import { minimatch } from 'minimatch';

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
}

// ---------------------------------------------------------------------------
// Always-denied paths (build artifacts, lockfiles, VCS internals)
// ---------------------------------------------------------------------------

const ALWAYS_DENIED_PATHS = [
  '.env', '.env.*',
  'node_modules/**', '.git/**', '.blockspool/**',
  'dist/**', 'build/**', 'coverage/**',
  '*.lock', 'package-lock.json',
];

// ---------------------------------------------------------------------------
// Credential / secret deny patterns
// ---------------------------------------------------------------------------

const CREDENTIAL_PATTERNS: RegExp[] = [
  /AKIA[0-9A-Z]{16}/,                        // AWS access key
  /-----BEGIN.*PRIVATE KEY-----/,              // PEM keys
  /ghp_[a-zA-Z0-9]{36}/,                      // GitHub PAT
  /sk-[a-zA-Z0-9]{48}/,                       // OpenAI key
  /password\s*[:=]\s*['"][^'"]+/i,            // hardcoded passwords
];

// ---------------------------------------------------------------------------
// Path deny patterns (file names that shouldn't be touched)
// ---------------------------------------------------------------------------

const FILE_DENY_PATTERNS: RegExp[] = [
  /\.(env|pem|key)$/,
  /credentials/i,
  /secret/i,
];

// ---------------------------------------------------------------------------
// Derive scope policy from ticket + config
// ---------------------------------------------------------------------------

export interface DeriveScopeInput {
  allowedPaths: string[];
  category: string;
  maxLinesPerTicket: number;
}

export function deriveScopePolicy(input: DeriveScopeInput): ScopePolicy {
  return {
    allowed_paths: input.allowedPaths,
    denied_paths: ALWAYS_DENIED_PATHS,
    denied_patterns: FILE_DENY_PATTERNS,
    max_files: 10,
    max_lines: input.category === 'test' ? 1000 : input.maxLinesPerTicket,
    plan_required: input.category !== 'docs',
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
}

export function validatePlanScope(
  files: PlanFile[],
  estimatedLines: number,
  riskLevel: string,
  policy: ScopePolicy,
): PlanValidationResult {
  // 1. Must have files
  if (!files || files.length === 0) {
    return { valid: false, reason: 'Plan must include at least one file to touch' };
  }

  // 2. Check estimated lines
  if (estimatedLines > policy.max_lines) {
    return {
      valid: false,
      reason: `Estimated lines (${estimatedLines}) exceeds max (${policy.max_lines})`,
    };
  }

  // 3. Check max files
  if (files.length > policy.max_files) {
    return {
      valid: false,
      reason: `Plan touches ${files.length} files, max allowed is ${policy.max_files}`,
    };
  }

  // 4. Valid risk level
  if (!riskLevel || !['low', 'medium', 'high'].includes(riskLevel)) {
    return { valid: false, reason: 'Plan must specify risk_level: low, medium, or high' };
  }

  // 5. Check each file against denied paths
  for (const f of files) {
    for (const deniedGlob of policy.denied_paths) {
      if (minimatch(f.path, deniedGlob, { dot: true })) {
        return { valid: false, reason: `Plan touches denied path: ${f.path} (matches ${deniedGlob})` };
      }
    }
  }

  // 6. Check each file against denied patterns
  for (const f of files) {
    for (const pattern of policy.denied_patterns) {
      if (pattern.test(f.path)) {
        return { valid: false, reason: `Plan touches sensitive file: ${f.path}` };
      }
    }
  }

  // 7. Check each file is within allowed_paths (if any specified)
  if (policy.allowed_paths.length > 0) {
    for (const f of files) {
      const isAllowed = policy.allowed_paths.some(glob =>
        minimatch(f.path, glob, { dot: true }),
      );
      if (!isAllowed) {
        return {
          valid: false,
          reason: `File ${f.path} is outside allowed paths: ${policy.allowed_paths.join(', ')}`,
        };
      }
    }
  }

  return { valid: true, reason: null };
}

// ---------------------------------------------------------------------------
// Check a single file path (used by PreToolUse hook)
// ---------------------------------------------------------------------------

export function isFileAllowed(filePath: string, policy: ScopePolicy): boolean {
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
      minimatch(filePath, glob, { dot: true }),
    );
  }

  return true;
}

// ---------------------------------------------------------------------------
// Check file content for credential patterns
// ---------------------------------------------------------------------------

export function containsCredentials(content: string): string | null {
  for (const pattern of CREDENTIAL_PATTERNS) {
    const match = content.match(pattern);
    if (match) {
      return `Content contains potential credential: ${pattern.source}`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Serialize policy for MCP tool response (RegExp → string)
// ---------------------------------------------------------------------------

export function serializeScopePolicy(policy: ScopePolicy): Record<string, unknown> {
  return {
    allowed_paths: policy.allowed_paths,
    denied_paths: policy.denied_paths,
    denied_patterns: policy.denied_patterns.map(r => r.source),
    max_files: policy.max_files,
    max_lines: policy.max_lines,
    plan_required: policy.plan_required,
  };
}
