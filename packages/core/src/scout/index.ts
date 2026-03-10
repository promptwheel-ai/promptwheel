/**
 * Scout service - Analyzes codebases and generates improvement proposals
 *
 * This is the core scout implementation that works with any DatabaseAdapter.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { nanoid } from '../utils/id.js';
import { bigramSimilarity } from '../dedup/shared.js';
import { inferSeverity, deriveSeverity, isValidRiskAssessment } from '../proposals/shared.js';
import { buildScoutPrompt } from './prompt.js';
import { parseClaudeOutput, ClaudeScoutBackend, type ScoutBackend } from './runner.js';
import { scanFiles, batchFilesByTokens, batchFilesByModule } from './scanner.js';
import type {
  ScoutOptions,
  ScoutResult,
  ScoutProgress,
  TicketProposal,
  ProposalCategory,
} from './types.js';

export * from './types.js';
export { buildScoutPrompt, buildCategoryPrompt } from './prompt.js';
export { type Finding, type ScanResult, type ScanSummary, findingId, proposalToFinding, validatedProposalToFinding, findingToProposal, buildScanResult } from './finding.js';
export { type EvalCase, type EvalResult, type ExpectedFinding, evalProject, formatEvalResult } from './eval.js';
export { toSarif } from './sarif.js';
export {
  type ScanHistoryEntry, type ScanDiff, type ScanTrend,
  appendScanHistory, loadScanHistory, getLastScan, diffScans, computeTrend, historyPath,
} from './history.js';
export {
  type Baseline, type BaselineEntry, type BaselineFilterResult,
  loadBaseline, saveBaseline, createBaseline, suppressFinding, unsuppressFinding,
  filterByBaseline, baselineSize, baselinePath, parseDuration, countExpired,
} from './baseline.js';
export {
  type FixAttempt, type FixOutcome, type FixJournalEntry, type FixStats, type FindingFixHistory,
  appendFixAttempt, appendFixOutcome, loadFixJournal,
  computeFixStats, getFixHistory, getRepeatFailures, buildFixContext, journalPath as fixJournalPath,
} from './fix-journal.js';
export {
  type CustomRule, type RuleSet,
  loadRules, saveRule, buildRulesPromptSection, rulesDir,
} from './rules.js';
export {
  type IngestOptions, type IngestResult,
  parseSarif, ingestToScanResult,
} from './ingest.js';
export { runClaude, parseClaudeOutput, ClaudeScoutBackend, CodexScoutBackend, CodexMcpScoutBackend, type ScoutBackend } from './runner.js';
export { AnthropicBatchScoutBackend } from './anthropic-batch-runner.js';
export { McpBatchServer } from './mcp-batch-server.js';
export { scanFiles, detectScope, batchFiles, batchFilesByTokens, batchFilesByModule, estimateTokens, type ScannedFile, type ModuleGroup } from './scanner.js';

/**
 * Detect available verification commands from a project's package.json.
 * Returns category-appropriate defaults if the project has relevant scripts.
 */
function detectVerificationCommands(projectPath: string): { test: string[]; types: string[]; fallback: string[] } {
  try {
    const pkgPath = path.join(projectPath, 'package.json');
    const raw = fs.readFileSync(pkgPath, 'utf8');
    const pkg = JSON.parse(raw);
    const scripts = pkg.scripts ?? {};
    const hasTest = 'test' in scripts;
    const hasTypecheck = 'typecheck' in scripts || 'type-check' in scripts;
    const hasTsc = hasTypecheck || (pkg.devDependencies?.typescript || pkg.dependencies?.typescript);
    return {
      test: hasTest ? ['npm test'] : [],
      types: hasTsc ? ['npx tsc --noEmit'] : [],
      fallback: hasTest ? ['npm test'] : [],
    };
  } catch {
    return { test: [], types: [], fallback: [] };
  }
}

/** Module-level cache — set once per scout() call. */
let _projectVerificationCommands: ReturnType<typeof detectVerificationCommands> | null = null;

/**
 * Get default verification commands for a proposal category.
 * Returns empty if no project scripts were detected.
 */
function getDefaultVerificationCommands(category: string): string[] {
  if (!_projectVerificationCommands) return [];
  if (category === 'test') return _projectVerificationCommands.test;
  if (category === 'types') return _projectVerificationCommands.types;
  return _projectVerificationCommands.fallback;
}

/**
 * Expand allowed paths for test proposals to include test file locations
 *
 * When a proposal is about adding tests, we need to allow:
 * 1. The original source file(s)
 * 2. Corresponding test files (e.g., foo.ts -> foo.test.ts, foo.spec.ts)
 * 3. Test directories (e.g., __tests__/, test/, tests/)
 * 4. Config files (vitest.config.ts, jest.config.js, tsconfig.json)
 */
function expandPathsForTests(paths: string[]): string[] {
  const expanded = new Set<string>(paths);

  for (const filePath of paths) {
    // Skip if already a test file
    if (filePath.includes('.test.') || filePath.includes('.spec.') || filePath.includes('__tests__')) {
      continue;
    }

    // Get directory and filename parts
    const lastSlash = filePath.lastIndexOf('/');
    const dir = lastSlash >= 0 ? filePath.slice(0, lastSlash) : '';
    const filename = lastSlash >= 0 ? filePath.slice(lastSlash + 1) : filePath;

    // Get extension and base name
    const lastDot = filename.lastIndexOf('.');
    const ext = lastDot >= 0 ? filename.slice(lastDot) : '';
    const baseName = lastDot >= 0 ? filename.slice(0, lastDot) : filename;

    // Add common test file patterns
    // 1. Same directory: foo.test.ts, foo.spec.ts (with multiple extensions)
    const testExts = [ext, '.ts', '.js', '.tsx', '.jsx'];
    const uniqueExts = [...new Set(testExts)];
    for (const testExt of uniqueExts) {
      if (dir) {
        expanded.add(`${dir}/${baseName}.test${testExt}`);
        expanded.add(`${dir}/${baseName}.spec${testExt}`);
      } else {
        expanded.add(`${baseName}.test${testExt}`);
        expanded.add(`${baseName}.spec${testExt}`);
      }
    }

    // 2. Adjacent __tests__ directory (comprehensive patterns)
    if (dir) {
      for (const testExt of uniqueExts) {
        expanded.add(`${dir}/__tests__/${baseName}.test${testExt}`);
        expanded.add(`${dir}/__tests__/${baseName}.spec${testExt}`);
        expanded.add(`${dir}/__tests__/${baseName}${testExt}`);
      }
    }
    // Root-level __tests__ directory
    for (const testExt of uniqueExts) {
      expanded.add(`__tests__/${baseName}.test${testExt}`);
      expanded.add(`__tests__/${baseName}.spec${testExt}`);
      expanded.add(`__tests__/${baseName}${testExt}`);
    }

    // 3. Project root test/ and tests/ directories
    for (const testExt of uniqueExts) {
      expanded.add(`test/${baseName}.test${testExt}`);
      expanded.add(`test/${baseName}.spec${testExt}`);
      expanded.add(`test/${baseName}${testExt}`);
      expanded.add(`tests/${baseName}.test${testExt}`);
      expanded.add(`tests/${baseName}.spec${testExt}`);
      expanded.add(`tests/${baseName}${testExt}`);
    }

    // 4. For src/ files, also allow mirrored structure in test directories
    if (dir.startsWith('src/')) {
      const relPath = dir.slice(4); // Remove 'src/'
      for (const testExt of uniqueExts) {
        // test/path/to/foo.test.ts
        expanded.add(`test/${relPath ? relPath + '/' : ''}${baseName}.test${testExt}`);
        expanded.add(`test/${relPath ? relPath + '/' : ''}${baseName}.spec${testExt}`);
        expanded.add(`test/${relPath ? relPath + '/' : ''}${baseName}${testExt}`);
        // tests/path/to/foo.test.ts
        expanded.add(`tests/${relPath ? relPath + '/' : ''}${baseName}.test${testExt}`);
        expanded.add(`tests/${relPath ? relPath + '/' : ''}${baseName}.spec${testExt}`);
        expanded.add(`tests/${relPath ? relPath + '/' : ''}${baseName}${testExt}`);
        // src/test/path/to/foo.test.ts (for projects that use src/test)
        expanded.add(`src/test/${relPath ? relPath + '/' : ''}${baseName}.test${testExt}`);
        expanded.add(`src/test/${relPath ? relPath + '/' : ''}${baseName}.spec${testExt}`);
      }
    }

    // 5. For packages/*/src/ files, allow test directories within the package
    const packageMatch = dir.match(/^(packages\/[^/]+)\/(src\/)?(.*)$/);
    if (packageMatch) {
      const [, packageDir, , relPath] = packageMatch;
      for (const testExt of uniqueExts) {
        // packages/foo/test/bar.test.ts
        expanded.add(`${packageDir}/test/${relPath ? relPath + '/' : ''}${baseName}.test${testExt}`);
        expanded.add(`${packageDir}/test/${relPath ? relPath + '/' : ''}${baseName}.spec${testExt}`);
        expanded.add(`${packageDir}/tests/${relPath ? relPath + '/' : ''}${baseName}.test${testExt}`);
        expanded.add(`${packageDir}/tests/${relPath ? relPath + '/' : ''}${baseName}.spec${testExt}`);
        // packages/foo/__tests__/bar.test.ts
        expanded.add(`${packageDir}/__tests__/${relPath ? relPath + '/' : ''}${baseName}.test${testExt}`);
        expanded.add(`${packageDir}/__tests__/${relPath ? relPath + '/' : ''}${baseName}.spec${testExt}`);
        // packages/foo/src/__tests__/bar.test.ts
        expanded.add(`${packageDir}/src/__tests__/${relPath ? relPath + '/' : ''}${baseName}.test${testExt}`);
        expanded.add(`${packageDir}/src/__tests__/${relPath ? relPath + '/' : ''}${baseName}.spec${testExt}`);
      }
    }
  }

  return Array.from(expanded);
}

/**
 * Validate and normalize a proposal
 */
function normalizeProposal(
  raw: Record<string, unknown>,
  category?: ProposalCategory
): TicketProposal | null {
  try {
    const proposal = raw as unknown as TicketProposal;

    // Validate required fields
    if (!proposal.category || !proposal.title || !proposal.description) {
      return null;
    }

    // Validate category (case-insensitive — LLMs sometimes emit "Refactor" or "SECURITY")
    const validCategories: ProposalCategory[] = ['refactor', 'docs', 'test', 'perf', 'security', 'fix', 'cleanup', 'types'];
    const rawCategory = String(proposal.category || '').toLowerCase() as ProposalCategory;
    if (!validCategories.includes(rawCategory)) {
      return null;
    }
    proposal.category = rawCategory;

    // Filter by category if specified
    if (category && proposal.category !== category) {
      return null;
    }

    // Noise filter — reject low-value cosmetic proposals that slip through the scout prompt
    const NOISE_PATTERNS = /\b(jsdoc|comment|typo|spelling|whitespace|import order|sort import|lint|format|prettier|eslint|tslint)\b/i;
    if (
      NOISE_PATTERNS.test(proposal.title) &&
      (rawCategory === 'docs' || rawCategory === 'cleanup') &&
      (proposal.confidence ?? 50) < 80
    ) {
      return null;
    }

    // Ensure arrays
    proposal.acceptance_criteria = Array.isArray(proposal.acceptance_criteria)
      ? proposal.acceptance_criteria
      : [];
    proposal.verification_commands = Array.isArray(proposal.verification_commands)
      ? proposal.verification_commands
      : [];
    proposal.allowed_paths = Array.isArray(proposal.allowed_paths)
      ? proposal.allowed_paths
      : [];
    proposal.files = Array.isArray(proposal.files)
      ? proposal.files
      : [];

    // Validate minimum requirements
    if (proposal.acceptance_criteria.length === 0) {
      proposal.acceptance_criteria = ['Implementation verified by tests'];
    }

    // Ensure at least default verification commands (category-appropriate)
    if (proposal.verification_commands.length === 0) {
      proposal.verification_commands = [...getDefaultVerificationCommands(rawCategory)];
    }

    // Ensure allowed_paths
    if (proposal.allowed_paths.length === 0 && proposal.files.length > 0) {
      proposal.allowed_paths = [...proposal.files];
    }

    // For test proposals, expand allowed_paths to include test file locations
    // Combine files and allowed_paths since LLM may list source files in 'files' but test files in 'allowed_paths'
    if (proposal.category === 'test') {
      const allPaths = [...new Set([...proposal.allowed_paths, ...proposal.files])];
      proposal.allowed_paths = expandPathsForTests(allPaths);

      // Always allow config files for test tickets
      const configFiles = [
        'package.json',
        'package-lock.json',
        'tsconfig.json',
        'vitest.config.ts',
        'vitest.config.js',
        'vitest.config.mts',
        'vitest.config.mjs',
        'jest.config.ts',
        'jest.config.js',
        'jest.config.mjs',
        'jest.config.json',
      ];
      for (const configFile of configFiles) {
        if (!proposal.allowed_paths.includes(configFile)) {
          proposal.allowed_paths.push(configFile);
        }
      }
    }

    // Generate ID
    proposal.id = `scout-${Date.now()}-${nanoid(6)}`;

    // Normalize confidence
    proposal.confidence = Math.max(0, Math.min(100, proposal.confidence || 50));

    // Normalize impact_score (optional, 1-10)
    if (proposal.impact_score !== null && proposal.impact_score !== undefined) {
      proposal.impact_score = Math.max(1, Math.min(10, proposal.impact_score));
    }

    // Validate complexity
    const validComplexities = ['trivial', 'simple', 'moderate', 'complex'];
    if (!validComplexities.includes(proposal.estimated_complexity)) {
      proposal.estimated_complexity = 'simple';
    }

    // Normalize target_symbols (optional, for symbol-aware conflict detection)
    if (proposal.target_symbols && !Array.isArray(proposal.target_symbols)) {
      proposal.target_symbols = undefined;
    }

    // Normalize risk_assessment and severity
    const rawAssessment = (raw as Record<string, unknown>).risk_assessment;
    if (rawAssessment && isValidRiskAssessment(rawAssessment)) {
      proposal.risk_assessment = rawAssessment;
      proposal.severity = deriveSeverity(rawAssessment);
    } else {
      const validSeverities = ['blocking', 'degrading', 'polish', 'speculative'];
      if (!proposal.severity || !validSeverities.includes(proposal.severity)) {
        proposal.severity = inferSeverity(proposal.category, proposal.description);
      }
    }

    return proposal;
  } catch (err) {
    if (process.env.PROMPTWHEEL_VERBOSE) {
      console.error(`normalizeProposal failed: ${err instanceof Error ? err.message : err}`);
    }
    return null;
  }
}

/**
 * Scout a codebase for improvement opportunities
 */
export async function scout(options: ScoutOptions): Promise<ScoutResult> {
  const {
    scope,
    types,
    excludeTypes,
    exclude = [],
    maxProposals = 10,
    minConfidence = 50,
    projectPath = process.cwd(),
    timeoutMs: userTimeoutMs,
    signal,
    onProgress,
    recentlyCompletedTitles,
    model,
    customPrompt,
    backend,
    protectedFiles,
    scoutConcurrency,
    coverageContext,
  } = options;

  // Detect project verification commands once for all proposals
  _projectVerificationCommands = detectVerificationCommands(projectPath);

  const scoutBackend: ScoutBackend = backend ?? new ClaudeScoutBackend();
  // Codex needs more time per batch: cold start + large token-packed batches
  // Claude gets 180s (up from 120s) — complex batches in large repos need the headroom
  const defaultTimeout = scoutBackend.name === 'codex' ? 600000 : 180000;
  const timeoutMs = userTimeoutMs ?? defaultTimeout;

  const startTime = Date.now();
  const errors: string[] = [];
  const proposals: TicketProposal[] = [];

  // Report progress
  const report = (progress: Partial<ScoutProgress>) => {
    onProgress?.({
      phase: 'discovering',
      filesScanned: 0,
      totalFiles: 0,
      proposalsFound: 0,
      currentBatch: 0,
      totalBatches: 0,
      ...progress,
    });
  };

  try {
    // Phase 1: Discover files
    report({ phase: 'discovering' });

    let files = scanFiles({
      cwd: projectPath,
      include: [scope],
      exclude,
      maxFiles: options.maxFiles ?? 60,
    });

    // Incremental scanning: restrict to changed files when provided
    if (options.changedFiles && options.changedFiles.length > 0) {
      const changedSet = new Set(options.changedFiles.map(f => f.replace(/\\/g, '/')));
      files = files.filter(f => changedSet.has(f.path.replace(/\\/g, '/')));
    }

    if (files.length === 0) {
      return {
        success: true,
        proposals: [],
        errors: ['No files found matching scope'],
        scannedFiles: 0,
        scanDurationMs: Date.now() - startTime,
      };
    }

    report({
      phase: 'analyzing',
      totalFiles: files.length,
    });

    // Phase 2: Batch files and analyze
    const backendName = scoutBackend.name;
    const defaultBudget = backendName === 'codex' ? 20000 : 10000;
    const budget = options.batchTokenBudget ?? defaultBudget;
    const batches = options.moduleGroups?.length
      ? batchFilesByModule(files, options.moduleGroups, budget)
      : batchFilesByTokens(files, budget);
    const maxBatches = Math.min(batches.length, 50); // Cap at 50 batches

    // Track last-seen sector reclassification across batches
    let lastSectorReclassification: { production?: boolean; confidence?: string } | undefined;

    // Helper to process a single batch result
    const processBatchResult = (result: import('./runner.js').RunnerResult, batchIndex: number) => {
      if (!result.success) {
        errors.push(`Batch ${batchIndex + 1} failed: ${result.error}`);
        return;
      }

      const parsed = parseClaudeOutput<{ proposals: Record<string, unknown>[]; sector_reclassification?: { production?: boolean; confidence?: string } }>(result.output);

      // Capture sector reclassification if present
      if (parsed?.sector_reclassification) {
        lastSectorReclassification = parsed.sector_reclassification;
      }

      if (!parsed?.proposals) {
        errors.push(`Batch ${batchIndex + 1}: Failed to parse output`);
        return;
      }

      for (const raw of parsed.proposals) {
        const proposal = normalizeProposal(raw);
        if (!proposal) continue;

        if (types?.length && !types.includes(proposal.category)) continue;
        if (excludeTypes?.length && excludeTypes.includes(proposal.category)) continue;
        if (proposal.confidence < minConfidence) continue;

        const isDuplicate = proposals.some(p => {
          const titleA = p.title.toLowerCase();
          const titleB = proposal.title.toLowerCase();
          return titleA === titleB || bigramSimilarity(titleA, titleB) >= 0.65;
        });
        if (isDuplicate) continue;

        proposals.push(proposal);
        if (proposals.length >= maxProposals) break;
      }
    };

    // Build all prompts upfront
    const batchSlice = batches.slice(0, maxBatches);
    const allPrompts = batchSlice.map(batch =>
      buildScoutPrompt({
        files: batch.map(f => ({ path: f.path, content: f.content })),
        scope,
        types,
        excludeTypes,
        maxProposals: Math.min(10, maxProposals),
        minConfidence,
        recentlyCompletedTitles,
        customPrompt,
        protectedFiles,
        coverageContext,
        customRules: options.customRules,
        fixContext: options.fixContext,
      })
    );

    // Optimization 2 path: if backend supports runAll(), use single session
    if (scoutBackend.runAll) {
      let filesProcessed = 0;
      for (const batch of batchSlice) filesProcessed += batch.length;
      report({
        phase: 'analyzing',
        filesScanned: filesProcessed,
        totalFiles: files.length,
        proposalsFound: 0,
        currentBatch: 1,
        totalBatches: maxBatches,
      });

      const allOptions = allPrompts.map((prompt, i) => ({
        prompt, cwd: projectPath, timeoutMs, model, signal,
        onRawOutput: options.onRawOutput ? (chunk: string) => options.onRawOutput!(i, chunk) : undefined,
      }));
      const results = await scoutBackend.runAll(allOptions);
      for (let i = 0; i < results.length; i++) {
        processBatchResult(results[i], i);
      }
    } else {
      // Optimization 1: parallel semaphore-gated batch loop
      const concurrency = scoutConcurrency ?? (scoutBackend.name === 'codex' ? 4 : 3);

      let permits = concurrency;
      const waiting: Array<() => void> = [];
      const acquire = async () => {
        if (permits > 0) { permits--; return; }
        return new Promise<void>(r => { waiting.push(r); });
      };
      const release = () => {
        if (waiting.length > 0) waiting.shift()!(); else permits++;
      };

      // Pre-compute cumulative file counts per batch for accurate progress
      const cumulativeFiles: number[] = [];
      let cumSum = 0;
      for (const batch of batchSlice) {
        cumSum += batch.length;
        cumulativeFiles.push(cumSum);
      }

      let batchesCompleted = 0;

      // Per-batch status tracking for multi-line display
      const batchStatuses: Array<{ index: number; status: 'waiting' | 'running' | 'done' | 'failed'; proposals?: number; startedAt?: number; durationMs?: number; error?: string }> =
        batchSlice.map((_, i) => ({ index: i, status: 'waiting' as const }));

      const emitProgress = () => {
        report({
          phase: 'analyzing',
          filesScanned: cumulativeFiles[Math.min(batchesCompleted, batchSlice.length - 1)] ?? 0,
          totalFiles: files.length,
          proposalsFound: proposals.length,
          batchStatuses: [...batchStatuses],
          totalBatches: maxBatches,
        });
      };

      emitProgress();

      const tasks = batchSlice.map(async (batch, i) => {
        await acquire();
        try {
          if (signal?.aborted || proposals.length >= maxProposals) return;

          batchStatuses[i] = { index: i, status: 'running', startedAt: Date.now() };
          emitProgress();

          const result = await scoutBackend.run({
            prompt: allPrompts[i],
            cwd: projectPath,
            timeoutMs,
            model,
            signal,
            onRawOutput: options.onRawOutput ? (chunk: string) => options.onRawOutput!(i, chunk) : undefined,
          });

          // JS is single-threaded between awaits — safe to mutate proposals
          const beforeCount = proposals.length;
          batchesCompleted++;
          processBatchResult(result, i);
          const batchProposals = proposals.length - beforeCount;

          if (result.success) {
            batchStatuses[i] = { index: i, status: 'done', proposals: batchProposals, durationMs: Date.now() - (batchStatuses[i].startedAt ?? Date.now()) };
          } else {
            batchStatuses[i] = { index: i, status: 'failed', error: result.error, durationMs: Date.now() - (batchStatuses[i].startedAt ?? Date.now()) };
          }
          emitProgress();
        } finally {
          release();
        }
      });

      await Promise.allSettled(tasks);
    }

    // Sort proposals by impact * confidence * severity weight (descending)
    const SEVERITY_WEIGHT: Record<string, number> = { blocking: 3, degrading: 2, polish: 1, speculative: 0.5 };
    proposals.sort((a, b) => {
      const sevA = SEVERITY_WEIGHT[(a as { severity?: string }).severity ?? 'polish'] ?? 1;
      const sevB = SEVERITY_WEIGHT[(b as { severity?: string }).severity ?? 'polish'] ?? 1;
      const scoreA = (a.impact_score ?? 5) * a.confidence * sevA;
      const scoreB = (b.impact_score ?? 5) * b.confidence * sevB;
      return scoreB - scoreA;
    });

    // Phase 3: Complete
    report({
      phase: 'complete',
      filesScanned: files.length,
      totalFiles: files.length,
      proposalsFound: proposals.length,
      currentBatch: maxBatches,
      totalBatches: maxBatches,
    });

    return {
      success: true,
      proposals,
      errors,
      scannedFiles: files.length,
      scanDurationMs: Date.now() - startTime,
      sectorReclassification: lastSectorReclassification,
    };

  } catch (error) {
    return {
      success: false,
      proposals,
      errors: [...errors, error instanceof Error ? error.message : String(error)],
      scannedFiles: 0,
      scanDurationMs: Date.now() - startTime,
    };
  }
}
