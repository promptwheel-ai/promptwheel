/**
 * Project guidelines loader — loads CLAUDE.md or AGENTS.md for prompt injection.
 *
 * Pure resolution logic and formatting live in @promptwheel/core/guidelines/shared.
 * This file wraps them with filesystem I/O.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  type ProjectGuidelines,
  type GuidelinesBackend,
  type BaselineInput,
  resolveGuidelinesPaths,
  getBaselineFilename,
  generateBaselineGuidelines,
} from '@promptwheel/core/guidelines/shared';

// Re-export types and pure functions
export type { ProjectGuidelines, GuidelinesBackend } from '@promptwheel/core/guidelines/shared';
export { formatGuidelinesForPrompt } from '@promptwheel/core/guidelines/shared';

export interface GuidelinesOptions {
  /** Which backend is running. Determines default file search order. */
  backend?: GuidelinesBackend;
  /** Auto-create baseline file if none found. */
  autoCreate?: boolean;
  /**
   * Custom path (relative to repoRoot) to the guidelines file.
   * Overrides the default CLAUDE.md / AGENTS.md search.
   * Set to false to disable guidelines entirely.
   */
  customPath?: string | false | null;
}

/**
 * Load project guidelines.
 *
 * Resolution order:
 * 1. If customPath is false → disabled, return null
 * 2. If customPath is a string → use that exact file
 * 3. Otherwise → search default paths by backend (primary then fallback)
 * 4. If nothing found and autoCreate → generate baseline
 */
export function loadGuidelines(
  repoRoot: string,
  opts: GuidelinesOptions = {},
): ProjectGuidelines | null {
  const { backend = 'claude', autoCreate = false, customPath } = opts;

  // Explicitly disabled
  if (customPath === false) return null;

  // Custom path — single file, no fallback
  if (typeof customPath === 'string') {
    return readGuidelinesFile(repoRoot, customPath);
  }

  // Default search: primary paths by backend, then fallback
  const [primaryPaths, fallbackPaths] = resolveGuidelinesPaths(backend);

  const result = searchPaths(repoRoot, primaryPaths) ?? searchPaths(repoRoot, fallbackPaths);
  if (result) return result;

  // Nothing found — auto-create if enabled
  if (autoCreate) {
    return createBaselineGuidelines(repoRoot, backend);
  }

  return null;
}

function readGuidelinesFile(repoRoot: string, rel: string): ProjectGuidelines | null {
  const full = path.join(repoRoot, rel);
  if (!fs.existsSync(full)) return null;
  try {
    const content = fs.readFileSync(full, 'utf-8');
    return { content, source: rel, loadedAt: Date.now() };
  } catch {
    return null;
  }
}

function searchPaths(repoRoot: string, paths: string[]): ProjectGuidelines | null {
  for (const rel of paths) {
    const result = readGuidelinesFile(repoRoot, rel);
    if (result) return result;
  }
  return null;
}

/**
 * Generate a baseline guidelines file from project metadata.
 */
function createBaselineGuidelines(
  repoRoot: string,
  backend: GuidelinesBackend,
): ProjectGuidelines | null {
  const filename = getBaselineFilename(backend);
  const fullPath = path.join(repoRoot, filename);

  // Don't overwrite existing files
  if (fs.existsSync(fullPath)) return null;

  // Build input from package.json
  const input = buildBaselineInput(repoRoot);
  const content = generateBaselineGuidelines(input, backend);

  try {
    fs.writeFileSync(fullPath, content, 'utf-8');
    return { content, source: filename, loadedAt: Date.now() };
  } catch {
    return null;
  }
}

/**
 * Build baseline input from project metadata (package.json, monorepo detection).
 */
function buildBaselineInput(repoRoot: string): BaselineInput {
  const projectName = path.basename(repoRoot);
  const input: BaselineInput = { projectName };

  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf-8'));
    input.description = pkg.description || undefined;
    input.scripts = pkg.scripts || {};
    input.hasTypeScript = !!(
      pkg.devDependencies?.typescript ||
      pkg.dependencies?.typescript
    );
  } catch {
    // No package.json
  }

  // Detect monorepo
  const hasWorkspaces =
    fs.existsSync(path.join(repoRoot, 'pnpm-workspace.yaml')) ||
    fs.existsSync(path.join(repoRoot, 'lerna.json'));
  input.isMonorepo = hasWorkspaces || fs.existsSync(path.join(repoRoot, 'packages'));

  return input;
}
