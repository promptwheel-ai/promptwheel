/**
 * Ticket repository - Database operations for tickets
 */

import type { DatabaseAdapter } from '../db/adapter.js';
import { nanoid, parseJsonArray } from '../utils/index.js';

export type TicketStatus =
  | 'backlog'
  | 'ready'
  | 'leased'
  | 'in_progress'
  | 'in_review'
  | 'done'
  | 'blocked'
  | 'aborted';

export type TicketCategory = 'refactor' | 'docs' | 'test' | 'perf' | 'security' | 'fix' | 'cleanup' | 'types';

export interface Ticket {
  id: string;
  projectId: string;
  title: string;
  description: string | null;
  status: TicketStatus;
  priority: number;
  shard: string | null;
  category: TicketCategory | null;
  allowedPaths: string[];
  forbiddenPaths: string[];
  verificationCommands: string[];
  maxRetries: number;
  retryCount: number;
  createdAt: Date;
  updatedAt: Date;
}

interface TicketRow {
  id: string;
  project_id: string;
  title: string;
  description: string | null;
  status: string;
  priority: number;
  shard: string | null;
  category: string | null;
  allowed_paths: string | null;
  forbidden_paths: string | null;
  verification_commands: string | null;
  max_retries: number;
  retry_count: number;
  created_at: string;
  updated_at: string;
}

function rowToTicket(row: TicketRow): Ticket {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    description: row.description,
    status: row.status as TicketStatus,
    priority: row.priority,
    shard: row.shard,
    category: row.category as TicketCategory | null,
    allowedPaths: parseJsonArray(row.allowed_paths),
    forbiddenPaths: parseJsonArray(row.forbidden_paths),
    verificationCommands: parseJsonArray(row.verification_commands),
    maxRetries: row.max_retries,
    retryCount: row.retry_count,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

/**
 * Get ticket by ID
 */
export async function getById(
  db: DatabaseAdapter,
  id: string
): Promise<Ticket | null> {
  const result = await db.query<TicketRow>(
    'SELECT * FROM tickets WHERE id = $1',
    [id]
  );
  return result.rows[0] ? rowToTicket(result.rows[0]) : null;
}

/**
 * Create a new ticket
 */
export async function create(
  db: DatabaseAdapter,
  opts: {
    projectId: string;
    title: string;
    description?: string;
    status?: TicketStatus;
    priority?: number;
    shard?: string;
    category?: TicketCategory;
    allowedPaths?: string[];
    forbiddenPaths?: string[];
    verificationCommands?: string[];
    maxRetries?: number;
  }
): Promise<Ticket> {
  const id = `tkt_${nanoid(12)}`;

  await db.query(
    `INSERT INTO tickets (
      id, project_id, title, description, status, priority,
      shard, category, allowed_paths, forbidden_paths,
      verification_commands, max_retries
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      id,
      opts.projectId,
      opts.title,
      opts.description ?? null,
      opts.status ?? 'ready',
      opts.priority ?? 0,
      opts.shard ?? null,
      opts.category ?? null,
      JSON.stringify(opts.allowedPaths ?? []),
      JSON.stringify(opts.forbiddenPaths ?? []),
      JSON.stringify(opts.verificationCommands ?? []),
      opts.maxRetries ?? 3,
    ]
  );

  const ticket = await getById(db, id);
  if (!ticket) {
    throw new Error('Failed to create ticket');
  }
  return ticket;
}

/**
 * Create multiple tickets in a transaction
 */
export async function createMany(
  db: DatabaseAdapter,
  tickets: Array<Parameters<typeof create>[1]>
): Promise<Ticket[]> {
  return db.withTransaction(async (tx) => {
    const created: Ticket[] = [];
    for (const opts of tickets) {
      const id = `tkt_${nanoid(12)}`;
      await tx.query(
        `INSERT INTO tickets (
          id, project_id, title, description, status, priority,
          shard, category, allowed_paths, forbidden_paths,
          verification_commands, max_retries
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          id,
          opts.projectId,
          opts.title,
          opts.description ?? null,
          opts.status ?? 'ready',
          opts.priority ?? 0,
          opts.shard ?? null,
          opts.category ?? null,
          JSON.stringify(opts.allowedPaths ?? []),
          JSON.stringify(opts.forbiddenPaths ?? []),
          JSON.stringify(opts.verificationCommands ?? []),
          opts.maxRetries ?? 3,
        ]
      );
      const result = await tx.query<TicketRow>(
        'SELECT * FROM tickets WHERE id = $1',
        [id]
      );
      if (!result.rows[0]) throw new Error('Failed to create ticket');
      created.push(rowToTicket(result.rows[0]));
    }
    return created;
  });
}

/**
 * Update ticket status
 */
export async function updateStatus(
  db: DatabaseAdapter,
  id: string,
  status: TicketStatus
): Promise<Ticket | null> {
  await db.query(
    `UPDATE tickets SET status = $1, updated_at = datetime('now') WHERE id = $2`,
    [status, id]
  );
  return getById(db, id);
}

/**
 * List tickets for a project
 */
export async function listByProject(
  db: DatabaseAdapter,
  projectId: string,
  opts?: {
    status?: TicketStatus | TicketStatus[];
    limit?: number;
  }
): Promise<Ticket[]> {
  let sql = 'SELECT * FROM tickets WHERE project_id = $1';
  const params: unknown[] = [projectId];

  if (opts?.status) {
    const statuses = Array.isArray(opts.status) ? opts.status : [opts.status];
    const placeholders = statuses.map((_, i) => `$${i + 2}`).join(', ');
    sql += ` AND status IN (${placeholders})`;
    params.push(...statuses);
  }

  sql += ' ORDER BY priority DESC, created_at DESC';

  if (opts?.limit !== undefined) {
    const paramIndex = params.length + 1;
    sql += ` LIMIT $${paramIndex}`;
    params.push(opts.limit);
  }

  const result = await db.query<TicketRow>(sql, params);
  return result.rows.map(rowToTicket);
}

/**
 * Get recently completed tickets (for dedup context)
 */
export async function getRecentlyCompleted(
  db: DatabaseAdapter,
  projectId: string,
  limit: number = 20
): Promise<Ticket[]> {
  return listByProject(db, projectId, { status: 'done', limit });
}

/**
 * Count tickets by status
 */
export async function countByStatus(
  db: DatabaseAdapter,
  projectId: string
): Promise<Record<TicketStatus, number>> {
  const result = await db.query<{ status: string; count: string }>(
    `SELECT status, COUNT(*) as count FROM tickets
     WHERE project_id = $1 GROUP BY status`,
    [projectId]
  );

  const counts: Record<TicketStatus, number> = {
    backlog: 0,
    ready: 0,
    leased: 0,
    in_progress: 0,
    in_review: 0,
    done: 0,
    blocked: 0,
    aborted: 0,
  };
  for (const row of result.rows) {
    counts[row.status as TicketStatus] = parseInt(row.count, 10);
  }

  return counts;
}

/**
 * Find similar ticket by title (for dedup)
 */
export async function findSimilarByTitle(
  db: DatabaseAdapter,
  projectId: string,
  title: string
): Promise<Ticket | null> {
  const result = await db.query<TicketRow>(
    `SELECT * FROM tickets
     WHERE project_id = $1 AND LOWER(title) = LOWER($2)
     LIMIT 1`,
    [projectId, title]
  );
  return result.rows[0] ? rowToTicket(result.rows[0]) : null;
}
