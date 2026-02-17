import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DatabaseAdapter } from '@blockspool/core';
import type { Project } from '@blockspool/core';
import { repos } from '@blockspool/core';
import { RunManager } from './run-manager.js';
import { recordDedupEntry } from './dedup-memory.js';
import {
  recordTicketOutcome as recordTicketOutcomeCore,
} from '@blockspool/core/sectors/shared';
import type { SectorState } from '@blockspool/core/sectors/shared';

// ---------------------------------------------------------------------------
// EventContext — shared context for all handlers
// ---------------------------------------------------------------------------

export interface EventContext {
  run: RunManager;
  db: DatabaseAdapter;
  project?: Project;
}

// ---------------------------------------------------------------------------
// ProcessResult
// ---------------------------------------------------------------------------

export interface ProcessResult {
  processed: boolean;
  phase_changed: boolean;
  new_phase?: string;
  message: string;
}

// ---------------------------------------------------------------------------
// Helpers — shared sector & dedup recording
// ---------------------------------------------------------------------------

/** Atomic write: write to .tmp then rename, preventing corruption on crash */
export function atomicWriteJsonSync(filePath: string, data: unknown): void {
  const tmpPath = filePath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmpPath, filePath);
}

/** Load sectors.json, return null if missing/invalid. */
export function loadSectorsState(rootPath: string): { state: SectorState; filePath: string } | null {
  try {
    const filePath = path.join(rootPath, '.blockspool', 'sectors.json');
    if (!fs.existsSync(filePath)) return null;
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (data?.version !== 2 || !Array.isArray(data.sectors)) return null;
    return { state: data as SectorState, filePath };
  } catch (err) {
    console.warn(`[blockspool] loadSectorsState: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

export function recordSectorOutcome(
  rootPath: string,
  sectorPath: string | undefined,
  outcome: 'success' | 'failure',
): void {
  if (!sectorPath) return;
  try {
    const loaded = loadSectorsState(rootPath);
    if (!loaded) return;
    recordTicketOutcomeCore(loaded.state, sectorPath, outcome === 'success');
    atomicWriteJsonSync(loaded.filePath, loaded.state);
  } catch (err) {
    console.warn(`[blockspool] recordSectorOutcome: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function recordTicketDedup(
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
  } catch (err) {
    console.warn(`[blockspool] recordTicketDedup: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Extract a normalized error signature from raw error output.
 * Captures the first recognizable error pattern (TypeError, SyntaxError, assertion, etc.)
 * and truncates to 120 chars for storage.
 */
export function extractErrorSignature(errorOutput: string): string | undefined {
  if (!errorOutput) return undefined;
  // Match common error patterns
  const patterns = [
    /(?:TypeError|ReferenceError|SyntaxError|RangeError|Error):\s*[^\n]{1,100}/,
    /AssertionError:\s*[^\n]{1,100}/i,
    /FAIL(?:ED)?[:\s]+[^\n]{1,80}/i,
    /error\[E\d+\]:\s*[^\n]{1,80}/i,  // Rust errors
    /panic:\s*[^\n]{1,80}/,             // Go panics
    /Exception[:\s]+[^\n]{1,80}/i,      // Java/Python exceptions
  ];
  for (const p of patterns) {
    const match = errorOutput.match(p);
    if (match) return match[0].slice(0, 120);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// QA error classification
// ---------------------------------------------------------------------------

export type QaErrorClass = 'environment' | 'timeout' | 'code' | 'unknown';

/**
 * Classify a QA error to determine retry strategy.
 * - environment: permission denied, missing tools, env vars — don't retry (will never pass)
 * - timeout: command timed out — retry once (transient)
 * - code: test failures, type errors, syntax errors — full retries (agent can fix)
 * - unknown: can't classify — full retries (default)
 */
export function classifyQaError(errorOutput: string): QaErrorClass {
  const lower = errorOutput.toLowerCase();
  // Environment / permission issues — unrecoverable without human intervention
  if (/permission denied|eacces|eperm/i.test(errorOutput)) return 'environment';
  if (/command not found|enoent.*spawn/i.test(errorOutput)) return 'environment';
  if (/missing.*(env|variable|credential|token|key|secret)/i.test(lower)) return 'environment';
  if (/econnrefused|enotfound|cannot connect/i.test(errorOutput)) return 'environment';
  // Timeout — transient, worth one retry
  if (/timed?\s*out|timeout|etimedout/i.test(errorOutput)) return 'timeout';
  if (/killed.*signal|sigterm|sigkill/i.test(lower)) return 'timeout';
  // Code errors — agent can fix these
  if (/syntaxerror|typeerror|referenceerror|rangeerror/i.test(errorOutput)) return 'code';
  if (/assertion|expect|fail|error\[/i.test(lower)) return 'code';
  if (/tsc.*error|type.*not assignable/i.test(lower)) return 'code';
  return 'unknown';
}

/** Max retries per error class */
export function maxRetriesForClass(errorClass: QaErrorClass): number {
  switch (errorClass) {
    case 'environment': return 1;  // One retry in case it was a race, then give up
    case 'timeout': return 2;      // Transient — try twice
    case 'code': return 3;         // Agent can fix — full retries
    case 'unknown': return 3;      // Default — full retries
  }
}
