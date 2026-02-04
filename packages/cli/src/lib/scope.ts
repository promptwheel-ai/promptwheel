/**
 * Scope enforcement utilities
 *
 * Validates that file changes stay within ticket's allowed paths
 * and don't touch forbidden paths.
 */

/**
 * Scope violation result
 */
export interface ScopeViolation {
  file: string;
  violation: 'not_in_allowed' | 'in_forbidden';
  pattern?: string;
}

/**
 * Normalize a file path by:
 * - Removing leading ./
 * - Collapsing multiple slashes (//)
 * - Removing trailing slashes (except for root)
 *
 * @param filePath - The file path to normalize
 * @returns Normalized path
 */
export function normalizePath(filePath: string): string {
  return filePath
    .replace(/\\/g, '/') // Normalize backslashes
    .replace(/^\.\//, '') // Remove leading ./
    .replace(/\/+/g, '/') // Collapse multiple slashes
    .replace(/\/$/, ''); // Remove trailing slash
}

/**
 * Detect if a path appears to be hallucinated by Claude.
 * Common hallucination patterns include repeated path segments like 'foo/foo/'.
 *
 * @param filePath - The file path to check
 * @returns Object with isHallucinated flag and optional reason
 */
export function detectHallucinatedPath(filePath: string): {
  isHallucinated: boolean;
  reason?: string;
} {
  const normalized = normalizePath(filePath);
  const segments = normalized.split('/').filter(s => s.length > 0);

  // Check for repeated consecutive segments (e.g., 'cloud/cloud/', 'src/src/')
  for (let i = 0; i < segments.length - 1; i++) {
    if (segments[i] === segments[i + 1] && segments[i].length > 0) {
      return {
        isHallucinated: true,
        reason: `Repeated path segment: '${segments[i]}/${segments[i]}'`,
      };
    }
  }

  // Check for obviously malformed patterns
  if (/\/\//.test(filePath)) {
    // Double slashes in original (before normalization)
    return {
      isHallucinated: true,
      reason: 'Contains double slashes',
    };
  }

  return { isHallucinated: false };
}

/**
 * Check if changed files violate ticket scope constraints
 *
 * @param changedFiles - List of file paths that were modified
 * @param allowedPaths - Glob patterns for allowed paths (empty = all allowed)
 * @param forbiddenPaths - Glob patterns for forbidden paths
 * @returns List of violations, empty if all files are within scope
 */
export function checkScopeViolations(
  changedFiles: string[],
  allowedPaths: string[],
  forbiddenPaths: string[]
): ScopeViolation[] {
  const violations: ScopeViolation[] = [];

  for (const file of changedFiles) {
    // Check for hallucinated paths first
    const hallucinationCheck = detectHallucinatedPath(file);
    if (hallucinationCheck.isHallucinated) {
      console.warn(
        `[scope] Warning: Detected hallucinated path '${file}': ${hallucinationCheck.reason}`
      );
      // Report hallucinated paths as not_in_allowed since they are invalid
      violations.push({
        file,
        violation: 'not_in_allowed',
        pattern: `hallucinated: ${hallucinationCheck.reason}`,
      });
      continue; // Skip further checks for hallucinated paths
    }

    // Normalize the path for consistent matching
    const normalizedFile = normalizePath(file);

    // Check forbidden paths first (higher priority)
    for (const pattern of forbiddenPaths) {
      if (matchesPattern(normalizedFile, pattern)) {
        violations.push({ file, violation: 'in_forbidden', pattern });
        break; // Don't check allowed if forbidden
      }
    }

    // If no forbidden match and allowed_paths is specified, check allowed
    if (allowedPaths.length > 0 && !violations.some(v => v.file === file)) {
      let isAllowed = allowedPaths.some(pattern =>
        matchesPattern(normalizedFile, pattern)
      );

      // For directory entries (git shows new dirs with trailing /),
      // check if any allowed path is under this directory
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

/**
 * Simple glob-style pattern matching
 * Supports: * (any chars), ** (any path segments), ? (single char)
 *
 * @param filePath - The file path to check
 * @param pattern - Glob pattern to match against
 * @returns true if the file matches the pattern
 */
export function matchesPattern(filePath: string, pattern: string): boolean {
  // Normalize paths
  const normalizedFile = filePath.replace(/\\/g, '/');
  const normalizedPattern = pattern.replace(/\\/g, '/');

  // Convert glob to regex
  // Step 1: Replace glob patterns with placeholders
  let regexPattern = normalizedPattern
    .replace(/\*\*\//g, '<<<GLOBSTAR_SLASH>>>') // **/ matches zero or more directories
    .replace(/\*\*/g, '<<<GLOBSTAR>>>') // ** at end matches anything
    .replace(/\*/g, '<<<STAR>>>') // * matches anything except /
    .replace(/\?/g, '<<<QUESTION>>>'); // ? matches single char

  // Step 2: Escape special regex chars (but not our placeholders)
  regexPattern = regexPattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');

  // Step 3: Replace placeholders with regex patterns
  regexPattern = regexPattern
    .replace(/<<<GLOBSTAR_SLASH>>>/g, '(?:.*/)?') // **/ = zero or more dirs
    .replace(/<<<GLOBSTAR>>>/g, '.*') // ** = anything
    .replace(/<<<STAR>>>/g, '[^/]*') // * = anything except /
    .replace(/<<<QUESTION>>>/g, '[^/]'); // ? = single char except /

  const regex = new RegExp(`^${regexPattern}$`);
  return regex.test(normalizedFile);
}

/**
 * Result of analyzing scope violations for auto-expansion
 */
export interface ScopeExpansionResult {
  /** Whether the paths can be expanded to fix violations */
  canExpand: boolean;
  /** New allowed paths after expansion */
  expandedPaths: string[];
  /** Files that were added to allowed paths */
  addedPaths: string[];
  /** Reason if expansion is not possible */
  reason?: string;
}

/**
 * Analyze scope violations and determine if paths can be auto-expanded.
 *
 * This enables "organic" handling of blocked tickets by automatically
 * expanding allowed_paths for reasonable related files:
 * - Same directory (sibling files)
 * - Test files for source files
 * - Type definition files (.d.ts)
 * - Index files
 *
 * Will NOT expand for:
 * - Hallucinated paths
 * - Forbidden path violations
 * - Files in completely unrelated directories
 *
 * @param violations - List of scope violations from checkScopeViolations
 * @param currentAllowedPaths - Current allowed_paths for the ticket
 * @param maxExpansions - Maximum number of paths to add (default: 10)
 * @returns Expansion result with new paths or reason for rejection
 */
export function analyzeViolationsForExpansion(
  violations: ScopeViolation[],
  currentAllowedPaths: string[],
  maxExpansions: number = 10
): ScopeExpansionResult {
  // Check for forbidden violations - these cannot be expanded
  const forbiddenViolations = violations.filter(v => v.violation === 'in_forbidden');
  if (forbiddenViolations.length > 0) {
    return {
      canExpand: false,
      expandedPaths: currentAllowedPaths,
      addedPaths: [],
      reason: `Cannot expand: ${forbiddenViolations.length} file(s) match forbidden paths`,
    };
  }

  // Check for hallucinated paths - these cannot be expanded
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

  // Get the "allowed" directories from current paths
  const allowedDirs = new Set<string>();
  for (const path of currentAllowedPaths) {
    const normalized = normalizePath(path);
    const lastSlash = normalized.lastIndexOf('/');
    if (lastSlash > 0) {
      allowedDirs.add(normalized.slice(0, lastSlash));
    }
  }

  // Analyze each violation and check if it's a "reasonable" expansion
  const pathsToAdd: string[] = [];
  const notAllowedViolations = violations.filter(v => v.violation === 'not_in_allowed');

  for (const violation of notAllowedViolations) {
    const normalizedFile = normalizePath(violation.file);
    const lastSlash = normalizedFile.lastIndexOf('/');
    const fileDir = lastSlash > 0 ? normalizedFile.slice(0, lastSlash) : '';
    const fileName = lastSlash > 0 ? normalizedFile.slice(lastSlash + 1) : normalizedFile;

    // Check if file is in a directory we already allow (sibling file)
    const isSiblingFile = allowedDirs.has(fileDir);

    // Check if file is a related type (types file, test file, index file)
    const isRelatedFile =
      fileName.endsWith('.d.ts') ||
      fileName.includes('.test.') ||
      fileName.includes('.spec.') ||
      fileName === 'index.ts' ||
      fileName === 'index.tsx' ||
      fileName === 'index.js' ||
      fileName === 'types.ts' ||
      fileName === 'types.tsx';

    // Check if file is in an allowed subdirectory
    const isSubdirectory = [...allowedDirs].some(dir => fileDir.startsWith(dir + '/'));

    // Check if file is a root-level config (vitest.config.ts, tsconfig.json, etc.)
    const isRootConfig = !fileDir && /^(vitest|vite|jest|tsconfig|eslint|prettier|babel|rollup|webpack|next|tailwind)\b/.test(fileName);

    if (isSiblingFile || isRelatedFile || isSubdirectory || isRootConfig) {
      pathsToAdd.push(normalizedFile);
    }
  }

  // Second pass: if some violations remain, check if they share a common
  // top-level module with the allowed paths (e.g. both under src/api/).
  // This handles legitimate cross-directory refactors like renames.
  if (pathsToAdd.length < notAllowedViolations.length) {
    const allowedTopDirs = new Set<string>();
    for (const dir of allowedDirs) {
      const parts = dir.split('/');
      // Add the root directory (e.g. "src" from "src/lib/utils")
      if (parts.length >= 1) {
        allowedTopDirs.add(parts[0]);
      }
      // Also add first two segments as the "module" (e.g. "src/lib")
      if (parts.length >= 2) {
        allowedTopDirs.add(parts.slice(0, 2).join('/'));
      }
    }

    // Cross-package awareness: if any packages/*/src path is allowed,
    // treat other packages/*/src paths as related (monorepo siblings)
    const hasPackagesDir = [...allowedDirs].some(d => d.startsWith('packages/'));
    if (hasPackagesDir) {
      allowedTopDirs.add('packages');
    }

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

  // Check if we have too many expansions
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

  // Merge new paths with existing
  const expandedPaths = [...currentAllowedPaths, ...pathsToAdd];
  const uniquePaths = [...new Set(expandedPaths)];

  return {
    canExpand: true,
    expandedPaths: uniquePaths,
    addedPaths: pathsToAdd,
  };
}

/**
 * Parse git status --porcelain output to get changed file paths
 *
 * @param statusOutput - Output from `git status --porcelain`
 * @returns List of file paths that were changed
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
      // Return the destination for renames, otherwise the filename
      return match[2] || match[1];
    })
    .filter((f): f is string => f !== null);
}
