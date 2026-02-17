/**
 * File scanner - Discovers and reads files for analysis
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * File info with content
 */
export interface ScannedFile {
  path: string;
  content: string;
  size: number;
}

/**
 * Options for file scanning
 */
export interface ScanOptions {
  /** Base directory */
  cwd: string;
  /** Glob-like patterns to include */
  include: string[];
  /** Glob-like patterns to exclude */
  exclude?: string[];
  /** Maximum file size in bytes (default: 100KB) */
  maxFileSize?: number;
  /** Maximum total files (default: 500) */
  maxFiles?: number;
}

/**
 * Default exclusion patterns
 */
const DEFAULT_EXCLUDES = [
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.next',
  '.cache',
  '*.min.js',
  '*.map',
  '*.lock',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
];

/**
 * Check if a path matches a simple glob pattern
 *
 * Supports:
 * - ** for recursive matching
 * - * for single segment matching
 * - Direct path matching
 */
function matchesPattern(filePath: string, pattern: string): boolean {
  // Normalize paths
  const normalizedPath = filePath.replace(/\\/g, '/');
  const normalizedPattern = pattern.replace(/\\/g, '/');

  // Direct match
  if (normalizedPath === normalizedPattern) {
    return true;
  }

  // Check if pattern is a directory prefix (without glob)
  if (!normalizedPattern.includes('*') && normalizedPath.startsWith(normalizedPattern + '/')) {
    return true;
  }

  // Simple glob matching
  if (normalizedPattern.includes('*')) {
    // Escape regex special chars except *
    const escaped = normalizedPattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&');

    // Convert glob patterns to regex
    // Note: **/ should be optional to match files directly in the directory
    // e.g., src/services/**/*.ts should match both src/services/auditor.ts
    // and src/services/sub/file.ts
    const regexPattern = escaped
      .replace(/\*\*\//g, '<<<DOUBLESTARSLASH>>>')
      .replace(/\*\*/g, '<<<DOUBLESTAR>>>')
      .replace(/\*/g, '[^/]*')
      .replace(/<<<DOUBLESTARSLASH>>>/g, '(.*\\/)?')
      .replace(/<<<DOUBLESTAR>>>/g, '.*');

    const regex = new RegExp(`^${regexPattern}$`);
    return regex.test(normalizedPath);
  }

  return false;
}

/**
 * Check if a path should be excluded
 */
function shouldExclude(filePath: string, excludePatterns: string[]): boolean {
  const allExcludes = [...DEFAULT_EXCLUDES, ...excludePatterns];

  for (const pattern of allExcludes) {
    if (matchesPattern(filePath, pattern)) {
      return true;
    }
    // Also check if any path segment matches (for things like node_modules)
    const segments = filePath.split('/');
    if (segments.some(seg => matchesPattern(seg, pattern))) {
      return true;
    }
  }

  return false;
}

/**
 * Check if a file matches any include pattern
 */
function shouldInclude(filePath: string, includePatterns: string[]): boolean {
  // If no patterns specified, include source-like files
  if (includePatterns.length === 0) {
    const ext = path.extname(filePath).toLowerCase();
    return ['.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.java', '.rb', '.md'].includes(ext);
  }

  return includePatterns.some(pattern => matchesPattern(filePath, pattern));
}

/**
 * Recursively scan directory for files
 */
function walkDir(
  dir: string,
  baseDir: string,
  options: ScanOptions,
  files: ScannedFile[]
): void {
  const maxFileSize = options.maxFileSize ?? 500 * 1024; // 500KB
  const maxFiles = options.maxFiles ?? 500;

  if (files.length >= maxFiles) {
    return;
  }

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // Skip unreadable directories
  }

  for (const entry of entries) {
    if (files.length >= maxFiles) {
      break;
    }

    const fullPath = path.join(dir, entry.name);
    const relativePath = path.relative(baseDir, fullPath);

    // Check exclusions first
    if (shouldExclude(relativePath, options.exclude ?? [])) {
      continue;
    }

    if (entry.isDirectory()) {
      walkDir(fullPath, baseDir, options, files);
    } else if (entry.isFile()) {
      // Check inclusion
      if (!shouldInclude(relativePath, options.include)) {
        continue;
      }

      // Check file size
      try {
        const stat = fs.statSync(fullPath);
        if (stat.size > maxFileSize) {
          continue;
        }

        // Read content
        const content = fs.readFileSync(fullPath, 'utf-8');
        files.push({
          path: relativePath,
          content,
          size: stat.size,
        });
      } catch {
        // Skip unreadable files
      }
    }
  }
}

/**
 * Scan a directory for files matching the given patterns
 */
export function scanFiles(options: ScanOptions): ScannedFile[] {
  const files: ScannedFile[] = [];
  walkDir(options.cwd, options.cwd, options, files);
  return files;
}

/**
 * Group files into batches for processing
 */
export function batchFiles(files: ScannedFile[], batchSize: number = 3): ScannedFile[][] {
  const batches: ScannedFile[][] = [];

  for (let i = 0; i < files.length; i += batchSize) {
    batches.push(files.slice(i, i + batchSize));
  }

  return batches;
}

/**
 * Estimate token count for a string (~4 chars per token)
 */
export function estimateTokens(content: string): number {
  return Math.ceil(content.length / 4);
}

/**
 * Group files into batches by token budget instead of fixed count.
 * Packs small files together; oversized files get their own batch.
 */
export function batchFilesByTokens(
  files: ScannedFile[],
  maxTokensPerBatch: number = 12000,
): ScannedFile[][] {
  const batches: ScannedFile[][] = [];
  let current: ScannedFile[] = [];
  let currentTokens = 0;

  for (const file of files) {
    const tokens = estimateTokens(file.content);
    // If single file exceeds budget, give it its own batch
    if (tokens >= maxTokensPerBatch) {
      if (current.length > 0) {
        batches.push(current);
        current = [];
        currentTokens = 0;
      }
      batches.push([file]);
      continue;
    }
    if (currentTokens + tokens > maxTokensPerBatch && current.length > 0) {
      batches.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push(file);
    currentTokens += tokens;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/**
 * Module group definition for dependency-aware batching.
 */
export interface ModuleGroup {
  /** Module directory path (e.g., "src/services") */
  path: string;
  /** Paths of modules this one imports from */
  dependencies?: string[];
}

/**
 * Group files into batches by module boundaries, keeping related files together.
 *
 * Files are first assigned to their module (by longest matching directory prefix).
 * Modules + their dependencies are packed into the same batch when they fit the token budget.
 * Orphan files (not matching any module) are batched together at the end.
 */
export function batchFilesByModule(
  files: ScannedFile[],
  modules: ModuleGroup[],
  maxTokensPerBatch: number = 12000,
): ScannedFile[][] {
  if (modules.length === 0) {
    return batchFilesByTokens(files, maxTokensPerBatch);
  }

  // Sort modules by path length descending so longer prefixes match first
  const sortedModules = [...modules].sort((a, b) => b.path.length - a.path.length);

  // Assign each file to its module
  const moduleFiles = new Map<string, ScannedFile[]>();
  const orphans: ScannedFile[] = [];

  for (const file of files) {
    const normalized = file.path.replace(/\\/g, '/');
    let assigned = false;
    for (const mod of sortedModules) {
      const modPath = mod.path.replace(/\\/g, '/');
      if (normalized === modPath || normalized.startsWith(modPath + '/')) {
        const existing = moduleFiles.get(mod.path) || [];
        existing.push(file);
        moduleFiles.set(mod.path, existing);
        assigned = true;
        break;
      }
    }
    if (!assigned) {
      orphans.push(file);
    }
  }

  // Build adjacency: modules that should be batched together (via dependencies)
  const depMap = new Map<string, Set<string>>();
  for (const mod of modules) {
    if (!depMap.has(mod.path)) depMap.set(mod.path, new Set());
    for (const dep of mod.dependencies || []) {
      // Only link if both modules have files in this scan
      if (moduleFiles.has(dep)) {
        depMap.get(mod.path)!.add(dep);
        if (!depMap.has(dep)) depMap.set(dep, new Set());
        depMap.get(dep)!.add(mod.path);
      }
    }
  }

  // Group connected modules via union-find
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    if (!parent.has(x)) parent.set(x, x);
    if (parent.get(x) !== x) parent.set(x, find(parent.get(x)!));
    return parent.get(x)!;
  };
  const union = (a: string, b: string) => {
    parent.set(find(a), find(b));
  };

  for (const [mod, deps] of depMap) {
    for (const dep of deps) {
      union(mod, dep);
    }
  }

  // Collect module clusters
  const clusters = new Map<string, string[]>();
  for (const modPath of moduleFiles.keys()) {
    const root = find(modPath);
    const existing = clusters.get(root) || [];
    existing.push(modPath);
    clusters.set(root, existing);
  }

  // Build batches: pack each cluster into batches respecting token budget
  const batches: ScannedFile[][] = [];

  for (const clusterMods of clusters.values()) {
    // Collect all files from this cluster
    const clusterFiles: ScannedFile[] = [];
    for (const mod of clusterMods) {
      clusterFiles.push(...(moduleFiles.get(mod) || []));
    }

    // Pack within the cluster using token budget
    let current: ScannedFile[] = [];
    let currentTokens = 0;

    for (const file of clusterFiles) {
      const tokens = estimateTokens(file.content);
      if (tokens >= maxTokensPerBatch) {
        if (current.length > 0) {
          batches.push(current);
          current = [];
          currentTokens = 0;
        }
        batches.push([file]);
        continue;
      }
      if (currentTokens + tokens > maxTokensPerBatch && current.length > 0) {
        batches.push(current);
        current = [];
        currentTokens = 0;
      }
      current.push(file);
      currentTokens += tokens;
    }
    if (current.length > 0) batches.push(current);
  }

  // Batch orphans
  if (orphans.length > 0) {
    const orphanBatches = batchFilesByTokens(orphans, maxTokensPerBatch);
    batches.push(...orphanBatches);
  }

  return batches;
}
