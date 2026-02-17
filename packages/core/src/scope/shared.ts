/**
 * Pure scope algorithms — no filesystem, no external dependencies.
 *
 * Shared by both @promptwheel/cli and @promptwheel/mcp.
 * CLI keeps its proposal-level scope checking wrapper.
 * MCP keeps its minimatch-based policy enforcement + file I/O.
 */

// ---------------------------------------------------------------------------
// Always-denied paths (build artifacts, lockfiles, VCS internals)
// ---------------------------------------------------------------------------

export const ALWAYS_DENIED: string[] = [
  '.env', '.env.*',
  'node_modules/**', '.git/**', '.promptwheel/**',
  'dist/**', 'build/**', 'coverage/**',
  // Lock files are auto-generated; governed by per-ticket allowed_paths instead
  'package-lock.json',
];

// ---------------------------------------------------------------------------
// Credential / secret detection patterns
// ---------------------------------------------------------------------------

export const CREDENTIAL_PATTERNS: RegExp[] = [
  /AKIA[0-9A-Z]{16}/,                        // AWS access key
  /-----BEGIN.*PRIVATE KEY-----/,              // PEM keys
  /ghp_[a-zA-Z0-9]{36}/,                      // GitHub PAT
  /\bsk-(?:proj-)?[a-zA-Z0-9_-]{32,}/,        // OpenAI key
  /password\s*[:=]\s*['"][^'"]+/i,            // hardcoded passwords
  /xox[bporas]-[a-zA-Z0-9-]+/,               // Slack tokens
  /postgres(ql)?:\/\/[^\s'"]+/i,             // PostgreSQL connection string
  /mongodb(\+srv)?:\/\/[^\s'"]+/i,           // MongoDB connection string
  /mysql:\/\/[^\s'"]+/i,                      // MySQL connection string
  /eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\./, // JWT tokens
  /(?:SECRET|TOKEN|API_?KEY|PRIVATE_?KEY)\s*[:=]\s*['"][^'"]{8,}/i, // Generic secrets
];

// ---------------------------------------------------------------------------
// File deny patterns (sensitive file names)
// ---------------------------------------------------------------------------

export const FILE_DENY_PATTERNS: RegExp[] = [
  /\.(env|pem|key)$/,
  /credentials/i,
  /secret/i,
];

// ---------------------------------------------------------------------------
// Path normalization
// ---------------------------------------------------------------------------

/**
 * Normalize a file path for consistent matching.
 */
export function normalizePath(filePath: string): string {
  return filePath
    .replace(/\\/g, '/')     // Normalize backslashes
    .replace(/^\.\//, '')    // Remove leading ./
    .replace(/\/+/g, '/')   // Collapse multiple slashes
    .replace(/\/$/, '');     // Remove trailing slash
}

// ---------------------------------------------------------------------------
// Hallucinated path detection
// ---------------------------------------------------------------------------

/**
 * Detect if a path appears to be hallucinated by an LLM.
 * Common patterns: repeated segments like 'foo/foo/'.
 */
export function detectHallucinatedPath(filePath: string): {
  isHallucinated: boolean;
  reason?: string;
} {
  const normalized = normalizePath(filePath);
  const segments = normalized.split('/').filter(s => s.length > 0);

  // Check for repeated consecutive segments
  for (let i = 0; i < segments.length - 1; i++) {
    if (segments[i] === segments[i + 1] && segments[i].length > 0) {
      return {
        isHallucinated: true,
        reason: `Repeated path segment: '${segments[i]}/${segments[i]}'`,
      };
    }
  }

  // Double slashes in original
  if (/\/\//.test(filePath)) {
    return {
      isHallucinated: true,
      reason: 'Contains double slashes',
    };
  }

  return { isHallucinated: false };
}

// ---------------------------------------------------------------------------
// Credential detection in file content
// ---------------------------------------------------------------------------

/**
 * Check file content for credential patterns.
 * Returns a description of the first match, or null if clean.
 */
export function detectCredentialInContent(content: string): string | null {
  for (const pattern of CREDENTIAL_PATTERNS) {
    const match = content.match(pattern);
    if (match) {
      return `Content contains potential credential: ${pattern.source}`;
    }
  }
  return null;
}

/**
 * Check if a file path matches credential/sensitive file patterns.
 */
export function detectCredentialPattern(filePath: string): boolean {
  for (const pattern of FILE_DENY_PATTERNS) {
    if (pattern.test(filePath)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Pure glob-style pattern matching (no external deps)
// ---------------------------------------------------------------------------

/**
 * Simple glob-style pattern matching.
 * Supports: * (any chars), ** (any path segments), ? (single char)
 */
export function matchesPattern(filePath: string, pattern: string): boolean {
  const normalizedFile = filePath.replace(/\\/g, '/');
  const normalizedPattern = pattern.replace(/\\/g, '/');

  // Convert glob to regex
  let regexPattern = normalizedPattern
    .replace(/\*\*\//g, '<<<GLOBSTAR_SLASH>>>')
    .replace(/\*\*/g, '<<<GLOBSTAR>>>')
    .replace(/\*/g, '<<<STAR>>>')
    .replace(/\?/g, '<<<QUESTION>>>');

  regexPattern = regexPattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');

  regexPattern = regexPattern
    .replace(/<<<GLOBSTAR_SLASH>>>/g, '(?:.*/)?')
    .replace(/<<<GLOBSTAR>>>/g, '.*')
    .replace(/<<<STAR>>>/g, '[^/]*')
    .replace(/<<<QUESTION>>>/g, '[^/]');

  const regex = new RegExp(`^${regexPattern}$`);
  return regex.test(normalizedFile);
}

// ---------------------------------------------------------------------------
// Path allowed/denied checking (pure — no minimatch dependency)
// ---------------------------------------------------------------------------

/**
 * Check if a path is allowed given allow/deny lists using built-in glob matching.
 * When allowed is empty, everything not denied is allowed.
 */
export function isPathAllowed(
  filePath: string,
  allowed: string[],
  denied: string[],
): boolean {
  const normalized = normalizePath(filePath);

  // Check denied first (higher priority)
  for (const pattern of denied) {
    if (matchesPattern(normalized, pattern)) return false;
  }

  // Check denied file patterns
  if (detectCredentialPattern(normalized)) return false;

  // Check allowed (empty = everything allowed)
  if (allowed.length === 0) return true;

  return allowed.some(pattern => matchesPattern(normalized, pattern));
}

// ---------------------------------------------------------------------------
// Scope violation checking
// ---------------------------------------------------------------------------

export interface ScopeViolation {
  file: string;
  violation: 'not_in_allowed' | 'in_forbidden';
  pattern?: string;
}

/**
 * Check if changed files violate scope constraints.
 */
export function checkScopeViolations(
  changedFiles: string[],
  allowedPaths: string[],
  forbiddenPaths: string[],
): ScopeViolation[] {
  const violations: ScopeViolation[] = [];

  for (const file of changedFiles) {
    // Check hallucinated paths first
    const hallucinationCheck = detectHallucinatedPath(file);
    if (hallucinationCheck.isHallucinated) {
      violations.push({
        file,
        violation: 'not_in_allowed',
        pattern: `hallucinated: ${hallucinationCheck.reason}`,
      });
      continue;
    }

    const normalizedFile = normalizePath(file);

    // Check forbidden paths (higher priority)
    let isForbidden = false;
    for (const pattern of forbiddenPaths) {
      if (matchesPattern(normalizedFile, pattern)) {
        violations.push({ file, violation: 'in_forbidden', pattern });
        isForbidden = true;
        break;
      }
    }

    // Check allowed paths
    if (!isForbidden && allowedPaths.length > 0) {
      let isAllowed = allowedPaths.some(pattern =>
        matchesPattern(normalizedFile, pattern)
      );

      if (!isAllowed && file.endsWith('/')) {
        const dirPrefix = normalizedFile + '/';
        isAllowed = allowedPaths.some(pattern => pattern.startsWith(dirPrefix));
      }

      if (!isAllowed) {
        violations.push({ file, violation: 'not_in_allowed' });
      }
    }
  }

  return violations;
}

// ---------------------------------------------------------------------------
// Scope expansion
// ---------------------------------------------------------------------------

export interface ScopeExpansionResult {
  canExpand: boolean;
  expandedPaths: string[];
  addedPaths: string[];
  reason?: string;
}

/**
 * Analyze violations and determine if paths can be auto-expanded.
 * Allows expansion for sibling files, test files, type definitions,
 * index files, subdirectories, and root configs.
 */
export function analyzeViolationsForExpansion(
  violations: ScopeViolation[],
  currentAllowedPaths: string[],
  maxExpansions: number = 10,
): ScopeExpansionResult {
  // Forbidden violations cannot be expanded
  const forbiddenViolations = violations.filter(v => v.violation === 'in_forbidden');
  if (forbiddenViolations.length > 0) {
    return {
      canExpand: false,
      expandedPaths: currentAllowedPaths,
      addedPaths: [],
      reason: `Cannot expand: ${forbiddenViolations.length} file(s) match forbidden paths`,
    };
  }

  // Hallucinated paths cannot be expanded
  const hallucinatedViolations = violations.filter(v =>
    v.pattern?.startsWith('hallucinated:')
  );
  if (hallucinatedViolations.length > 0) {
    return {
      canExpand: false,
      expandedPaths: currentAllowedPaths,
      addedPaths: [],
      reason: `Cannot expand: ${hallucinatedViolations.length} hallucinated path(s) detected`,
    };
  }

  // Get allowed directories
  const allowedDirs = new Set<string>();
  for (const p of currentAllowedPaths) {
    const normalized = normalizePath(p);
    const lastSlash = normalized.lastIndexOf('/');
    if (lastSlash > 0) {
      allowedDirs.add(normalized.slice(0, lastSlash));
    }
  }

  const pathsToAdd: string[] = [];
  const notAllowedViolations = violations.filter(v => v.violation === 'not_in_allowed');

  for (const violation of notAllowedViolations) {
    const normalizedFile = normalizePath(violation.file);
    const lastSlash = normalizedFile.lastIndexOf('/');
    const fileDir = lastSlash > 0 ? normalizedFile.slice(0, lastSlash) : '';
    const fileName = lastSlash > 0 ? normalizedFile.slice(lastSlash + 1) : normalizedFile;

    const isSiblingFile = allowedDirs.has(fileDir);
    const isRelatedFile =
      // JS/TS
      fileName.endsWith('.d.ts') ||
      fileName.includes('.test.') ||
      fileName.includes('.spec.') ||
      fileName === 'index.ts' || fileName === 'index.tsx' || fileName === 'index.js' ||
      fileName === 'types.ts' || fileName === 'types.tsx' ||
      // Python
      fileName === '__init__.py' || fileName === 'conftest.py' ||
      fileName.startsWith('test_') || fileName.endsWith('_test.py') ||
      // Rust
      fileName === 'mod.rs' || fileName === 'lib.rs' || fileName === 'build.rs' ||
      // Go
      fileName === 'go.mod' || fileName === 'go.sum' ||
      fileName.endsWith('_test.go') ||
      // Java/Kotlin
      fileName.endsWith('Test.java') || fileName.endsWith('Test.kt') ||
      // C#
      fileName.endsWith('.csproj') || fileName.endsWith('.sln') ||
      fileName.endsWith('Tests.cs') || fileName.endsWith('Test.cs') ||
      // Ruby
      fileName.endsWith('_spec.rb') || fileName === 'Rakefile' || fileName === 'Gemfile.lock' ||
      // Elixir
      fileName.endsWith('_test.exs') || fileName === 'mix.lock' ||
      // Swift
      fileName === 'Package.swift' || fileName.endsWith('Tests.swift') ||
      // Dart
      fileName === 'pubspec.yaml' || fileName === 'pubspec.lock' ||
      fileName.endsWith('_test.dart') ||
      // Scala
      fileName.endsWith('Spec.scala') || fileName.endsWith('Test.scala') ||
      fileName === 'build.sbt' ||
      // Haskell
      fileName.endsWith('Spec.hs') || fileName === 'stack.yaml' ||
      fileName.endsWith('.cabal') ||
      // Zig
      fileName === 'build.zig' || fileName === 'build.zig.zon' ||
      // C/C++
      fileName === 'CMakeLists.txt' || fileName === 'Makefile';
    const isSubdirectory = [...allowedDirs].some(dir => fileDir.startsWith(dir + '/'));
    const isRootConfig = !fileDir && /^(vitest|vite|jest|tsconfig|eslint|prettier|babel|rollup|webpack|next|tailwind|pyproject|setup|Cargo|go\.mod|go\.sum|Gemfile|mix|pom|build\.gradle|CMakeLists|Makefile)\b/.test(fileName);

    if (isSiblingFile || isRelatedFile || isSubdirectory || isRootConfig) {
      pathsToAdd.push(normalizedFile);
    }
  }

  // Second pass: cross-directory within same top-level module
  if (pathsToAdd.length < notAllowedViolations.length) {
    const allowedTopDirs = new Set<string>();
    for (const dir of allowedDirs) {
      const parts = dir.split('/');
      if (parts.length >= 1) allowedTopDirs.add(parts[0]);
      if (parts.length >= 2) allowedTopDirs.add(parts.slice(0, 2).join('/'));
    }

    const hasPackagesDir = [...allowedDirs].some(d => d.startsWith('packages/'));
    if (hasPackagesDir) allowedTopDirs.add('packages');

    for (const violation of notAllowedViolations) {
      const normalizedFile = normalizePath(violation.file);
      if (pathsToAdd.includes(normalizedFile)) continue;

      const fileParts = normalizedFile.split('/');
      const fileTopDir = fileParts.length >= 2
        ? fileParts.slice(0, 2).join('/')
        : fileParts[0];

      if (allowedTopDirs.has(fileTopDir) || allowedTopDirs.has(fileParts[0])) {
        pathsToAdd.push(normalizedFile);
      }
    }
  }

  if (pathsToAdd.length === 0) {
    return {
      canExpand: false,
      expandedPaths: currentAllowedPaths,
      addedPaths: [],
      reason: `Cannot expand: ${notAllowedViolations.length} file(s) in unrelated directories`,
    };
  }

  if (pathsToAdd.length > maxExpansions) {
    return {
      canExpand: false,
      expandedPaths: currentAllowedPaths,
      addedPaths: [],
      reason: `Cannot expand: ${pathsToAdd.length} files need expansion (max: ${maxExpansions})`,
    };
  }

  const expandedPaths = [...new Set([...currentAllowedPaths, ...pathsToAdd])];

  return {
    canExpand: true,
    expandedPaths,
    addedPaths: pathsToAdd,
  };
}

// ---------------------------------------------------------------------------
// Git status parsing
// ---------------------------------------------------------------------------

/**
 * Parse git status --porcelain output to get changed file paths.
 */
export function parseChangedFiles(statusOutput: string): string[] {
  if (!statusOutput.trim()) return [];

  return statusOutput
    .split('\n')
    .filter(line => line.trim())
    .map(line => {
      // Format: XY filename or XY original -> renamed
      // eslint-disable-next-line security/detect-unsafe-regex
      const match = line.match(/^..\s+(.+?)(?:\s+->\s+(.+))?$/);
      if (!match) return null;
      return match[2] || match[1];
    })
    .filter((f): f is string => f !== null);
}
