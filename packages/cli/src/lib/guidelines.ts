/**
 * Project guidelines loader — loads CLAUDE.md or AGENTS.md for prompt injection.
 *
 * For Claude-based runs: searches for CLAUDE.md
 * For Codex-based runs: searches for AGENTS.md
 * Falls back to whichever exists if the preferred one is missing.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Loaded project guidelines with metadata.
 */
export interface ProjectGuidelines {
  content: string;
  source: string;
  loadedAt: number;
}

export type GuidelinesBackend = string;

/**
 * Search paths by backend, in priority order.
 * Primary search uses the backend-appropriate file, fallback uses the other.
 */
const CLAUDE_PATHS = ['CLAUDE.md'];

const CODEX_PATHS = ['AGENTS.md'];

const MAX_CHARS = 4000;

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
  const BACKEND_PATHS: Record<string, string[]> = {
    claude: CLAUDE_PATHS,
    codex: CODEX_PATHS,
    kimi: ['KIMI.md'],
    'openai-local': ['CLAUDE.md'],
  };
  const primaryPaths = BACKEND_PATHS[backend] ?? CLAUDE_PATHS;
  // Fallback: try all other known paths
  const allPaths = [...new Set([...CLAUDE_PATHS, ...CODEX_PATHS, ...Object.values(BACKEND_PATHS).flat()])];
  const fallbackPaths = allPaths.filter(p => !primaryPaths.includes(p));

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
    let content = fs.readFileSync(full, 'utf-8');
    if (content.length > MAX_CHARS) {
      content = content.slice(0, MAX_CHARS) + '\n\n[truncated]';
    }
    return { content, source: rel, loadedAt: Date.now() };
  } catch {
    return null;
  }
}

function searchPaths(repoRoot: string, paths: string[]): ProjectGuidelines | null {
  for (const rel of paths) {
    const full = path.join(repoRoot, rel);
    if (fs.existsSync(full)) {
      try {
        let content = fs.readFileSync(full, 'utf-8');
        if (content.length > MAX_CHARS) {
          content = content.slice(0, MAX_CHARS) + '\n\n[truncated]';
        }
        return { content, source: rel, loadedAt: Date.now() };
      } catch {
        // Unreadable — skip
      }
    }
  }
  return null;
}

/**
 * Wrap guidelines in XML tags for prompt injection.
 */
export function formatGuidelinesForPrompt(guidelines: ProjectGuidelines): string {
  return [
    '<project-guidelines>',
    `<!-- Source: ${guidelines.source} -->`,
    guidelines.content,
    '</project-guidelines>',
  ].join('\n');
}

/**
 * Generate a baseline guidelines file from project metadata.
 * Writes AGENTS.md for codex, CLAUDE.md for claude.
 * Returns the loaded guidelines, or null if creation fails.
 */
function createBaselineGuidelines(
  repoRoot: string,
  backend: GuidelinesBackend,
): ProjectGuidelines | null {
  const BACKEND_FILENAMES: Record<string, string> = {
    codex: 'AGENTS.md',
    kimi: 'KIMI.md',
  };
  const filename = BACKEND_FILENAMES[backend] ?? 'CLAUDE.md';
  const fullPath = path.join(repoRoot, filename);

  // Don't overwrite existing files
  if (fs.existsSync(fullPath)) return null;

  const content = generateBaseline(repoRoot, backend);

  try {
    fs.writeFileSync(fullPath, content, 'utf-8');
    return { content, source: filename, loadedAt: Date.now() };
  } catch {
    // Can't write — not fatal
    return null;
  }
}

/**
 * Build baseline guidelines content from project metadata.
 */
function generateBaseline(repoRoot: string, backend: GuidelinesBackend): string {
  const projectName = path.basename(repoRoot);
  const parts: string[] = [];

  parts.push(`# ${projectName}`);
  parts.push('');

  // Detect project type from package.json
  let description = '';
  let hasTypeScript = false;
  let testCmd = '';
  let lintCmd = '';
  let buildCmd = '';
  const scripts: Record<string, string> = {};

  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf-8'));
    description = pkg.description || '';
    Object.assign(scripts, pkg.scripts || {});
    hasTypeScript = !!(
      pkg.devDependencies?.typescript ||
      pkg.dependencies?.typescript
    );
    if (scripts.test) testCmd = `npm test`;
    if (scripts.lint) lintCmd = `npm run lint`;
    if (scripts.typecheck || scripts['type-check']) {
      lintCmd = lintCmd ? `${lintCmd} && npm run typecheck` : 'npm run typecheck';
    }
    if (scripts.build) buildCmd = `npm run build`;
  } catch {
    // No package.json — keep defaults
  }

  if (description) {
    parts.push(description);
    parts.push('');
  }

  // Conventions section
  parts.push('## Conventions');
  parts.push('');
  if (hasTypeScript) {
    parts.push('- This project uses TypeScript. Prefer strict types over `any`.');
  }
  parts.push('- Keep changes minimal and focused on the task at hand.');
  parts.push('- Follow existing code style and patterns in the codebase.');
  parts.push('- Do not introduce new dependencies without justification.');
  parts.push('');

  // Verification section
  const verifyCommands: string[] = [];
  if (lintCmd) verifyCommands.push(lintCmd);
  if (testCmd) verifyCommands.push(testCmd);
  if (buildCmd) verifyCommands.push(buildCmd);

  if (verifyCommands.length > 0) {
    parts.push('## Verification');
    parts.push('');
    parts.push('After making changes, verify with:');
    parts.push('');
    for (const cmd of verifyCommands) {
      parts.push(`\`\`\`bash`);
      parts.push(cmd);
      parts.push(`\`\`\``);
    }
    parts.push('');
  }

  // Detect monorepo
  const hasWorkspaces = !!scripts['workspaces'] ||
    fs.existsSync(path.join(repoRoot, 'pnpm-workspace.yaml')) ||
    fs.existsSync(path.join(repoRoot, 'lerna.json'));

  if (hasWorkspaces || fs.existsSync(path.join(repoRoot, 'packages'))) {
    parts.push('## Structure');
    parts.push('');
    parts.push('This is a monorepo. When modifying code in one package, check for cross-package impacts.');
    parts.push('');
  }

  const header = backend === 'codex'
    ? '<!-- Generated by BlockSpool. Edit freely to customize agent behavior. -->'
    : '<!-- Generated by BlockSpool. Edit freely to customize agent behavior. -->';

  return header + '\n\n' + parts.join('\n');
}
