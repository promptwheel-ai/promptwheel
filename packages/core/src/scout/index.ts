/**
 * Scout service - Analyzes codebases and generates improvement proposals
 *
 * This is the core scout implementation that works with any DatabaseAdapter.
 */

import { nanoid } from '../utils/id.js';
import { buildScoutPrompt } from './prompt.js';
import { runClaude, parseClaudeOutput, ClaudeScoutBackend, type ScoutBackend } from './runner.js';
import { scanFiles, batchFiles, batchFilesByTokens, type ScannedFile } from './scanner.js';
import type {
  ScoutOptions,
  ScoutResult,
  ScoutProgress,
  TicketProposal,
  ProposalCategory,
} from './types.js';

export * from './types.js';
export { buildScoutPrompt, buildCategoryPrompt } from './prompt.js';
export { runClaude, parseClaudeOutput, ClaudeScoutBackend, CodexScoutBackend, type ScoutBackend } from './runner.js';
export { scanFiles, batchFiles, batchFilesByTokens, estimateTokens, type ScannedFile } from './scanner.js';

/**
 * Default verification commands by category
 */
const DEFAULT_VERIFICATION_COMMANDS: Record<ProposalCategory, string[]> = {
  refactor: ['npm run build'],
  docs: ['npm run build'],
  test: ['npm run build', 'npm test'],
  perf: ['npm run build'],
  security: ['npm run build'],
};

/**
 * Sanitize verification commands to prevent predictable failures
 */
function sanitizeVerificationCommands(
  commands: string[],
  category: ProposalCategory
): string[] {
  const sanitized = commands.filter(cmd => {
    const lower = cmd.toLowerCase();
    // Remove fragile commands
    if (lower.includes('grep ') || lower.includes('wc ')) return false;
    // Remove file-specific test commands (often fail)
    if (lower.includes('npm test --') || lower.includes('npm test -- ')) return false;
    // Remove npm test for non-test categories (wastes time)
    if (category !== 'test' && lower.includes('npm test')) return false;
    return true;
  });

  // Ensure at least the default commands
  if (sanitized.length === 0) {
    return DEFAULT_VERIFICATION_COMMANDS[category];
  }

  return sanitized;
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

    // Validate category
    const validCategories: ProposalCategory[] = ['refactor', 'docs', 'test', 'perf', 'security'];
    if (!validCategories.includes(proposal.category)) {
      return null;
    }

    // Filter by category if specified
    if (category && proposal.category !== category) {
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

    // Sanitize verification commands
    proposal.verification_commands = sanitizeVerificationCommands(
      proposal.verification_commands,
      proposal.category
    );

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

    return proposal;
  } catch {
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
  } = options;

  const scoutBackend: ScoutBackend = backend ?? new ClaudeScoutBackend();
  // Codex needs more time per batch since batches are larger with token-based packing
  const defaultTimeout = scoutBackend.name === 'codex' ? 300000 : 120000;
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

    const files = scanFiles({
      cwd: projectPath,
      include: [scope],
      exclude,
      maxFiles: options.maxFiles ?? 60,
    });

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
    const batches = batchFilesByTokens(files, budget);
    const maxBatches = Math.min(batches.length, 20); // Cap at 20 batches

    let filesProcessed = 0;
    for (let i = 0; i < maxBatches; i++) {
      // Check for cancellation
      if (signal?.aborted) {
        errors.push('Scan aborted by user');
        break;
      }

      // Check if we have enough proposals
      if (proposals.length >= maxProposals) {
        break;
      }

      const batch = batches[i];
      report({
        phase: 'analyzing',
        filesScanned: filesProcessed,
        totalFiles: files.length,
        proposalsFound: proposals.length,
        currentBatch: i + 1,
        totalBatches: maxBatches,
        currentFile: batch[0]?.path,
      });
      filesProcessed += batch.length;

      // Build prompt for this batch
      const prompt = buildScoutPrompt({
        files: batch.map(f => ({ path: f.path, content: f.content })),
        scope,
        types,
        excludeTypes,
        maxProposals: Math.min(5, maxProposals - proposals.length),
        minConfidence,
        recentlyCompletedTitles,
        customPrompt,
        protectedFiles,
      });

      // Run scout backend
      const result = await scoutBackend.run({
        prompt,
        cwd: projectPath,
        timeoutMs,
        model,
        signal,
      });

      if (!result.success) {
        errors.push(`Batch ${i + 1} failed: ${result.error}`);
        continue;
      }

      // Parse output
      const parsed = parseClaudeOutput<{ proposals: Record<string, unknown>[] }>(result.output);
      if (!parsed?.proposals) {
        errors.push(`Batch ${i + 1}: Failed to parse output`);
        continue;
      }

      // Normalize and filter proposals
      for (const raw of parsed.proposals) {
        const proposal = normalizeProposal(raw, types?.[0]);
        if (!proposal) continue;

        // Apply category filters
        if (types?.length && !types.includes(proposal.category)) continue;
        if (excludeTypes?.length && excludeTypes.includes(proposal.category)) continue;

        // Apply confidence filter
        if (proposal.confidence < minConfidence) continue;

        // Check for duplicates (by title similarity)
        const isDuplicate = proposals.some(
          p => p.title.toLowerCase() === proposal.title.toLowerCase()
        );
        if (isDuplicate) continue;

        proposals.push(proposal);

        if (proposals.length >= maxProposals) break;
      }
    }

    // Sort proposals by impact * confidence (descending)
    proposals.sort((a, b) => {
      const scoreA = (a.impact_score ?? 5) * a.confidence;
      const scoreB = (b.impact_score ?? 5) * b.confidence;
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
