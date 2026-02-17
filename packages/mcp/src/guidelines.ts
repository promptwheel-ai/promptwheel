/**
 * Project guidelines loader for MCP advance prompts.
 *
 * Pure resolution logic and formatting live in @blockspool/core/guidelines/shared.
 * This file wraps them with filesystem I/O.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  type ProjectGuidelines,
  type GuidelinesBackend,
  resolveGuidelinesPaths,
} from '@blockspool/core/guidelines/shared';

// Re-export types and pure functions
export type { ProjectGuidelines } from '@blockspool/core/guidelines/shared';
export type { GuidelinesBackend } from '@blockspool/core/guidelines/shared';
export { formatGuidelinesForPrompt } from '@blockspool/core/guidelines/shared';

export interface GuidelinesOptions {
  backend?: GuidelinesBackend;
  customPath?: string | false | null;
}

export function loadGuidelines(
  repoRoot: string,
  opts: GuidelinesOptions = {},
): ProjectGuidelines | null {
  const { backend = 'claude', customPath } = opts;

  if (customPath === false) return null;

  if (typeof customPath === 'string') {
    return readGuidelinesFile(repoRoot, customPath);
  }

  const [primaryPaths, fallbackPaths] = resolveGuidelinesPaths(backend);
  return searchPaths(repoRoot, primaryPaths) ?? searchPaths(repoRoot, fallbackPaths);
}

function readGuidelinesFile(repoRoot: string, rel: string): ProjectGuidelines | null {
  const full = path.join(repoRoot, rel);
  if (!fs.existsSync(full)) return null;
  try {
    const content = fs.readFileSync(full, 'utf-8');
    return { content, source: rel, loadedAt: Date.now() };
  } catch (err) {
    if (err instanceof Error && !('code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT')) {
      console.warn(`[blockspool] failed to read guidelines file ${rel}: ${err.message}`);
    }
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
