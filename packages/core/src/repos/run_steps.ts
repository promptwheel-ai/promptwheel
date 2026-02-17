/**
 * Run Steps repository - Database operations for run steps
 *
 * Steps are individual commands/actions within a run (e.g., QA commands).
 * Supports retry attempts with full history preserved.
 */

import type { DatabaseAdapter } from '../db/adapter.js';
import { nanoid } from '../utils/id.js';

export type StepStatus = 'queued' | 'running' | 'success' | 'failed' | 'skipped' | 'canceled';
export type StepKind = 'command' | 'llm_fix' | 'git' | 'internal';

export interface RunStep {
  id: string;
  runId: string;
  attempt: number;
  ordinal: number;
  name: string;
  kind: StepKind;
  status: StepStatus;
  cmd: string | null;
  cwd: string | null;
  timeoutMs: number | null;
  exitCode: number | null;
  signal: string | null;
  startedAtMs: number | null;
  endedAtMs: number | null;
  durationMs: number | null;
  stdoutPath: string | null;
  stderrPath: string | null;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  stdoutTail: string | null;
  stderrTail: string | null;
  errorMessage: string | null;
  metadata: Record<string, unknown>;
  createdAtMs: number;
  updatedAtMs: number;
}

interface RunStepRow {
  id: string;
  run_id: string;
  attempt: number;
  ordinal: number;
  name: string;
  kind: string;
  status: string;
  cmd: string | null;
  cwd: string | null;
  timeout_ms: number | null;
  exit_code: number | null;
  signal: string | null;
  started_at_ms: number | null;
  ended_at_ms: number | null;
  duration_ms: number | null;
  stdout_path: string | null;
  stderr_path: string | null;
  stdout_bytes: number;
  stderr_bytes: number;
  stdout_truncated: number;
  stderr_truncated: number;
  stdout_tail: string | null;
  stderr_tail: string | null;
  error_message: string | null;
  meta_json: string | null;
  created_at_ms: number;
  updated_at_ms: number;
}

function rowToStep(row: RunStepRow): RunStep {
  return {
    id: row.id,
    runId: row.run_id,
    attempt: row.attempt,
    ordinal: row.ordinal,
    name: row.name,
    kind: row.kind as StepKind,
    status: row.status as StepStatus,
    cmd: row.cmd,
    cwd: row.cwd,
    timeoutMs: row.timeout_ms,
    exitCode: row.exit_code,
    signal: row.signal,
    startedAtMs: row.started_at_ms,
    endedAtMs: row.ended_at_ms,
    durationMs: row.duration_ms,
    stdoutPath: row.stdout_path,
    stderrPath: row.stderr_path,
    stdoutBytes: row.stdout_bytes,
    stderrBytes: row.stderr_bytes,
    stdoutTruncated: row.stdout_truncated === 1,
    stderrTruncated: row.stderr_truncated === 1,
    stdoutTail: row.stdout_tail,
    stderrTail: row.stderr_tail,
    errorMessage: row.error_message,
    metadata: row.meta_json ? JSON.parse(row.meta_json) : {},
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
  };
}

/**
 * Get step by ID
 */
export async function getById(
  db: DatabaseAdapter,
  id: string
): Promise<RunStep | null> {
  const result = await db.query<RunStepRow>(
    'SELECT * FROM run_steps WHERE id = $1',
    [id]
  );
  return result.rows[0] ? rowToStep(result.rows[0]) : null;
}

/**
 * Create a new step
 */
export async function create(
  db: DatabaseAdapter,
  opts: {
    runId: string;
    attempt?: number;
    ordinal: number;
    name: string;
    kind?: StepKind;
    cmd?: string;
    cwd?: string;
    timeoutMs?: number;
    metadata?: Record<string, unknown>;
  }
): Promise<RunStep> {
  const id = `stp_${nanoid(12)}`;
  const now = Date.now();

  await db.query(
    `INSERT INTO run_steps (
      id, run_id, attempt, ordinal, name, kind,
      cmd, cwd, timeout_ms, meta_json,
      created_at_ms, updated_at_ms
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      id,
      opts.runId,
      opts.attempt ?? 1,
      opts.ordinal,
      opts.name,
      opts.kind ?? 'command',
      opts.cmd ?? null,
      opts.cwd ?? null,
      opts.timeoutMs ?? null,
      JSON.stringify(opts.metadata ?? {}),
      now,
      now,
    ]
  );

  const step = await getById(db, id);
  if (!step) {
    throw new Error('Failed to create run step');
  }
  return step;
}

/**
 * Create multiple steps at once (for initializing a QA run)
 */
export async function createMany(
  db: DatabaseAdapter,
  runId: string,
  steps: Array<{
    name: string;
    cmd: string;
    cwd?: string;
    timeoutMs?: number;
  }>,
  attempt: number = 1
): Promise<RunStep[]> {
  return db.withTransaction(async (tx) => {
    const created: RunStep[] = [];

    for (let i = 0; i < steps.length; i++) {
      const id = `stp_${nanoid(12)}`;
      const now = Date.now();

      await tx.query(
        `INSERT INTO run_steps (
          id, run_id, attempt, ordinal, name, kind,
          cmd, cwd, timeout_ms, meta_json,
          created_at_ms, updated_at_ms
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          id, runId, attempt, i, steps[i].name, 'command',
          steps[i].cmd, steps[i].cwd ?? null, steps[i].timeoutMs ?? null,
          JSON.stringify({}), now, now,
        ]
      );

      const result = await tx.query<RunStepRow>(
        'SELECT * FROM run_steps WHERE id = $1',
        [id]
      );
      if (!result.rows[0]) throw new Error('Failed to create run step');
      created.push(rowToStep(result.rows[0]));
    }

    return created;
  });
}

/**
 * Mark step as started
 */
export async function markStarted(
  db: DatabaseAdapter,
  id: string
): Promise<RunStep | null> {
  const now = Date.now();

  await db.query(
    `UPDATE run_steps SET
      status = 'running',
      started_at_ms = $1,
      updated_at_ms = $2
     WHERE id = $3`,
    [now, now, id]
  );

  return getById(db, id);
}

/**
 * Mark step as successful
 */
export async function markSuccess(
  db: DatabaseAdapter,
  id: string,
  opts?: {
    exitCode?: number;
    stdoutPath?: string;
    stderrPath?: string;
    stdoutBytes?: number;
    stderrBytes?: number;
    stdoutTruncated?: boolean;
    stderrTruncated?: boolean;
    stdoutTail?: string;
    stderrTail?: string;
    metadata?: Record<string, unknown>;
  }
): Promise<RunStep | null> {
  const existing = await getById(db, id);
  if (!existing) return null;

  const now = Date.now();
  const durationMs = existing.startedAtMs ? now - existing.startedAtMs : null;
  const merged = { ...existing.metadata, ...opts?.metadata };

  await db.query(
    `UPDATE run_steps SET
      status = 'success',
      exit_code = $1,
      ended_at_ms = $2,
      duration_ms = $3,
      stdout_path = COALESCE($4, stdout_path),
      stderr_path = COALESCE($5, stderr_path),
      stdout_bytes = COALESCE($6, stdout_bytes),
      stderr_bytes = COALESCE($7, stderr_bytes),
      stdout_truncated = COALESCE($8, stdout_truncated),
      stderr_truncated = COALESCE($9, stderr_truncated),
      stdout_tail = COALESCE($10, stdout_tail),
      stderr_tail = COALESCE($11, stderr_tail),
      meta_json = $12,
      updated_at_ms = $13
     WHERE id = $14`,
    [
      opts?.exitCode ?? 0,
      now,
      durationMs,
      opts?.stdoutPath ?? null,
      opts?.stderrPath ?? null,
      opts?.stdoutBytes ?? null,
      opts?.stderrBytes ?? null,
      opts?.stdoutTruncated ? 1 : null,
      opts?.stderrTruncated ? 1 : null,
      opts?.stdoutTail ?? null,
      opts?.stderrTail ?? null,
      JSON.stringify(merged),
      now,
      id,
    ]
  );

  return getById(db, id);
}

/**
 * Mark step as failed
 */
export async function markFailed(
  db: DatabaseAdapter,
  id: string,
  opts: {
    exitCode?: number;
    signal?: string;
    errorMessage?: string;
    stdoutPath?: string;
    stderrPath?: string;
    stdoutBytes?: number;
    stderrBytes?: number;
    stdoutTruncated?: boolean;
    stderrTruncated?: boolean;
    stdoutTail?: string;
    stderrTail?: string;
    metadata?: Record<string, unknown>;
  }
): Promise<RunStep | null> {
  const existing = await getById(db, id);
  if (!existing) return null;

  const now = Date.now();
  const durationMs = existing.startedAtMs ? now - existing.startedAtMs : null;
  const merged = { ...existing.metadata, ...opts.metadata };

  await db.query(
    `UPDATE run_steps SET
      status = 'failed',
      exit_code = $1,
      signal = $2,
      error_message = $3,
      ended_at_ms = $4,
      duration_ms = $5,
      stdout_path = COALESCE($6, stdout_path),
      stderr_path = COALESCE($7, stderr_path),
      stdout_bytes = COALESCE($8, stdout_bytes),
      stderr_bytes = COALESCE($9, stderr_bytes),
      stdout_truncated = COALESCE($10, stdout_truncated),
      stderr_truncated = COALESCE($11, stderr_truncated),
      stdout_tail = COALESCE($12, stdout_tail),
      stderr_tail = COALESCE($13, stderr_tail),
      meta_json = $14,
      updated_at_ms = $15
     WHERE id = $16`,
    [
      opts.exitCode ?? null,
      opts.signal ?? null,
      opts.errorMessage ?? null,
      now,
      durationMs,
      opts.stdoutPath ?? null,
      opts.stderrPath ?? null,
      opts.stdoutBytes ?? null,
      opts.stderrBytes ?? null,
      opts.stdoutTruncated ? 1 : null,
      opts.stderrTruncated ? 1 : null,
      opts.stdoutTail ?? null,
      opts.stderrTail ?? null,
      JSON.stringify(merged),
      now,
      id,
    ]
  );

  return getById(db, id);
}

/**
 * Mark step as skipped
 */
export async function markSkipped(
  db: DatabaseAdapter,
  id: string,
  reason?: string
): Promise<RunStep | null> {
  const now = Date.now();

  await db.query(
    `UPDATE run_steps SET
      status = 'skipped',
      error_message = $1,
      ended_at_ms = $2,
      updated_at_ms = $3
     WHERE id = $4`,
    [reason ?? null, now, now, id]
  );

  return getById(db, id);
}

/**
 * Mark step as canceled
 */
export async function markCanceled(
  db: DatabaseAdapter,
  id: string,
  reason?: string
): Promise<RunStep | null> {
  const now = Date.now();

  await db.query(
    `UPDATE run_steps SET
      status = 'canceled',
      error_message = $1,
      ended_at_ms = $2,
      updated_at_ms = $3
     WHERE id = $4`,
    [reason ?? null, now, now, id]
  );

  return getById(db, id);
}

/**
 * List steps for a run
 */
export async function listByRun(
  db: DatabaseAdapter,
  runId: string,
  opts?: {
    attempt?: number;
    status?: StepStatus | StepStatus[];
  }
): Promise<RunStep[]> {
  let sql = 'SELECT * FROM run_steps WHERE run_id = $1';
  const params: unknown[] = [runId];
  let paramIndex = 2;

  if (opts?.attempt !== undefined) {
    sql += ` AND attempt = $${paramIndex++}`;
    params.push(opts.attempt);
  }

  if (opts?.status) {
    const statuses = Array.isArray(opts.status) ? opts.status : [opts.status];
    const placeholders = statuses.map(() => `$${paramIndex++}`).join(', ');
    sql += ` AND status IN (${placeholders})`;
    params.push(...statuses);
  }

  sql += ' ORDER BY attempt ASC, ordinal ASC';

  const result = await db.query<RunStepRow>(sql, params);
  return result.rows.map(rowToStep);
}

/**
 * Get the latest attempt number for a run
 */
export async function getLatestAttempt(
  db: DatabaseAdapter,
  runId: string
): Promise<number> {
  const result = await db.query<{ attempt: number }>(
    'SELECT COALESCE(MAX(attempt), 0) AS attempt FROM run_steps WHERE run_id = $1',
    [runId]
  );
  return result.rows[0]?.attempt ?? 0;
}

/**
 * Get step counts for a run attempt
 */
export interface StepCounts {
  passed: number;
  failed: number;
  active: number;
  skipped: number;
  total: number;
}

export async function getStepCounts(
  db: DatabaseAdapter,
  runId: string,
  attempt?: number
): Promise<StepCounts> {
  const actualAttempt = attempt ?? (await getLatestAttempt(db, runId));

  const result = await db.query<{
    passed: string;
    failed: string;
    active: string;
    skipped: string;
    total: string;
  }>(
    `SELECT
      SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS passed,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN status IN ('queued', 'running') THEN 1 ELSE 0 END) AS active,
      SUM(CASE WHEN status IN ('skipped', 'canceled') THEN 1 ELSE 0 END) AS skipped,
      COUNT(*) AS total
     FROM run_steps
     WHERE run_id = $1 AND attempt = $2`,
    [runId, actualAttempt]
  );

  const row = result.rows[0];
  return {
    passed: parseInt(row?.passed ?? '0', 10),
    failed: parseInt(row?.failed ?? '0', 10),
    active: parseInt(row?.active ?? '0', 10),
    skipped: parseInt(row?.skipped ?? '0', 10),
    total: parseInt(row?.total ?? '0', 10),
  };
}

/**
 * Get the first failed step for a run attempt
 */
export async function getFirstFailedStep(
  db: DatabaseAdapter,
  runId: string,
  attempt?: number
): Promise<RunStep | null> {
  const actualAttempt = attempt ?? (await getLatestAttempt(db, runId));

  const result = await db.query<RunStepRow>(
    `SELECT * FROM run_steps
     WHERE run_id = $1 AND attempt = $2 AND status = 'failed'
     ORDER BY ordinal ASC
     LIMIT 1`,
    [runId, actualAttempt]
  );

  return result.rows[0] ? rowToStep(result.rows[0]) : null;
}

/**
 * Get the currently running step for a run
 */
export async function getRunningStep(
  db: DatabaseAdapter,
  runId: string,
  attempt?: number
): Promise<RunStep | null> {
  const actualAttempt = attempt ?? (await getLatestAttempt(db, runId));

  const result = await db.query<RunStepRow>(
    `SELECT * FROM run_steps
     WHERE run_id = $1 AND attempt = $2 AND status = 'running'
     ORDER BY ordinal ASC
     LIMIT 1`,
    [runId, actualAttempt]
  );

  return result.rows[0] ? rowToStep(result.rows[0]) : null;
}

/**
 * Get run step summary for display
 */
export interface StepSummary {
  runId: string;
  latestAttempt: number;
  counts: StepCounts;
  firstFailedStep: string | null;
  runningStep: string | null;
  totalDurationMs: number;
}

export async function getSummary(
  db: DatabaseAdapter,
  runId: string
): Promise<StepSummary> {
  const latestAttempt = await getLatestAttempt(db, runId);

  if (latestAttempt === 0) {
    return {
      runId,
      latestAttempt: 0,
      counts: { passed: 0, failed: 0, active: 0, skipped: 0, total: 0 },
      firstFailedStep: null,
      runningStep: null,
      totalDurationMs: 0,
    };
  }

  const [counts, firstFailed, running, durationResult] = await Promise.all([
    getStepCounts(db, runId, latestAttempt),
    getFirstFailedStep(db, runId, latestAttempt),
    getRunningStep(db, runId, latestAttempt),
    db.query<{ total_duration: string }>(
      `SELECT COALESCE(SUM(duration_ms), 0) AS total_duration
       FROM run_steps
       WHERE run_id = $1 AND attempt = $2`,
      [runId, latestAttempt]
    ),
  ]);

  return {
    runId,
    latestAttempt,
    counts,
    firstFailedStep: firstFailed?.name ?? null,
    runningStep: running?.name ?? null,
    totalDurationMs: parseInt(durationResult.rows[0]?.total_duration ?? '0', 10),
  };
}
