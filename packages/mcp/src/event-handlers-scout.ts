import type { EventContext, ProcessResult } from './event-helpers.js';
import { loadSectorsState, atomicWriteJsonSync } from './event-helpers.js';
import { isRecord, toBooleanOrUndefined, toNumberOrUndefined, toStringArrayOrUndefined, toStringOrUndefined } from './event-helpers.js';
import { repos, SCOUT_DEFAULTS } from '@promptwheel/core';
import { filterAndCreateTickets, parseReviewedProposals } from './proposals.js';
import type { RawProposal } from './proposals.js';
import { addLearning, extractTags } from './learnings.js';
import {
  recordScanResult as recordScanResultCore,
} from '@promptwheel/core/sectors/shared';

const MAX_SCOUT_RETRIES = SCOUT_DEFAULTS.MAX_SCOUT_RETRIES;

function isRawProposal(value: unknown): value is RawProposal {
  return isRecord(value);
}

export async function handleScoutOutput(ctx: EventContext, payload: Record<string, unknown>): Promise<ProcessResult> {
  const s = ctx.run.require();

  if (s.phase !== 'SCOUT') {
    return { processed: true, phase_changed: false, message: 'Scout output outside SCOUT phase, ignored' };
  }

  // Track explored directories for rotation across cycles
  const exploredDirs = toStringArrayOrUndefined(payload['explored_dirs']) ?? [];
  if (exploredDirs.length > 0) {
    for (const dir of exploredDirs) {
      if (!s.scouted_dirs.includes(dir)) {
        s.scouted_dirs.push(dir);
      }
    }
  }

  // Update coverage from codebase index + scouted dirs (production modules only)
  if (s.codebase_index) {
    const scoutedSet = new Set(s.scouted_dirs.map(d => d.replace(/\/$/, '')));
    let scannedSectors = 0;
    let scannedFiles = 0;
    let totalFiles = 0;
    let totalSectors = 0;
    for (const mod of s.codebase_index.modules) {
      if (mod.production === false) continue;
      const fc = mod.production_file_count ?? mod.file_count ?? 0;
      totalFiles += fc;
      totalSectors++;
      if (scoutedSet.has(mod.path) || scoutedSet.has(mod.path + '/')) {
        scannedSectors++;
        scannedFiles += fc;
      }
    }
    s.sectors_scanned = scannedSectors;
    s.sectors_total = totalSectors;
    s.files_scanned = scannedFiles;
    s.files_total = totalFiles;
  }

  // Handle sector reclassification if present — use recordScanResult with 0 proposals
  const sectorReclass = (() => {
    const raw = payload['sector_reclassification'];
    if (!isRecord(raw)) return undefined;
    const production = toBooleanOrUndefined(raw['production']);
    const confidence = toStringOrUndefined(raw['confidence']);
    return { production, confidence };
  })();
  if (sectorReclass && (sectorReclass.confidence === 'medium' || sectorReclass.confidence === 'high') && exploredDirs.length > 0) {
    try {
      const loaded = loadSectorsState(ctx.run.rootPath);
      if (loaded) {
        const targetPath = exploredDirs[0].replace(/\/$/, '');
        const target = loaded.state.sectors.find(sec => sec.path === targetPath);
        if (target) {
          // Apply reclassification directly (recordScanResult would also bump scan counters)
          if (sectorReclass.production !== undefined) {
            target.production = sectorReclass.production;
          }
          target.classificationConfidence = sectorReclass.confidence;
          atomicWriteJsonSync(loaded.filePath, loaded.state);
        }
      }
    } catch (err) {
      console.warn(`[promptwheel] sector reclassification: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Fallback: if pending_proposals exist and the LLM sent review results
  // through SCOUT_OUTPUT instead of PROPOSALS_REVIEWED, redirect to the
  // PROPOSALS_REVIEWED handler.
  if (s.pending_proposals !== null) {
    // Path 1: structured reviewed_proposals array in payload
    const reviewedArray = Array.isArray(payload['reviewed_proposals']) ? payload['reviewed_proposals'] : undefined;
    if (Array.isArray(reviewedArray) && reviewedArray.length > 0) {
      return handleProposalsReviewed(ctx, payload);
    }
    // Path 2: XML <reviewed-proposals> block in payload text
    const payloadText = toStringOrUndefined(payload['text']);
    if (typeof payloadText === 'string' && payloadText.includes('<reviewed-proposals>')) {
      const parsed = parseReviewedProposals(payloadText);
      if (parsed && parsed.length > 0) {
        return handleProposalsReviewed(ctx, { reviewed_proposals: parsed });
      }
    }
  }

  // Extract proposals from payload
  const rawProposals = Array.isArray(payload['proposals']) ? payload['proposals'].filter(isRawProposal) : [];

  // Build exploration log entry (before empty-check so retries also get logged)
  const explorationSummary = toStringOrUndefined(payload['exploration_summary']) ?? '';
  const logEntry = explorationSummary
    ? `Attempt ${s.scout_retries + 1}: Explored ${exploredDirs.join(', ') || '(unknown)'}. Found ${rawProposals.length} proposals. ${explorationSummary}`
    : `Attempt ${s.scout_retries + 1}: Explored ${exploredDirs.join(', ') || '(unknown)'}. Found ${rawProposals.length} proposals.`;
  s.scout_exploration_log.push(logEntry);

  // Update sector scan stats if a sector was selected for this cycle.
  // This must happen BEFORE the empty-proposals check so that zero-yield
  // sectors are still recorded — otherwise rotation keeps picking the same
  // exhausted sector indefinitely.
  if (s.selected_sector_path) {
    try {
      const loaded = loadSectorsState(ctx.run.rootPath);
      if (loaded) {
        recordScanResultCore(loaded.state, s.selected_sector_path, s.scout_cycles, rawProposals.length);
        atomicWriteJsonSync(loaded.filePath, loaded.state);
      }
    } catch (err) {
      console.warn(`[promptwheel] record sector scan stats: ${err instanceof Error ? err.message : String(err)}`);
    }
    s.current_sector_path = s.selected_sector_path;
    s.selected_sector_path = undefined;
    s.selected_sector_polished = false;
  }

  if (rawProposals.length === 0) {
    // Polished sectors don't get retries — they've been scanned 5+ times
    // with consistently low yield; retrying wastes LLM calls
    const effectiveMaxRetries = s.selected_sector_polished ? 0 : MAX_SCOUT_RETRIES;

    if (s.scout_retries < effectiveMaxRetries) {
      s.scout_retries++;
      // Stay in SCOUT phase — advance() will return an escalated prompt
      return {
        processed: true,
        phase_changed: false,
        message: `No proposals found (attempt ${s.scout_retries}/${effectiveMaxRetries + 1}). Retrying with deeper analysis.`,
      };
    }

    // Retries exhausted — try next cycle if budget allows
    if (s.scout_cycles < s.max_cycles) {
      const attempts = s.scout_retries + 1;
      s.scout_retries = 0;
      s.scout_exploration_log = [];
      // Stay in SCOUT — advance() will pick a new sector for the next cycle
      return {
        processed: true,
        phase_changed: false,
        message: `No proposals after ${attempts} attempt(s). Moving to next cycle.`,
      };
    }

    // No cycles remaining — genuinely done
    ctx.run.setPhase('DONE');
    return {
      processed: true,
      phase_changed: true,
      new_phase: 'DONE',
      message: 'No proposals in scout output after all retries, transitioning to DONE',
    };
  }

  // skip_review: create tickets directly without adversarial review pass
  if (s.skip_review) {
    ctx.run.saveArtifact(
      `${s.step_count}-scout-proposals.json`,
      JSON.stringify({ raw: rawProposals, skip_review: true }, null, 2),
    );

    const result = await filterAndCreateTickets(ctx.run, ctx.db, rawProposals);

    if (result.created_ticket_ids.length > 0) {
      s.scout_retries = 0;
      ctx.run.setPhase('NEXT_TICKET');
      return {
        processed: true,
        phase_changed: true,
        new_phase: 'NEXT_TICKET',
        message: `Created ${result.created_ticket_ids.length} tickets (review skipped, ${result.rejected.length} rejected)`,
      };
    }

    // All proposals rejected
    if (s.scout_retries < MAX_SCOUT_RETRIES) {
      s.scout_retries++;
      return {
        processed: true,
        phase_changed: false,
        message: `All proposals rejected (review skipped, attempt ${s.scout_retries}/${MAX_SCOUT_RETRIES + 1}). Retrying.`,
      };
    }
    ctx.run.setPhase('DONE');
    return {
      processed: true,
      phase_changed: true,
      new_phase: 'DONE',
      message: `All proposals rejected (review skipped) after all retries`,
    };
  }

  // Store proposals as pending for adversarial review (instead of creating tickets immediately)
  s.pending_proposals = rawProposals;

  // Save proposals artifact
  ctx.run.saveArtifact(
    `${s.step_count}-scout-proposals.json`,
    JSON.stringify({ raw: rawProposals, pending_review: true }, null, 2),
  );

  return {
    processed: true,
    phase_changed: false,
    message: `${rawProposals.length} proposals pending adversarial review`,
  };
}

export async function handleProposalsReviewed(ctx: EventContext, payload: Record<string, unknown>): Promise<ProcessResult> {
  const s = ctx.run.require();

  if (s.phase !== 'SCOUT') {
    return { processed: true, phase_changed: false, message: 'PROPOSALS_REVIEWED outside SCOUT phase, ignored' };
  }

  const pendingProposals = s.pending_proposals;
  if (!pendingProposals || pendingProposals.length === 0) {
    return { processed: true, phase_changed: false, message: 'No pending proposals to review' };
  }

  // Apply revised scores from review
  const reviewedItems: Array<{
    title?: string;
    confidence?: number;
    impact_score?: number;
    review_note?: string;
  }> = [];
  const rawReviewedItems = Array.isArray(payload['reviewed_proposals']) ? payload['reviewed_proposals'] : [];
  for (const item of rawReviewedItems) {
    if (!isRecord(item)) continue;
    reviewedItems.push({
      title: toStringOrUndefined(item['title']),
      confidence: toNumberOrUndefined(item['confidence']),
      impact_score: toNumberOrUndefined(item['impact_score']),
      review_note: toStringOrUndefined(item['review_note']),
    });
  }

  // Merge reviewed scores back into pending proposals
  for (const reviewed of reviewedItems) {
    if (!reviewed.title) continue;
    const match = pendingProposals.find(p => p.title === reviewed.title);
    if (match) {
      // Record learning if confidence lowered >20 pts
      if (s.learnings_enabled && typeof reviewed.confidence === 'number' && typeof match.confidence === 'number') {
        const drop = match.confidence - reviewed.confidence;
        if (drop > 20) {
          addLearning(ctx.run.rootPath, {
            text: `Proposal "${reviewed.title}" had inflated confidence (${match.confidence}→${reviewed.confidence})`,
            category: 'warning',
            source: { type: 'review_downgrade', detail: reviewed.review_note },
            tags: extractTags(match.files ?? match.allowed_paths ?? [], []),
            structured: {
              root_cause: reviewed.review_note ?? `Confidence inflated by ${drop} points`,
              applies_to: match.allowed_paths?.[0],
            },
          });
        }
      }
      if (typeof reviewed.confidence === 'number') match.confidence = reviewed.confidence;
      if (typeof reviewed.impact_score === 'number') match.impact_score = reviewed.impact_score;
    }
  }

  // Clear pending
  s.pending_proposals = null;

  // Now filter and create tickets with revised scores
  const result = await filterAndCreateTickets(ctx.run, ctx.db, pendingProposals);

  // Update exploration log with rejection info
  const lastIdx = s.scout_exploration_log.length - 1;
  if (lastIdx >= 0) {
    s.scout_exploration_log[lastIdx] += ` ${result.accepted.length} accepted, ${result.rejected.length} rejected (${result.rejected.map(r => r.reason).slice(0, 3).join('; ')}).`;
  }

  // Save reviewed artifact
  ctx.run.saveArtifact(
    `${s.step_count}-scout-proposals-reviewed.json`,
    JSON.stringify({ reviewed: reviewedItems, result }, null, 2),
  );

  if (result.created_ticket_ids.length > 0) {
    s.scout_retries = 0;
    ctx.run.setPhase('NEXT_TICKET');
    return {
      processed: true,
      phase_changed: true,
      new_phase: 'NEXT_TICKET',
      message: `Created ${result.created_ticket_ids.length} tickets after review (${result.rejected.length} rejected)`,
    };
  }

  // All proposals rejected after review
  if (s.scout_retries < MAX_SCOUT_RETRIES) {
    s.scout_retries++;
    return {
      processed: true,
      phase_changed: false,
      message: `All proposals rejected after review (attempt ${s.scout_retries}/${MAX_SCOUT_RETRIES + 1}). Retrying.`,
    };
  }
  ctx.run.setPhase('DONE');
  return {
    processed: true,
    phase_changed: true,
    new_phase: 'DONE',
    message: `All proposals rejected after review and all retries: ${result.rejected.map(r => r.reason).join('; ')}`,
  };
}

export async function handleProposalsFiltered(ctx: EventContext, _payload: Record<string, unknown>): Promise<ProcessResult> {
  const s = ctx.run.require();

  // Emitted after proposal filtering.
  // Check if we have ready tickets now.
  const readyCount = await repos.tickets.countByStatus(ctx.db, s.project_id);
  const ready = isRecord(readyCount) && typeof readyCount['ready'] === 'number' ? readyCount['ready'] : 0;
  if (ready > 0 && s.phase === 'SCOUT') {
    ctx.run.setPhase('NEXT_TICKET');
    return {
      processed: true,
      phase_changed: true,
      new_phase: 'NEXT_TICKET',
      message: `${ready} tickets ready, transitioning to NEXT_TICKET`,
    };
  }
  if (ready === 0 && s.phase === 'SCOUT') {
    ctx.run.setPhase('DONE');
    return {
      processed: true,
      phase_changed: true,
      new_phase: 'DONE',
      message: 'No proposals accepted, transitioning to DONE',
    };
  }
  return { processed: true, phase_changed: false, message: 'Proposals filtered' };
}
