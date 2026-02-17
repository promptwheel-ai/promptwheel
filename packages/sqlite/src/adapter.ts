/**
 * SQLite adapter implementation
 *
 * Uses better-sqlite3 for synchronous, fast SQLite operations.
 * This is the zero-config adapter for individual developers.
 *
 * Key differences from Postgres:
 * - Synchronous API (better-sqlite3 is sync)
 * - WAL mode for better concurrency
 * - Single-writer pattern (SQLite limitation)
 * - No RETURNING * in older SQLite versions
 * - Different parameter placeholder syntax ($1 → ?)
 */

import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  DatabaseAdapter,
  DatabaseConfig,
  MigrationResult,
  QueryLogConfig,
  QueryResult,
  QueryStats,
  TransactionClient,
} from '@promptwheel/core/db';

/**
 * Internal query statistics
 */
interface InternalStats {
  totalQueries: number;
  totalErrors: number;
  totalDurationMs: number;
  byType: Record<string, { count: number; errors: number; durationMs: number }>;
}

/**
 * SQLite adapter for PromptWheel
 *
 * Features:
 * - WAL mode for better concurrency
 * - Auto-creates database directory
 * - Converts Postgres-style $1 params to SQLite ? params
 * - Embedded migrations
 */
export class SQLiteAdapter implements DatabaseAdapter {
  readonly name = 'sqlite';
  private db: Database.Database | null = null;
  private dbPath: string;
  private logConfig: QueryLogConfig = {
    logAll: false,
    slowQueryThresholdMs: 50, // Lower threshold for SQLite (it's faster)
    logParams: false,
  };
  private stats: InternalStats = {
    totalQueries: 0,
    totalErrors: 0,
    totalDurationMs: 0,
    byType: {},
  };

  constructor(private config: DatabaseConfig) {
    // Parse database path from URL
    this.dbPath = this.parsePath(config.url);
  }

  get connected(): boolean {
    return this.db !== null && this.db.open;
  }

  /**
   * Parse database path from various URL formats
   */
  private parsePath(url: string): string {
    if (url.startsWith('sqlite://')) {
      return url.slice('sqlite://'.length);
    }
    if (url.startsWith('file:')) {
      return url.slice('file:'.length);
    }
    // Assume it's a direct path
    return url;
  }

  /**
   * Ensure the database directory exists
   */
  private ensureDirectory(): void {
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  /**
   * Get or create the database connection
   */
  private getDb(): Database.Database {
    if (!this.db) {
      this.ensureDirectory();

      this.db = new Database(this.dbPath);

      // Enable WAL mode for better concurrency
      if (this.config.walMode !== false) {
        this.db.pragma('journal_mode = WAL');
      }

      // Other performance pragmas
      this.db.pragma('synchronous = NORMAL');
      this.db.pragma('cache_size = -64000'); // 64MB cache
      this.db.pragma('foreign_keys = ON');
    }
    return this.db;
  }

  /**
   * Convert Postgres-style $1, $2 params to SQLite ? params
   *
   * Note: This is a simple conversion that assumes params are used in order.
   * For complex queries with out-of-order params, this would need enhancement.
   */
  private convertParams(text: string, params?: unknown[]): { sql: string; values: unknown[] } {
    if (!params || params.length === 0) {
      return { sql: text, values: [] };
    }

    // Replace $1, $2, etc. with ?
    // Track which params are used and in what order
    const usedParams: number[] = [];
    const sql = text.replace(/\$(\d+)/g, (_, num) => {
      usedParams.push(parseInt(num, 10) - 1);
      return '?';
    });

    // Reorder params based on usage
    const values = usedParams.map((idx) => params[idx]);

    return { sql, values };
  }

  /**
   * Extract query type for statistics
   */
  private getQueryType(text: string): string {
    const trimmed = text.trim().toUpperCase();
    if (trimmed.startsWith('SELECT')) return 'SELECT';
    if (trimmed.startsWith('INSERT')) return 'INSERT';
    if (trimmed.startsWith('UPDATE')) return 'UPDATE';
    if (trimmed.startsWith('DELETE')) return 'DELETE';
    if (trimmed.startsWith('BEGIN') || trimmed.startsWith('COMMIT') || trimmed.startsWith('ROLLBACK')) {
      return 'TRANSACTION';
    }
    if (trimmed.startsWith('CREATE') || trimmed.startsWith('ALTER') || trimmed.startsWith('DROP')) {
      return 'DDL';
    }
    return 'OTHER';
  }

  /**
   * Update statistics after a query
   */
  private recordStats(type: string, durationMs: number, isError: boolean): void {
    this.stats.totalQueries++;
    this.stats.totalDurationMs += durationMs;
    if (isError) this.stats.totalErrors++;

    if (!this.stats.byType[type]) {
      this.stats.byType[type] = { count: 0, errors: 0, durationMs: 0 };
    }
    this.stats.byType[type].count++;
    this.stats.byType[type].durationMs += durationMs;
    if (isError) this.stats.byType[type].errors++;
  }

  /**
   * Log query if configured
   */
  private logQuery(text: string, params: unknown[] | undefined, durationMs: number): void {
    const shouldLog =
      this.logConfig.logAll || durationMs >= this.logConfig.slowQueryThresholdMs;

    if (shouldLog) {
      const paramInfo = this.logConfig.logParams && params?.length
        ? ` params=${JSON.stringify(params)}`
        : '';
      const slowTag = durationMs >= this.logConfig.slowQueryThresholdMs ? ' [SLOW]' : '';
      console.log(`[sqlite]${slowTag} ${durationMs}ms: ${text.slice(0, 100)}${paramInfo}`);
    }
  }

  async query<T = Record<string, unknown>>(
    text: string,
    params?: unknown[]
  ): Promise<QueryResult<T>> {
    const db = this.getDb();
    const queryType = this.getQueryType(text);
    const { sql, values } = this.convertParams(text, params);
    const start = Date.now();

    try {
      let rows: T[] = [];
      let rowCount: number | null = null;

      // Use run() for INSERT/UPDATE/DELETE, all() for SELECT, PRAGMA, and RETURNING queries
      const hasReturning = /\bRETURNING\s+/i.test(text);
      if (queryType === 'SELECT' || hasReturning || text.trim().toUpperCase().startsWith('PRAGMA')) {
        const stmt = db.prepare(sql);
        rows = stmt.all(...values) as T[];
        rowCount = rows.length;
      } else {
        const stmt = db.prepare(sql);
        const result = stmt.run(...values);
        rowCount = result.changes;
      }

      const durationMs = Date.now() - start;
      this.recordStats(queryType, durationMs, false);
      this.logQuery(text, params, durationMs);

      return { rows, rowCount };
    } catch (error) {
      const durationMs = Date.now() - start;
      this.recordStats(queryType, durationMs, true);
      throw error;
    }
  }

  async withTransaction<T>(fn: (client: TransactionClient) => Promise<T>): Promise<T> {
    const db = this.getDb();

    // SQLite transactions are synchronous with better-sqlite3
    // But we wrap in async for interface compatibility
    const txClient: TransactionClient = {
      query: async <R = Record<string, unknown>>(
        text: string,
        params?: unknown[]
      ): Promise<QueryResult<R>> => {
        return this.query<R>(text, params);
      },
    };

    try {
      db.exec('BEGIN IMMEDIATE'); // IMMEDIATE for write transactions

      const result = await fn(txClient);

      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  async migrate(options?: {
    dryRun?: boolean;
    target?: string;
    verbose?: boolean;
  }): Promise<MigrationResult> {
    const db = this.getDb();

    // Create migrations table if not exists
    db.exec(`
      CREATE TABLE IF NOT EXISTS _migrations (
        id TEXT PRIMARY KEY,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    // For now, run embedded core migrations
    const migrations = this.getCoreMigrations();
    const applied: string[] = [];
    const skipped: string[] = [];

    for (const migration of migrations) {
      // Check if already applied
      const existing = db.prepare('SELECT id FROM _migrations WHERE id = ?').get(migration.id);
      if (existing) {
        skipped.push(migration.id);
        continue;
      }

      if (options?.dryRun) {
        if (options.verbose) {
          console.log(`[sqlite] Would apply: ${migration.id}`);
        }
        applied.push(migration.id);
        continue;
      }

      // Apply migration
      if (options?.verbose) {
        console.log(`[sqlite] Applying: ${migration.id}`);
      }

      try {
        db.exec('BEGIN');
        db.exec(migration.up);
        db.prepare('INSERT INTO _migrations (id, checksum) VALUES (?, ?)').run(
          migration.id,
          migration.checksum
        );
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
      applied.push(migration.id);

      if (options?.target && migration.id === options.target) {
        break;
      }
    }

    return {
      applied,
      skipped,
      dryRun: options?.dryRun ?? false,
    };
  }

  /**
   * Get core migrations for SQLite schema
   *
   * These are simplified versions of the Postgres migrations,
   * adapted for SQLite syntax.
   */
  private getCoreMigrations(): Array<{ id: string; up: string; checksum: string }> {
    return [
      {
        id: '001_initial',
        up: `
          -- Projects table
          CREATE TABLE IF NOT EXISTS projects (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            repo_url TEXT,
            root_path TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
          );

          -- Tickets table
          CREATE TABLE IF NOT EXISTS tickets (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL REFERENCES projects(id),
            title TEXT NOT NULL,
            description TEXT,
            status TEXT NOT NULL DEFAULT 'backlog',
            priority INTEGER NOT NULL DEFAULT 0,
            shard TEXT,
            category TEXT,
            allowed_paths TEXT, -- JSON array
            forbidden_paths TEXT, -- JSON array
            verification_commands TEXT, -- JSON array
            max_retries INTEGER DEFAULT 3,
            retry_count INTEGER DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
          );

          CREATE INDEX IF NOT EXISTS idx_tickets_project_status ON tickets(project_id, status);
          CREATE INDEX IF NOT EXISTS idx_tickets_shard ON tickets(shard);

          -- Runs table
          CREATE TABLE IF NOT EXISTS runs (
            id TEXT PRIMARY KEY,
            ticket_id TEXT REFERENCES tickets(id),
            project_id TEXT NOT NULL REFERENCES projects(id),
            type TEXT NOT NULL DEFAULT 'worker',
            status TEXT NOT NULL DEFAULT 'pending',
            iteration INTEGER NOT NULL DEFAULT 1,
            max_iterations INTEGER NOT NULL DEFAULT 10,
            started_at TEXT,
            completed_at TEXT,
            error TEXT,
            metadata TEXT,
            pr_url TEXT,
            pr_number INTEGER,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
          );

          CREATE INDEX IF NOT EXISTS idx_runs_ticket ON runs(ticket_id);
          CREATE INDEX IF NOT EXISTS idx_runs_project ON runs(project_id);
          CREATE INDEX IF NOT EXISTS idx_runs_type ON runs(type);

          -- Leases table
          CREATE TABLE IF NOT EXISTS leases (
            id TEXT PRIMARY KEY,
            ticket_id TEXT NOT NULL REFERENCES tickets(id),
            run_id TEXT NOT NULL REFERENCES runs(id),
            agent_id TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'issued',
            expires_at TEXT NOT NULL,
            heartbeat_at TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
          );

          CREATE INDEX IF NOT EXISTS idx_leases_ticket ON leases(ticket_id);
          CREATE INDEX IF NOT EXISTS idx_leases_status ON leases(status);

          -- Run events table
          CREATE TABLE IF NOT EXISTS run_events (
            id TEXT PRIMARY KEY,
            run_id TEXT NOT NULL REFERENCES runs(id),
            type TEXT NOT NULL,
            data TEXT, -- JSON
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
          );

          CREATE INDEX IF NOT EXISTS idx_run_events_run ON run_events(run_id);

          -- Artifacts table
          CREATE TABLE IF NOT EXISTS artifacts (
            id TEXT PRIMARY KEY,
            run_id TEXT NOT NULL REFERENCES runs(id),
            type TEXT NOT NULL,
            name TEXT NOT NULL,
            content TEXT,
            path TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
          );

          CREATE INDEX IF NOT EXISTS idx_artifacts_run ON artifacts(run_id);

          -- Learnings table
          CREATE TABLE IF NOT EXISTS learnings (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL REFERENCES projects(id),
            ticket_id TEXT REFERENCES tickets(id),
            run_id TEXT REFERENCES runs(id),
            content TEXT NOT NULL,
            source TEXT NOT NULL,
            promoted INTEGER DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
          );

          CREATE INDEX IF NOT EXISTS idx_learnings_project ON learnings(project_id);
        `,
        checksum: 'initial-001-v1',
      },
      {
        id: '002_run_steps',
        up: `
          -- Run steps table for QA loop and future step-based runs
          -- Each step is a command/action within a run
          -- Supports retry attempts with full history
          CREATE TABLE IF NOT EXISTS run_steps (
            id               TEXT PRIMARY KEY,
            run_id           TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,

            attempt          INTEGER NOT NULL DEFAULT 1,
            ordinal          INTEGER NOT NULL,

            name             TEXT NOT NULL,
            kind             TEXT NOT NULL DEFAULT 'command',

            status           TEXT NOT NULL DEFAULT 'queued',

            cmd              TEXT,
            cwd              TEXT,
            timeout_ms       INTEGER,

            exit_code        INTEGER,
            signal           TEXT,

            started_at_ms    INTEGER,
            ended_at_ms      INTEGER,
            duration_ms      INTEGER,

            stdout_path      TEXT,
            stderr_path      TEXT,
            stdout_bytes     INTEGER NOT NULL DEFAULT 0,
            stderr_bytes     INTEGER NOT NULL DEFAULT 0,
            stdout_truncated INTEGER NOT NULL DEFAULT 0,
            stderr_truncated INTEGER NOT NULL DEFAULT 0,
            stdout_tail      TEXT,
            stderr_tail      TEXT,

            error_message    TEXT,
            meta_json        TEXT,

            created_at_ms    INTEGER NOT NULL,
            updated_at_ms    INTEGER NOT NULL,

            CONSTRAINT run_steps_status_check CHECK (
              status IN ('queued','running','success','failed','skipped','canceled')
            ),
            CONSTRAINT run_steps_kind_check CHECK (
              kind IN ('command','llm_fix','git','internal')
            ),
            CONSTRAINT run_steps_stdout_trunc_check CHECK (stdout_truncated IN (0,1)),
            CONSTRAINT run_steps_stderr_trunc_check CHECK (stderr_truncated IN (0,1))
          );

          -- Unique indexes for data integrity
          CREATE UNIQUE INDEX IF NOT EXISTS run_steps_run_attempt_name_uniq
            ON run_steps(run_id, attempt, name);

          CREATE UNIQUE INDEX IF NOT EXISTS run_steps_run_attempt_ordinal_uniq
            ON run_steps(run_id, attempt, ordinal);

          -- Query indexes
          CREATE INDEX IF NOT EXISTS run_steps_run_attempt_idx
            ON run_steps(run_id, attempt);

          CREATE INDEX IF NOT EXISTS run_steps_run_status_idx
            ON run_steps(run_id, status);
        `,
        checksum: 'run-steps-002-v1',
      },
    ];
  }

  async close(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  configureLogging(config: Partial<QueryLogConfig>): void {
    this.logConfig = { ...this.logConfig, ...config };
  }

  getStats(): Readonly<QueryStats> {
    return { ...this.stats };
  }

  resetStats(): void {
    this.stats = {
      totalQueries: 0,
      totalErrors: 0,
      totalDurationMs: 0,
      byType: {},
    };
  }
}

/**
 * Create a SQLite adapter
 *
 * @param config - Database configuration
 * @returns Initialized SQLite adapter
 */
export async function createSQLiteAdapter(config: DatabaseConfig): Promise<SQLiteAdapter> {
  const adapter = new SQLiteAdapter(config);
  // Run migrations to ensure schema exists
  await adapter.migrate({ verbose: false });
  return adapter;
}
