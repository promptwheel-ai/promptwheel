/**
 * Solo mode configuration
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import chalk from 'chalk';
import { createSQLiteAdapter } from '@blockspool/sqlite';
import { getDefaultDatabaseUrl, type DatabaseAdapter } from '@blockspool/core/db';
import type { ScoutDeps, ScoutProgress } from '@blockspool/core/services';
import type { TicketProposal, ProposalCategory } from '@blockspool/core/scout';
import { createGitService } from './git.js';
import { createLogger } from './logger.js';
import type { SpindleConfig } from './spindle/index.js';

/**
 * Retention configuration — caps on unbounded state accumulation.
 * All values are item counts (not time-based), except maxStaleBranchDays.
 */
export interface RetentionConfig {
  /** Keep last N run folders in .blockspool/runs/ (default 50) */
  maxRuns: number;
  /** Keep last N lines in history.ndjson (default 100) */
  maxHistoryEntries: number;
  /** Keep newest N artifact files per run folder (default 20) */
  maxArtifactsPerRun: number;
  /** Keep last N archived spool files (default 5) */
  maxSpoolArchives: number;
  /** Max deferred proposals in run-state.json (default 20) */
  maxDeferredProposals: number;
  /** Hard-delete oldest completed tickets beyond this cap (default 200) */
  maxCompletedTickets: number;
  /** Cap file_edit_counts keys in spindle state (default 50) */
  maxSpindleFileEditKeys: number;
  /** Keep last N local blockspool/* branches (default 10) */
  maxMergedBranches: number;
}

/**
 * Default retention configuration — conservative values.
 */
export const DEFAULT_RETENTION_CONFIG: RetentionConfig = {
  maxRuns: 50,
  maxHistoryEntries: 100,
  maxArtifactsPerRun: 20,
  maxSpoolArchives: 5,
  maxDeferredProposals: 20,
  maxCompletedTickets: 200,
  maxSpindleFileEditKeys: 50,
  maxMergedBranches: 10,
};

/**
 * Auto configuration - the "trust ladder" settings
 */
export interface AutoConfig {
  allowCategories: string[];
  blockCategories: string[];
  minConfidence: number;
  maxPrs: number;
  maxFilesPerTicket: number;
  maxLinesPerTicket: number;
  draftPrs: boolean;
  defaultScope: string;
  docsAudit: boolean;
  docsAuditInterval: number;
  /** Pull from origin every N cycles to stay current with team changes (0 = disabled, default 5) */
  pullEveryNCycles: number;
  /** What to do when pull fails due to divergence: "halt" stops the session, "warn" logs and continues (default "halt") */
  pullPolicy: 'halt' | 'warn';
  /** Re-read guidelines file every N cycles to pick up changes (default 10, 0 = disabled) */
  guidelinesRefreshCycles: number;
  /** Auto-create a baseline guidelines file (AGENTS.md or CLAUDE.md) if none exists (default true) */
  autoCreateGuidelines: boolean;
  /**
   * Custom path to guidelines file, relative to repo root.
   * Overrides the default CLAUDE.md / AGENTS.md search.
   * Set to false to disable guidelines entirely.
   * Examples: "docs/GUIDELINES.md", "CONVENTIONS.md", false
   */
  guidelinesPath: string | false | null;
  /** Enable adversarial proposal review — second-pass critique before acceptance (default: true) */
  adversarialReview: boolean;
  /** Enable cross-run learnings (default: true) */
  learningsEnabled: boolean;
  /** Character budget for learnings injected into prompts (default: 2000) */
  learningsBudget: number;
  /** Weight decay per session (default: 3) */
  learningsDecayRate: number;
  /** Token budget per scout batch (default: auto based on backend — 20k codex, 10k claude) */
  batchTokenBudget?: number;
  /** Timeout per scout batch in ms (default: auto — 300s codex, 120s claude) */
  scoutTimeoutMs?: number;
  /** Maximum files to scan per scout cycle (default: 60) */
  maxFilesPerCycle?: number;
  /** Max parallel scout batches (default: auto — 4 for codex, 3 for claude) */
  scoutConcurrency?: number;
  /** Per-backend overrides */
  claude?: { scoutConcurrency?: number; batchTokenBudget?: number };
  codex?: { scoutConcurrency?: number; batchTokenBudget?: number };
  kimi?: { scoutConcurrency?: number; batchTokenBudget?: number; scoutTimeoutMs?: number };
  local?: { scoutConcurrency?: number; batchTokenBudget?: number; scoutTimeoutMs?: number; maxIterations?: number };
}

/**
 * Default auto config - conservative "safe demo" settings
 */
export const DEFAULT_AUTO_CONFIG: AutoConfig = {
  allowCategories: ['refactor', 'test', 'docs', 'types', 'perf'],
  blockCategories: ['security', 'deps', 'auth', 'config', 'migration'],
  minConfidence: 70,
  maxPrs: 3,
  maxFilesPerTicket: 10,
  maxLinesPerTicket: 300,
  draftPrs: true,
  defaultScope: 'src',
  docsAudit: true,
  docsAuditInterval: 3,
  pullEveryNCycles: 5,
  pullPolicy: 'halt' as const,
  guidelinesRefreshCycles: 10,
  autoCreateGuidelines: true,
  guidelinesPath: null,
  adversarialReview: true,
  learningsEnabled: true,
  learningsBudget: 2000,
  learningsDecayRate: 3,
};

/**
 * Solo config file structure
 */
export interface SoloConfig {
  version: number;
  repoRoot: string;
  createdAt: string;
  dbPath: string;
  qa?: {
    commands: Array<{
      name: string;
      cmd: string;
      cwd?: string;
      timeoutSec?: number;
      timeoutMs?: number;
    }>;
    retry?: {
      enabled: boolean;
      maxAttempts: number;
    };
    artifacts?: {
      storeDir?: string;
      maxLogBytes?: number;
      tailBytes?: number;
    };
  };
  allowedRemote?: string;
  spindle?: Partial<SpindleConfig>;
  auto?: Partial<AutoConfig>;
  retention?: Partial<RetentionConfig>;
  /** Max parallel tickets for plugin mode (default: 2, max: 5) */
  pluginParallel?: number;
  /** Saved Codex model choice (persisted across runs) */
  codexModel?: string;
}

/**
 * Detected QA command from project configuration
 */
export interface DetectedQaCommand {
  name: string;
  cmd: string;
  source: 'package.json' | 'detected';
}

/**
 * Get the .blockspool directory path (repo-local or global)
 */
export function getBlockspoolDir(repoRoot?: string): string {
  if (repoRoot) {
    return path.join(repoRoot, '.blockspool');
  }
  const home = process.env.HOME || process.env.USERPROFILE || '.';
  return path.join(home, '.blockspool');
}

/**
 * Get database path
 */
export function getDbPath(repoRoot?: string): string {
  const dir = getBlockspoolDir(repoRoot);
  return path.join(dir, 'state.sqlite');
}

/**
 * Check if solo mode is initialized for a repo
 */
export function isInitialized(repoRoot: string): boolean {
  const configPath = path.join(getBlockspoolDir(repoRoot), 'config.json');
  return fs.existsSync(configPath);
}

/**
 * Detect QA commands from project configuration
 */
export function detectQaCommands(repoRoot: string): DetectedQaCommand[] {
  const commands: DetectedQaCommand[] = [];
  const packageJsonPath = path.join(repoRoot, 'package.json');

  if (!fs.existsSync(packageJsonPath)) {
    return commands;
  }

  try {
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
    const scripts = packageJson.scripts || {};

    const qaPatterns: Array<{ pattern: RegExp | string; priority: number; name: string }> = [
      { pattern: 'typecheck', priority: 1, name: 'typecheck' },
      { pattern: 'type-check', priority: 1, name: 'typecheck' },
      { pattern: 'check:types', priority: 1, name: 'typecheck' },
      { pattern: 'lint', priority: 2, name: 'lint' },
      { pattern: /^lint:.*/, priority: 2, name: 'lint' },
      { pattern: 'check', priority: 3, name: 'check' },
      { pattern: 'test', priority: 4, name: 'test' },
      { pattern: 'test:unit', priority: 4, name: 'test:unit' },
      { pattern: 'build', priority: 5, name: 'build' },
    ];

    const added = new Set<string>();

    for (const { pattern, name } of qaPatterns) {
      for (const [scriptName, _scriptCmd] of Object.entries(scripts)) {
        const matches = typeof pattern === 'string'
          ? scriptName === pattern
          : pattern.test(scriptName);

        if (matches && !added.has(scriptName)) {
          added.add(scriptName);
          commands.push({
            name: scriptName === name ? name : `${name} (${scriptName})`,
            cmd: `npm run ${scriptName}`,
            source: 'package.json',
          });
        }
      }
    }

    const order = ['typecheck', 'lint', 'check', 'test', 'build'];
    commands.sort((a, b) => {
      const aIdx = order.findIndex(o => a.name.startsWith(o));
      const bIdx = order.findIndex(o => b.name.startsWith(o));
      return (aIdx === -1 ? 99 : aIdx) - (bIdx === -1 ? 99 : bIdx);
    });
  } catch {
    // Ignore JSON parse errors
  }

  return commands;
}

/**
 * Initialize solo mode for a repository
 */
export async function initSolo(repoRoot: string): Promise<{ config: SoloConfig; detectedQa: DetectedQaCommand[] }> {
  const dir = getBlockspoolDir(repoRoot);
  const configPath = path.join(dir, 'config.json');
  const dbPath = getDbPath(repoRoot);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const detectedQa = detectQaCommands(repoRoot);

  // Capture origin remote URL for safety validation
  let allowedRemote: string | undefined;
  try {
    const { execSync } = await import('child_process');
    allowedRemote = execSync('git remote get-url origin', { cwd: repoRoot, encoding: 'utf-8' }).trim();
  } catch {
    // No remote configured yet — that's fine
  }

  const config: SoloConfig = {
    version: 1,
    repoRoot,
    createdAt: new Date().toISOString(),
    dbPath,
    ...(allowedRemote ? { allowedRemote } : {}),
  };

  if (detectedQa.length > 0) {
    config.qa = {
      commands: detectedQa.map(c => ({
        name: c.name,
        cmd: c.cmd,
      })),
    };
  }

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

  const gitignorePath = path.join(repoRoot, '.gitignore');
  if (fs.existsSync(gitignorePath)) {
    const content = fs.readFileSync(gitignorePath, 'utf-8');
    if (!content.includes('.blockspool')) {
      fs.appendFileSync(gitignorePath, '\n# BlockSpool local state\n.blockspool/\n');
    }
  }

  return { config, detectedQa };
}

/**
 * Load solo config
 */
export function loadConfig(repoRoot: string): SoloConfig | null {
  const configPath = path.join(getBlockspoolDir(repoRoot), 'config.json');
  if (!fs.existsSync(configPath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
}

/**
 * Save solo config (merges updates into existing config)
 */
export function saveConfig(repoRoot: string, updates: Partial<SoloConfig>): void {
  const configPath = path.join(getBlockspoolDir(repoRoot), 'config.json');
  const existing = loadConfig(repoRoot);
  if (!existing) return;
  const merged = { ...existing, ...updates };
  fs.writeFileSync(configPath, JSON.stringify(merged, null, 2));
}

/**
 * Get or create database adapter
 */
export async function getAdapter(repoRoot?: string): Promise<DatabaseAdapter> {
  const dbPath = repoRoot ? getDbPath(repoRoot) : getDefaultDatabaseUrl();
  return createSQLiteAdapter({ url: dbPath });
}

/**
 * Create scout dependencies
 */
export function createScoutDeps(
  db: DatabaseAdapter,
  opts: { verbose?: boolean; quiet?: boolean } = {}
): ScoutDeps {
  return {
    db,
    git: createGitService(),
    logger: createLogger(opts),
  };
}

/**
 * Format progress for display
 */
export function formatProgress(progress: ScoutProgress): string {
  switch (progress.phase) {
    case 'init':
      return chalk.gray(progress.message || 'Initializing...');
    case 'scanning':
      return chalk.gray(progress.message || 'Scanning files...');
    case 'analyzing':
      return chalk.gray(
        progress.message
          ? `${progress.message} (${progress.filesScanned}/${progress.totalFiles} files, ${progress.proposalsFound} proposals)`
          : `Analyzing (${progress.filesScanned}/${progress.totalFiles} files, ${progress.proposalsFound} proposals)`
      );
    case 'storing':
      return chalk.gray(progress.message || 'Storing results...');
    case 'complete':
      return chalk.green(
        `Complete: ${progress.proposalsFound} proposals, ` +
        `${progress.ticketsCreated} tickets created`
      );
    default:
      return '';
  }
}

/**
 * Display a proposal summary
 */
export function displayProposal(proposal: TicketProposal, index: number): void {
  const categoryColors: Record<ProposalCategory, typeof chalk.blue> = {
    refactor: chalk.cyan,
    docs: chalk.yellow,
    test: chalk.green,
    perf: chalk.magenta,
    security: chalk.red,
  };

  const color = categoryColors[proposal.category] || chalk.white;

  console.log();
  console.log(chalk.bold(`${index + 1}. ${proposal.title}`));
  const impactStr = proposal.impact_score !== null ? ` | impact ${proposal.impact_score}/10` : '';
  console.log(
    `   ${color(proposal.category)} | ` +
    `${proposal.estimated_complexity} | ` +
    `${proposal.confidence}% confidence${impactStr}`
  );
  console.log(
    `   ${chalk.gray(proposal.description.slice(0, 100))}` +
    `${proposal.description.length > 100 ? '...' : ''}`
  );
  console.log(
    `   ${chalk.gray('Files:')} ` +
    `${proposal.files.slice(0, 3).join(', ')}` +
    `${proposal.files.length > 3 ? ` +${proposal.files.length - 3} more` : ''}`
  );
}
