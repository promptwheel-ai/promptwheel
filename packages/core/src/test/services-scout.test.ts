import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DatabaseAdapter } from '../db/adapter.js';
import type { GitService, ScoutDeps, ScoutProgress } from '../services/scout.js';

// Mock the scout/index.js module
vi.mock('../scout/index.js', () => ({
  scout: vi.fn(),
}));

// Mock repos
vi.mock('../repos/projects.js', () => ({
  ensureForRepo: vi.fn(),
}));

vi.mock('../repos/tickets.js', () => ({
  createMany: vi.fn(),
  getRecentlyCompleted: vi.fn(),
}));

vi.mock('../repos/runs.js', () => ({
  create: vi.fn(),
  getById: vi.fn(),
  markSuccess: vi.fn(),
  markFailure: vi.fn(),
}));

import { scoutRepo, approveProposals } from '../services/scout.js';
import { scout as scanAndPropose } from '../scout/index.js';
import * as projects from '../repos/projects.js';
import * as tickets from '../repos/tickets.js';
import * as runs from '../repos/runs.js';
import type { TicketProposal } from '../scout/index.js';

function makeProposal(overrides: Partial<TicketProposal> = {}): TicketProposal {
  return {
    id: 'scout-123-abc',
    category: 'refactor',
    title: 'Refactor utils module',
    description: 'Extract shared helpers',
    acceptance_criteria: ['Tests pass', 'No regressions'],
    verification_commands: ['npm test'],
    allowed_paths: ['src/utils/**'],
    files: ['src/utils/index.ts'],
    confidence: 80,
    rationale: 'Reduces duplication',
    estimated_complexity: 'simple',
    ...overrides,
  };
}

function makeFakeDb(): DatabaseAdapter {
  return {
    name: 'mock',
    connected: true,
    query: vi.fn(),
    withTransaction: vi.fn((fn) => fn({ query: vi.fn() })),
    migrate: vi.fn(),
    close: vi.fn(),
  } as unknown as DatabaseAdapter;
}

function makeFakeGit(): GitService {
  return {
    findRepoRoot: vi.fn().mockResolvedValue('/repo'),
    getRemoteUrl: vi.fn().mockResolvedValue('https://github.com/test/repo'),
    getProjectId: vi.fn().mockReturnValue('proj_abc123'),
  };
}

function makeDeps(overrides: Partial<ScoutDeps> = {}): ScoutDeps {
  return {
    db: makeFakeDb(),
    git: makeFakeGit(),
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    ...overrides,
  };
}

const fakeProject = {
  id: 'proj_abc123',
  name: 'repo',
  repoUrl: 'https://github.com/test/repo',
  rootPath: '/repo',
  createdAt: new Date(),
  updatedAt: new Date(),
};

const fakeRun = {
  id: 'run_xyz',
  projectId: 'proj_abc123',
  ticketId: null,
  type: 'scout' as const,
  status: 'running' as const,
  iteration: 0,
  maxIterations: 10,
  startedAt: new Date(),
  completedAt: null,
  error: null,
  metadata: {},
  createdAt: new Date(),
};

describe('scoutRepo', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(projects.ensureForRepo).mockResolvedValue(fakeProject);
    vi.mocked(runs.create).mockResolvedValue(fakeRun);
    vi.mocked(runs.getById).mockResolvedValue({ ...fakeRun, status: 'success' as const });
    vi.mocked(runs.markSuccess).mockResolvedValue(null);
    vi.mocked(runs.markFailure).mockResolvedValue(null);
    vi.mocked(tickets.getRecentlyCompleted).mockResolvedValue([]);
    vi.mocked(tickets.createMany).mockResolvedValue([]);
  });

  it('creates or gets project', async () => {
    vi.mocked(scanAndPropose).mockResolvedValue({
      success: true,
      proposals: [],
      errors: [],
      scannedFiles: 5,
    });

    const deps = makeDeps();
    await scoutRepo(deps, { path: '/repo' });

    expect(projects.ensureForRepo).toHaveBeenCalledWith(deps.db, expect.objectContaining({
      id: 'proj_abc123',
      rootPath: '/repo',
    }));
  });

  it('calls scout with correct options', async () => {
    vi.mocked(scanAndPropose).mockResolvedValue({
      success: true,
      proposals: [],
      errors: [],
      scannedFiles: 10,
    });

    await scoutRepo(makeDeps(), {
      path: '/repo',
      scope: 'lib/**',
      maxProposals: 5,
      minConfidence: 70,
      model: 'sonnet',
    });

    expect(scanAndPropose).toHaveBeenCalledWith(expect.objectContaining({
      scope: 'lib/**',
      maxProposals: 5,
      minConfidence: 70,
      projectPath: '/repo',
      model: 'sonnet',
    }));
  });

  it('stores proposals as tickets when autoApprove', async () => {
    const proposal = makeProposal();
    vi.mocked(scanAndPropose).mockResolvedValue({
      success: true,
      proposals: [proposal],
      errors: [],
      scannedFiles: 3,
    });

    const fakeTicket = {
      id: 'tkt_001',
      projectId: 'proj_abc123',
      title: proposal.title,
      description: 'desc',
      status: 'ready' as const,
      priority: 80,
      shard: null,
      category: 'refactor' as const,
      allowedPaths: ['src/utils/**'],
      forbiddenPaths: [],
      verificationCommands: ['npm test'],
      maxRetries: 3,
      retryCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    vi.mocked(tickets.createMany).mockResolvedValue([fakeTicket]);

    const result = await scoutRepo(makeDeps(), { autoApprove: true });

    expect(tickets.createMany).toHaveBeenCalled();
    expect(result.tickets).toHaveLength(1);
    expect(result.tickets[0].title).toBe(proposal.title);
  });

  it('reports progress at each phase', async () => {
    vi.mocked(scanAndPropose).mockResolvedValue({
      success: true,
      proposals: [],
      errors: [],
      scannedFiles: 1,
    });

    const phases: ScoutProgress['phase'][] = [];
    await scoutRepo(makeDeps(), {
      onProgress: (p) => phases.push(p.phase),
    });

    expect(phases).toContain('init');
    expect(phases).toContain('scanning');
    expect(phases).toContain('complete');
  });

  it('handles scout failure gracefully', async () => {
    vi.mocked(scanAndPropose).mockRejectedValue(new Error('LLM timeout'));

    const result = await scoutRepo(makeDeps());

    expect(result.success).toBe(false);
    expect(result.errors).toContain('LLM timeout');
    expect(runs.markFailure).toHaveBeenCalledWith(
      expect.anything(),
      fakeRun.id,
      expect.any(Error),
      expect.objectContaining({ durationMs: expect.any(Number) }),
    );
  });

  it('returns result with proposals count', async () => {
    const proposals = [makeProposal(), makeProposal({ title: 'Another fix' })];
    vi.mocked(scanAndPropose).mockResolvedValue({
      success: true,
      proposals,
      errors: [],
      scannedFiles: 20,
    });

    const result = await scoutRepo(makeDeps());

    expect(result.success).toBe(true);
    expect(result.proposals).toHaveLength(2);
    expect(result.scannedFiles).toBe(20);
  });
});

describe('approveProposals', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates tickets from proposals', async () => {
    const proposals = [makeProposal(), makeProposal({ title: 'Security fix', category: 'security' })];
    const fakeTickets = proposals.map((p, i) => ({
      id: `tkt_${i}`,
      projectId: 'proj_abc123',
      title: p.title,
      description: 'desc',
      status: 'ready' as const,
      priority: p.confidence,
      shard: null,
      category: p.category,
      allowedPaths: p.allowed_paths,
      forbiddenPaths: [],
      verificationCommands: p.verification_commands,
      maxRetries: 3,
      retryCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    }));
    vi.mocked(tickets.createMany).mockResolvedValue(fakeTickets);

    const result = await approveProposals(makeDeps(), 'proj_abc123', proposals);

    expect(result).toHaveLength(2);
    expect(tickets.createMany).toHaveBeenCalledWith(
      expect.anything(),
      expect.arrayContaining([
        expect.objectContaining({ projectId: 'proj_abc123', title: 'Refactor utils module' }),
        expect.objectContaining({ projectId: 'proj_abc123', title: 'Security fix' }),
      ]),
    );
  });

  it('handles empty proposals array', async () => {
    vi.mocked(tickets.createMany).mockResolvedValue([]);

    const result = await approveProposals(makeDeps(), 'proj_abc123', []);

    expect(result).toHaveLength(0);
    expect(tickets.createMany).toHaveBeenCalledWith(expect.anything(), []);
  });

  it('links tickets to project', async () => {
    const proposal = makeProposal();
    vi.mocked(tickets.createMany).mockResolvedValue([{
      id: 'tkt_1',
      projectId: 'proj_xyz',
      title: proposal.title,
      description: '',
      status: 'ready',
      priority: 80,
      shard: null,
      category: 'refactor',
      allowedPaths: [],
      forbiddenPaths: [],
      verificationCommands: [],
      maxRetries: 3,
      retryCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    }]);

    await approveProposals(makeDeps(), 'proj_xyz', [proposal]);

    expect(tickets.createMany).toHaveBeenCalledWith(
      expect.anything(),
      expect.arrayContaining([
        expect.objectContaining({ projectId: 'proj_xyz' }),
      ]),
    );
  });
});
