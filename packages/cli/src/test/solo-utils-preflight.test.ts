import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { DatabaseAdapter } from '@blockspool/core/db';
import { runPreflightChecks, findConflictingTickets } from '../lib/solo-utils.js';

// Mock child_process
vi.mock('node:child_process', () => ({
  spawnSync: vi.fn(),
  execSync: vi.fn(),
}));

// Mock solo-config
vi.mock('../lib/solo-config.js', () => ({
  loadConfig: vi.fn(),
}));

// Mock solo-remote
vi.mock('../lib/solo-remote.js', () => ({
  normalizeRemoteUrl: vi.fn((url: string) => url.toLowerCase().replace(/\.git$/, '')),
}));

describe('runPreflightChecks', () => {
  let spawnSyncMock: ReturnType<typeof vi.fn>;
  let execSyncMock: ReturnType<typeof vi.fn>;
  let loadConfigMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const childProcess = await import('node:child_process');
    spawnSyncMock = vi.mocked(childProcess.spawnSync);
    execSyncMock = vi.mocked(childProcess.execSync);

    const config = await import('../lib/solo-config.js');
    loadConfigMock = vi.mocked(config.loadConfig);

    // Default: claude CLI exists
    spawnSyncMock.mockImplementation((cmd) => {
      if (cmd === 'claude') {
        return { status: 0 } as any;
      }
      if (cmd === 'gh') {
        return { status: 0 } as any;
      }
      return { status: 1 } as any;
    });

    // Default: git remote exists
    execSyncMock.mockImplementation((cmd) => {
      if (cmd === 'git remote') {
        return 'origin\n';
      }
      if (cmd === 'git remote get-url origin') {
        return 'git@github.com:org/repo.git\n';
      }
      if (cmd === 'gh auth status') {
        return '';
      }
      return '';
    });

    loadConfigMock.mockReturnValue({ allowedRemote: 'git@github.com:org/repo.git' });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns ok when all checks pass', async () => {
    const result = await runPreflightChecks('/repo', { needsPr: false });
    expect(result.ok).toBe(true);
    expect(result.hasRemote).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it('fails when claude CLI is not found (status != 0)', async () => {
    spawnSyncMock.mockReturnValue({ status: 1 } as any);

    const result = await runPreflightChecks('/repo', { needsPr: false });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Claude CLI not found');
  });

  it('fails when claude CLI throws exception', async () => {
    spawnSyncMock.mockImplementation(() => {
      throw new Error('command not found');
    });

    const result = await runPreflightChecks('/repo', { needsPr: false });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Claude CLI not found');
  });

  it('fails when no git remote configured', async () => {
    execSyncMock.mockImplementation((cmd) => {
      if (cmd === 'git remote') {
        return '';
      }
      return '';
    });

    const result = await runPreflightChecks('/repo', { needsPr: false });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('No git remote configured');
    expect(result.hasRemote).toBe(false);
  });

  it('fails when git remote throws exception', async () => {
    execSyncMock.mockImplementation((cmd) => {
      if (cmd === 'git remote') {
        throw new Error('not a git repository');
      }
      return '';
    });

    const result = await runPreflightChecks('/repo', { needsPr: false });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('No git remote configured');
  });

  it('fails when remote URL does not match config', async () => {
    execSyncMock.mockImplementation((cmd) => {
      if (cmd === 'git remote') {
        return 'origin\n';
      }
      if (cmd === 'git remote get-url origin') {
        return 'git@github.com:different/repo.git\n';
      }
      return '';
    });

    const result = await runPreflightChecks('/repo', { needsPr: false });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Remote mismatch');
    expect(result.error).toContain('different/repo');
  });

  it('adds warning when remote check fails but does not block', async () => {
    loadConfigMock.mockImplementation(() => {
      throw new Error('config not found');
    });

    const result = await runPreflightChecks('/repo', { needsPr: false });
    expect(result.ok).toBe(true);
    expect(result.warnings).toContain('Could not verify origin remote against config');
  });

  it('skips remote check when skipRemoteCheck is true', async () => {
    execSyncMock.mockImplementation((cmd) => {
      if (cmd === 'git remote') {
        return 'origin\n';
      }
      if (cmd === 'git remote get-url origin') {
        return 'git@github.com:different/repo.git\n';
      }
      return '';
    });

    const result = await runPreflightChecks('/repo', { needsPr: false, skipRemoteCheck: true });
    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('checks gh CLI when needsPr is true', async () => {
    const result = await runPreflightChecks('/repo', { needsPr: true });
    expect(result.ok).toBe(true);
    expect(result.ghAuthenticated).toBe(true);
  });

  it('fails when gh CLI not found and needsPr is true', async () => {
    spawnSyncMock.mockImplementation((cmd) => {
      if (cmd === 'gh') {
        return { status: 1 } as any;
      }
      if (cmd === 'claude') {
        return { status: 0 } as any;
      }
      return { status: 1 } as any;
    });

    const result = await runPreflightChecks('/repo', { needsPr: true });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('GitHub CLI not found');
    expect(result.ghAuthenticated).toBe(false);
  });

  it('fails when gh CLI throws and needsPr is true', async () => {
    spawnSyncMock.mockImplementation((cmd) => {
      if (cmd === 'gh') {
        throw new Error('command not found');
      }
      if (cmd === 'claude') {
        return { status: 0 } as any;
      }
      return { status: 1 } as any;
    });

    const result = await runPreflightChecks('/repo', { needsPr: true });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('GitHub CLI not found');
  });

  it('fails when gh not authenticated and needsPr is true', async () => {
    execSyncMock.mockImplementation((cmd) => {
      if (cmd === 'gh auth status') {
        throw new Error('not authenticated');
      }
      if (cmd === 'git remote') {
        return 'origin\n';
      }
      if (cmd === 'git remote get-url origin') {
        return 'git@github.com:org/repo.git\n';
      }
      return '';
    });

    const result = await runPreflightChecks('/repo', { needsPr: true });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('GitHub CLI not authenticated');
    expect(result.ghAuthenticated).toBe(false);
  });

  it('does not check gh when needsPr is false', async () => {
    const result = await runPreflightChecks('/repo', { needsPr: false });
    expect(result.ok).toBe(true);
    expect(result.ghAuthenticated).toBe(false);
  });
});

describe('findConflictingTickets', () => {
  let mockDb: DatabaseAdapter;

  beforeEach(() => {
    mockDb = {
      name: 'mock',
      connected: true,
      query: vi.fn(),
      withTransaction: vi.fn(),
      migrate: vi.fn(),
      close: vi.fn(),
    } as any;
  });

  const makeTicket = (id: string, projectId: string, allowedPaths: string[], status: string = 'in_progress') => ({
    id,
    projectId,
    title: 'Test',
    description: 'Test',
    priority: 2,
    status,
    category: 'refactor' as const,
    allowedPaths,
    forbiddenPaths: [],
    verificationCommands: [],
    maxRetries: 3,
    retryCount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    shard: null,
  });

  it('returns empty array when no in-progress tickets exist', async () => {
    const ticket = makeTicket('tkt_1', 'prj_1', ['src/lib/a.ts']);
    vi.mocked(mockDb.query).mockResolvedValue({ rows: [], rowCount: 0 });

    const conflicts = await findConflictingTickets(mockDb, ticket);
    expect(conflicts).toEqual([]);
  });

  it('excludes the ticket itself from conflict check', async () => {
    const ticket = makeTicket('tkt_1', 'prj_1', ['src/lib/a.ts']);
    const otherTicket = makeTicket('tkt_1', 'prj_1', ['src/lib/a.ts']);

    vi.mocked(mockDb.query).mockResolvedValue({
      rows: [
        {
          id: 'tkt_1',
          project_id: 'prj_1',
          title: 'Test',
          description: 'Test',
          priority: 2,
          status: 'in_progress',
          category: 'refactor',
          allowed_paths: '["src/lib/a.ts"]',
          forbidden_paths: '[]',
          verification_commands: '[]',
          max_retries: 3,
          retry_count: 0,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          shard: null,
        },
      ],
      rowCount: 1,
    });

    const conflicts = await findConflictingTickets(mockDb, ticket);
    expect(conflicts).toEqual([]);
  });

  it('detects exact path overlap', async () => {
    const ticket = makeTicket('tkt_1', 'prj_1', ['src/lib/a.ts']);

    vi.mocked(mockDb.query).mockResolvedValue({
      rows: [
        {
          id: 'tkt_2',
          project_id: 'prj_1',
          title: 'Test 2',
          description: 'Test 2',
          priority: 2,
          status: 'in_progress',
          category: 'refactor',
          allowed_paths: '["src/lib/a.ts"]',
          forbidden_paths: '[]',
          verification_commands: '[]',
          max_retries: 3,
          retry_count: 0,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          shard: null,
        },
      ],
      rowCount: 1,
    });

    const conflicts = await findConflictingTickets(mockDb, ticket);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].ticket.id).toBe('tkt_2');
    expect(conflicts[0].overlappingPaths).toContain('src/lib/a.ts <-> src/lib/a.ts');
  });

  it('detects directory containment overlap', async () => {
    const ticket = makeTicket('tkt_1', 'prj_1', ['src/lib']);

    vi.mocked(mockDb.query).mockResolvedValue({
      rows: [
        {
          id: 'tkt_2',
          project_id: 'prj_1',
          title: 'Test 2',
          description: 'Test 2',
          priority: 2,
          status: 'in_progress',
          category: 'refactor',
          allowed_paths: '["src/lib/utils.ts"]',
          forbidden_paths: '[]',
          verification_commands: '[]',
          max_retries: 3,
          retry_count: 0,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          shard: null,
        },
      ],
      rowCount: 1,
    });

    const conflicts = await findConflictingTickets(mockDb, ticket);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].overlappingPaths).toContain('src/lib <-> src/lib/utils.ts');
  });

  it('detects glob pattern overlap', async () => {
    const ticket = makeTicket('tkt_1', 'prj_1', ['src/**/*.ts']);

    vi.mocked(mockDb.query).mockResolvedValue({
      rows: [
        {
          id: 'tkt_2',
          project_id: 'prj_1',
          title: 'Test 2',
          description: 'Test 2',
          priority: 2,
          status: 'in_progress',
          category: 'refactor',
          allowed_paths: '["src/lib/a.ts"]',
          forbidden_paths: '[]',
          verification_commands: '[]',
          max_retries: 3,
          retry_count: 0,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          shard: null,
        },
      ],
      rowCount: 1,
    });

    const conflicts = await findConflictingTickets(mockDb, ticket);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].overlappingPaths).toContain('src/**/*.ts <-> src/lib/a.ts');
  });

  it('does not detect conflicts for non-overlapping paths', async () => {
    const ticket = makeTicket('tkt_1', 'prj_1', ['src/lib/a.ts']);

    vi.mocked(mockDb.query).mockResolvedValue({
      rows: [
        {
          id: 'tkt_2',
          project_id: 'prj_1',
          title: 'Test 2',
          description: 'Test 2',
          priority: 2,
          status: 'in_progress',
          category: 'refactor',
          allowed_paths: '["src/other/b.ts"]',
          forbidden_paths: '[]',
          verification_commands: '[]',
          max_retries: 3,
          retry_count: 0,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          shard: null,
        },
      ],
      rowCount: 1,
    });

    const conflicts = await findConflictingTickets(mockDb, ticket);
    expect(conflicts).toEqual([]);
  });

  it('skips tickets with empty allowed_paths', async () => {
    const ticket = makeTicket('tkt_1', 'prj_1', ['src/lib/a.ts']);

    vi.mocked(mockDb.query).mockResolvedValue({
      rows: [
        {
          id: 'tkt_2',
          project_id: 'prj_1',
          title: 'Test 2',
          description: 'Test 2',
          priority: 2,
          status: 'in_progress',
          category: 'refactor',
          allowed_paths: '[]',
          forbidden_paths: '[]',
          verification_commands: '[]',
          max_retries: 3,
          retry_count: 0,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          shard: null,
        },
      ],
      rowCount: 1,
    });

    const conflicts = await findConflictingTickets(mockDb, ticket);
    expect(conflicts).toEqual([]);
  });

  it('returns empty when current ticket has empty allowed_paths', async () => {
    const ticket = makeTicket('tkt_1', 'prj_1', []);

    vi.mocked(mockDb.query).mockResolvedValue({
      rows: [
        {
          id: 'tkt_2',
          project_id: 'prj_1',
          title: 'Test 2',
          description: 'Test 2',
          priority: 2,
          status: 'in_progress',
          category: 'refactor',
          allowed_paths: '["src/lib/a.ts"]',
          forbidden_paths: '[]',
          verification_commands: '[]',
          max_retries: 3,
          retry_count: 0,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          shard: null,
        },
      ],
      rowCount: 1,
    });

    const conflicts = await findConflictingTickets(mockDb, ticket);
    expect(conflicts).toEqual([]);
  });

  it('detects multiple overlapping paths', async () => {
    const ticket = makeTicket('tkt_1', 'prj_1', ['src/lib/a.ts', 'src/lib/b.ts']);

    vi.mocked(mockDb.query).mockResolvedValue({
      rows: [
        {
          id: 'tkt_2',
          project_id: 'prj_1',
          title: 'Test 2',
          description: 'Test 2',
          priority: 2,
          status: 'in_progress',
          category: 'refactor',
          allowed_paths: '["src/lib/a.ts", "src/lib/b.ts"]',
          forbidden_paths: '[]',
          verification_commands: '[]',
          max_retries: 3,
          retry_count: 0,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          shard: null,
        },
      ],
      rowCount: 1,
    });

    const conflicts = await findConflictingTickets(mockDb, ticket);
    expect(conflicts).toHaveLength(1);
    // Each path in ticket matches each path in other ticket: 2 * 2 = 4 combinations
    // But pathsOverlap returns true for exact matches, so we have:
    // a.ts <-> a.ts, a.ts <-> b.ts, b.ts <-> a.ts, b.ts <-> b.ts
    // But b.ts <-> a.ts is not an overlap, only exact matches
    // So we should have 2 overlaps: a.ts <-> a.ts, b.ts <-> b.ts
    expect(conflicts[0].overlappingPaths).toHaveLength(2);
  });

  it('detects conflicts with leased status', async () => {
    const ticket = makeTicket('tkt_1', 'prj_1', ['src/lib/a.ts']);

    vi.mocked(mockDb.query).mockResolvedValue({
      rows: [
        {
          id: 'tkt_2',
          project_id: 'prj_1',
          title: 'Test 2',
          description: 'Test 2',
          priority: 2,
          status: 'leased',
          category: 'refactor',
          allowed_paths: '["src/lib/a.ts"]',
          forbidden_paths: '[]',
          verification_commands: '[]',
          max_retries: 3,
          retry_count: 0,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          shard: null,
        },
      ],
      rowCount: 1,
    });

    const conflicts = await findConflictingTickets(mockDb, ticket);
    expect(conflicts).toHaveLength(1);
  });

  it('returns multiple conflicts when multiple tickets overlap', async () => {
    const ticket = makeTicket('tkt_1', 'prj_1', ['src/lib/a.ts']);

    vi.mocked(mockDb.query).mockResolvedValue({
      rows: [
        {
          id: 'tkt_2',
          project_id: 'prj_1',
          title: 'Test 2',
          description: 'Test 2',
          priority: 2,
          status: 'in_progress',
          category: 'refactor',
          allowed_paths: '["src/lib/a.ts"]',
          forbidden_paths: '[]',
          verification_commands: '[]',
          max_retries: 3,
          retry_count: 0,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          shard: null,
        },
        {
          id: 'tkt_3',
          project_id: 'prj_1',
          title: 'Test 3',
          description: 'Test 3',
          priority: 2,
          status: 'in_progress',
          category: 'refactor',
          allowed_paths: '["src/lib"]',
          forbidden_paths: '[]',
          verification_commands: '[]',
          max_retries: 3,
          retry_count: 0,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          shard: null,
        },
      ],
      rowCount: 2,
    });

    const conflicts = await findConflictingTickets(mockDb, ticket);
    expect(conflicts).toHaveLength(2);
    expect(conflicts[0].ticket.id).toBe('tkt_2');
    expect(conflicts[1].ticket.id).toBe('tkt_3');
  });
});
