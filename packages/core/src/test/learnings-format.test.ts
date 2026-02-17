/**
 * Integration gap-fill tests for packages/core/src/repos/index.ts exports
 *
 * Since learnings.ts does not exist in packages/core/src/repos/,
 * we test the repos barrel exports and the row-mapping logic in
 * tickets.ts and projects.ts via their public APIs with a mock DatabaseAdapter.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// We test through the barrel export to verify it re-exports correctly
import * as repos from '../repos/index.js';

// ---------------------------------------------------------------------------
// Mock DatabaseAdapter
// ---------------------------------------------------------------------------

interface MockDB {
  query: ReturnType<typeof vi.fn>;
  withTransaction: ReturnType<typeof vi.fn>;
}

function createMockDb(): MockDB {
  const db: MockDB = {
    query: vi.fn(),
    withTransaction: vi.fn(),
  };
  // withTransaction executes the callback immediately
  db.withTransaction.mockImplementation(async (fn: () => Promise<unknown>) => fn());
  return db;
}

// ---------------------------------------------------------------------------
// Barrel export sanity
// ---------------------------------------------------------------------------

describe('repos barrel exports', () => {
  it('exports projects namespace', () => {
    expect(repos.projects).toBeDefined();
    expect(typeof repos.projects.getById).toBe('function');
    expect(typeof repos.projects.ensureForRepo).toBe('function');
    expect(typeof repos.projects.list).toBe('function');
  });

  it('exports tickets namespace', () => {
    expect(repos.tickets).toBeDefined();
    expect(typeof repos.tickets.getById).toBe('function');
    expect(typeof repos.tickets.create).toBe('function');
    expect(typeof repos.tickets.listByProject).toBe('function');
    expect(typeof repos.tickets.countByStatus).toBe('function');
  });

  it('exports runs namespace', () => {
    expect(repos.runs).toBeDefined();
    expect(typeof repos.runs.getById).toBe('function');
  });

  it('exports runSteps namespace', () => {
    expect(repos.runSteps).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// projects repo
// ---------------------------------------------------------------------------

describe('projects.getById', () => {
  let db: MockDB;

  beforeEach(() => {
    db = createMockDb();
  });

  it('returns null when no rows', async () => {
    db.query.mockResolvedValue({ rows: [] });
    const result = await repos.projects.getById(db as any, 'proj_abc');
    expect(result).toBeNull();
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('SELECT'),
      ['proj_abc'],
    );
  });

  it('maps row to Project with Date fields', async () => {
    db.query.mockResolvedValue({
      rows: [
        {
          id: 'proj_1',
          name: 'My Project',
          repo_url: 'https://github.com/x/y',
          root_path: '/tmp/repo',
          created_at: '2025-01-01T00:00:00Z',
          updated_at: '2025-06-01T00:00:00Z',
        },
      ],
    });

    const project = await repos.projects.getById(db as any, 'proj_1');
    expect(project).not.toBeNull();
    expect(project!.id).toBe('proj_1');
    expect(project!.name).toBe('My Project');
    expect(project!.repoUrl).toBe('https://github.com/x/y');
    expect(project!.rootPath).toBe('/tmp/repo');
    expect(project!.createdAt).toBeInstanceOf(Date);
    expect(project!.updatedAt).toBeInstanceOf(Date);
  });
});

// ---------------------------------------------------------------------------
// tickets repo
// ---------------------------------------------------------------------------

describe('tickets.getById', () => {
  let db: MockDB;

  beforeEach(() => {
    db = createMockDb();
  });

  it('returns null when ticket not found', async () => {
    db.query.mockResolvedValue({ rows: [] });
    const result = await repos.tickets.getById(db as any, 'tkt_missing');
    expect(result).toBeNull();
  });

  it('parses JSON array fields from row', async () => {
    db.query.mockResolvedValue({
      rows: [
        {
          id: 'tkt_1',
          project_id: 'proj_1',
          title: 'Fix tests',
          description: null,
          status: 'ready',
          priority: 5,
          shard: 'core',
          category: 'test',
          allowed_paths: '["src/test/**"]',
          forbidden_paths: '["node_modules/**"]',
          verification_commands: '["npm test"]',
          max_retries: 3,
          retry_count: 0,
          created_at: '2025-01-01T00:00:00Z',
          updated_at: '2025-01-01T00:00:00Z',
        },
      ],
    });

    const ticket = await repos.tickets.getById(db as any, 'tkt_1');
    expect(ticket).not.toBeNull();
    expect(ticket!.allowedPaths).toEqual(['src/test/**']);
    expect(ticket!.forbiddenPaths).toEqual(['node_modules/**']);
    expect(ticket!.verificationCommands).toEqual(['npm test']);
    expect(ticket!.status).toBe('ready');
    expect(ticket!.category).toBe('test');
    expect(ticket!.createdAt).toBeInstanceOf(Date);
  });

  it('handles null JSON array fields gracefully', async () => {
    db.query.mockResolvedValue({
      rows: [
        {
          id: 'tkt_2',
          project_id: 'proj_1',
          title: 'Minimal ticket',
          description: null,
          status: 'backlog',
          priority: 0,
          shard: null,
          category: null,
          allowed_paths: null,
          forbidden_paths: null,
          verification_commands: null,
          max_retries: 3,
          retry_count: 0,
          created_at: '2025-01-01T00:00:00Z',
          updated_at: '2025-01-01T00:00:00Z',
        },
      ],
    });

    const ticket = await repos.tickets.getById(db as any, 'tkt_2');
    expect(ticket).not.toBeNull();
    expect(Array.isArray(ticket!.allowedPaths)).toBe(true);
    expect(Array.isArray(ticket!.forbiddenPaths)).toBe(true);
    expect(Array.isArray(ticket!.verificationCommands)).toBe(true);
  });
});

describe('tickets.countByStatus', () => {
  let db: MockDB;

  beforeEach(() => {
    db = createMockDb();
  });

  it('returns parsed counts keyed by status', async () => {
    db.query.mockResolvedValue({
      rows: [
        { status: 'ready', count: '5' },
        { status: 'done', count: '12' },
        { status: 'blocked', count: '2' },
      ],
    });

    const counts = await repos.tickets.countByStatus(db as any, 'proj_1');
    expect(counts.ready).toBe(5);
    expect(counts.done).toBe(12);
    expect(counts.blocked).toBe(2);
  });
});
