/**
 * Pre-Scout Codebase Index — lightweight structural map built at session start.
 *
 * Walks directories 2 levels deep using `fs` only. No AST parsing, no heavy deps.
 * Provides module map, dependency edges, test gaps, complexity hotspots, and entrypoints.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CodebaseIndex {
  built_at: string;
  modules: ModuleEntry[];
  dependency_edges: Record<string, string[]>; // module → modules it imports from
  untested_modules: string[];
  large_files: LargeFileEntry[];              // >300 LOC
  entrypoints: string[];
  /** mtimes of files sampled for import scanning — used for change detection. Not included in prompt. */
  sampled_file_mtimes: Record<string, number>;
}

export interface ModuleEntry {
  path: string;       // "src/services"
  file_count: number;
  purpose: string;    // "api"|"services"|"tests"|"ui"|"utils"|"config"|"unknown"
}

export interface LargeFileEntry {
  path: string;
  lines: number;
}

// ---------------------------------------------------------------------------
// Source file extensions
// ---------------------------------------------------------------------------

const SOURCE_EXTENSIONS = new Set([
  '.ts', '.js', '.py', '.rs', '.go', '.rb', '.java', '.cs', '.ex', '.php', '.swift',
]);

// ---------------------------------------------------------------------------
// Purpose inference from directory name
// ---------------------------------------------------------------------------

const PURPOSE_MAP: Record<string, string> = {
  api: 'api',
  apis: 'api',
  routes: 'api',
  handlers: 'api',
  controllers: 'api',
  endpoints: 'api',
  services: 'services',
  service: 'services',
  lib: 'services',
  core: 'services',
  test: 'tests',
  tests: 'tests',
  __tests__: 'tests',
  spec: 'tests',
  specs: 'tests',
  ui: 'ui',
  components: 'ui',
  views: 'ui',
  pages: 'ui',
  screens: 'ui',
  utils: 'utils',
  util: 'utils',
  helpers: 'utils',
  shared: 'utils',
  common: 'utils',
  config: 'config',
  configs: 'config',
  configuration: 'config',
  settings: 'config',
};

function inferPurpose(dirName: string): string {
  const lower = dirName.toLowerCase();
  return PURPOSE_MAP[lower] ?? 'unknown';
}

// ---------------------------------------------------------------------------
// Import regex patterns
// ---------------------------------------------------------------------------

// JS/TS: import ... from '...' or require('...')
const JS_IMPORT_RE = /(?:import\s+.*?\s+from\s+['"]([^'"]+)['"]|require\s*\(\s*['"]([^'"]+)['"]\s*\))/g;
// Python: from X import ... or import X
const PY_IMPORT_RE = /(?:from\s+([\w.]+)\s+import|^import\s+([\w.]+))/gm;
// Go: import "..."
const GO_IMPORT_RE = /import\s+"([^"]+)"/g;

function extractImports(content: string, filePath: string): string[] {
  const ext = path.extname(filePath);
  const imports: string[] = [];

  if (ext === '.ts' || ext === '.js') {
    for (const m of content.matchAll(JS_IMPORT_RE)) {
      const spec = m[1] ?? m[2];
      if (spec) imports.push(spec);
    }
  } else if (ext === '.py') {
    for (const m of content.matchAll(PY_IMPORT_RE)) {
      const spec = m[1] ?? m[2];
      if (spec) imports.push(spec);
    }
  } else if (ext === '.go') {
    for (const m of content.matchAll(GO_IMPORT_RE)) {
      if (m[1]) imports.push(m[1]);
    }
  }

  return imports;
}

/**
 * Resolve a relative import specifier to a module path relative to projectRoot.
 * Returns null for non-relative (package) imports.
 */
function resolveImportToModule(
  specifier: string,
  sourceFile: string,
  projectRoot: string,
  modulePaths: string[],
): string | null {
  // Only resolve relative imports
  if (!specifier.startsWith('.')) return null;

  const sourceDir = path.dirname(sourceFile);
  const resolved = path.resolve(sourceDir, specifier);
  const relative = path.relative(projectRoot, resolved);

  // Find which module this resolved path falls under
  for (const mod of modulePaths) {
    if (relative === mod || relative.startsWith(mod + '/') || relative.startsWith(mod + path.sep)) {
      return mod;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// buildCodebaseIndex
// ---------------------------------------------------------------------------

export function buildCodebaseIndex(
  projectRoot: string,
  excludeDirs: string[] = [],
): CodebaseIndex {
  const excludeSet = new Set(excludeDirs.map(d => d.toLowerCase()));

  // Step 1: Module map — walk dirs 2 levels deep
  const modules: ModuleEntry[] = [];
  const sourceFilesByModule = new Map<string, string[]>();

  function shouldExclude(name: string): boolean {
    return excludeSet.has(name.toLowerCase()) || name.startsWith('.');
  }

  function walkForModules(dir: string, depth: number): void {
    if (modules.length >= 50) return;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    const sourceFiles: string[] = [];
    const subdirs: fs.Dirent[] = [];

    for (const entry of entries) {
      if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
        sourceFiles.push(path.join(dir, entry.name));
      } else if (entry.isDirectory() && !shouldExclude(entry.name)) {
        subdirs.push(entry);
      }
    }

    // Register this dir as a module if it has source files
    if (sourceFiles.length > 0 && depth > 0) {
      const relPath = path.relative(projectRoot, dir);
      if (relPath && modules.length < 50) {
        modules.push({
          path: relPath,
          file_count: sourceFiles.length,
          purpose: inferPurpose(path.basename(dir)),
        });
        sourceFilesByModule.set(relPath, sourceFiles);
      }
    }

    // Recurse into subdirs (up to depth 2)
    if (depth < 2) {
      for (const sub of subdirs) {
        if (modules.length >= 50) break;
        walkForModules(path.join(dir, sub.name), depth + 1);
      }
    }
  }

  walkForModules(projectRoot, 0);

  // Also count source files at root level for modules registered at depth > 0
  // (root files don't form a module — they become entrypoints)

  const modulePaths = modules.map(m => m.path);

  // Step 2: Import scanning — build dependency_edges + record file mtimes
  const dependencyEdges: Record<string, string[]> = {};
  const sampledFileMtimes: Record<string, number> = {};

  for (const mod of modules) {
    const files = sourceFilesByModule.get(mod.path) ?? [];
    const deps = new Set<string>();

    // Read first 50 lines of up to 5 files
    const filesToScan = files.slice(0, 5);
    for (const filePath of filesToScan) {
      try {
        // Record mtime for change detection
        const relFile = path.relative(projectRoot, filePath);
        sampledFileMtimes[relFile] = fs.statSync(filePath).mtimeMs;

        const fd = fs.openSync(filePath, 'r');
        const buf = Buffer.alloc(4096); // ~50 lines worth
        const bytesRead = fs.readSync(fd, buf, 0, 4096, 0);
        fs.closeSync(fd);
        const content = buf.toString('utf8', 0, bytesRead);
        // Trim to ~50 lines
        const lines = content.split('\n').slice(0, 50).join('\n');

        const imports = extractImports(lines, filePath);
        for (const spec of imports) {
          const resolved = resolveImportToModule(spec, filePath, projectRoot, modulePaths);
          if (resolved && resolved !== mod.path) {
            deps.add(resolved);
          }
        }
      } catch {
        // skip unreadable files
      }
    }

    if (deps.size > 0) {
      dependencyEdges[mod.path] = [...deps];
    }
  }

  // Step 3: Test coverage — find untested modules
  const untestedModules: string[] = [];

  for (const mod of modules) {
    if (mod.purpose === 'tests') continue;

    const modAbsPath = path.join(projectRoot, mod.path);
    const modParent = path.dirname(modAbsPath);
    const modName = path.basename(modAbsPath);

    let hasTesting = false;

    // Check for __tests__/ sibling
    if (existsDir(path.join(modAbsPath, '__tests__'))) {
      hasTesting = true;
    }

    // Check for parallel test/ or tests/ dir at same level
    if (!hasTesting && (existsDir(path.join(modParent, 'test')) || existsDir(path.join(modParent, 'tests')))) {
      hasTesting = true;
    }

    // Check for *.test.* or *.spec.* files within the module
    if (!hasTesting) {
      const files = sourceFilesByModule.get(mod.path) ?? [];
      hasTesting = files.some(f => {
        const base = path.basename(f);
        return base.includes('.test.') || base.includes('.spec.');
      });
    }

    if (!hasTesting) {
      untestedModules.push(mod.path);
    }
  }

  // Step 4: Large files — stat.size / 40 heuristic for LOC
  const largeFiles: LargeFileEntry[] = [];

  for (const mod of modules) {
    const files = sourceFilesByModule.get(mod.path) ?? [];
    for (const filePath of files) {
      if (largeFiles.length >= 20) break;
      try {
        const stat = fs.statSync(filePath);
        const estimatedLines = Math.round(stat.size / 40);
        if (estimatedLines > 300) {
          largeFiles.push({
            path: path.relative(projectRoot, filePath),
            lines: estimatedLines,
          });
        }
      } catch {
        // skip
      }
    }
    if (largeFiles.length >= 20) break;
  }

  // Step 5: Entrypoints
  const entrypoints: string[] = [];
  const entrypointNames = [
    'index.ts', 'index.js', 'main.ts', 'main.js',
    'app.ts', 'app.js', 'server.ts', 'server.js',
    'main.py', 'app.py', 'main.go', 'main.rs',
    'index.php', 'main.swift', 'main.rb', 'main.ex',
  ];

  const searchDirs = [projectRoot, path.join(projectRoot, 'src')];
  for (const dir of searchDirs) {
    for (const name of entrypointNames) {
      if (entrypoints.length >= 10) break;
      const full = path.join(dir, name);
      try {
        if (fs.statSync(full).isFile()) {
          entrypoints.push(path.relative(projectRoot, full));
        }
      } catch {
        // doesn't exist
      }
    }
  }

  return {
    built_at: new Date().toISOString(),
    modules,
    dependency_edges: dependencyEdges,
    untested_modules: untestedModules,
    large_files: largeFiles,
    entrypoints,
    sampled_file_mtimes: sampledFileMtimes,
  };
}

// ---------------------------------------------------------------------------
// refreshCodebaseIndex — incremental reindex, only re-scans changed modules
// ---------------------------------------------------------------------------

/**
 * Incrementally refresh the codebase index. Re-walks the directory tree (cheap)
 * but only re-scans imports for modules whose file count changed or that are new.
 * Unchanged modules keep their existing dependency edges.
 */
export function refreshCodebaseIndex(
  existing: CodebaseIndex,
  projectRoot: string,
  excludeDirs: string[] = [],
): CodebaseIndex {
  const fresh = buildCodebaseIndex(projectRoot, excludeDirs);

  // Build lookup of old modules by path
  const oldByPath = new Map(existing.modules.map(m => [m.path, m]));

  // For unchanged modules (same path + same file_count), keep old dependency edges
  // to avoid re-reading file contents. New/changed modules get fresh edges.
  const mergedEdges: Record<string, string[]> = {};

  for (const mod of fresh.modules) {
    const old = oldByPath.get(mod.path);
    if (old && old.file_count === mod.file_count) {
      // Module unchanged — reuse existing edges
      const oldEdges = existing.dependency_edges[mod.path];
      if (oldEdges) {
        mergedEdges[mod.path] = oldEdges;
      }
    } else {
      // New or changed module — use freshly scanned edges
      const freshEdges = fresh.dependency_edges[mod.path];
      if (freshEdges) {
        mergedEdges[mod.path] = freshEdges;
      }
    }
  }

  fresh.dependency_edges = mergedEdges;
  return fresh;
}

// ---------------------------------------------------------------------------
// hasStructuralChanges — cheap mtime check to detect external modifications
// ---------------------------------------------------------------------------

/**
 * Check if the codebase structure has changed since the last index build.
 *
 * Two-layer detection:
 * 1. Directory mtimes — catches file additions/deletions, new dirs, git pulls, branch switches.
 * 2. Sampled file mtimes — catches content edits to files we scanned for imports (dependency edges).
 *
 * Cost: ≤60 dir statSync + ≤250 file statSync. Zero file reads, zero tokens.
 */
export function hasStructuralChanges(
  index: CodebaseIndex,
  projectRoot: string,
): boolean {
  const builtAt = new Date(index.built_at).getTime();

  // Layer 1: Check directory mtimes (structural changes — add/delete/rename)
  const dirsToCheck = new Set<string>();

  for (const mod of index.modules) {
    const absPath = path.join(projectRoot, mod.path);
    dirsToCheck.add(absPath);
    // Also check parent dir (catches new sibling modules)
    dirsToCheck.add(path.dirname(absPath));
  }

  // Always check root and src/ for new top-level dirs
  dirsToCheck.add(projectRoot);
  dirsToCheck.add(path.join(projectRoot, 'src'));

  for (const dir of dirsToCheck) {
    try {
      if (fs.statSync(dir).mtimeMs > builtAt) {
        return true;
      }
    } catch {
      // Dir was removed — structural change if it was a known module
      const rel = path.relative(projectRoot, dir);
      if (index.modules.some(m => m.path === rel)) {
        return true;
      }
    }
  }

  // Layer 2: Check sampled file mtimes (content edits that may change imports)
  for (const [relFile, oldMtime] of Object.entries(index.sampled_file_mtimes)) {
    try {
      const currentMtime = fs.statSync(path.join(projectRoot, relFile)).mtimeMs;
      if (currentMtime !== oldMtime) {
        return true;
      }
    } catch {
      // File was deleted — structural change
      return true;
    }
  }

  return false;
}

function existsDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// formatIndexForPrompt — chunked rendering
// ---------------------------------------------------------------------------

const CHUNK_SIZE = 15;

export function formatIndexForPrompt(index: CodebaseIndex, scoutCycle: number): string {
  const { modules, dependency_edges, untested_modules, large_files, entrypoints } = index;

  if (modules.length === 0) {
    return '## Codebase Structure\n\nNo modules detected.';
  }

  const totalChunks = Math.max(1, Math.ceil(modules.length / CHUNK_SIZE));
  const chunkIndex = scoutCycle % totalChunks;
  const offset = chunkIndex * CHUNK_SIZE;
  const focusModules = modules.slice(offset, offset + CHUNK_SIZE);
  const otherModules = modules.filter((_, i) => i < offset || i >= offset + CHUNK_SIZE);

  const parts: string[] = [];

  parts.push(`## Codebase Structure (chunk ${chunkIndex + 1}/${totalChunks})`);
  parts.push('');
  parts.push('### Modules in Focus This Cycle');

  for (const mod of focusModules) {
    const deps = dependency_edges[mod.path];
    const depStr = deps ? ` → imports: ${deps.join(', ')}` : '';
    parts.push(`${mod.path}/ — ${mod.file_count} files (${mod.purpose})${depStr}`);
  }

  if (otherModules.length > 0) {
    parts.push('');
    parts.push('### Other Modules (not in focus — available for future cycles)');
    parts.push(otherModules.map(m => m.path + '/').join(', '));
  }

  if (untested_modules.length > 0) {
    parts.push('');
    parts.push('### Untested Modules (context only — do NOT prioritize writing tests for these)');
    parts.push(untested_modules.map(m => m + '/').join(', '));
  }

  if (large_files.length > 0) {
    parts.push('');
    parts.push('### Complexity Hotspots (>300 LOC)');
    parts.push(large_files.map(f => `${f.path} (${f.lines})`).join(', '));
  }

  if (entrypoints.length > 0) {
    parts.push('');
    parts.push('### Entrypoints');
    parts.push(entrypoints.join(', '));
  }

  return parts.join('\n');
}
