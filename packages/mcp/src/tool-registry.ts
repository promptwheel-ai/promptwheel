/**
 * Tool Registry — queryable registry of tool specs for phase/category/trust filtering.
 *
 * Replaces hardcoded auto-approve arrays and CATEGORY_TOOL_POLICIES
 * with a single registry that loads built-in specs + custom user tools.
 *
 * Custom tools can be loaded from `.promptwheel/tools/*.json` when explicitly enabled.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  BUILTIN_TOOL_SPECS,
  filterToolSpecs,
  collectApprovePatterns,
  collectConstraintNotes,
  type ToolSpec,
  type ToolPhase,
  type TrustLevel,
} from '@promptwheel/core/tools/shared';
import type {
  CustomToolLoadReport,
  CustomToolValidationWarning,
} from './types.js';

// Re-export core types for convenience
export type { ToolSpec, ToolPhase, TrustLevel } from '@promptwheel/core/tools/shared';

export interface ToolContext {
  phase: ToolPhase;
  category: string | null;
  trustLevel?: TrustLevel;
}

export interface GetRegistryOptions {
  enableCustomTools?: boolean;
}

interface ToolRegistryOptions {
  enableCustomTools?: boolean;
}

interface CustomToolValidationResult {
  spec: ToolSpec | null;
  warnings: CustomToolValidationWarning[];
}

// ---------------------------------------------------------------------------
// Module-level cache for the registry
// ---------------------------------------------------------------------------

let cachedRegistry: ToolRegistry | null = null;
let cachedProjectPath: string | null = null;
let cachedCustomToolsEnabled: boolean | null = null;
let customToolsEnabledOverride: boolean | null = null;

const CUSTOM_TOOLS_ENABLE_ENV = 'PROMPTWHEEL_ENABLE_CUSTOM_TOOLS';
const VALID_PHASES = new Set<ToolPhase>(['SCOUT', 'PLAN', 'EXECUTE', 'QA', 'PR']);
const VALID_TRUST = new Set<TrustLevel>(['safe', 'default', 'full']);
const ALLOWED_APPROVE_PATTERN_TOOLS = new Set(['Read', 'Glob', 'Grep', 'Bash', 'Edit', 'Write', 'MultiEdit']);

function isTruthyEnv(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function resolveCustomToolsEnabled(explicit?: boolean): boolean {
  if (typeof explicit === 'boolean') return explicit;
  if (customToolsEnabledOverride !== null) return customToolsEnabledOverride;
  return isTruthyEnv(process.env[CUSTOM_TOOLS_ENABLE_ENV]);
}

function clearRegistryCache(): void {
  cachedRegistry = null;
  cachedProjectPath = null;
  cachedCustomToolsEnabled = null;
}

/**
 * Set or clear session-scoped override for custom tool loading.
 * `null` clears override and falls back to env/default behavior.
 */
export function setCustomToolsEnabledOverride(enabled: boolean | null): void {
  customToolsEnabledOverride = enabled;
  clearRegistryCache();
}

/**
 * Get a cached ToolRegistry instance for the given project path.
 * Creates a new one if the project path changed.
 */
export function getRegistry(projectPath?: string, options: GetRegistryOptions = {}): ToolRegistry {
  const effectiveProjectPath = projectPath ?? cachedProjectPath ?? null;
  const customToolsEnabled = resolveCustomToolsEnabled(options.enableCustomTools);

  if (
    cachedRegistry
    && cachedProjectPath === effectiveProjectPath
    && cachedCustomToolsEnabled === customToolsEnabled
  ) {
    return cachedRegistry;
  }

  cachedRegistry = new ToolRegistry(effectiveProjectPath ?? undefined, {
    enableCustomTools: customToolsEnabled,
  });
  cachedProjectPath = effectiveProjectPath;
  cachedCustomToolsEnabled = customToolsEnabled;
  return cachedRegistry;
}

// ---------------------------------------------------------------------------
// ToolRegistry
// ---------------------------------------------------------------------------

export class ToolRegistry {
  private specs: ToolSpec[];
  private customToolReport: CustomToolLoadReport;

  constructor(projectPath?: string, options: ToolRegistryOptions = {}) {
    this.specs = [...BUILTIN_TOOL_SPECS];
    const customToolsEnabled = resolveCustomToolsEnabled(options.enableCustomTools);
    const toolsDir = projectPath ? path.join(projectPath, '.promptwheel', 'tools') : null;
    this.customToolReport = {
      enabled: customToolsEnabled,
      directory: toolsDir,
      discovered: 0,
      loaded: 0,
      rejected: 0,
      warnings: [],
    };

    // Load custom tools from .promptwheel/tools/*.json
    if (!toolsDir || !fs.existsSync(toolsDir)) return;

    let files: string[];
    try {
      files = fs.readdirSync(toolsDir).filter(f => f.endsWith('.json')).sort();
      this.customToolReport.discovered = files.length;
    } catch (err) {
      if (!(err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT')) {
        this.addCustomToolWarning({
          code: 'custom_tools_dir_read_failed',
          message: `Failed to read custom tools directory: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
      return;
    }

    if (!customToolsEnabled) {
      if (files.length > 0) {
        this.addCustomToolWarning({
          code: 'custom_tools_disabled',
          message: `Ignored ${files.length} custom tool file(s). Enable via session config (\`enable_custom_tools\`) or ${CUSTOM_TOOLS_ENABLE_ENV}=1.`,
        });
      }
      return;
    }

    for (const file of files) {
      const fullPath = path.join(toolsDir, file);
      try {
        const raw = JSON.parse(fs.readFileSync(fullPath, 'utf-8'));
        const result = validateCustomTool(raw, file);
        if (!result.spec) {
          this.customToolReport.rejected++;
          for (const warning of result.warnings) {
            this.addCustomToolWarning(warning);
          }
          continue;
        }

        this.specs.push(result.spec);
        this.customToolReport.loaded++;
      } catch (err) {
        this.customToolReport.rejected++;
        this.addCustomToolWarning({
          code: 'custom_tool_file_load_failed',
          file,
          message: `Failed to load custom tool file: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
  }

  /** Get all tool specs matching the given context. */
  getToolsForContext(ctx: ToolContext): ToolSpec[] {
    return filterToolSpecs(this.specs, ctx.phase, ctx.category, ctx.trustLevel ?? 'default');
  }

  /** Get auto-approve patterns for the given context. */
  getAutoApprovePatterns(ctx: ToolContext): string[] {
    const filtered = this.getToolsForContext(ctx);
    return collectApprovePatterns(filtered);
  }

  /** Get constraint note for the given context (if any). */
  getConstraintNote(ctx: ToolContext): string | undefined {
    const filtered = this.getToolsForContext(ctx);
    return collectConstraintNotes(filtered);
  }

  /** Serialize tools for a subagent prompt (markdown block). */
  serializeForSubagent(ctx: ToolContext): string {
    const filtered = this.getToolsForContext(ctx);
    if (filtered.length === 0) return '';

    const lines = ['## Available Tools', ''];
    for (const spec of filtered) {
      lines.push(`- **${spec.name}**: ${spec.description}`);
      if (spec.constraint_note) {
        lines.push(`  ⚠️ ${spec.constraint_note}`);
      }
    }
    return lines.join('\n');
  }

  /** Get all specs (for testing). */
  getAllSpecs(): ToolSpec[] {
    return [...this.specs];
  }

  /** Get structured custom-tool load and validation report. */
  getCustomToolReport(): CustomToolLoadReport {
    return {
      ...this.customToolReport,
      warnings: this.customToolReport.warnings.map(w => ({ ...w })),
    };
  }

  private addCustomToolWarning(warning: CustomToolValidationWarning): void {
    this.customToolReport.warnings.push(warning);
    console.warn(`[promptwheel] custom tool warning: ${JSON.stringify(warning)}`);
  }
}

// ---------------------------------------------------------------------------
// Custom tool validation
// ---------------------------------------------------------------------------

function schemaWarning(
  file: string,
  message: string,
  tool?: string,
  pattern?: string,
): CustomToolValidationWarning {
  return {
    code: 'custom_tool_schema_invalid',
    file,
    tool,
    pattern,
    message,
  };
}

function validateApprovePattern(
  pattern: string,
  file: string,
  toolName: string,
): CustomToolValidationWarning | null {
  const match = /^([A-Za-z][A-Za-z0-9:_-]*)\((.*)\)$/.exec(pattern);
  if (!match) {
    return {
      code: 'custom_tool_approve_pattern_malformed',
      file,
      tool: toolName,
      pattern,
      message: 'Pattern must match ToolName(argument-pattern) format.',
    };
  }

  const approvedTool = match[1];
  const bodyRaw = match[2];
  const body = bodyRaw.trim();

  if (!ALLOWED_APPROVE_PATTERN_TOOLS.has(approvedTool)) {
    return {
      code: 'custom_tool_approve_pattern_malformed',
      file,
      tool: toolName,
      pattern,
      message: `Unsupported tool in approve pattern: ${approvedTool}.`,
    };
  }

  if (!body || /[\r\n]/.test(bodyRaw)) {
    return {
      code: 'custom_tool_approve_pattern_malformed',
      file,
      tool: toolName,
      pattern,
      message: 'Pattern body must be a single non-empty line.',
    };
  }

  if ((approvedTool === 'Edit' || approvedTool === 'Write') && body === '*') {
    return {
      code: 'custom_tool_approve_pattern_unsafe',
      file,
      tool: toolName,
      pattern,
      message: `Over-broad ${approvedTool}(*) approval is not allowed for custom tools.`,
    };
  }

  if (approvedTool === 'Bash') {
    if (body === '*' || body.startsWith('*')) {
      return {
        code: 'custom_tool_approve_pattern_unsafe',
        file,
        tool: toolName,
        pattern,
        message: 'Over-broad Bash wildcard approvals are not allowed.',
      };
    }

    const wildcardCount = (body.match(/\*/g) ?? []).length;
    if (wildcardCount > 1 || (wildcardCount === 1 && !body.endsWith('*'))) {
      return {
        code: 'custom_tool_approve_pattern_malformed',
        file,
        tool: toolName,
        pattern,
        message: 'Bash patterns may contain at most one trailing wildcard (*).',
      };
    }

    if (/^\S+\s+\*$/.test(body)) {
      return {
        code: 'custom_tool_approve_pattern_unsafe',
        file,
        tool: toolName,
        pattern,
        message: 'Over-broad Bash(command *) approvals are not allowed.',
      };
    }

    if (body.includes('&&') || body.includes('||') || /[;|`<>]/.test(body) || body.includes('$(')) {
      return {
        code: 'custom_tool_approve_pattern_malformed',
        file,
        tool: toolName,
        pattern,
        message: 'Bash pattern must target a single command prefix without shell chaining/operators.',
      };
    }
  }

  return null;
}

function validateCustomTool(raw: unknown, file: string): CustomToolValidationResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      spec: null,
      warnings: [schemaWarning(file, 'Custom tool file must contain a JSON object.')],
    };
  }

  const obj = raw as Record<string, unknown>;
  const warnings: CustomToolValidationWarning[] = [];

  const name = typeof obj.name === 'string' ? obj.name.trim() : '';
  if (!name) {
    warnings.push(schemaWarning(file, 'Field `name` must be a non-empty string.'));
  }

  const approveRaw = obj.approve_patterns;
  const approvePatterns: string[] = [];
  if (!Array.isArray(approveRaw) || approveRaw.length === 0) {
    warnings.push(schemaWarning(file, 'Field `approve_patterns` must be a non-empty string array.', name || undefined));
  } else {
    for (const entry of approveRaw) {
      if (typeof entry !== 'string' || !entry.trim()) {
        warnings.push(schemaWarning(file, 'approve_patterns entries must be non-empty strings.', name || undefined));
        continue;
      }
      const normalized = entry.trim();
      const approveWarning = validateApprovePattern(normalized, file, name || '<unknown>');
      if (approveWarning) {
        warnings.push(approveWarning);
        continue;
      }
      approvePatterns.push(normalized);
    }
  }

  const rawPhaseAccess = obj.phase_access;
  const phaseAccess: ToolPhase[] = [];
  if (!Array.isArray(rawPhaseAccess) || rawPhaseAccess.length === 0) {
    warnings.push(schemaWarning(file, 'Field `phase_access` must be a non-empty array of phases.', name || undefined));
  } else {
    for (const value of rawPhaseAccess) {
      if (typeof value !== 'string' || !VALID_PHASES.has(value as ToolPhase)) {
        warnings.push(schemaWarning(file, `Invalid phase in phase_access: ${String(value)}`, name || undefined));
        continue;
      }
      if (!phaseAccess.includes(value as ToolPhase)) {
        phaseAccess.push(value as ToolPhase);
      }
    }
  }

  let trustLevels: TrustLevel[] = ['safe', 'default', 'full'];
  if (obj.trust_levels !== undefined) {
    if (!Array.isArray(obj.trust_levels) || obj.trust_levels.length === 0) {
      warnings.push(schemaWarning(file, 'Field `trust_levels` must be a non-empty array when provided.', name || undefined));
      trustLevels = [];
    } else {
      trustLevels = [];
      for (const value of obj.trust_levels) {
        if (typeof value !== 'string' || !VALID_TRUST.has(value as TrustLevel)) {
          warnings.push(schemaWarning(file, `Invalid trust level: ${String(value)}`, name || undefined));
          continue;
        }
        if (!trustLevels.includes(value as TrustLevel)) {
          trustLevels.push(value as TrustLevel);
        }
      }
    }
  }

  let categoryAccess: string[] | null = null;
  if (obj.category_access !== undefined && obj.category_access !== null) {
    if (!Array.isArray(obj.category_access)) {
      warnings.push(schemaWarning(file, 'Field `category_access` must be an array of strings when provided.', name || undefined));
    } else {
      const categories: string[] = [];
      for (const value of obj.category_access) {
        if (typeof value !== 'string' || !value.trim()) {
          warnings.push(schemaWarning(file, `Invalid category_access entry: ${String(value)}`, name || undefined));
          continue;
        }
        const normalized = value.trim();
        if (!categories.includes(normalized)) categories.push(normalized);
      }
      categoryAccess = categories;
    }
  }

  if (approvePatterns.length === 0) {
    warnings.push(schemaWarning(file, 'At least one valid approve pattern is required.', name || undefined));
  }
  if (phaseAccess.length === 0) {
    warnings.push(schemaWarning(file, 'At least one valid phase is required in phase_access.', name || undefined));
  }
  if (trustLevels.length === 0) {
    warnings.push(schemaWarning(file, 'At least one valid trust level is required in trust_levels.', name || undefined));
  }

  if (warnings.length > 0) {
    return { spec: null, warnings };
  }

  return {
    spec: {
      name,
      description: typeof obj.description === 'string' ? obj.description : '',
      approve_patterns: approvePatterns,
      phase_access: phaseAccess,
      trust_levels: trustLevels,
      category_access: categoryAccess,
      constraint_note: typeof obj.constraint_note === 'string' ? obj.constraint_note : undefined,
      custom: true,
    },
    warnings: [],
  };
}
