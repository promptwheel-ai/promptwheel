/**
 * Project Metadata — framework-agnostic detection of tooling, test runners,
 * package managers, and languages.
 *
 * Scans config files at the project root to build a structured summary
 * that gets injected into scout prompts so the LLM knows which CLI
 * flags and conventions to use.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { ProjectMetadata, DetectorContext, LanguageDetector } from './types.js';
import { detectNode } from './node.js';
import { detectPython } from './python.js';
import { detectRust } from './rust.js';
import { detectGo } from './go.js';
import { detectRuby } from './ruby.js';
import { detectElixir } from './elixir.js';
import { detectJava } from './java.js';
import { detectCsharp } from './csharp.js';
import { detectPhp } from './php.js';
import { detectSwift } from './swift.js';

export type { ProjectMetadata, TestRunnerInfo } from './types.js';

/** Ordered list of language detectors */
const detectors: LanguageDetector[] = [
  detectNode,
  detectPython,
  detectRust,
  detectGo,
  detectRuby,
  detectElixir,
  detectJava,
  detectCsharp,
  detectPhp,
  detectSwift,
];

/** Simple glob check for a single pattern at root level */
function existsGlob(dir: string, pattern: string): boolean {
  try {
    const ext = pattern.replace('*', '');
    const entries = fs.readdirSync(dir);
    return entries.some(e => e.endsWith(ext));
  } catch {
    return false;
  }
}

export function detectProjectMetadata(projectRoot: string): ProjectMetadata {
  const meta: ProjectMetadata = {
    languages: [],
    package_manager: null,
    test_runner: null,
    framework: null,
    linter: null,
    type_checker: null,
    monorepo_tool: null,
    signals: [],
  };

  const ctx: DetectorContext = {
    projectRoot,
    exists: (f: string) => fs.existsSync(path.join(projectRoot, f)),
    readJson: (f: string) => {
      try { return JSON.parse(fs.readFileSync(path.join(projectRoot, f), 'utf8')); }
      catch { return null; }
    },
    readText: (f: string) => {
      try { return fs.readFileSync(path.join(projectRoot, f), 'utf8'); }
      catch { return null; }
    },
    existsGlob: (pattern: string) => existsGlob(projectRoot, pattern),
  };

  for (const detect of detectors) {
    detect(ctx, meta);
  }

  return meta;
}

export function formatMetadataForPrompt(meta: ProjectMetadata): string {
  const lines: string[] = ['## Project Tooling'];

  if (meta.languages.length > 0) {
    lines.push(`**Language(s):** ${meta.languages.join(', ')}`);
  }
  if (meta.framework) {
    lines.push(`**Framework:** ${meta.framework}`);
  }
  if (meta.package_manager) {
    lines.push(`**Package manager:** ${meta.package_manager}`);
  }
  if (meta.test_runner) {
    lines.push(`**Test runner:** ${meta.test_runner.name}`);
    lines.push(`**Run tests:** \`${meta.test_runner.run_command}\``);
    lines.push(`**Filter tests:** \`${meta.test_runner.filter_syntax}\``);
    lines.push('');
    lines.push(`**IMPORTANT:** Use ${meta.test_runner.name} CLI syntax for all \`verification_commands\`. Do NOT guess — use the exact syntax above.`);
  }
  if (meta.linter) {
    lines.push(`**Linter:** ${meta.linter}`);
  }
  if (meta.type_checker) {
    lines.push(`**Type checker:** ${meta.type_checker}`);
  }
  if (meta.monorepo_tool) {
    lines.push(`**Monorepo:** ${meta.monorepo_tool}`);
  }

  return lines.join('\n');
}
