/**
 * Tool Registry — queryable registry of tool specs for phase/category/trust filtering.
 *
 * Replaces hardcoded auto-approve arrays and CATEGORY_TOOL_POLICIES
 * with a single registry that loads built-in specs + custom user tools.
 *
 * Custom tools are loaded from `.blockspool/tools/*.json`.
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
} from '@blockspool/core/tools/shared';

// Re-export core types for convenience
export type { ToolSpec, ToolPhase, TrustLevel } from '@blockspool/core/tools/shared';

export interface ToolContext {
  phase: ToolPhase;
  category: string | null;
  trustLevel?: TrustLevel;
}

// ---------------------------------------------------------------------------
// Module-level cache for the registry
// ---------------------------------------------------------------------------

let cachedRegistry: ToolRegistry | null = null;
let cachedProjectPath: string | null = null;

/**
 * Get a cached ToolRegistry instance for the given project path.
 * Creates a new one if the project path changed.
 */
export function getRegistry(projectPath?: string): ToolRegistry {
  if (cachedRegistry && cachedProjectPath === (projectPath ?? null)) {
    return cachedRegistry;
  }
  cachedRegistry = new ToolRegistry(projectPath);
  cachedProjectPath = projectPath ?? null;
  return cachedRegistry;
}

// ---------------------------------------------------------------------------
// ToolRegistry
// ---------------------------------------------------------------------------

export class ToolRegistry {
  private specs: ToolSpec[];

  constructor(projectPath?: string) {
    this.specs = [...BUILTIN_TOOL_SPECS];

    // Load custom tools from .blockspool/tools/*.json
    if (projectPath) {
      const toolsDir = path.join(projectPath, '.blockspool', 'tools');
      if (fs.existsSync(toolsDir)) {
        try {
          const files = fs.readdirSync(toolsDir).filter(f => f.endsWith('.json'));
          for (const file of files) {
            try {
              const raw = JSON.parse(fs.readFileSync(path.join(toolsDir, file), 'utf-8'));
              const spec = validateCustomTool(raw);
              if (spec) {
                this.specs.push(spec);
              }
            } catch (err) {
              console.warn(`[blockspool] failed to load custom tool file ${file}: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
        } catch (err) {
          if (err instanceof Error && !('code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT')) {
            console.warn(`[blockspool] failed to read tools directory: ${err.message}`);
          }
        }
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
}

// ---------------------------------------------------------------------------
// Custom tool validation
// ---------------------------------------------------------------------------

function validateCustomTool(raw: unknown): ToolSpec | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;

  // Required fields
  if (typeof obj.name !== 'string' || !obj.name) return null;
  if (!Array.isArray(obj.approve_patterns)) return null;
  if (!Array.isArray(obj.phase_access)) return null;

  const validPhases = new Set(['SCOUT', 'PLAN', 'EXECUTE', 'QA', 'PR']);
  const validTrust = new Set(['safe', 'default', 'full']);

  const phaseAccess = (obj.phase_access as string[]).filter(p => validPhases.has(p)) as ToolPhase[];
  if (phaseAccess.length === 0) return null;

  const trustLevels = Array.isArray(obj.trust_levels)
    ? (obj.trust_levels as string[]).filter(t => validTrust.has(t)) as TrustLevel[]
    : ['safe', 'default', 'full'] as TrustLevel[];

  return {
    name: obj.name,
    description: typeof obj.description === 'string' ? obj.description : '',
    approve_patterns: (obj.approve_patterns as unknown[]).filter(p => typeof p === 'string') as string[],
    phase_access: phaseAccess,
    trust_levels: trustLevels,
    category_access: Array.isArray(obj.category_access) ? obj.category_access as string[] : null,
    constraint_note: typeof obj.constraint_note === 'string' ? obj.constraint_note : undefined,
    custom: true,
  };
}
