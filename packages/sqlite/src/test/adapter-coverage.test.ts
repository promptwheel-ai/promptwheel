import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { SQLiteAdapter, createSQLiteAdapter } from '../adapter.js';

let tmpDir: string;
let dbPath: string;
let adapter: SQLiteAdapter;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-test-'));
  dbPath = path.join(tmpDir, 'test.sqlite');
  adapter = new SQLiteAdapter({ url: dbPath });
});

afterEach(async () => {
  await adapter.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('constructor and properties', () => {
  it('sets name to sqlite', () => {
    expect(adapter.name).toBe('sqlite');
  });

  it('connected is false before first query', () => {
    expect(adapter.connected).toBe(false);
  });

  it('connected is true after query', async () => {
    await adapter.query('SELECT 1');
    expect(adapter.connected).toBe(true);
  });
});

describe('query', () => {
  it('SELECT returns rows', async () => {
    const result = await adapter.query('SELECT 1 as val');
    expect(result.rows).toEqual([{ val: 1 }]);
    expect(result.rowCount).toBe(1);
  });

  it('INSERT changes rowCount', async () => {
    await adapter.query('CREATE TABLE t1 (id INTEGER PRIMARY KEY, name TEXT)');
    const result = await adapter.query("INSERT INTO t1 (id, name) VALUES (1, 'alice')");
    expect(result.rowCount).toBe(1);
  });

  it('UPDATE changes rowCount', async () => {
    await adapter.query('CREATE TABLE t2 (id INTEGER PRIMARY KEY, name TEXT)');
    await adapter.query("INSERT INTO t2 (id, name) VALUES (1, 'alice')");
    const result = await adapter.query("UPDATE t2 SET name = 'bob' WHERE id = 1");
    expect(result.rowCount).toBe(1);
  });

  it('DELETE changes rowCount', async () => {
    await adapter.query('CREATE TABLE t3 (id INTEGER PRIMARY KEY, name TEXT)');
    await adapter.query("INSERT INTO t3 (id, name) VALUES (1, 'alice')");
    const result = await adapter.query('DELETE FROM t3 WHERE id = 1');
    expect(result.rowCount).toBe(1);
  });

  it('throws on invalid SQL', async () => {
    await expect(adapter.query('NOT VALID SQL')).rejects.toThrow();
  });

  it('DDL queries work (CREATE TABLE)', async () => {
    await adapter.query('CREATE TABLE ddl_test (id INTEGER PRIMARY KEY)');
    const result = await adapter.query("SELECT name FROM sqlite_master WHERE type='table' AND name='ddl_test'");
    expect(result.rows).toHaveLength(1);
  });

  it('multiple sequential queries work', async () => {
    await adapter.query('CREATE TABLE seq (id INTEGER PRIMARY KEY, val TEXT)');
    await adapter.query("INSERT INTO seq (id, val) VALUES (1, 'a')");
    await adapter.query("INSERT INTO seq (id, val) VALUES (2, 'b')");
    await adapter.query("INSERT INTO seq (id, val) VALUES (3, 'c')");
    const result = await adapter.query('SELECT * FROM seq ORDER BY id');
    expect(result.rows).toHaveLength(3);
  });
});

describe('convertParams (tested via real queries)', () => {
  it('converts $1 $2 to ?', async () => {
    await adapter.query('CREATE TABLE cp (id INTEGER PRIMARY KEY, name TEXT, age INTEGER)');
    await adapter.query('INSERT INTO cp (id, name, age) VALUES ($1, $2, $3)', [1, 'alice', 30]);
    const result = await adapter.query('SELECT * FROM cp WHERE id = $1', [1]);
    expect(result.rows).toHaveLength(1);
    expect((result.rows[0] as any).name).toBe('alice');
    expect((result.rows[0] as any).age).toBe(30);
  });
});

describe('getQueryType (tested via stats)', () => {
  it('tracks SELECT, INSERT, UPDATE, DELETE, DDL, OTHER types', async () => {
    adapter.resetStats();
    await adapter.query('CREATE TABLE qt (id INTEGER PRIMARY KEY, v TEXT)');
    await adapter.query("INSERT INTO qt (id, v) VALUES (1, 'x')");
    await adapter.query('SELECT * FROM qt');
    await adapter.query("UPDATE qt SET v = 'y' WHERE id = 1");
    await adapter.query('DELETE FROM qt WHERE id = 1');

    const stats = adapter.getStats();
    expect(stats.byType['DDL']).toBeDefined();
    expect(stats.byType['DDL'].count).toBeGreaterThanOrEqual(1);
    expect(stats.byType['INSERT']).toBeDefined();
    expect(stats.byType['SELECT']).toBeDefined();
    expect(stats.byType['UPDATE']).toBeDefined();
    expect(stats.byType['DELETE']).toBeDefined();
  });
});

describe('extractTableName (tested via RETURNING clause)', () => {
  it('handles INSERT with RETURNING', async () => {
    await adapter.query('CREATE TABLE ret (id INTEGER PRIMARY KEY, name TEXT)');
    const result = await adapter.query("INSERT INTO ret (id, name) VALUES (1, 'test') RETURNING *");
    // RETURNING simulation should return the inserted row
    expect(result.rows).toHaveLength(1);
    expect((result.rows[0] as any).name).toBe('test');
  });
});

describe('migrate', () => {
  it('creates tables', async () => {
    await adapter.migrate();
    const result = await adapter.query("SELECT name FROM sqlite_master WHERE type='table' AND name='projects'");
    expect(result.rows).toHaveLength(1);
  });

  it('is idempotent (running twice does not error)', async () => {
    await adapter.migrate();
    await expect(adapter.migrate()).resolves.not.toThrow();
  });
});

describe('withTransaction', () => {
  it('commits on success', async () => {
    await adapter.query('CREATE TABLE tx1 (id INTEGER PRIMARY KEY, v TEXT)');
    await adapter.withTransaction(async (client) => {
      await client.query("INSERT INTO tx1 (id, v) VALUES (1, 'committed')");
    });
    const result = await adapter.query('SELECT * FROM tx1');
    expect(result.rows).toHaveLength(1);
  });

  it('rolls back on error', async () => {
    await adapter.query('CREATE TABLE tx2 (id INTEGER PRIMARY KEY, v TEXT)');
    await expect(
      adapter.withTransaction(async (client) => {
        await client.query("INSERT INTO tx2 (id, v) VALUES (1, 'should_rollback')");
        throw new Error('fail');
      }),
    ).rejects.toThrow('fail');
    const result = await adapter.query('SELECT * FROM tx2');
    expect(result.rows).toHaveLength(0);
  });
});

describe('close', () => {
  it('sets connected to false', async () => {
    await adapter.query('SELECT 1');
    expect(adapter.connected).toBe(true);
    await adapter.close();
    expect(adapter.connected).toBe(false);
  });
});

describe('configureLogging', () => {
  it('does not throw', () => {
    expect(() => adapter.configureLogging({ logAll: true })).not.toThrow();
  });
});

describe('getStats and resetStats', () => {
  it('getStats returns stats object', async () => {
    await adapter.query('SELECT 1');
    const stats = adapter.getStats();
    expect(stats).toHaveProperty('totalQueries');
    expect(stats).toHaveProperty('totalErrors');
    expect(stats).toHaveProperty('totalDurationMs');
    expect(stats).toHaveProperty('byType');
    expect(stats.totalQueries).toBeGreaterThanOrEqual(1);
  });

  it('resetStats resets counters', async () => {
    await adapter.query('SELECT 1');
    adapter.resetStats();
    const stats = adapter.getStats();
    expect(stats.totalQueries).toBe(0);
    expect(stats.totalErrors).toBe(0);
    expect(stats.totalDurationMs).toBe(0);
  });
});

describe('WAL mode', () => {
  it('is enabled by default', async () => {
    await adapter.query('SELECT 1'); // triggers connection
    const result = await adapter.query('PRAGMA journal_mode');
    expect((result.rows[0] as any).journal_mode).toBe('wal');
  });
});

describe('parsePath', () => {
  it('handles sqlite:// prefix', async () => {
    const a = new SQLiteAdapter({ url: `sqlite://${dbPath}` });
    await a.query('SELECT 1');
    expect(a.connected).toBe(true);
    await a.close();
  });

  it('handles file: prefix', async () => {
    const p = path.join(tmpDir, 'file-test.sqlite');
    const a = new SQLiteAdapter({ url: `file:${p}` });
    await a.query('SELECT 1');
    expect(a.connected).toBe(true);
    await a.close();
  });

  it('handles raw path', async () => {
    const p = path.join(tmpDir, 'raw-test.sqlite');
    const a = new SQLiteAdapter({ url: p });
    await a.query('SELECT 1');
    expect(a.connected).toBe(true);
    await a.close();
  });
});

describe('createSQLiteAdapter', () => {
  it('returns a migrated adapter', async () => {
    const a = await createSQLiteAdapter({ url: path.join(tmpDir, 'factory.sqlite') });
    expect(a.name).toBe('sqlite');
    expect(a.connected).toBe(true);
    const result = await a.query("SELECT name FROM sqlite_master WHERE type='table' AND name='projects'");
    expect(result.rows).toHaveLength(1);
    await a.close();
  });
});
