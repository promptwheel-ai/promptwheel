/**
 * Artifact persistence helpers
 *
 * Writes structured data as JSON files in .blockspool/artifacts/
 * Used for proposals, run outputs, and other debugging data.
 *
 * Artifact Types:
 * - proposals: Scout proposals before approval
 * - executions: Agent execution logs (stdout, stderr, prompt)
 * - diffs: Git diff snapshots
 * - runs: Complete run summaries with all steps
 * - violations: Scope violation details
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Sanitize a path segment (type or id) to prevent directory traversal.
 * Rejects any value containing path separators or traversal sequences.
 */
function sanitizePathSegment(value: string, label: string): string {
  if (
    value.includes('/') ||
    value.includes('\\') ||
    value.includes('\0') ||
    value === '.' ||
    value === '..' ||
    value.includes('..')
  ) {
    throw new Error(
      `Invalid ${label}: must not contain path separators or traversal sequences, got "${value}"`
    );
  }
  return value;
}

/**
 * Known artifact types - single source of truth
 */
export const ARTIFACT_TYPES = [
  'proposals',
  'executions',
  'diffs',
  'runs',
  'violations',
  'spindle',
] as const;

/**
 * Known artifact types for type safety
 */
export type ArtifactType = (typeof ARTIFACT_TYPES)[number];

/**
 * Run summary artifact structure
 */
export interface RunSummaryArtifact {
  runId: string;
  ticketId: string;
  ticketTitle: string;
  projectId: string;
  success: boolean;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  branchName?: string;
  prUrl?: string;
  error?: string;
  steps: Array<{
    name: string;
    status: 'success' | 'failed' | 'skipped';
    durationMs?: number;
    errorMessage?: string;
    artifactPath?: string;
  }>;
  artifacts: {
    execution?: string;
    diff?: string;
    violations?: string;
  };
}

/**
 * Scope violations artifact structure
 */
export interface ViolationsArtifact {
  runId: string;
  ticketId: string;
  changedFiles: string[];
  allowedPaths: string[];
  forbiddenPaths: string[];
  violations: Array<{
    file: string;
    violation: 'not_in_allowed' | 'in_forbidden';
    pattern?: string;
  }>;
}

/**
 * Options for writing an artifact
 */
interface WriteArtifactOptions {
  /** Base directory (usually .blockspool) */
  baseDir: string;
  /** Artifact type (creates subfolder) */
  type: string;
  /** Unique identifier (used in filename) */
  id: string;
  /** Data to serialize */
  data: unknown;
  /** Optional timestamp suffix (default: true) */
  timestamp?: boolean;
}

/**
 * Write a JSON artifact file
 *
 * Creates: {baseDir}/artifacts/{type}/{id}[-timestamp].json
 *
 * @returns The full path to the written file
 */
export function writeJsonArtifact(opts: WriteArtifactOptions): string {
  const { baseDir, type, id, data, timestamp = true } = opts;

  sanitizePathSegment(type, 'artifact type');
  sanitizePathSegment(id, 'artifact id');

  const artifactsDir = path.join(baseDir, 'artifacts', type);

  // Ensure directory exists
  if (!fs.existsSync(artifactsDir)) {
    fs.mkdirSync(artifactsDir, { recursive: true });
  }

  // Build filename
  const ts = timestamp ? `-${Date.now()}` : '';
  const filename = `${id}${ts}.json`;
  const filePath = path.join(artifactsDir, filename);

  // Write atomically (write to temp, then rename)
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filePath);

  return filePath;
}

/**
 * Read a JSON artifact file
 *
 * @returns Parsed data or null if file doesn't exist
 */
export function readJsonArtifact<T = unknown>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  const content = fs.readFileSync(filePath, 'utf-8');
  return JSON.parse(content) as T;
}

/**
 * List artifacts of a given type
 *
 * @returns Array of { path, id, timestamp } sorted by timestamp desc
 */
export function listArtifacts(
  baseDir: string,
  type: string
): Array<{ path: string; id: string; timestamp: number }> {
  sanitizePathSegment(type, 'artifact type');

  const artifactsDir = path.join(baseDir, 'artifacts', type);

  if (!fs.existsSync(artifactsDir)) {
    return [];
  }

  const files = fs.readdirSync(artifactsDir)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      // eslint-disable-next-line security/detect-unsafe-regex
      const match = f.match(/^(.+?)(?:-(\d+))?\.json$/);
      if (!match) return null;

      const filePath = path.join(artifactsDir, f);
      const stat = fs.statSync(filePath);

      return {
        path: filePath,
        id: match[1],
        timestamp: match[2] ? parseInt(match[2], 10) : stat.mtimeMs,
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  // Sort by timestamp descending (most recent first)
  return files.sort((a, b) => b.timestamp - a.timestamp);
}

/**
 * Get the most recent artifact of a given type
 */
export function getLatestArtifact<T = unknown>(
  baseDir: string,
  type: string
): { path: string; data: T } | null {
  const artifacts = listArtifacts(baseDir, type);
  if (artifacts.length === 0) return null;

  const latest = artifacts[0];
  const data = readJsonArtifact<T>(latest.path);
  if (data === null) return null;

  return { path: latest.path, data };
}

/**
 * Get all artifacts for a specific run ID
 *
 * Searches across all artifact types for files matching the run ID.
 */
export function getArtifactsForRun(
  baseDir: string,
  runId: string
): Record<ArtifactType, { path: string; data: unknown } | null> {
  const result: Record<string, { path: string; data: unknown } | null> = {};

  for (const type of ARTIFACT_TYPES) {
    const artifacts = listArtifacts(baseDir, type);
    const match = artifacts.find(a => a.id === runId || a.id.startsWith(runId));

    if (match) {
      const data = readJsonArtifact(match.path);
      result[type] = data ? { path: match.path, data } : null;
    } else {
      result[type] = null;
    }
  }

  return result as Record<ArtifactType, { path: string; data: unknown } | null>;
}

/**
 * Get artifact by run ID and type
 */
export function getArtifactByRunId<T = unknown>(
  baseDir: string,
  runId: string,
  type: ArtifactType
): { path: string; data: T } | null {
  const artifacts = listArtifacts(baseDir, type);
  const match = artifacts.find(a => a.id === runId || a.id.startsWith(runId));

  if (!match) return null;

  const data = readJsonArtifact<T>(match.path);
  return data ? { path: match.path, data } : null;
}

/**
 * Get all artifacts in the base directory, grouped by type
 */
export function getAllArtifacts(
  baseDir: string
): Record<ArtifactType, Array<{ path: string; id: string; timestamp: number }>> {
  const result: Record<string, Array<{ path: string; id: string; timestamp: number }>> = {};

  for (const type of ARTIFACT_TYPES) {
    result[type] = listArtifacts(baseDir, type);
  }

  return result as Record<ArtifactType, Array<{ path: string; id: string; timestamp: number }>>;
}
