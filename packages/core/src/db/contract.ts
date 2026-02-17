/**
 * Database Adapter Contract Tests
 *
 * This module exports a test harness that validates any DatabaseAdapter
 * implementation behaves correctly. Run these tests against both SQLite
 * and Postgres adapters to ensure consistent behavior.
 *
 * Usage:
 *   import { runAdapterContract } from '@promptwheel/core/db/contract';
 *   import { createSQLiteAdapter } from '@promptwheel/sqlite';
 *
 *   describe('SQLite Adapter', () => {
 *     runAdapterContract(() => createSQLiteAdapter({ url: ':memory:' }));
 *   });
 */

import type { DatabaseAdapter } from './adapter.js';

/**
 * Test assertion helper
 */
function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

/**
 * Test result
 */
export interface ContractTestResult {
  name: string;
  passed: boolean;
  error?: string;
  durationMs: number;
}

/**
 * Contract test suite result
 */
export interface ContractSuiteResult {
  adapter: string;
  total: number;
  passed: number;
  failed: number;
  results: ContractTestResult[];
}

/**
 * Run the adapter contract test suite
 *
 * @param createAdapter - Factory function to create a fresh adapter for each test
 * @returns Test results
 */
export async function runAdapterContract(
  createAdapter: () => Promise<DatabaseAdapter>
): Promise<ContractSuiteResult> {
  const results: ContractTestResult[] = [];
  let adapterName = 'unknown';

  const tests: Array<{
    name: string;
    fn: (adapter: DatabaseAdapter) => Promise<void>;
  }> = [
    {
      name: 'adapter has correct name',
      fn: async (adapter) => {
        adapterName = adapter.name;
        assert(
          typeof adapter.name === 'string' && adapter.name.length > 0,
          'adapter.name should be a non-empty string'
        );
      },
    },
    {
      name: 'adapter reports connected state',
      fn: async (adapter) => {
        assert(adapter.connected === true, 'adapter should be connected after creation');
      },
    },
    {
      name: 'migrations create required tables',
      fn: async (adapter) => {
        // Run a simple query against each expected table to verify they exist
        // This works across both SQLite and Postgres
        try {
          await adapter.query('SELECT 1 FROM projects LIMIT 1');
        } catch {
          throw new Error('Assertion failed: projects table should exist');
        }

        try {
          await adapter.query('SELECT 1 FROM tickets LIMIT 1');
        } catch {
          throw new Error('Assertion failed: tickets table should exist');
        }

        try {
          await adapter.query('SELECT 1 FROM runs LIMIT 1');
        } catch {
          throw new Error('Assertion failed: runs table should exist');
        }

        try {
          await adapter.query('SELECT 1 FROM leases LIMIT 1');
        } catch {
          throw new Error('Assertion failed: leases table should exist');
        }

        try {
          await adapter.query('SELECT 1 FROM run_steps LIMIT 1');
        } catch {
          throw new Error('Assertion failed: run_steps table should exist');
        }
      },
    },
    {
      name: 'ensureProject is idempotent',
      fn: async (adapter) => {
        const projectId = 'test_proj_1';
        const projectData = {
          id: projectId,
          name: 'Test Project',
          repo_url: 'https://github.com/test/repo',
          root_path: '/tmp/test',
        };

        // First insert
        await adapter.query(
          `INSERT INTO projects (id, name, repo_url, root_path) VALUES ($1, $2, $3, $4)`,
          [projectData.id, projectData.name, projectData.repo_url, projectData.root_path]
        );

        // Query back
        const result1 = await adapter.query<{ id: string }>(
          'SELECT id FROM projects WHERE id = $1',
          [projectId]
        );
        assert(result1.rows.length === 1, 'project should exist after first insert');

        // Second insert should fail (unique constraint) or be idempotent
        try {
          await adapter.query(
            `INSERT INTO projects (id, name, repo_url, root_path) VALUES ($1, $2, $3, $4)`,
            [projectData.id, projectData.name, projectData.repo_url, projectData.root_path]
          );
          // If we get here, the adapter allows duplicates (bad) unless it's an upsert
        } catch {
          // Expected: unique constraint violation
        }

        // Query should still return exactly one row
        const result2 = await adapter.query<{ id: string }>(
          'SELECT id FROM projects WHERE id = $1',
          [projectId]
        );
        assert(result2.rows.length === 1, 'should still have exactly one project');
      },
    },
    {
      name: 'createRun then getRun returns same data',
      fn: async (adapter) => {
        // Create project first
        const projectId = 'test_proj_run';
        await adapter.query(
          `INSERT INTO projects (id, name, repo_url, root_path) VALUES ($1, $2, $3, $4)`,
          [projectId, 'Test', null, '/tmp']
        );

        // Create run
        const runId = 'test_run_1';
        await adapter.query(
          `INSERT INTO runs (id, project_id, type, status, max_iterations)
           VALUES ($1, $2, $3, $4, $5)`,
          [runId, projectId, 'scout', 'running', 10]
        );

        // Query back
        const result = await adapter.query<{
          id: string;
          project_id: string;
          type: string;
          status: string;
        }>('SELECT id, project_id, type, status FROM runs WHERE id = $1', [runId]);

        assert(result.rows.length === 1, 'run should exist');
        assert(result.rows[0].id === runId, 'run id should match');
        assert(result.rows[0].project_id === projectId, 'project_id should match');
        assert(result.rows[0].type === 'scout', 'type should match');
        assert(result.rows[0].status === 'running', 'status should match');
      },
    },
    {
      name: 'transaction commits on success',
      fn: async (adapter) => {
        const projectId = 'test_proj_tx_success';

        await adapter.withTransaction(async (tx) => {
          await tx.query(
            `INSERT INTO projects (id, name, repo_url, root_path) VALUES ($1, $2, $3, $4)`,
            [projectId, 'TX Test', null, '/tmp/tx']
          );
        });

        // Should exist after commit
        const result = await adapter.query<{ id: string }>(
          'SELECT id FROM projects WHERE id = $1',
          [projectId]
        );
        assert(result.rows.length === 1, 'project should exist after transaction commit');
      },
    },
    {
      name: 'transaction rollbacks on error',
      fn: async (adapter) => {
        const projectId = 'test_proj_tx_rollback';

        try {
          await adapter.withTransaction(async (tx) => {
            await tx.query(
              `INSERT INTO projects (id, name, repo_url, root_path) VALUES ($1, $2, $3, $4)`,
              [projectId, 'TX Rollback Test', null, '/tmp/tx']
            );
            // Force error
            throw new Error('Intentional rollback');
          });
        } catch {
          // Expected
        }

        // Should NOT exist after rollback
        const result = await adapter.query<{ id: string }>(
          'SELECT id FROM projects WHERE id = $1',
          [projectId]
        );
        assert(result.rows.length === 0, 'project should not exist after transaction rollback');
      },
    },
    {
      name: 'query returns correct rowCount for INSERT',
      fn: async (adapter) => {
        const result = await adapter.query(
          `INSERT INTO projects (id, name, repo_url, root_path) VALUES ($1, $2, $3, $4)`,
          ['test_proj_rowcount', 'RowCount Test', null, '/tmp']
        );

        // Note: SQLite returns changes, Postgres returns rowCount
        // Both should indicate 1 row affected
        assert(
          result.rowCount === 1 || result.rowCount === null,
          'rowCount should be 1 or null for single insert'
        );
      },
    },
    {
      name: 'timestamps are stored correctly',
      fn: async (adapter) => {
        const projectId = 'test_proj_timestamps';
        // Give 1 second buffer for timing issues
        const beforeInsert = new Date(Date.now() - 1000);

        await adapter.query(
          `INSERT INTO projects (id, name, repo_url, root_path) VALUES ($1, $2, $3, $4)`,
          [projectId, 'Timestamp Test', null, '/tmp']
        );

        const result = await adapter.query<{ created_at: string }>(
          'SELECT created_at FROM projects WHERE id = $1',
          [projectId]
        );

        assert(result.rows.length === 1, 'project should exist');

        // Parse the timestamp (SQLite uses 'YYYY-MM-DD HH:MM:SS' format)
        const createdAtStr = result.rows[0].created_at;
        const createdAt = new Date(createdAtStr.replace(' ', 'T') + 'Z');
        const afterInsert = new Date(Date.now() + 1000);

        assert(
          createdAt >= beforeInsert && createdAt <= afterInsert,
          `created_at (${createdAt.toISOString()}) should be between ${beforeInsert.toISOString()} and ${afterInsert.toISOString()}`
        );
      },
    },
    {
      name: 'close disconnects adapter',
      fn: async (adapter) => {
        await adapter.close();
        assert(adapter.connected === false, 'adapter should be disconnected after close');
      },
    },
  ];

  // Run each test
  for (const test of tests) {
    const start = Date.now();
    let adapter: DatabaseAdapter | null = null;

    try {
      adapter = await createAdapter();
      await test.fn(adapter);

      results.push({
        name: test.name,
        passed: true,
        durationMs: Date.now() - start,
      });
    } catch (error) {
      results.push({
        name: test.name,
        passed: false,
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - start,
      });
    } finally {
      // Close adapter if test didn't already close it
      if (adapter?.connected) {
        try {
          await adapter.close();
        } catch {
          // Ignore close errors
        }
      }
    }
  }

  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;

  return {
    adapter: adapterName,
    total: results.length,
    passed,
    failed,
    results,
  };
}

/**
 * Format contract test results for console output
 */
export function formatContractResults(suite: ContractSuiteResult): string {
  const lines: string[] = [
    `\nAdapter Contract Tests: ${suite.adapter}`,
    `${'='.repeat(50)}`,
  ];

  for (const result of suite.results) {
    const status = result.passed ? '✓' : '✗';
    const time = `(${result.durationMs}ms)`;
    lines.push(`${status} ${result.name} ${time}`);
    if (result.error) {
      lines.push(`  Error: ${result.error}`);
    }
  }

  lines.push(`${'='.repeat(50)}`);
  lines.push(`Total: ${suite.total} | Passed: ${suite.passed} | Failed: ${suite.failed}`);

  return lines.join('\n');
}
