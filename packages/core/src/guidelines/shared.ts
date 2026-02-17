/**
 * Pure guideline resolution logic — no filesystem I/O.
 *
 * Shared by both @blockspool/cli and @blockspool/mcp.
 * Callers handle file I/O (reading files, writing baseline).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProjectGuidelines {
  content: string;
  source: string;
  loadedAt: number;
}

export type GuidelinesBackend = string;

// ---------------------------------------------------------------------------
// Path resolution (pure — returns paths to try, doesn't read files)
// ---------------------------------------------------------------------------

const CLAUDE_PATHS = ['CLAUDE.md'];
const CODEX_PATHS = ['AGENTS.md'];

const BACKEND_PATHS: Record<string, string[]> = {
  claude: CLAUDE_PATHS,
  codex: CODEX_PATHS,
  kimi: ['KIMI.md'],
  'openai-local': ['CLAUDE.md'],
};

/**
 * Resolve the ordered list of guideline file paths to search.
 * Returns [primaryPaths, fallbackPaths].
 */
export function resolveGuidelinesPaths(
  backend: GuidelinesBackend = 'claude',
): [primary: string[], fallback: string[]] {
  const primaryPaths = BACKEND_PATHS[backend] ?? CLAUDE_PATHS;
  const allPaths = [...new Set([
    ...CLAUDE_PATHS,
    ...CODEX_PATHS,
    ...Object.values(BACKEND_PATHS).flat(),
  ])];
  const fallbackPaths = allPaths.filter(p => !primaryPaths.includes(p));
  return [primaryPaths, fallbackPaths];
}

/**
 * Get the filename to use when creating a baseline guidelines file.
 */
export function getBaselineFilename(backend: GuidelinesBackend = 'claude'): string {
  const BACKEND_FILENAMES: Record<string, string> = {
    codex: 'AGENTS.md',
    kimi: 'KIMI.md',
  };
  return BACKEND_FILENAMES[backend] ?? 'CLAUDE.md';
}

// ---------------------------------------------------------------------------
// Prompt formatting (pure)
// ---------------------------------------------------------------------------

/**
 * Wrap guidelines content in XML tags for prompt injection.
 */
export function formatGuidelinesForPrompt(guidelines: ProjectGuidelines): string {
  return [
    '<project-guidelines>',
    `<!-- Source: ${guidelines.source} -->`,
    guidelines.content,
    '</project-guidelines>',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Baseline generation (pure — returns content string, caller writes)
// ---------------------------------------------------------------------------

export interface BaselineInput {
  projectName: string;
  description?: string;
  hasTypeScript?: boolean;
  scripts?: Record<string, string>;
  isMonorepo?: boolean;
  /** Detected test runner command (language-agnostic) */
  testCommand?: string;
  /** Detected lint command */
  lintCommand?: string;
  /** Detected build command */
  buildCommand?: string;
  /** Primary language */
  language?: string;
}

/**
 * Generate baseline guidelines content from project metadata.
 * Returns the file content as a string. Caller handles writing.
 */
export function generateBaselineGuidelines(
  input: BaselineInput,
  _backend: GuidelinesBackend = 'claude',
): string {
  const parts: string[] = [];

  parts.push(`# ${input.projectName}`);
  parts.push('');

  if (input.description) {
    parts.push(input.description);
    parts.push('');
  }

  // Conventions section
  parts.push('## Conventions');
  parts.push('');
  if (input.hasTypeScript) {
    parts.push('- This project uses TypeScript. Prefer strict types over `any`.');
  }
  parts.push('- Keep changes minimal and focused on the task at hand.');
  parts.push('- Follow existing code style and patterns in the codebase.');
  parts.push('- Do not introduce new dependencies without justification.');
  parts.push('');

  // Verification section — prefer detected commands, fall back to package.json scripts
  const scripts = input.scripts ?? {};
  const verifyCommands: string[] = [];

  if (input.lintCommand) {
    verifyCommands.push(input.lintCommand);
  } else {
    let lintCmd = '';
    if (scripts.lint) lintCmd = 'npm run lint';
    if (scripts.typecheck || scripts['type-check']) {
      lintCmd = lintCmd ? `${lintCmd} && npm run typecheck` : 'npm run typecheck';
    }
    if (lintCmd) verifyCommands.push(lintCmd);
  }
  if (input.testCommand) {
    verifyCommands.push(input.testCommand);
  } else if (scripts.test) {
    verifyCommands.push('npm test');
  }
  if (input.buildCommand) {
    verifyCommands.push(input.buildCommand);
  } else if (scripts.build) {
    verifyCommands.push('npm run build');
  }

  if (verifyCommands.length > 0) {
    parts.push('## Verification');
    parts.push('');
    parts.push('After making changes, verify with:');
    parts.push('');
    for (const cmd of verifyCommands) {
      parts.push('```bash');
      parts.push(cmd);
      parts.push('```');
    }
    parts.push('');
  }

  // Monorepo section
  if (input.isMonorepo) {
    parts.push('## Structure');
    parts.push('');
    parts.push('This is a monorepo. When modifying code in one package, check for cross-package impacts.');
    parts.push('');
  }

  const header = '<!-- Generated by BlockSpool. Edit freely to customize agent behavior. -->';
  return header + '\n\n' + parts.join('\n');
}
