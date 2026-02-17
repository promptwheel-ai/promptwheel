/**
 * Formulas - User-defined repeatable sweep recipes
 *
 * A formula is a YAML config that defines what an auto run should
 * look for and how to fix it. Formulas live in .promptwheel/formulas/
 * and can be invoked with --formula <name>.
 *
 * Pure definitions (BUILTIN_FORMULAS, YAML parsing) live in
 * @promptwheel/core/formulas/shared. This file wraps them with
 * filesystem I/O and adds CLI-specific formula application logic.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ProposalCategory } from '@promptwheel/core/scout';
import {
  type Formula as CoreFormula,
  BUILTIN_FORMULAS as CORE_BUILTINS,
  parseSimpleYaml,
  parseStringList,
} from '@promptwheel/core/formulas/shared';

// Re-export core types and constants
export type { Formula } from '@promptwheel/core/formulas/shared';
export { BUILTIN_FORMULAS, parseSimpleYaml, parseStringList } from '@promptwheel/core/formulas/shared';

// Use core's Formula type locally
type Formula = CoreFormula;

// =============================================================================
// Formula Loader (wraps core with filesystem I/O)
// =============================================================================

/**
 * Load a formula by name.
 *
 * Search order:
 * 1. .promptwheel/formulas/<name>.yaml (or .yml)
 * 2. Built-in formulas
 */
export function loadFormula(name: string, repoPath?: string): Formula | null {
  const userFormula = loadUserFormula(name, repoPath);
  if (userFormula) return userFormula;
  return CORE_BUILTINS.find(f => f.name === name) ?? null;
}

/**
 * List all available formulas (built-in + user-defined)
 */
export function listFormulas(repoPath?: string): Formula[] {
  const userFormulas = loadAllUserFormulas(repoPath);
  const userNames = new Set(userFormulas.map(f => f.name));
  const builtins = CORE_BUILTINS.filter(f => !userNames.has(f.name));
  return [...userFormulas, ...builtins];
}

/**
 * Load a user-defined formula from .promptwheel/formulas/
 */
function loadUserFormula(name: string, repoPath?: string): Formula | null {
  const dir = getFormulasDir(repoPath);
  if (!dir) return null;

  for (const ext of ['.yaml', '.yml']) {
    const filePath = path.join(dir, `${name}${ext}`);
    if (fs.existsSync(filePath)) {
      return parseFormulaFile(filePath, name);
    }
  }

  return null;
}

/**
 * Load all user-defined formulas
 */
function loadAllUserFormulas(repoPath?: string): Formula[] {
  const dir = getFormulasDir(repoPath);
  if (!dir || !fs.existsSync(dir)) return [];

  const files = fs.readdirSync(dir).filter(f => f.endsWith('.yaml') || f.endsWith('.yml'));
  const formulas: Formula[] = [];

  for (const file of files) {
    const name = path.basename(file, path.extname(file));
    const formula = parseFormulaFile(path.join(dir, file), name);
    if (formula) formulas.push(formula);
  }

  return formulas;
}

/**
 * Get the formulas directory path
 */
function getFormulasDir(repoPath?: string): string | null {
  const base = repoPath || process.cwd();
  return path.join(base, '.promptwheel', 'formulas');
}

/**
 * Parse a YAML formula file.
 */
function parseFormulaFile(filePath: string, name: string): Formula | null {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const parsed = parseSimpleYaml(content);

    return {
      name,
      description: parsed.description || `Formula: ${name}`,
      scope: parsed.scope,
      categories: parsed.categories ? parseStringList(parsed.categories) as ProposalCategory[] : undefined,
      minConfidence: parsed.min_confidence ? parseInt(parsed.min_confidence, 10) : undefined,
      prompt: parsed.prompt,
      maxPrs: parsed.max_prs ? parseInt(parsed.max_prs, 10) : undefined,
      maxTime: parsed.max_time,
      focusAreas: parsed.focus_areas ? parseStringList(parsed.focus_areas) : undefined,
      exclude: parsed.exclude ? parseStringList(parsed.exclude) : undefined,
      useRoadmap: parsed.use_roadmap !== undefined ? parsed.use_roadmap === 'true' : undefined,
      tags: parsed.tags ? parseStringList(parsed.tags) : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Apply a formula's settings to auto options.
 * Formula values override defaults but CLI flags take precedence.
 */
export function applyFormula(
  formula: Formula,
  cliOptions: {
    scope?: string;
    types?: ProposalCategory[];
    minConfidence?: number;
    maxPrs?: number;
    maxTime?: string;
    exclude?: string[];
    noRoadmap?: boolean;
  }
): {
  scope: string;
  types?: ProposalCategory[];
  minConfidence?: number;
  maxPrs?: number;
  maxTime?: string;
  exclude?: string[];
  noRoadmap?: boolean;
  prompt?: string;
  focusAreas?: string[];
} {
  return {
    scope: cliOptions.scope || formula.scope || 'src',
    types: cliOptions.types || formula.categories as ProposalCategory[] | undefined,
    minConfidence: cliOptions.minConfidence ?? formula.minConfidence,
    maxPrs: cliOptions.maxPrs ?? formula.maxPrs,
    maxTime: cliOptions.maxTime || formula.maxTime,
    exclude: cliOptions.exclude || formula.exclude,
    noRoadmap: cliOptions.noRoadmap ?? (formula.useRoadmap === false ? true : undefined),
    prompt: formula.prompt,
    focusAreas: formula.focusAreas,
  };
}
