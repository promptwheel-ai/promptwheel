/**
 * Scout phase for auto mode: build context, execute scout, handle results.
 */

import chalk from 'chalk';
import type { ScoutProgress } from '@blockspool/core/services';
import type { TicketProposal, ProposalCategory } from '@blockspool/core/scout';
import { scoutRepo } from '@blockspool/core/services';
import type { AutoSessionState } from './solo-auto-state.js';
import { getNextScope } from './solo-auto-state.js';
import { formatElapsed } from './solo-auto-utils.js';
import { getQualityRate, readRunState } from './run-state.js';
import { createSpinner, createBatchProgress, type BatchProgressDisplay } from './spinner.js';
import { formatProgress } from './solo-config.js';
import { consumePendingHints } from './solo-hints.js';
import { formatGuidelinesForPrompt } from './guidelines.js';
import { selectRelevant, formatLearningsForPrompt, extractTags, addLearning } from './learnings.js';
import { formatIndexForPrompt } from './codebase-index.js';
import { formatMetadataForPrompt } from './project-metadata/index.js';
import { formatDedupForPrompt } from './dedup-memory.js';
import { buildScoutEscalation } from './wave-scheduling.js';
import {
  recordScanResult, saveSectors, computeCoverage, buildSectorSummary,
  getSectorDifficulty, getSectorCategoryAffinity,
} from './sectors.js';
import { getDeduplicationContext } from './dedup.js';
import { buildCycleContextBlock } from './cycle-context.js';
import { formatTasteForPrompt } from './taste-profile.js';
import { sleep } from './dedup.js';

export interface ScoutResult {
  proposals: TicketProposal[];
  scoutResult: Awaited<ReturnType<typeof scoutRepo>>;
  scope: string;
  cycleFormula: import('./formulas.js').Formula | null;
  isDeepCycle: boolean;
  isDocsAuditCycle: boolean;
  shouldRetry: boolean;
  shouldBreak: boolean;
}

export async function runScoutPhase(state: AutoSessionState): Promise<ScoutResult> {
  const scope = getNextScope(state);

  // Cycle header
  if (state.cycleCount > 1) {
    console.log();
    console.log(chalk.blue(`━━━ Cycle ${state.cycleCount} ━━━`));
    console.log(chalk.gray(`  Elapsed: ${formatElapsed(Date.now() - state.startTime)}`));
    if (state.milestoneMode) {
      console.log(chalk.gray(`  Milestone PRs: ${state.totalMilestonePrs}/${state.maxPrs} (${state.totalPrsCreated} tickets merged)`));
    } else {
      console.log(chalk.gray(`  PRs created: ${state.totalPrsCreated}/${state.maxPrs}`));
    }
    if (state.endTime) {
      const remaining = Math.max(0, state.endTime - Date.now());
      console.log(chalk.gray(`  Time remaining: ${formatElapsed(remaining)}`));
    }
    console.log();
  }

  const dedupContext = await getDeduplicationContext(state.adapter, state.project.id, state.repoRoot);

  const cycleFormula = state.getCycleFormula(state.cycleCount);
  state.currentFormulaName = cycleFormula?.name ?? 'default';
  const { allow: allowCategories, block: blockCategories } = state.getCycleCategories(cycleFormula);
  const isDeepCycle = cycleFormula?.name === 'deep' && cycleFormula !== state.activeFormula;
  const isDocsAuditCycle = cycleFormula?.name === 'docs-audit' && cycleFormula !== state.activeFormula;

  const cycleSuffix = isDeepCycle ? ' 🔬 deep' : isDocsAuditCycle ? ' 📄 docs-audit' : '';
  const cycleLabel = state.maxCycles > 1 || state.isContinuous
    ? `[Cycle ${state.cycleCount}]${cycleSuffix} `
    : 'Step 1: ';
  const spinner = createSpinner(`Scouting ${scope}...`, 'stack');
  console.log(chalk.bold(`${cycleLabel}Scouting ${scope}...`));

  // Consume pending hints
  const hintBlock = consumePendingHints(state.repoRoot);
  if (hintBlock) {
    const hintCount = hintBlock.split('\n').filter(l => l.startsWith('- ')).length;
    console.log(chalk.yellow(`[Hints] Applying ${hintCount} user hint(s) to this scout cycle`));
  }

  let lastProgress = '';
  const batchProgressRef: { current: BatchProgressDisplay | null } = { current: null };
  const scoutPath = (state.milestoneMode && state.milestoneWorktreePath) ? state.milestoneWorktreePath : state.repoRoot;
  const guidelinesPrefix = state.guidelines ? formatGuidelinesForPrompt(state.guidelines) + '\n\n' : '';
  const learningsPrefix = state.autoConf.learningsEnabled
    ? formatLearningsForPrompt(selectRelevant(state.allLearnings, { paths: [scope] }), state.autoConf.learningsBudget)
    : '';
  const learningsSuffix = learningsPrefix ? learningsPrefix + '\n\n' : '';
  const indexPrefix = state.codebaseIndex ? formatIndexForPrompt(state.codebaseIndex, state.cycleCount) + '\n\n' : '';
  const metadataPrefix = state.metadataBlock ? state.metadataBlock + '\n\n' : '';
  const escalationPrefix = state.scoutRetries > 0
    ? buildScoutEscalation(state.scoutRetries, state.scoutedDirs, state.codebaseIndex, state.sectorState ?? undefined) + '\n\n'
    : '';
  const dedupPrefix = formatDedupForPrompt(state.dedupMemory);
  const dedupBlock = dedupPrefix ? dedupPrefix + '\n\n' : '';

  // Coverage context
  const coverageCtx = state.sectorState && state.currentSectorId
    ? (() => {
        const cov = computeCoverage(state.sectorState!);
        const sec = state.sectorState!.sectors.find(s => s.path === state.currentSectorId);
        return {
          sectorPath: state.currentSectorId!,
          scannedSectors: cov.scannedSectors,
          totalSectors: cov.totalSectors,
          percent: cov.percent,
          sectorPercent: cov.sectorPercent,
          classificationConfidence: sec?.classificationConfidence ?? 'low',
          scanCount: sec?.scanCount ?? 0,
          proposalYield: sec?.proposalYield ?? 0,
          sectorSummary: buildSectorSummary(state.sectorState!, state.currentSectorId!),
          sectorDifficulty: sec ? getSectorDifficulty(sec) : undefined,
          sectorCategoryAffinity: sec ? getSectorCategoryAffinity(sec) : undefined,
        };
      })()
    : undefined;

  // Cycle context
  const rs0 = readRunState(state.repoRoot);
  const cycleCtxBlock = buildCycleContextBlock(rs0.recentCycles ?? [], rs0.recentDiffs ?? []);
  const cycleCtxPrefix = cycleCtxBlock ? cycleCtxBlock + '\n\n' : '';

  // Taste profile
  const tastePrefix = state.tasteProfile ? formatTasteForPrompt(state.tasteProfile) + '\n\n' : '';

  const basePrompt = guidelinesPrefix + metadataPrefix + tastePrefix + indexPrefix + dedupBlock + cycleCtxPrefix + escalationPrefix + learningsSuffix + (cycleFormula?.prompt || '');
  const effectivePrompt = hintBlock ? (basePrompt + hintBlock) : (basePrompt || undefined);

  let scoutResult;
  try {
    scoutResult = await scoutRepo(state.deps, {
      path: scoutPath,
      scope,
      types: allowCategories.length <= 4 ? allowCategories as ProposalCategory[] : undefined,
      excludeTypes: allowCategories.length > 4 ? blockCategories as ProposalCategory[] : undefined,
      maxProposals: 20,
      minConfidence: state.effectiveMinConfidence,
      model: state.options.scoutBackend === 'codex' ? undefined : (state.options.eco ? 'sonnet' : (cycleFormula?.model ?? 'opus')),
      customPrompt: effectivePrompt,
      autoApprove: false,
      backend: state.scoutBackend,
      protectedFiles: ['.blockspool/**', ...(state.options.includeClaudeMd ? [] : ['CLAUDE.md', '.claude/**'])],
      batchTokenBudget: state.batchTokenBudget,
      timeoutMs: state.scoutTimeoutMs,
      maxFiles: state.maxScoutFiles,
      scoutConcurrency: state.scoutConcurrency,
      coverageContext: coverageCtx,
      moduleGroups: state.codebaseIndex?.modules.map(m => ({
        path: m.path,
        dependencies: state.codebaseIndex!.dependency_edges[m.path],
      })),
      onProgress: (progress: ScoutProgress) => {
        if (progress.batchStatuses && progress.totalBatches && progress.totalBatches > 1) {
          if (!batchProgressRef.current) {
            spinner.stop();
            batchProgressRef.current = createBatchProgress(progress.totalBatches);
          }
          batchProgressRef.current.update(progress.batchStatuses, progress.proposalsFound ?? 0);
        } else {
          const formatted = formatProgress(progress);
          if (formatted !== lastProgress) {
            spinner.update(formatted);
            lastProgress = formatted;
          }
        }
      },
    });
  } catch (scoutErr) {
    batchProgressRef.current?.stop();
    spinner.fail('Scout failed');
    throw scoutErr;
  }

  // Clean up batch progress
  if (batchProgressRef.current) {
    const count = scoutResult.proposals.length;
    batchProgressRef.current.stop(chalk.green(`Scouting complete — ${count} proposal${count !== 1 ? 's' : ''} found`));
  }

  // Record scan
  if (state.sectorState && state.currentSectorId) {
    recordScanResult(state.sectorState, state.currentSectorId, state.currentSectorCycle, scoutResult.proposals.length, scoutResult.sectorReclassification);
    saveSectors(state.repoRoot, state.sectorState);
    const cov = computeCoverage(state.sectorState);
    console.log(chalk.gray(`  Sector: ${state.currentSectorId} (${cov.scannedSectors}/${cov.totalSectors} scanned, ${cov.percent}% coverage)`));
    if (cov.sectorPercent >= 100) {
      console.log(chalk.gray(`  Full coverage — sector fully scanned`));
    }
  }

  // Mark sectors with no scannable files so they're never re-selected
  if (scoutResult.scannedFiles === 0 && state.sectorState && state.currentSectorId) {
    const sector = state.sectorState.sectors.find(s => s.path === state.currentSectorId);
    if (sector) {
      sector.fileCount = 0;
      sector.productionFileCount = 0;
      saveSectors(state.repoRoot, state.sectorState);
    }
  }

  const proposals = scoutResult.proposals;

  if (proposals.length === 0) {
    if (scoutResult.errors.length > 0) {
      spinner.fail('Scout encountered errors');
      for (const err of scoutResult.errors) {
        console.log(chalk.yellow(`  ⚠ ${err}`));
      }
      if (scoutResult.errors.length > 0 && state.autoConf.learningsEnabled) {
        for (const err of scoutResult.errors.slice(0, 3)) {
          addLearning(state.repoRoot, {
            text: `Scout error in ${scope}: ${err}`.slice(0, 200),
            category: 'warning',
            source: { type: 'ticket_failure', detail: 'scout_error' },
            tags: extractTags([scope], []),
          });
        }
      }
    } else {
      spinner.stop();
    }
    state.scoutedDirs.push(scope);
    const MAX_SCOUT_RETRIES = 2;
    if (state.scoutRetries < MAX_SCOUT_RETRIES) {
      state.scoutRetries++;
      console.log(chalk.gray(`  No improvements found in ${scope} (attempt ${state.scoutRetries}/${MAX_SCOUT_RETRIES + 1}). Retrying with fresh approach...`));
      await sleep(1000);
      return { proposals: [], scoutResult, scope, cycleFormula, isDeepCycle, isDocsAuditCycle, shouldRetry: true, shouldBreak: false };
    }
    state.scoutRetries = 0;
    state.scoutedDirs = [];
    if (state.isContinuous) {
      await sleep(2000);
    }
    const covMsg = state.sectorState
      ? (() => { const c = computeCoverage(state.sectorState!); return ` (${c.scannedSectors}/${c.totalSectors} sectors scanned, ${c.percent}% coverage)`; })()
      : '';
    console.log(chalk.green(`✓ No improvements found in this sector${covMsg}`));
    // Let shouldContinue() decide whether to loop or stop
    return { proposals: [], scoutResult, scope, cycleFormula, isDeepCycle, isDocsAuditCycle, shouldRetry: true, shouldBreak: false };
  }

  spinner.succeed(`Found ${proposals.length} potential improvements`);
  return { proposals, scoutResult, scope, cycleFormula, isDeepCycle, isDocsAuditCycle, shouldRetry: false, shouldBreak: false };
}
