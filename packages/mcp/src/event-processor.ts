/**
 * Event Processor — handles ingested events and triggers state transitions.
 *
 * When the client calls `blockspool_ingest_event`, this module processes
 * the event and updates RunState accordingly (phase transitions, counters, etc).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DatabaseAdapter } from '@blockspool/core';
import type { Project } from '@blockspool/core';
import { repos } from '@blockspool/core';
import { RunManager } from './run-manager.js';
import type { EventType, CommitPlan } from './types.js';
import { filterAndCreateTickets } from './proposals.js';
import type { RawProposal } from './proposals.js';
import { deriveScopePolicy, validatePlanScope } from './scope-policy.js';
import { recordOutput, recordDiff, recordCommandFailure, recordPlanHash } from './spindle.js';
import { addLearning, confirmLearning, extractTags } from './learnings.js';
import { recordDedupEntry } from './dedup-memory.js';
import { ingestTicketEvent } from './ticket-worker.js';

// ---------------------------------------------------------------------------
// Helpers — shared sector & dedup recording
// ---------------------------------------------------------------------------

function recordSectorOutcome(
  rootPath: string,
  sectorPath: string | undefined,
  outcome: 'success' | 'failure',
): void {
  if (!sectorPath) return;
  try {
    const sectorsPath = path.join(rootPath, '.blockspool', 'sectors.json');
    if (!fs.existsSync(sectorsPath)) return;
    const sectorsData = JSON.parse(fs.readFileSync(sectorsPath, 'utf8'));
    if (sectorsData?.version !== 2 || !Array.isArray(sectorsData.sectors)) return;
    const sector = sectorsData.sectors.find((sec: { path: string }) => sec.path === sectorPath);
    if (!sector) return;
    if (outcome === 'failure') {
      sector.failureCount = (sector.failureCount ?? 0) + 1;
    } else {
      sector.successCount = (sector.successCount ?? 0) + 1;
    }
    fs.writeFileSync(sectorsPath, JSON.stringify(sectorsData, null, 2), 'utf8');
  } catch {
    // Non-fatal
  }
}

async function recordTicketDedup(
  db: DatabaseAdapter,
  rootPath: string,
  ticketId: string | null,
  completed: boolean,
  reason?: string,
  /** Pass a pre-fetched ticket to avoid a redundant DB lookup */
  prefetchedTicket?: { title: string } | null,
): Promise<void> {
  if (!ticketId) return;
  try {
    const ticket = prefetchedTicket ?? await repos.tickets.getById(db, ticketId);
    if (ticket) {
      recordDedupEntry(rootPath, ticket.title, completed, reason);
    }
  } catch {
    // Non-fatal
  }
}

export interface ProcessResult {
  processed: boolean;
  phase_changed: boolean;
  new_phase?: string;
  message: string;
}

const MAX_SCOUT_RETRIES = 2;

export async function processEvent(
  run: RunManager,
  db: DatabaseAdapter,
  type: EventType,
  payload: Record<string, unknown>,
  project?: Project,
): Promise<ProcessResult> {
  const s = run.require();

  // ---------------------------------------------------------------------------
  // Parallel execution: forward ticket-specific events to ticket workers
  // ---------------------------------------------------------------------------
  // When in PARALLEL_EXECUTE phase, events like PR_CREATED, TICKET_RESULT, etc.
  // should be routed to the ticket worker, not processed at session level.
  // This handles the case where the user calls blockspool_ingest_event instead
  // of blockspool_ticket_event for ticket completion.
  const TICKET_WORKER_EVENTS = new Set([
    'PR_CREATED', 'TICKET_RESULT', 'PLAN_SUBMITTED', 'QA_PASSED', 'QA_FAILED', 'QA_COMMAND_RESULT',
  ]);

  if (s.phase === 'PARALLEL_EXECUTE' && TICKET_WORKER_EVENTS.has(type)) {
    const ticketId = payload['ticket_id'] as string | undefined;
    if (ticketId && run.getTicketWorker(ticketId)) {
      // Forward to ticket worker
      const ctx = { run, db, project: project ?? { id: s.project_id, rootPath: run.rootPath } as Project };
      const result = await ingestTicketEvent(ctx, ticketId, type, payload);
      return {
        processed: result.processed,
        phase_changed: false,
        message: result.message,
      };
    }
  }

  switch (type) {
    // -----------------------------------------------------------------
    // Scout events
    // -----------------------------------------------------------------
    case 'SCOUT_OUTPUT': {
      if (s.phase !== 'SCOUT') {
        return { processed: true, phase_changed: false, message: 'Scout output outside SCOUT phase, ignored' };
      }

      // Track explored directories for rotation across cycles
      const exploredDirs = (payload['explored_dirs'] ?? []) as string[];
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

      // Handle sector reclassification if present
      const sectorReclass = payload['sector_reclassification'] as { production?: boolean; confidence?: string } | undefined;
      if (sectorReclass && (sectorReclass.confidence === 'medium' || sectorReclass.confidence === 'high')) {
        try {
          const sectorsPath = path.join(run.rootPath, '.blockspool', 'sectors.json');
          if (fs.existsSync(sectorsPath)) {
            const sectorsData = JSON.parse(fs.readFileSync(sectorsPath, 'utf8'));
            if (sectorsData?.version === 2 && Array.isArray(sectorsData.sectors) && exploredDirs.length > 0) {
              const targetPath = exploredDirs[0].replace(/\/$/, '');
              const sector = sectorsData.sectors.find((sec: { path: string }) => sec.path === targetPath);
              if (sector) {
                if (sectorReclass.production !== undefined) {
                  sector.production = sectorReclass.production;
                }
                sector.classificationConfidence = sectorReclass.confidence;
                fs.writeFileSync(sectorsPath, JSON.stringify(sectorsData, null, 2), 'utf8');
              }
            }
          }
        } catch {
          // Non-fatal — sector reclassification is best-effort
        }
      }

      // Extract proposals from payload
      const rawProposals = (payload['proposals'] ?? []) as RawProposal[];

      // Build exploration log entry (before empty-check so retries also get logged)
      const explorationSummary = (payload['exploration_summary'] ?? '') as string;
      const logEntry = explorationSummary
        ? `Attempt ${s.scout_retries + 1}: Explored ${exploredDirs.join(', ') || '(unknown)'}. Found ${rawProposals.length} proposals. ${explorationSummary}`
        : `Attempt ${s.scout_retries + 1}: Explored ${exploredDirs.join(', ') || '(unknown)'}. Found ${rawProposals.length} proposals.`;
      s.scout_exploration_log.push(logEntry);

      if (rawProposals.length === 0) {
        if (s.scout_retries < MAX_SCOUT_RETRIES) {
          s.scout_retries++;
          // Stay in SCOUT phase — advance() will return an escalated prompt
          return {
            processed: true,
            phase_changed: false,
            message: `No proposals found (attempt ${s.scout_retries}/${MAX_SCOUT_RETRIES + 1}). Retrying with deeper analysis.`,
          };
        }
        // Exhausted retries — genuinely no work
        run.setPhase('DONE');
        return {
          processed: true,
          phase_changed: true,
          new_phase: 'DONE',
          message: 'No proposals in scout output after all retries, transitioning to DONE',
        };
      }

      // Update sector scan stats if a sector was selected for this cycle
      if (s.selected_sector_path) {
        try {
          const sectorsPath = path.join(run.rootPath, '.blockspool', 'sectors.json');
          if (fs.existsSync(sectorsPath)) {
            const sectorsData = JSON.parse(fs.readFileSync(sectorsPath, 'utf8'));
            if (sectorsData?.version === 2 && Array.isArray(sectorsData.sectors)) {
              const sector = sectorsData.sectors.find((sec: { path: string }) => sec.path === s.selected_sector_path);
              if (sector) {
                sector.lastScannedAt = Date.now();
                sector.lastScannedCycle = s.scout_cycles;
                sector.scanCount = (sector.scanCount ?? 0) + 1;
                sector.proposalYield = 0.7 * (sector.proposalYield ?? 0) + 0.3 * rawProposals.length;
                fs.writeFileSync(sectorsPath, JSON.stringify(sectorsData, null, 2), 'utf8');
              }
            }
          }
        } catch {
          // Non-fatal
        }
        s.current_sector_path = s.selected_sector_path;
        s.selected_sector_path = undefined;
      }

      // Store proposals as pending for adversarial review (instead of creating tickets immediately)
      s.pending_proposals = rawProposals;

      // Save proposals artifact
      run.saveArtifact(
        `${s.step_count}-scout-proposals.json`,
        JSON.stringify({ raw: rawProposals, pending_review: true }, null, 2),
      );

      return {
        processed: true,
        phase_changed: false,
        message: `${rawProposals.length} proposals pending adversarial review`,
      };
    }

    // -----------------------------------------------------------------
    // Proposal review (adversarial critique pass)
    // -----------------------------------------------------------------
    case 'PROPOSALS_REVIEWED': {
      if (s.phase !== 'SCOUT') {
        return { processed: true, phase_changed: false, message: 'PROPOSALS_REVIEWED outside SCOUT phase, ignored' };
      }

      const pendingProposals = s.pending_proposals;
      if (!pendingProposals || pendingProposals.length === 0) {
        return { processed: true, phase_changed: false, message: 'No pending proposals to review' };
      }

      // Apply revised scores from review
      const reviewedItems = (payload['reviewed_proposals'] ?? []) as Array<{
        title?: string;
        confidence?: number;
        impact_score?: number;
        review_note?: string;
      }>;

      // Merge reviewed scores back into pending proposals
      for (const reviewed of reviewedItems) {
        if (!reviewed.title) continue;
        const match = pendingProposals.find(p => p.title === reviewed.title);
        if (match) {
          // Record learning if confidence lowered >20 pts
          if (s.learnings_enabled && typeof reviewed.confidence === 'number' && typeof match.confidence === 'number') {
            const drop = match.confidence - reviewed.confidence;
            if (drop > 20) {
              addLearning(run.rootPath, {
                text: `Proposal "${reviewed.title}" had inflated confidence (${match.confidence}→${reviewed.confidence})`,
                category: 'warning',
                source: { type: 'review_downgrade', detail: reviewed.review_note },
                tags: extractTags(match.files ?? match.allowed_paths ?? [], []),
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
      const result = await filterAndCreateTickets(run, db, pendingProposals);

      // Update exploration log with rejection info
      const lastIdx = s.scout_exploration_log.length - 1;
      if (lastIdx >= 0) {
        s.scout_exploration_log[lastIdx] += ` ${result.accepted.length} accepted, ${result.rejected.length} rejected (${result.rejected.map(r => r.reason).slice(0, 3).join('; ')}).`;
      }

      // Save reviewed artifact
      run.saveArtifact(
        `${s.step_count}-scout-proposals-reviewed.json`,
        JSON.stringify({ reviewed: reviewedItems, result }, null, 2),
      );

      if (result.created_ticket_ids.length > 0) {
        s.scout_retries = 0;
        run.setPhase('NEXT_TICKET');
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
      run.setPhase('DONE');
      return {
        processed: true,
        phase_changed: true,
        new_phase: 'DONE',
        message: `All proposals rejected after review and all retries: ${result.rejected.map(r => r.reason).join('; ')}`,
      };
    }

    case 'PROPOSALS_FILTERED': {
      // Emitted after proposal filtering.
      // Check if we have ready tickets now.
      const readyCount = await repos.tickets.countByStatus(db, s.project_id);
      const ready = (readyCount as Record<string, number>)['ready'] ?? 0;
      if (ready > 0 && s.phase === 'SCOUT') {
        run.setPhase('NEXT_TICKET');
        return {
          processed: true,
          phase_changed: true,
          new_phase: 'NEXT_TICKET',
          message: `${ready} tickets ready, transitioning to NEXT_TICKET`,
        };
      }
      if (ready === 0 && s.phase === 'SCOUT') {
        run.setPhase('DONE');
        return {
          processed: true,
          phase_changed: true,
          new_phase: 'DONE',
          message: 'No proposals accepted, transitioning to DONE',
        };
      }
      return { processed: true, phase_changed: false, message: 'Proposals filtered' };
    }

    // -----------------------------------------------------------------
    // Plan events
    // -----------------------------------------------------------------
    case 'PLAN_SUBMITTED': {
      if (s.phase !== 'PLAN') {
        return { processed: true, phase_changed: false, message: 'Plan submitted outside PLAN phase, ignored' };
      }

      const raw = payload as Record<string, unknown>;
      // Coerce files_to_touch — accept files/touched_files as fallback names
      const rawFiles = Array.isArray(raw.files_to_touch) ? raw.files_to_touch
        : Array.isArray(raw.files) ? raw.files
        : Array.isArray(raw.touched_files) ? raw.touched_files : [];
      const files_to_touch = rawFiles.map((f: unknown) => {
        if (typeof f === 'string') return { path: f, action: 'modify' as const, reason: '' };
        if (f && typeof f === 'object' && 'path' in f) return f as { path: string; action: 'create' | 'modify' | 'delete'; reason: string };
        return { path: String(f), action: 'modify' as const, reason: '' };
      });
      const plan: CommitPlan = {
        ticket_id: String(raw.ticket_id ?? s.current_ticket_id ?? ''),
        files_to_touch,
        expected_tests: Array.isArray(raw.expected_tests) ? raw.expected_tests.map(String) : [],
        risk_level: (raw.risk_level === 'low' || raw.risk_level === 'medium' || raw.risk_level === 'high')
          ? raw.risk_level : 'low',
        estimated_lines: typeof raw.estimated_lines === 'number' ? raw.estimated_lines : 50,
      };

      // Derive scope policy for the current ticket
      const ticket = s.current_ticket_id
        ? await repos.tickets.getById(db, s.current_ticket_id)
        : null;

      const policy = deriveScopePolicy({
        allowedPaths: ticket?.allowedPaths ?? [],
        category: ticket?.category ?? 'refactor',
        maxLinesPerTicket: s.max_lines_per_ticket,
      });

      // Validate plan against scope policy
      const scopeResult = validatePlanScope(
        plan.files_to_touch,
        plan.estimated_lines,
        plan.risk_level,
        policy,
      );

      if (!scopeResult.valid) {
        s.plan_rejections++;
        run.appendEvent('PLAN_REJECTED', { reason: scopeResult.reason, attempt: s.plan_rejections });
        // Record learning on plan rejection
        if (s.learnings_enabled) {
          addLearning(run.rootPath, {
            text: `Plan rejected: ${scopeResult.reason}`.slice(0, 200),
            category: 'gotcha',
            source: { type: 'plan_rejection', detail: scopeResult.reason ?? undefined },
            tags: extractTags(plan.files_to_touch.map(f => f.path), []),
          });
        }
        return {
          processed: true,
          phase_changed: false,
          message: `Plan rejected: ${scopeResult.reason} (attempt ${s.plan_rejections}/${3})`,
        };
      }

      // Plan passed validation
      s.current_ticket_plan = plan;
      recordPlanHash(s.spindle, plan);

      // High-risk plans → BLOCKED_NEEDS_HUMAN
      if (plan.risk_level === 'high') {
        run.appendEvent('PLAN_REJECTED', { reason: 'High-risk plan requires human approval', risk_level: 'high' });
        run.setPhase('BLOCKED_NEEDS_HUMAN');
        return {
          processed: true,
          phase_changed: true,
          new_phase: 'BLOCKED_NEEDS_HUMAN',
          message: 'High-risk plan requires human approval',
        };
      }

      // Low/medium risk — auto-approve
      s.plan_approved = true;
      run.appendEvent('PLAN_APPROVED', { risk_level: plan.risk_level, auto: true });
      run.setPhase('EXECUTE');
      return {
        processed: true,
        phase_changed: true,
        new_phase: 'EXECUTE',
        message: `${plan.risk_level}-risk plan auto-approved, moving to EXECUTE`,
      };
    }

    // -----------------------------------------------------------------
    // Execution events
    // -----------------------------------------------------------------
    case 'TICKET_RESULT': {
      if (s.phase !== 'EXECUTE') {
        return { processed: true, phase_changed: false, message: 'Ticket result outside EXECUTE phase' };
      }

      const status = payload['status'] as string;

      // Accept both 'done' and 'success' as completion status
      if (status === 'done' || status === 'success') {
        // Validate changed_files against plan (if plan exists)
        const changedFiles = (payload['changed_files'] ?? []) as string[];
        const linesAdded = (payload['lines_added'] ?? 0) as number;
        const linesRemoved = (payload['lines_removed'] ?? 0) as number;
        const totalLines = linesAdded + linesRemoved;

        // Save ticket result artifact
        run.saveArtifact(
          `${s.step_count}-ticket-result.json`,
          JSON.stringify({
            status,
            changed_files: changedFiles,
            lines_added: linesAdded,
            lines_removed: linesRemoved,
            summary: payload['summary'],
          }, null, 2),
        );

        // Validate changed files against approved plan
        if (s.current_ticket_plan) {
          const plannedPaths = new Set(s.current_ticket_plan.files_to_touch.map(f => f.path));
          const surpriseFiles = changedFiles.filter(f => !plannedPaths.has(f));

          if (surpriseFiles.length > 0) {
            run.appendEvent('SCOPE_BLOCKED', {
              ticket_id: s.current_ticket_id,
              surprise_files: surpriseFiles,
              planned_files: [...plannedPaths],
            });
            return {
              processed: true,
              phase_changed: false,
              message: `Changed files not in plan: ${surpriseFiles.join(', ')}. Revert those changes and re-submit.`,
            };
          }

          // Validate lines against budget
          if (totalLines > s.max_lines_per_ticket) {
            return {
              processed: true,
              phase_changed: false,
              message: `Lines changed (${totalLines}) exceeds budget (${s.max_lines_per_ticket}). Reduce changes.`,
            };
          }
        }

        // Track lines
        s.total_lines_changed += totalLines;

        // Update spindle state with diff info
        const diff = (payload['diff'] ?? null) as string | null;
        recordDiff(s.spindle, diff ?? (changedFiles.length > 0 ? changedFiles.join('\n') : null));

        // Move to QA
        run.setPhase('QA');
        return {
          processed: true,
          phase_changed: true,
          new_phase: 'QA',
          message: `Ticket result accepted (${changedFiles.length} files, ${totalLines} lines), moving to QA`,
        };
      }

      if (status === 'failed') {
        // Fetch ticket once for both learning and dedup
        const ticket = s.current_ticket_id ? await repos.tickets.getById(db, s.current_ticket_id) : null;
        // Record learning on ticket failure
        if (s.learnings_enabled) {
          const reason = (payload['reason'] as string) ?? 'Execution failed';
          addLearning(run.rootPath, {
            text: `Ticket failed on ${ticket?.title ?? 'unknown'} — ${reason}`.slice(0, 200),
            category: 'warning',
            source: { type: 'ticket_failure', detail: reason },
            tags: extractTags(ticket?.allowedPaths ?? [], ticket?.verificationCommands ?? []),
          });
        }
        // Record failed ticket in dedup memory + sector failure
        await recordTicketDedup(db, run.rootPath, s.current_ticket_id, false, 'agent_error', ticket);
        recordSectorOutcome(run.rootPath, s.current_sector_path, 'failure');
        // Fail the ticket, move to next
        if (s.current_ticket_id) {
          await repos.tickets.updateStatus(db, s.current_ticket_id, 'blocked');
          run.failTicket(payload['reason'] as string ?? 'Execution failed');
        }
        run.setPhase('NEXT_TICKET');
        return {
          processed: true,
          phase_changed: true,
          new_phase: 'NEXT_TICKET',
          message: 'Ticket failed, moving to NEXT_TICKET',
        };
      }

      return { processed: true, phase_changed: false, message: `Ticket result: ${status}` };
    }

    // -----------------------------------------------------------------
    // QA events
    // -----------------------------------------------------------------
    case 'QA_COMMAND_RESULT': {
      if (s.phase !== 'QA') {
        return { processed: true, phase_changed: false, message: 'QA command result outside QA phase' };
      }

      const command = payload['command'] as string;
      const success = payload['success'] as boolean;
      const output = (payload['output'] ?? '') as string;

      // Record command failure in spindle state
      if (!success) {
        recordCommandFailure(s.spindle, command, output);
      }

      // Save command output as artifact
      const cmdSlug = command.replace(/[^a-z0-9]/gi, '-').slice(0, 30);
      run.saveArtifact(
        `${s.step_count}-qa-${cmdSlug}-${success ? 'pass' : 'fail'}.log`,
        `$ ${command}\n\n${output}`,
      );

      return {
        processed: true,
        phase_changed: false,
        message: `QA command ${success ? 'passed' : 'failed'}: ${command}`,
      };
    }

    case 'QA_PASSED': {
      if (s.phase !== 'QA') {
        return { processed: true, phase_changed: false, message: 'QA passed outside QA phase' };
      }

      // Confirm injected learnings on success
      if (s.learnings_enabled && s.injected_learning_ids.length > 0) {
        for (const id of s.injected_learning_ids) {
          confirmLearning(run.rootPath, id);
        }
        s.injected_learning_ids = [];
      }

      // Record success learning
      if (s.learnings_enabled && s.current_ticket_id) {
        try {
          const ticket = await repos.tickets.getById(db, s.current_ticket_id);
          if (ticket) {
            addLearning(run.rootPath, {
              text: `${ticket.category ?? 'refactor'} succeeded: ${ticket.title}`.slice(0, 200),
              category: 'pattern',
              source: { type: 'ticket_success', detail: ticket.category ?? 'refactor' },
              tags: extractTags(ticket.allowedPaths ?? [], ticket.verificationCommands ?? []),
            });
          }
        } catch {
          // Non-fatal
        }
      }

      // Mark ticket done in DB
      if (s.current_ticket_id) {
        await repos.tickets.updateStatus(db, s.current_ticket_id, 'done');
      }

      // Save QA summary artifact
      run.saveArtifact(
        `${s.step_count}-qa-summary.json`,
        JSON.stringify({
          ticket_id: s.current_ticket_id,
          status: 'passed',
          attempt: s.qa_retries + 1,
          ...payload,
        }, null, 2),
      );

      // Skip PR phase when draft_prs is false (e.g., --hours mode)
      if (!s.draft_prs) {
        await recordTicketDedup(db, run.rootPath, s.current_ticket_id, true);
        recordSectorOutcome(run.rootPath, s.current_sector_path, 'success');
        run.completeTicket();
        run.appendEvent('TICKET_COMPLETED_NO_PR', payload);
        run.setPhase('NEXT_TICKET');
        return {
          processed: true,
          phase_changed: true,
          new_phase: 'NEXT_TICKET',
          message: 'QA passed, PRs disabled — moving to NEXT_TICKET',
        };
      }

      // Move to PR
      run.setPhase('PR');
      return {
        processed: true,
        phase_changed: true,
        new_phase: 'PR',
        message: 'QA passed, moving to PR',
      };
    }

    case 'QA_FAILED': {
      if (s.phase !== 'QA') {
        return { processed: true, phase_changed: false, message: 'QA failed outside QA phase' };
      }

      // Record QA failure in spindle (for stall detection — no progress)
      recordDiff(s.spindle, null);

      // Save failure artifact
      run.saveArtifact(
        `${s.step_count}-qa-failed-attempt-${s.qa_retries + 1}.json`,
        JSON.stringify({
          ticket_id: s.current_ticket_id,
          attempt: s.qa_retries + 1,
          ...payload,
        }, null, 2),
      );

      s.qa_retries++;

      if (s.qa_retries >= 3) {
        // Fetch ticket once for both learning and dedup
        const ticket = s.current_ticket_id ? await repos.tickets.getById(db, s.current_ticket_id) : null;
        // Record learning on final QA failure
        if (s.learnings_enabled) {
          const failedCmds = (payload['failed_commands'] ?? payload['command'] ?? '') as string;
          const errorSummary = ((payload['error'] ?? payload['output'] ?? '') as string).slice(0, 100);
          addLearning(run.rootPath, {
            text: `QA fails on ${ticket?.title ?? 'unknown'} — ${errorSummary || failedCmds}`.slice(0, 200),
            category: 'gotcha',
            source: { type: 'qa_failure', detail: failedCmds },
            tags: extractTags(ticket?.allowedPaths ?? [], ticket?.verificationCommands ?? []),
          });
        }
        // Record failed ticket in dedup memory + sector failure
        await recordTicketDedup(db, run.rootPath, s.current_ticket_id, false, 'qa_failed', ticket);
        recordSectorOutcome(run.rootPath, s.current_sector_path, 'failure');
        // Give up on this ticket
        if (s.current_ticket_id) {
          await repos.tickets.updateStatus(db, s.current_ticket_id, 'blocked');
          run.failTicket(`QA failed ${s.qa_retries} times`);
        }
        run.setPhase('NEXT_TICKET');
        return {
          processed: true,
          phase_changed: true,
          new_phase: 'NEXT_TICKET',
          message: `QA failed ${s.qa_retries} times, giving up on ticket`,
        };
      }

      // Retry: go back to EXECUTE to fix
      run.setPhase('EXECUTE');
      return {
        processed: true,
        phase_changed: true,
        new_phase: 'EXECUTE',
        message: `QA failed (attempt ${s.qa_retries}/3), retrying execution`,
      };
    }

    // -----------------------------------------------------------------
    // PR events
    // -----------------------------------------------------------------
    case 'PR_CREATED': {
      if (s.phase !== 'PR') {
        return { processed: true, phase_changed: false, message: 'PR created outside PR phase' };
      }

      // Record completed ticket in dedup memory + sector success (before completeTicket clears current_ticket_id)
      await recordTicketDedup(db, run.rootPath, s.current_ticket_id, true);
      recordSectorOutcome(run.rootPath, s.current_sector_path, 'success');

      // Save PR artifact
      run.saveArtifact(
        `${s.step_count}-pr-created.json`,
        JSON.stringify({
          ticket_id: s.current_ticket_id,
          pr_number: s.prs_created + 1,
          ...payload,
        }, null, 2),
      );

      s.prs_created++;
      run.completeTicket();
      run.appendEvent('PR_CREATED', payload);
      run.setPhase('NEXT_TICKET');
      return {
        processed: true,
        phase_changed: true,
        new_phase: 'NEXT_TICKET',
        message: `PR created (${s.prs_created}/${s.max_prs}), moving to NEXT_TICKET`,
      };
    }

    // -----------------------------------------------------------------
    // User overrides
    // -----------------------------------------------------------------
    case 'USER_OVERRIDE': {
      if (typeof payload['hint'] === 'string') {
        run.addHint(payload['hint'] as string);
        return { processed: true, phase_changed: false, message: 'Hint added' };
      }
      if (payload['cancel'] === true) {
        run.setPhase('DONE');
        return {
          processed: true,
          phase_changed: true,
          new_phase: 'DONE',
          message: 'Session cancelled by user',
        };
      }
      return { processed: true, phase_changed: false, message: 'User override recorded' };
    }

    // -----------------------------------------------------------------
    // Default: just record
    // -----------------------------------------------------------------
    default:
      return { processed: true, phase_changed: false, message: `Event ${type} recorded` };
  }
}

