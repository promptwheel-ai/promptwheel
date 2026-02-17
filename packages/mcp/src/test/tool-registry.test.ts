/**
 * Tool Registry tests — verifies built-in specs, filtering, category overrides,
 * trust levels, custom tool loading, and category deconfliction.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  BUILTIN_TOOL_SPECS,
  filterToolSpecs,
  collectApprovePatterns,
  collectConstraintNotes,
  type ToolPhase,
} from '@promptwheel/core/tools/shared';
import { ToolRegistry, getRegistry } from '../tool-registry.js';

// ---------------------------------------------------------------------------
// filterToolSpecs — core algorithm
// ---------------------------------------------------------------------------

describe('filterToolSpecs', () => {
  it('returns read-only tools for SCOUT phase', () => {
    const specs = filterToolSpecs(BUILTIN_TOOL_SPECS, 'SCOUT', null);
    const names = specs.map(s => s.name);
    expect(names).toContain('Read');
    expect(names).toContain('Glob');
    expect(names).toContain('Grep');
    expect(names).toContain('Bash:scout');
    expect(names).not.toContain('Edit');
    expect(names).not.toContain('Write');
  });

  it('returns Edit/Write for EXECUTE phase with default trust', () => {
    const specs = filterToolSpecs(BUILTIN_TOOL_SPECS, 'EXECUTE', null, 'default');
    const names = specs.map(s => s.name);
    expect(names).toContain('Edit');
    expect(names).toContain('Write');
    expect(names).toContain('Bash:test');
    expect(names).toContain('Bash:git-status');
  });

  it('excludes Edit/Write for EXECUTE phase with safe trust', () => {
    const specs = filterToolSpecs(BUILTIN_TOOL_SPECS, 'EXECUTE', null, 'safe');
    const names = specs.map(s => s.name);
    expect(names).not.toContain('Edit');
    expect(names).not.toContain('Write');
    // But read-only and test tools should still be present
    expect(names).toContain('Read');
    expect(names).toContain('Bash:test');
  });

  it('returns git/gh tools for PR phase', () => {
    const specs = filterToolSpecs(BUILTIN_TOOL_SPECS, 'PR', null, 'default');
    const names = specs.map(s => s.name);
    expect(names).toContain('Bash:git-ops');
    expect(names).toContain('Bash:gh');
    expect(names).toContain('Read');
    expect(names).not.toContain('Edit');
  });

  it('returns QA tools for QA phase', () => {
    const specs = filterToolSpecs(BUILTIN_TOOL_SPECS, 'QA', null, 'default');
    const names = specs.map(s => s.name);
    expect(names).toContain('Bash:test');
    expect(names).toContain('Bash:git-status');
    expect(names).toContain('Read');
    expect(names).not.toContain('Edit');
  });
});

// ---------------------------------------------------------------------------
// Category overrides — docs, test, security
// ---------------------------------------------------------------------------

describe('category overrides', () => {
  it('uses Edit:docs instead of generic Edit for docs category', () => {
    const specs = filterToolSpecs(BUILTIN_TOOL_SPECS, 'EXECUTE', 'docs', 'default');
    const names = specs.map(s => s.name);
    expect(names).toContain('Edit:docs');
    expect(names).toContain('Write:docs');
    expect(names).not.toContain('Edit');
    expect(names).not.toContain('Write');
  });

  it('uses Edit:test instead of generic Edit for test category', () => {
    const specs = filterToolSpecs(BUILTIN_TOOL_SPECS, 'EXECUTE', 'test', 'default');
    const names = specs.map(s => s.name);
    expect(names).toContain('Edit:test');
    expect(names).toContain('Write:test');
    expect(names).not.toContain('Edit');
    expect(names).not.toContain('Write');
  });

  it('includes security constraint for security category', () => {
    const specs = filterToolSpecs(BUILTIN_TOOL_SPECS, 'EXECUTE', 'security', 'default');
    const names = specs.map(s => s.name);
    expect(names).toContain('constraint:security');
    // Security still gets generic Edit/Write (no security-specific Edit override)
    expect(names).toContain('Edit');
    expect(names).toContain('Write');
  });

  it('returns constraint note for security category', () => {
    const specs = filterToolSpecs(BUILTIN_TOOL_SPECS, 'EXECUTE', 'security', 'default');
    const note = collectConstraintNotes(specs);
    expect(note).toBeDefined();
    expect(note).toContain('security');
    expect(note).toContain('npm install');
  });

  it('returns no constraint note for refactor category', () => {
    const specs = filterToolSpecs(BUILTIN_TOOL_SPECS, 'EXECUTE', 'refactor', 'default');
    const note = collectConstraintNotes(specs);
    expect(note).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// collectApprovePatterns
// ---------------------------------------------------------------------------

describe('collectApprovePatterns', () => {
  it('collects patterns for SCOUT phase', () => {
    const specs = filterToolSpecs(BUILTIN_TOOL_SPECS, 'SCOUT', null);
    const patterns = collectApprovePatterns(specs);
    expect(patterns).toContain('Read(*)');
    expect(patterns).toContain('Glob(*)');
    expect(patterns).toContain('Grep(*)');
    expect(patterns).toContain('Bash(ls *)');
  });

  it('collects docs-specific patterns for EXECUTE docs', () => {
    const specs = filterToolSpecs(BUILTIN_TOOL_SPECS, 'EXECUTE', 'docs', 'default');
    const patterns = collectApprovePatterns(specs);
    expect(patterns).toContain('Edit(*.md)');
    expect(patterns).toContain('Write(*.md)');
    expect(patterns).not.toContain('Edit(*)');
    expect(patterns).not.toContain('Write(*)');
  });

  it('deduplicates patterns', () => {
    const specs = filterToolSpecs(BUILTIN_TOOL_SPECS, 'EXECUTE', null, 'default');
    const patterns = collectApprovePatterns(specs);
    const unique = new Set(patterns);
    expect(patterns.length).toBe(unique.size);
  });
});

// ---------------------------------------------------------------------------
// ToolRegistry — class with caching and custom tools
// ---------------------------------------------------------------------------

describe('ToolRegistry', () => {
  it('loads built-in specs without project path', () => {
    const registry = new ToolRegistry();
    const all = registry.getAllSpecs();
    expect(all.length).toBe(BUILTIN_TOOL_SPECS.length);
  });

  it('getAutoApprovePatterns returns patterns for given context', () => {
    const registry = new ToolRegistry();
    const patterns = registry.getAutoApprovePatterns({ phase: 'SCOUT', category: null });
    expect(patterns).toContain('Read(*)');
    expect(patterns).toContain('Glob(*)');
  });

  it('getConstraintNote returns note for security', () => {
    const registry = new ToolRegistry();
    const note = registry.getConstraintNote({ phase: 'EXECUTE', category: 'security' });
    expect(note).toContain('security');
  });

  it('getConstraintNote returns undefined for refactor', () => {
    const registry = new ToolRegistry();
    const note = registry.getConstraintNote({ phase: 'EXECUTE', category: 'refactor' });
    expect(note).toBeUndefined();
  });

  it('serializeForSubagent returns markdown for EXECUTE', () => {
    const registry = new ToolRegistry();
    const md = registry.serializeForSubagent({ phase: 'EXECUTE', category: null });
    expect(md).toContain('## Available Tools');
    expect(md).toContain('Edit');
  });

  it('serializeForSubagent returns empty for unknown phase combo with no matches', () => {
    const registry = new ToolRegistry();
    // PR phase with safe trust won't match git-ops or gh (they require default+)
    const md = registry.serializeForSubagent({ phase: 'PR', category: null, trustLevel: 'safe' });
    // Should still have Read/Glob/Grep
    expect(md).toContain('Read');
  });
});

// ---------------------------------------------------------------------------
// Custom tool loading
// ---------------------------------------------------------------------------

describe('ToolRegistry with custom tools', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-tool-registry-'));
    const toolsDir = path.join(tmpDir, '.promptwheel', 'tools');
    fs.mkdirSync(toolsDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loads valid custom tool from .promptwheel/tools/', () => {
    const customTool = {
      name: 'Bash:lint',
      description: 'Run project linter',
      approve_patterns: ['Bash(npm run lint*)'],
      phase_access: ['EXECUTE', 'QA'],
      trust_levels: ['safe', 'default', 'full'],
    };
    fs.writeFileSync(
      path.join(tmpDir, '.promptwheel', 'tools', 'lint.json'),
      JSON.stringify(customTool),
    );

    const registry = new ToolRegistry(tmpDir);
    const all = registry.getAllSpecs();
    expect(all.length).toBe(BUILTIN_TOOL_SPECS.length + 1);
    const lint = all.find(s => s.name === 'Bash:lint');
    expect(lint).toBeDefined();
    expect(lint!.custom).toBe(true);
    expect(lint!.approve_patterns).toContain('Bash(npm run lint*)');
  });

  it('skips invalid custom tool files', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.promptwheel', 'tools', 'bad.json'),
      'not valid json',
    );
    fs.writeFileSync(
      path.join(tmpDir, '.promptwheel', 'tools', 'empty.json'),
      JSON.stringify({}),
    );

    const registry = new ToolRegistry(tmpDir);
    const all = registry.getAllSpecs();
    // Should still have all built-ins, no extra
    expect(all.length).toBe(BUILTIN_TOOL_SPECS.length);
  });

  it('skips non-json files in tools directory', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.promptwheel', 'tools', 'readme.txt'),
      'not a tool',
    );

    const registry = new ToolRegistry(tmpDir);
    expect(registry.getAllSpecs().length).toBe(BUILTIN_TOOL_SPECS.length);
  });

  it('custom tool appears in filtered results', () => {
    const customTool = {
      name: 'Bash:lint',
      description: 'Run linter',
      approve_patterns: ['Bash(npm run lint*)'],
      phase_access: ['EXECUTE'],
    };
    fs.writeFileSync(
      path.join(tmpDir, '.promptwheel', 'tools', 'lint.json'),
      JSON.stringify(customTool),
    );

    const registry = new ToolRegistry(tmpDir);
    const patterns = registry.getAutoApprovePatterns({ phase: 'EXECUTE', category: null });
    expect(patterns).toContain('Bash(npm run lint*)');
  });
});

// ---------------------------------------------------------------------------
// getRegistry — module-level cache
// ---------------------------------------------------------------------------

describe('getRegistry', () => {
  it('returns same instance for same project path', () => {
    const r1 = getRegistry('/tmp/test-project');
    const r2 = getRegistry('/tmp/test-project');
    expect(r1).toBe(r2);
  });

  it('returns new instance when project path changes', () => {
    const r1 = getRegistry('/tmp/project-a');
    const r2 = getRegistry('/tmp/project-b');
    expect(r1).not.toBe(r2);
  });
});
