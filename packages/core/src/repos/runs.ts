/**
 * Run repository - Database operations for runs
 */

import type { DatabaseAdapter } from '../db/adapter.js';
import { nanoid } from '../utils/id.js';

export type RunStatus = 'pending' | 'running' | 'success' | 'failure' | 'aborted';
export type RunType = 'scout' | 'worker' | 'qa' | 'merge';

export interface Run {
  id: string;
  ticketId: string | null;
  projectId: string;
  type: RunType;
  status: RunStatus;
  iteration: number;
  maxIterations: number;
  startedAt: Date | null;
  completedAt: Date | null;
  error: string | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
}

interface RunRow {
  id: string;
  ticket_id: string | null;
  project_id: string;
  type: string;
  status: string;
  iteration: number;
  max_iterations: number;
  started_at: string | null;
  completed_at: string | null;
  error: string | null;
  metadata: string | null;
  created_at: string;
}

function rowToRun(row: RunRow): Run {
  return {
    id: row.id,
    ticketId: row.ticket_id,
    projectId: row.project_id,
    type: row.type as RunType,
    status: row.status as RunStatus,
    iteration: row.iteration,
    maxIterations: row.max_iterations,
    startedAt: row.started_at ? new Date(row.started_at) : null,
    completedAt: row.completed_at ? new Date(row.completed_at) : null,
    error: row.error,
    metadata: row.metadata ? JSON.parse(row.metadata) : {},
    createdAt: new Date(row.created_at),
  };
}

/**
 * Get run by ID
 */
export async function getById(
  db: DatabaseAdapter,
  id: string
): Promise<Run | null> {
  const result = await db.query<RunRow>(
    'SELECT * FROM runs WHERE id = $1',
    [id]
  );
  return result.rows[0] ? rowToRun(result.rows[0]) : null;
}

/**
 * Create a new run
 */
export async function create(
  db: DatabaseAdapter,
  opts: {
    projectId: string;
    type: RunType;
    ticketId?: string;
    maxIterations?: number;
    metadata?: Record<string, unknown>;
  }
): Promise<Run> {
  const id = `run_${nanoid(12)}`;

  await db.query(
    `INSERT INTO runs (
      id, ticket_id, project_id, type, status,
      max_iterations, metadata, started_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, datetime('now'))`,
    [
      id,
      opts.ticketId ?? null,
      opts.projectId,
      opts.type,
      'running',
      opts.maxIterations ?? 10,
      JSON.stringify(opts.metadata ?? {}),
    ]
  );

  const run = await getById(db, id);
  if (!run) {
    throw new Error('Failed to create run');
  }
  return run;
}

/**
 * Mark run as successful
 */
export async function markSuccess(
  db: DatabaseAdapter,
  id: string,
  metadata?: Record<string, unknown>
): Promise<Run | null> {
  return db.withTransaction(async (tx) => {
    const result = await tx.query<RunRow>('SELECT * FROM runs WHERE id = $1', [id]);
    if (!result.rows[0]) return null;
    const existing = rowToRun(result.rows[0]);

    const merged = { ...existing.metadata, ...metadata };

    await tx.query(
      `UPDATE runs SET
        status = 'success',
        completed_at = datetime('now'),
        metadata = $1
       WHERE id = $2`,
      [JSON.stringify(merged), id]
    );

    const updated = await tx.query<RunRow>('SELECT * FROM runs WHERE id = $1', [id]);
    return updated.rows[0] ? rowToRun(updated.rows[0]) : null;
  });
}

/**
 * Mark run as failed
 */
export async function markFailure(
  db: DatabaseAdapter,
  id: string,
  error: Error | string,
  metadata?: Record<string, unknown>
): Promise<Run | null> {
  return db.withTransaction(async (tx) => {
    const result = await tx.query<RunRow>('SELECT * FROM runs WHERE id = $1', [id]);
    if (!result.rows[0]) return null;
    const existing = rowToRun(result.rows[0]);

    const merged = { ...existing.metadata, ...metadata };
    const errorMsg = error instanceof Error ? error.message : error;

    await tx.query(
      `UPDATE runs SET
        status = 'failure',
        completed_at = datetime('now'),
        error = $1,
        metadata = $2
       WHERE id = $3`,
      [errorMsg, JSON.stringify(merged), id]
    );

    const updated = await tx.query<RunRow>('SELECT * FROM runs WHERE id = $1', [id]);
    return updated.rows[0] ? rowToRun(updated.rows[0]) : null;
  });
}

/**
 * List runs for a project
 */
export async function listByProject(
  db: DatabaseAdapter,
  projectId: string,
  opts?: {
    type?: RunType;
    status?: RunStatus | RunStatus[];
    limit?: number;
  }
): Promise<Run[]> {
  let sql = 'SELECT * FROM runs WHERE project_id = $1';
  const params: unknown[] = [projectId];
  let paramIndex = 2;

  if (opts?.type) {
    sql += ` AND type = $${paramIndex++}`;
    params.push(opts.type);
  }

  if (opts?.status) {
    const statuses = Array.isArray(opts.status) ? opts.status : [opts.status];
    const placeholders = statuses.map(() => `$${paramIndex++}`).join(', ');
    sql += ` AND status IN (${placeholders})`;
    params.push(...statuses);
  }

  sql += ' ORDER BY created_at DESC';

  if (opts?.limit !== undefined) {
    sql += ` LIMIT $${paramIndex}`;
    params.push(opts.limit);
  }

  const result = await db.query<RunRow>(sql, params);
  return result.rows.map(rowToRun);
}

/**
 * Count active runs
 */
export async function countActive(
  db: DatabaseAdapter,
  projectId?: string
): Promise<number> {
  const sql = projectId
    ? `SELECT COUNT(*) as count FROM runs WHERE status IN ('pending', 'running') AND project_id = $1`
    : `SELECT COUNT(*) as count FROM runs WHERE status IN ('pending', 'running')`;

  const result = await db.query<{ count: string }>(
    sql,
    projectId ? [projectId] : []
  );

  return parseInt(result.rows[0]?.count ?? '0', 10);
}

/**
 * Get the latest run of a specific type for a project
 */
export async function getLatestByType(
  db: DatabaseAdapter,
  projectId: string,
  type: RunType
): Promise<Run | null> {
  const result = await db.query<RunRow>(
    `SELECT * FROM runs
     WHERE project_id = $1 AND type = $2
     ORDER BY created_at DESC
     LIMIT 1`,
    [projectId, type]
  );
  return result.rows[0] ? rowToRun(result.rows[0]) : null;
}

/**
 * Get run summary for status display
 */
export interface RunSummary {
  lastScout: {
    id: string;
    status: RunStatus;
    completedAt: Date | null;
    proposalCount: number;
    ticketCount: number;
    scannedFiles: number;
    durationMs: number;
  } | null;
  lastQa: {
    id: string;
    status: RunStatus;
    completedAt: Date | null;
    stepsPassed: number;
    stepsFailed: number;
    durationMs: number;
  } | null;
  lastExecute: {
    id: string;
    ticketId: string | null;
    status: RunStatus;
    completedAt: Date | null;
    branchName: string | null;
    prUrl: string | null;
    durationMs: number;
  } | null;
  activeRuns: number;
}

export async function getSummary(
  db: DatabaseAdapter,
  projectId: string
): Promise<RunSummary> {
  const [lastScoutRun, lastQaRun, lastExecuteRun, activeCount] = await Promise.all([
    getLatestByType(db, projectId, 'scout'),
    getLatestByType(db, projectId, 'qa'),
    getLatestByType(db, projectId, 'worker'),
    countActive(db, projectId),
  ]);

  // For QA runs, get step counts from run_steps table
  let qaStepsPassed = 0;
  let qaStepsFailed = 0;
  if (lastQaRun) {
    const stepCounts = await db.query<{ passed: string; failed: string }>(
      `SELECT
        SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS passed,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
       FROM run_steps
       WHERE run_id = $1`,
      [lastQaRun.id]
    );
    qaStepsPassed = parseInt(stepCounts.rows[0]?.passed ?? '0', 10);
    qaStepsFailed = parseInt(stepCounts.rows[0]?.failed ?? '0', 10);
  }

  return {
    lastScout: lastScoutRun ? {
      id: lastScoutRun.id,
      status: lastScoutRun.status,
      completedAt: lastScoutRun.completedAt,
      proposalCount: (lastScoutRun.metadata.proposalCount as number) ?? 0,
      ticketCount: (lastScoutRun.metadata.ticketCount as number) ?? 0,
      scannedFiles: (lastScoutRun.metadata.scannedFiles as number) ?? 0,
      durationMs: (lastScoutRun.metadata.durationMs as number) ?? 0,
    } : null,
    lastQa: lastQaRun ? {
      id: lastQaRun.id,
      status: lastQaRun.status,
      completedAt: lastQaRun.completedAt,
      stepsPassed: qaStepsPassed,
      stepsFailed: qaStepsFailed,
      durationMs: (lastQaRun.metadata.durationMs as number) ?? 0,
    } : null,
    lastExecute: lastExecuteRun ? {
      id: lastExecuteRun.id,
      ticketId: lastExecuteRun.ticketId,
      status: lastExecuteRun.status,
      completedAt: lastExecuteRun.completedAt,
      branchName: (lastExecuteRun.metadata.branchName as string) ?? null,
      prUrl: (lastExecuteRun.metadata.prUrl as string) ?? null,
      durationMs: (lastExecuteRun.metadata.durationMs as number) ?? 0,
    } : null,
    activeRuns: activeCount,
  };
}
