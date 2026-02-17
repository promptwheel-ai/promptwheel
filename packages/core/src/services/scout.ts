/**
 * Scout Service - Orchestrates codebase scanning and ticket creation
 *
 * This is pure orchestration - it coordinates between:
 * - File scanning (scanner.ts)
 * - LLM analysis (runner.ts)
 * - Data persistence (repos/*)
 *
 * It accepts dependencies via ScoutDeps, making it testable and adapter-agnostic.
 */

import type { DatabaseAdapter } from '../db/adapter.js';
import * as projects from '../repos/projects.js';
import * as tickets from '../repos/tickets.js';
import * as runs from '../repos/runs.js';
import {
  scout as scanAndPropose,
  type ScoutResult as ScanResult,
  type TicketProposal,
  type ScoutBackend,
  type ProposalCategory,
} from '../scout/index.js';

/**
 * Dependencies for the scout service
 */
export interface ScoutDeps {
  /** Database adapter */
  db: DatabaseAdapter;
  /** Git operations */
  git: GitService;
  /** Logger */
  logger?: Logger;
  /** Clock for timestamps (useful for testing) */
  clock?: () => Date;
}

/**
 * Git service interface
 */
export interface GitService {
  /** Find repository root from a path */
  findRepoRoot(path: string): Promise<string | null>;
  /** Get remote URL */
  getRemoteUrl(repoRoot: string): Promise<string | null>;
  /** Generate deterministic project ID from repo */
  getProjectId(repoRoot: string, remoteUrl: string | null): string;
}

/**
 * Logger interface
 */
export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

/**
 * Scout options
 */
export interface ScoutRepoOptions {
  /** Path to scan (defaults to repo root) */
  path?: string;
  /** Glob pattern for files */
  scope?: string;
  /** Filter to categories */
  types?: ProposalCategory[];
  /** Categories to exclude */
  excludeTypes?: ProposalCategory[];
  /** Maximum proposals */
  maxProposals?: number;
  /** Minimum confidence threshold */
  minConfidence?: number;
  /** Model to use */
  model?: 'haiku' | 'sonnet' | 'opus';
  /** Custom prompt from formula — tells the AI what to focus on */
  customPrompt?: string;
  /** Timeout per batch */
  timeoutMs?: number;
  /** Abort signal */
  signal?: AbortSignal;
  /** Progress callback */
  onProgress?: (progress: ScoutProgress) => void;
  /** Raw output streaming callback (per-batch stdout/stderr) */
  onRawOutput?: (batchIndex: number, chunk: string) => void;
  /** Auto-create tickets from proposals */
  autoApprove?: boolean;
  /** Scout backend override (default: ClaudeScoutBackend) */
  backend?: ScoutBackend;
  /** Files the scout can read but must NOT propose changes to */
  protectedFiles?: string[];
  /** Token budget per scout batch (default: auto based on backend) */
  batchTokenBudget?: number;
  /** Maximum files to scan per cycle (default: 60) */
  maxFiles?: number;
  /** Max parallel scout batches (default: auto — 4 for codex, 3 for claude) */
  scoutConcurrency?: number;
  /** Module groups for dependency-aware batching */
  moduleGroups?: import('../scout/scanner.js').ModuleGroup[];
  /** Coverage context passed through to the scout prompt */
  coverageContext?: {
    sectorPath: string;
    scannedSectors: number;
    totalSectors: number;
    percent: number;
    sectorPercent: number;
    classificationConfidence: string;
    scanCount: number;
    proposalYield: number;
    sectorSummary?: string;
    sectorDifficulty?: 'easy' | 'moderate' | 'hard';
    sectorCategoryAffinity?: { boost: string[]; suppress: string[] };
  };
}

/**
 * Scout progress
 */
export interface BatchStatus {
  index: number;
  status: 'waiting' | 'running' | 'done' | 'failed';
  proposals?: number;
  startedAt?: number;
  durationMs?: number;
  error?: string;
}

export interface ScoutProgress {
  phase: 'init' | 'scanning' | 'analyzing' | 'storing' | 'complete';
  filesScanned?: number;
  totalFiles?: number;
  proposalsFound?: number;
  ticketsCreated?: number;
  message?: string;
  /** Per-batch status for multi-line display */
  batchStatuses?: BatchStatus[];
  totalBatches?: number;
}

/**
 * Scout result
 */
export interface ScoutRepoResult {
  success: boolean;
  project: projects.Project;
  run: runs.Run;
  proposals: TicketProposal[];
  tickets: tickets.Ticket[];
  errors: string[];
  scannedFiles: number;
  durationMs: number;
  sectorReclassification?: { production?: boolean; confidence?: string };
}

/**
 * Scout a repository for improvement opportunities
 *
 * This is the main entry point for the scout service. It:
 * 1. Resolves the repository root
 * 2. Ensures the project exists in the database
 * 3. Creates a scout run
 * 4. Scans files and generates proposals
 * 5. Optionally creates tickets from proposals
 * 6. Records the run outcome
 */
export async function scoutRepo(
  deps: ScoutDeps,
  opts: ScoutRepoOptions = {}
): Promise<ScoutRepoResult> {
  const { db, git, logger } = deps;
  const startTime = Date.now();
  const errors: string[] = [];

  const report = (progress: Partial<ScoutProgress>) => {
    opts.onProgress?.({
      phase: 'init',
      ...progress,
    });
  };

  // Phase 1: Resolve repository
  report({ phase: 'init', message: 'Resolving repository...' });

  const targetPath = opts.path ?? process.cwd();
  const repoRoot = await git.findRepoRoot(targetPath);

  if (!repoRoot) {
    throw new Error(`Not a git repository: ${targetPath}`);
  }

  const remoteUrl = await git.getRemoteUrl(repoRoot);
  const projectId = git.getProjectId(repoRoot, remoteUrl);

  logger?.debug('Resolved repository', { repoRoot, remoteUrl, projectId });

  // Phase 2: Ensure project exists
  const project = await projects.ensureForRepo(db, {
    id: projectId,
    name: repoRoot.split('/').pop() || 'unknown',
    repoUrl: remoteUrl,
    rootPath: repoRoot,
  });

  logger?.info('Project ensured', { projectId: project.id, name: project.name });

  // Phase 3: Create scout run
  const run = await runs.create(db, {
    projectId: project.id,
    type: 'scout',
    metadata: {
      scope: opts.scope ?? 'src/**',
      maxProposals: opts.maxProposals ?? 10,
      model: opts.model ?? (opts.backend ? undefined : 'opus'),
    },
  });

  logger?.debug('Scout run created', { runId: run.id });

  try {
    // Phase 4: Get dedup context
    const recentTickets = await tickets.getRecentlyCompleted(db, project.id, 20);
    const recentTitles = recentTickets.map(t => t.title);

    // Phase 5: Scan and generate proposals
    report({ phase: 'scanning', message: 'Scanning files...' });

    const scanResult: ScanResult = await scanAndPropose({
      scope: opts.scope ?? 'src/**',
      types: opts.types,
      excludeTypes: opts.excludeTypes,
      maxProposals: opts.maxProposals ?? 10,
      minConfidence: opts.minConfidence ?? 50,
      projectPath: repoRoot,
      model: opts.model ?? (opts.backend ? undefined : 'opus'),
      timeoutMs: opts.timeoutMs ?? 120000,
      signal: opts.signal,
      recentlyCompletedTitles: recentTitles,
      customPrompt: opts.customPrompt,
      backend: opts.backend,
      protectedFiles: opts.protectedFiles,
      batchTokenBudget: opts.batchTokenBudget,
      maxFiles: opts.maxFiles,
      scoutConcurrency: opts.scoutConcurrency,
      moduleGroups: opts.moduleGroups,
      coverageContext: opts.coverageContext,
      onRawOutput: opts.onRawOutput,
      onProgress: (p) => {
        report({
          phase: 'analyzing',
          filesScanned: p.filesScanned,
          totalFiles: p.totalFiles,
          proposalsFound: p.proposalsFound,
          message: `Analyzing batch ${p.currentBatch}/${p.totalBatches}`,
          batchStatuses: p.batchStatuses,
          totalBatches: p.totalBatches,
        });
      },
    });

    if (!scanResult.success) {
      errors.push(...scanResult.errors);
    }

    logger?.info('Scan complete', {
      files: scanResult.scannedFiles,
      proposals: scanResult.proposals.length,
    });

    // Phase 6: Create tickets if auto-approve
    const createdTickets: tickets.Ticket[] = [];

    if (opts.autoApprove && scanResult.proposals.length > 0) {
      report({
        phase: 'storing',
        proposalsFound: scanResult.proposals.length,
        message: 'Creating tickets...',
      });

      const ticketInputs = scanResult.proposals.map(proposal => ({
        projectId: project.id,
        title: proposal.title,
        description: formatProposalDescription(proposal),
        status: 'ready' as const,
        priority: proposal.confidence,
        category: proposal.category,
        allowedPaths: proposal.allowed_paths,
        verificationCommands: proposal.verification_commands,
      }));

      const created = await tickets.createMany(db, ticketInputs);
      createdTickets.push(...created);

      logger?.info('Tickets created', { count: created.length });
    }

    // Phase 7: Mark run success
    await runs.markSuccess(db, run.id, {
      scannedFiles: scanResult.scannedFiles,
      proposalCount: scanResult.proposals.length,
      ticketCount: createdTickets.length,
      durationMs: Date.now() - startTime,
    });

    report({
      phase: 'complete',
      filesScanned: scanResult.scannedFiles,
      proposalsFound: scanResult.proposals.length,
      ticketsCreated: createdTickets.length,
    });

    return {
      success: true,
      project,
      run: (await runs.getById(db, run.id))!,
      proposals: scanResult.proposals,
      tickets: createdTickets,
      errors: scanResult.errors,
      scannedFiles: scanResult.scannedFiles,
      durationMs: Date.now() - startTime,
      sectorReclassification: scanResult.sectorReclassification,
    };

  } catch (error) {
    // Mark run as failed
    await runs.markFailure(db, run.id, error as Error, {
      durationMs: Date.now() - startTime,
    });

    logger?.error('Scout failed', { error: (error as Error).message });

    return {
      success: false,
      project,
      run: (await runs.getById(db, run.id))!,
      proposals: [],
      tickets: [],
      errors: [...errors, (error as Error).message],
      scannedFiles: 0,
      durationMs: Date.now() - startTime,
    };
  }
}

/**
 * Format a proposal into ticket description markdown
 */
function formatProposalDescription(proposal: TicketProposal): string {
  const parts = [
    proposal.description,
    '',
    '## Acceptance Criteria',
    ...proposal.acceptance_criteria.map(c => `- ${c}`),
    '',
    '## Rationale',
    proposal.rationale,
    '',
    '## Files',
    ...proposal.files.map(f => `- \`${f}\``),
    '',
    `**Complexity:** ${proposal.estimated_complexity}`,
    `**Confidence:** ${proposal.confidence}%`,
  ];

  return parts.join('\n');
}

/**
 * Approve specific proposals and create tickets
 */
export async function approveProposals(
  deps: ScoutDeps,
  projectId: string,
  proposals: TicketProposal[]
): Promise<tickets.Ticket[]> {
  const { db, logger } = deps;

  const ticketInputs = proposals.map(proposal => ({
    projectId,
    title: proposal.title,
    description: formatProposalDescription(proposal),
    status: 'ready' as const,
    priority: proposal.confidence,
    category: proposal.category,
    allowedPaths: proposal.allowed_paths,
    verificationCommands: proposal.verification_commands,
  }));

  const created = await tickets.createMany(db, ticketInputs);
  logger?.info('Proposals approved', { count: created.length });

  return created;
}
