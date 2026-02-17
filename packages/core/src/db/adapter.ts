/**
 * DatabaseAdapter - Abstract interface for database operations
 *
 * This interface allows PromptWheel to work with different database backends:
 * - PostgreSQL (for teams/cloud)
 * - SQLite (for individual developers, zero-config)
 *
 * Implementations must handle:
 * - Connection management
 * - Query execution with parameterized queries
 * - Transaction support
 * - Schema migrations
 */

/**
 * Result of a database query
 */
export interface QueryResult<T = Record<string, unknown>> {
  /** Array of rows returned by the query */
  rows: T[];
  /** Number of rows affected (for INSERT/UPDATE/DELETE) */
  rowCount: number | null;
  /** Column metadata (optional, Postgres-specific) */
  fields?: Array<{ name: string; dataTypeID?: number }>;
}

/**
 * Transaction client interface
 * Passed to transaction callbacks to execute queries within the transaction
 */
export interface TransactionClient {
  /**
   * Execute a query within the transaction
   */
  query<T = Record<string, unknown>>(
    text: string,
    params?: unknown[]
  ): Promise<QueryResult<T>>;
}

/**
 * Migration definition
 */
export interface Migration {
  /** Unique migration identifier (e.g., "001_initial") */
  id: string;
  /** SQL to apply the migration */
  up: string;
  /** SQL to rollback the migration (optional) */
  down?: string;
  /** Checksum for integrity validation */
  checksum: string;
}

/**
 * Migration result
 */
export interface MigrationResult {
  /** Migrations that were applied */
  applied: string[];
  /** Migrations that were skipped (already applied) */
  skipped: string[];
  /** Whether this was a dry run */
  dryRun: boolean;
}

/**
 * Query logging configuration
 */
export interface QueryLogConfig {
  /** Log all queries (verbose) */
  logAll: boolean;
  /** Log queries slower than this threshold (ms) */
  slowQueryThresholdMs: number;
  /** Log query parameters (may expose sensitive data) */
  logParams: boolean;
}

/**
 * Query statistics for monitoring
 */
export interface QueryStats {
  totalQueries: number;
  totalErrors: number;
  totalDurationMs: number;
  byType: Record<string, { count: number; errors: number; durationMs: number }>;
}

/**
 * Database adapter interface
 *
 * All database operations in PromptWheel go through this interface,
 * allowing seamless switching between backends.
 */
export interface DatabaseAdapter {
  /**
   * Adapter name for logging/debugging
   */
  readonly name: string;

  /**
   * Whether the adapter is connected
   */
  readonly connected: boolean;

  /**
   * Execute a parameterized query
   *
   * @param text - SQL query with $1, $2, etc. placeholders
   * @param params - Parameter values
   * @returns Query result with rows and metadata
   *
   * @example
   * const result = await adapter.query<UserRow>(
   *   'SELECT * FROM users WHERE id = $1',
   *   [userId]
   * );
   */
  query<T = Record<string, unknown>>(
    text: string,
    params?: unknown[]
  ): Promise<QueryResult<T>>;

  /**
   * Execute a function within a database transaction
   *
   * The transaction is automatically committed on success,
   * or rolled back on error.
   *
   * @param fn - Function to execute within the transaction
   * @returns Result of the function
   *
   * @example
   * await adapter.withTransaction(async (tx) => {
   *   await tx.query('INSERT INTO orders ...', [...]);
   *   await tx.query('UPDATE inventory ...', [...]);
   * });
   */
  withTransaction<T>(fn: (client: TransactionClient) => Promise<T>): Promise<T>;

  /**
   * Run pending migrations
   *
   * @param options - Migration options
   * @returns Migration result
   */
  migrate(options?: {
    dryRun?: boolean;
    target?: string;
    verbose?: boolean;
  }): Promise<MigrationResult>;

  /**
   * Close the database connection
   *
   * Should be called when shutting down the application.
   */
  close(): Promise<void>;

  /**
   * Configure query logging
   */
  configureLogging?(config: Partial<QueryLogConfig>): void;

  /**
   * Get query statistics
   */
  getStats?(): Readonly<QueryStats>;

  /**
   * Reset query statistics
   */
  resetStats?(): void;
}

/**
 * Factory function type for creating database adapters
 */
export type DatabaseAdapterFactory = (config: DatabaseConfig) => Promise<DatabaseAdapter>;

/**
 * Database configuration
 */
export interface DatabaseConfig {
  /** Connection URL (postgres://, sqlite://, or file path) */
  url: string;
  /** Maximum connections in pool (Postgres) */
  maxConnections?: number;
  /** Idle timeout in ms */
  idleTimeoutMs?: number;
  /** Connection timeout in ms */
  connectionTimeoutMs?: number;
  /** Enable WAL mode (SQLite) */
  walMode?: boolean;
}

/**
 * Detect database type from URL
 */
export function detectDatabaseType(url: string): 'postgres' | 'sqlite' | 'unknown' {
  if (url.startsWith('postgres://') || url.startsWith('postgresql://')) {
    return 'postgres';
  }
  if (url.startsWith('sqlite://') || url.startsWith('file:') || url.endsWith('.db') || url.endsWith('.sqlite')) {
    return 'sqlite';
  }
  return 'unknown';
}

/**
 * Default database URL based on environment
 *
 * - If DATABASE_URL is set, use it (Postgres)
 * - Otherwise, default to SQLite at ~/.promptwheel/data.db
 */
export function getDefaultDatabaseUrl(): string {
  if (process.env.DATABASE_URL) {
    return process.env.DATABASE_URL;
  }

  // Default to SQLite for zero-config mode
  const home = process.env.HOME || process.env.USERPROFILE || '.';
  return `${home}/.promptwheel/data.db`;
}
