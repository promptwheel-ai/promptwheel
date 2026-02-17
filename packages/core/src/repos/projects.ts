/**
 * Project repository - Database operations for projects
 */

import type { DatabaseAdapter } from '../db/adapter.js';
import { nanoid } from '../utils/id.js';

export interface Project {
  id: string;
  name: string;
  repoUrl: string | null;
  rootPath: string;
  createdAt: Date;
  updatedAt: Date;
}

interface ProjectRow {
  id: string;
  name: string;
  repo_url: string | null;
  root_path: string;
  created_at: string;
  updated_at: string;
}

function rowToProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    repoUrl: row.repo_url,
    rootPath: row.root_path,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

/**
 * Get project by ID
 */
export async function getById(
  db: DatabaseAdapter,
  id: string
): Promise<Project | null> {
  const result = await db.query<ProjectRow>(
    'SELECT * FROM projects WHERE id = $1',
    [id]
  );
  return result.rows[0] ? rowToProject(result.rows[0]) : null;
}

/**
 * Get project by repository root path
 */
export async function getByRepoRoot(
  db: DatabaseAdapter,
  rootPath: string
): Promise<Project | null> {
  const result = await db.query<ProjectRow>(
    'SELECT * FROM projects WHERE root_path = $1',
    [rootPath]
  );
  return result.rows[0] ? rowToProject(result.rows[0]) : null;
}

/**
 * Ensure a project exists for a repository
 * Returns existing project or creates new one
 *
 * This is idempotent - calling twice with same rootPath returns same project
 */
export async function ensureForRepo(
  db: DatabaseAdapter,
  opts: {
    name: string;
    rootPath: string;
    id?: string;
    repoUrl?: string | null;
  }
): Promise<Project> {
  // Check if already exists by rootPath
  const existing = await getByRepoRoot(db, opts.rootPath);
  if (existing) {
    return existing;
  }

  // Create new project (use ON CONFLICT to handle race conditions / worktree paths)
  const id = opts.id ?? `proj_${nanoid(6)}`;
  await db.query(
    `INSERT INTO projects (id, name, repo_url, root_path)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO NOTHING`,
    [id, opts.name, opts.repoUrl ?? null, opts.rootPath]
  );

  const created = await getById(db, id);
  if (!created) {
    throw new Error('Failed to create project');
  }
  return created;
}

/**
 * List all projects
 */
export async function list(db: DatabaseAdapter): Promise<Project[]> {
  const result = await db.query<ProjectRow>(
    'SELECT * FROM projects ORDER BY updated_at DESC'
  );
  return result.rows.map(rowToProject);
}

/**
 * Delete a project and all related data
 */
export async function remove(db: DatabaseAdapter, id: string): Promise<void> {
  await db.withTransaction(async (tx) => {
    // Delete in order respecting foreign keys
    // Use project_id directly on runs to catch scout runs with NULL ticket_id
    await tx.query('DELETE FROM run_events WHERE run_id IN (SELECT id FROM runs WHERE project_id = $1)', [id]);
    await tx.query('DELETE FROM artifacts WHERE run_id IN (SELECT id FROM runs WHERE project_id = $1)', [id]);
    await tx.query('DELETE FROM leases WHERE ticket_id IN (SELECT id FROM tickets WHERE project_id = $1)', [id]);
    await tx.query('DELETE FROM runs WHERE project_id = $1', [id]);
    await tx.query('DELETE FROM learnings WHERE project_id = $1', [id]);
    await tx.query('DELETE FROM tickets WHERE project_id = $1', [id]);
    await tx.query('DELETE FROM projects WHERE id = $1', [id]);
  });
}
