import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DatabaseAdapter } from '@promptwheel/core';
import type { Project } from '@promptwheel/core';
import { repos } from '@promptwheel/core';
import { RunManager } from './run-manager.js';
import type { EventType } from './types.js';
import { recordDedupEntry } from './dedup-memory.js';
import { truncateUtf8 } from './utf8-utils.js';

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

export interface EventPayloadValidationSuccess {
  ok: true;
  payload: Record<string, unknown>;
}

export interface EventPayloadValidationFailure {
  ok: false;
  error: string;
}

export type EventPayloadValidation = EventPayloadValidationSuccess | EventPayloadValidationFailure;

const PLAN_ACTIONS = new Set(['create', 'modify', 'delete']);
const RISK_LEVELS = new Set(['low', 'medium', 'high']);
type PlanAction = 'create' | 'modify' | 'delete';

// ---------------------------------------------------------------------------
// Forgiveness aliases — normalize LLM synonym variations
// ---------------------------------------------------------------------------

const ACTION_ALIASES: Record<string, PlanAction> = {
  update: 'modify', edit: 'modify', change: 'modify',
  add: 'create', new: 'create',
  remove: 'delete', rm: 'delete',
};

const RISK_ALIASES: Record<string, string> = {
  none: 'low', minimal: 'low',
  moderate: 'medium',
  critical: 'high', severe: 'high',
};

/** Normalize a plan action string, accepting common LLM synonyms. */
export function normalizePlanAction(value: string): PlanAction | undefined {
  const lower = value.toLowerCase();
  if (isPlanAction(lower)) return lower;
  return ACTION_ALIASES[lower];
}

/** Normalize a risk level string, accepting common LLM synonyms. */
export function normalizeRiskLevel(value: string): string | undefined {
  const lower = value.toLowerCase();
  if (RISK_LEVELS.has(lower)) return lower;
  return RISK_ALIASES[lower];
}

export const EVENT_MAX_PAYLOAD_BYTES = 512 * 1024;
export const EVENT_MAX_RECORD_ARRAY_ITEMS = 200;
export const EVENT_MAX_STRING_ARRAY_ITEMS = 400;
export const EVENT_MAX_PLAN_FILES = 400;
export const EVENT_MAX_PATH_BYTES = 2048;
export const EVENT_MAX_COMMAND_BYTES = 4096;
export const EVENT_MAX_SMALL_STRING_BYTES = 8192;
export const EVENT_MAX_MEDIUM_STRING_BYTES = 32768;
export const EVENT_MAX_LARGE_STRING_BYTES = 131072;
export const EVENT_MAX_ARTIFACT_BYTES = 131072;

type StringLimitMode = 'truncate' | 'reject';
type ArrayLimitMode = 'truncate' | 'reject';

interface PayloadTruncation {
  field: string;
  kind: 'string' | 'array';
  original: number;
  max: number;
}

interface FieldValidationSuccess<T> {
  ok: true;
  value: T;
}

type FieldValidationResult<T> = FieldValidationSuccess<T> | EventPayloadValidationFailure;

function isPlanAction(value: string): value is PlanAction {
  return value === 'create' || value === 'modify' || value === 'delete';
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function toStringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function toNumberOrUndefined(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

export function toBooleanOrUndefined(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (value.toLowerCase() === 'true') return true;
    if (value.toLowerCase() === 'false') return false;
    return undefined;
  }
  if (typeof value === 'number') {
    if (value === 1) return true;
    if (value === 0) return false;
    return undefined;
  }
  return undefined;
}

export function toStringArrayOrUndefined(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') return undefined;
    items.push(item);
  }
  return items;
}

function invalid(type: EventType, message: string): EventPayloadValidationFailure {
  return { ok: false, error: `Invalid ${type} payload: ${message}` };
}

function toJsonBytes(value: unknown): number {
  try {
    const serialized = JSON.stringify(value);
    if (typeof serialized !== 'string') return Number.POSITIVE_INFINITY;
    return Buffer.byteLength(serialized, 'utf8');
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

// truncateUtf8 imported from ./utf8-utils.js (shared with run-manager)

export function truncateArtifactText(
  text: string,
  maxBytes: number = EVENT_MAX_ARTIFACT_BYTES,
): {
  text: string;
  truncated: boolean;
  originalBytes: number;
  maxBytes: number;
} {
  const limited = truncateUtf8(text, maxBytes);
  return {
    text: limited.value,
    truncated: limited.truncated,
    originalBytes: limited.originalBytes,
    maxBytes,
  };
}

export function stringifyBoundedArtifactJson(
  value: unknown,
  fallback: Record<string, unknown> = {},
  maxBytes: number = EVENT_MAX_ARTIFACT_BYTES,
): string {
  const serialized = JSON.stringify(value, null, 2);
  if (typeof serialized !== 'string') {
    return JSON.stringify({
      ...fallback,
      _artifact_truncated: true,
      _artifact_original_bytes: -1,
      _artifact_max_bytes: maxBytes,
      _artifact_preview: '[unserializable artifact payload]',
    }, null, 2);
  }
  const bytes = Buffer.byteLength(serialized, 'utf8');
  if (bytes <= maxBytes) return serialized;

  const previewBudget = Math.max(0, maxBytes - 1536);
  const preview = truncateUtf8(serialized, previewBudget).value;
  return JSON.stringify({
    ...fallback,
    _artifact_truncated: true,
    _artifact_original_bytes: bytes,
    _artifact_max_bytes: maxBytes,
    _artifact_preview: preview,
  }, null, 2);
}

function validateRecordArrayField(
  type: EventType,
  field: string,
  value: unknown,
  maxItems: number,
  arrayMode: ArrayLimitMode,
  truncations: PayloadTruncation[],
): FieldValidationResult<Record<string, unknown>[]> {
  if (!Array.isArray(value)) {
    return invalid(type, `\`${field}\` must be an array of objects`);
  }

  if (value.length > maxItems) {
    if (arrayMode === 'reject') {
      return invalid(type, `\`${field}\` must contain at most ${maxItems} items`);
    }
    truncations.push({ field, kind: 'array', original: value.length, max: maxItems });
  }

  const records: Record<string, unknown>[] = [];
  const bounded = value.slice(0, maxItems);
  for (const item of bounded) {
    if (!isRecord(item)) {
      return invalid(type, `\`${field}\` must be an array of objects`);
    }
    records.push(item);
  }
  return { ok: true, value: records };
}

function validateStringField(
  type: EventType,
  field: string,
  value: unknown,
  maxBytes: number,
  mode: StringLimitMode,
  truncations: PayloadTruncation[],
): FieldValidationResult<string> {
  if (typeof value !== 'string') {
    return invalid(type, `\`${field}\` must be a string`);
  }
  const limited = truncateUtf8(value, maxBytes);
  if (!limited.truncated) return { ok: true, value };
  if (mode === 'reject') {
    return invalid(type, `\`${field}\` exceeds ${maxBytes} bytes`);
  }
  truncations.push({ field, kind: 'string', original: limited.originalBytes, max: maxBytes });
  return { ok: true, value: limited.value };
}

function validateStringArrayField(
  type: EventType,
  field: string,
  value: unknown,
  maxItems: number,
  maxItemBytes: number,
  arrayMode: ArrayLimitMode,
  itemMode: StringLimitMode,
  truncations: PayloadTruncation[],
): FieldValidationResult<string[]> {
  if (!Array.isArray(value)) {
    return invalid(type, `\`${field}\` must be an array of strings`);
  }

  let source = value;
  if (value.length > maxItems) {
    if (arrayMode === 'reject') {
      return invalid(type, `\`${field}\` must contain at most ${maxItems} items`);
    }
    truncations.push({ field, kind: 'array', original: value.length, max: maxItems });
    source = value.slice(0, maxItems);
  }

  const strings: string[] = [];
  let truncatedItems = 0;
  let maxOriginalItemBytes = 0;
  for (let i = 0; i < source.length; i++) {
    const item = source[i];
    if (typeof item !== 'string') {
      return invalid(type, `\`${field}\` must be an array of strings`);
    }
    const limited = truncateUtf8(item, maxItemBytes);
    if (limited.truncated) {
      if (itemMode === 'reject') {
        return invalid(type, `\`${field}[${i}]\` exceeds ${maxItemBytes} bytes`);
      }
      truncatedItems++;
      if (limited.originalBytes > maxOriginalItemBytes) {
        maxOriginalItemBytes = limited.originalBytes;
      }
    }
    strings.push(limited.value);
  }
  if (truncatedItems > 0) {
    truncations.push({ field: `${field}[*]`, kind: 'string', original: maxOriginalItemBytes, max: maxItemBytes });
  }
  return { ok: true, value: strings };
}

function attachTruncationMetadata(
  payload: Record<string, unknown>,
  truncations: PayloadTruncation[],
): Record<string, unknown> {
  if (truncations.length === 0) return payload;
  return {
    ...payload,
    _payload_truncated: true,
    _payload_truncations: truncations,
  };
}

export function validateAndSanitizeEventPayload(
  type: EventType,
  payload: Record<string, unknown>,
): EventPayloadValidation {
  const payloadBytes = toJsonBytes(payload);
  if (!Number.isFinite(payloadBytes)) {
    return invalid(type, 'payload is not JSON-serializable');
  }
  if (payloadBytes > EVENT_MAX_PAYLOAD_BYTES) {
    return invalid(type, `payload exceeds ${EVENT_MAX_PAYLOAD_BYTES} bytes`);
  }

  const truncations: PayloadTruncation[] = [];
  const sanitized: Record<string, unknown> = { ...payload };
  if ('ticket_id' in payload) {
    const ticketId = payload['ticket_id'];
    if (typeof ticketId === 'string') {
      const limitedTicketId = validateStringField(
        type,
        'ticket_id',
        ticketId,
        EVENT_MAX_COMMAND_BYTES,
        'truncate',
        truncations,
      );
      if (!limitedTicketId.ok) return limitedTicketId;
      sanitized['ticket_id'] = limitedTicketId.value;
    } else if (typeof ticketId === 'number' && Number.isFinite(ticketId)) {
      sanitized['ticket_id'] = String(ticketId);
    } else {
      return invalid(type, '`ticket_id` must be a string or number');
    }
  }

  switch (type) {
    case 'SCOUT_OUTPUT': {
      if ('explored_dirs' in payload) {
        const exploredDirs = validateStringArrayField(
          type,
          'explored_dirs',
          payload['explored_dirs'],
          EVENT_MAX_STRING_ARRAY_ITEMS,
          EVENT_MAX_PATH_BYTES,
          'truncate',
          'truncate',
          truncations,
        );
        if (!exploredDirs.ok) return exploredDirs;
        sanitized['explored_dirs'] = exploredDirs.value;
      }

      if ('proposals' in payload) {
        const proposals = validateRecordArrayField(
          type,
          'proposals',
          payload['proposals'],
          EVENT_MAX_RECORD_ARRAY_ITEMS,
          'reject',
          truncations,
        );
        if (!proposals.ok) return proposals;
        sanitized['proposals'] = proposals.value;
      }

      if ('reviewed_proposals' in payload) {
        const reviewedProposals = validateRecordArrayField(
          type,
          'reviewed_proposals',
          payload['reviewed_proposals'],
          EVENT_MAX_RECORD_ARRAY_ITEMS,
          'reject',
          truncations,
        );
        if (!reviewedProposals.ok) return reviewedProposals;
        sanitized['reviewed_proposals'] = reviewedProposals.value;
      }

      if ('text' in payload) {
        const text = validateStringField(
          type,
          'text',
          payload['text'],
          EVENT_MAX_LARGE_STRING_BYTES,
          'truncate',
          truncations,
        );
        if (!text.ok) return text;
        sanitized['text'] = text.value;
      }

      if ('exploration_summary' in payload) {
        const summary = validateStringField(
          type,
          'exploration_summary',
          payload['exploration_summary'],
          EVENT_MAX_SMALL_STRING_BYTES,
          'truncate',
          truncations,
        );
        if (!summary.ok) return summary;
        sanitized['exploration_summary'] = summary.value;
      }

      return { ok: true, payload: attachTruncationMetadata(sanitized, truncations) };
    }

    case 'PROPOSALS_REVIEWED': {
      const reviewedProposals = validateRecordArrayField(
        type,
        'reviewed_proposals',
        payload['reviewed_proposals'],
        EVENT_MAX_RECORD_ARRAY_ITEMS,
        'reject',
        truncations,
      );
      if (!reviewedProposals.ok) return reviewedProposals;

      const cleanItems: Record<string, unknown>[] = [];
      for (const item of reviewedProposals.value) {
        const clean: Record<string, unknown> = {};
        let skipItem = false;

        if ('title' in item) {
          const title = validateStringField(
            type,
            'reviewed_proposals[].title',
            item['title'],
            EVENT_MAX_SMALL_STRING_BYTES,
            'truncate',
            truncations,
          );
          if (!title.ok) { skipItem = true; } else { clean['title'] = title.value; }
        }
        if (!skipItem && 'confidence' in item) {
          const confidence = toNumberOrUndefined(item['confidence']);
          if (confidence === undefined) { skipItem = true; } else { clean['confidence'] = confidence; }
        }
        if (!skipItem && 'impact_score' in item) {
          const impactScore = toNumberOrUndefined(item['impact_score']);
          if (impactScore === undefined) { skipItem = true; } else { clean['impact_score'] = impactScore; }
        }
        if (!skipItem && 'review_note' in item) {
          const reviewNote = validateStringField(
            type,
            'reviewed_proposals[].review_note',
            item['review_note'],
            EVENT_MAX_MEDIUM_STRING_BYTES,
            'truncate',
            truncations,
          );
          if (!reviewNote.ok) { skipItem = true; } else { clean['review_note'] = reviewNote.value; }
        }

        if (!skipItem) {
          cleanItems.push({ ...item, ...clean });
        }
      }

      sanitized['reviewed_proposals'] = cleanItems;
      return { ok: true, payload: attachTruncationMetadata(sanitized, truncations) };
    }

    case 'PROPOSALS_FILTERED':
    case 'QA_PASSED':
      return { ok: true, payload: attachTruncationMetadata(sanitized, truncations) };

    case 'PLAN_SUBMITTED': {
      const filesToTouchRaw = Array.isArray(payload['files_to_touch']) ? payload['files_to_touch']
        : Array.isArray(payload['files']) ? payload['files']
        : Array.isArray(payload['touched_files']) ? payload['touched_files']
        : undefined;

      if (
        ('files_to_touch' in payload && !Array.isArray(payload['files_to_touch']))
        || ('files' in payload && !Array.isArray(payload['files']))
        || ('touched_files' in payload && !Array.isArray(payload['touched_files']))
      ) {
        return invalid(type, '`files_to_touch`/`files`/`touched_files` must be arrays');
      }

      if ((filesToTouchRaw?.length ?? 0) > EVENT_MAX_PLAN_FILES) {
        return invalid(type, `\`files_to_touch\` must contain at most ${EVENT_MAX_PLAN_FILES} items`);
      }

      const filesToTouch: Array<{ path: string; action: PlanAction; reason: string }> = [];
      for (const file of filesToTouchRaw ?? []) {
        if (typeof file === 'string') {
          const filePath = validateStringField(
            type,
            'files_to_touch[].path',
            file,
            EVENT_MAX_PATH_BYTES,
            'truncate',
            truncations,
          );
          if (!filePath.ok) return filePath;
          filesToTouch.push({ path: filePath.value, action: 'modify', reason: '' });
          continue;
        }
        if (!isRecord(file)) {
          return invalid(type, '`files_to_touch[]` entries must be strings or objects');
        }
        const pathValue = validateStringField(
          type,
          'files_to_touch[].path',
          file['path'],
          EVENT_MAX_PATH_BYTES,
          'truncate',
          truncations,
        );
        if (!pathValue.ok || !pathValue.value) return invalid(type, '`files_to_touch[].path` must be a non-empty string');
        const rawAction = 'action' in file ? toStringOrUndefined(file['action']) : 'modify';
        const actionValue = rawAction ? normalizePlanAction(rawAction) : undefined;
        if (!actionValue) {
          return invalid(type, '`files_to_touch[].action` must be create, modify, or delete');
        }
        const reasonValue = 'reason' in file
          ? validateStringField(
            type,
            'files_to_touch[].reason',
            file['reason'],
            EVENT_MAX_SMALL_STRING_BYTES,
            'truncate',
            truncations,
          )
          : { ok: true, value: '' } as const;
        if (!reasonValue.ok) return reasonValue;
        filesToTouch.push({ path: pathValue.value, action: actionValue, reason: reasonValue.value });
      }
      sanitized['files_to_touch'] = filesToTouch;

      if ('expected_tests' in payload) {
        const expectedTests = validateStringArrayField(
          type,
          'expected_tests',
          payload['expected_tests'],
          EVENT_MAX_STRING_ARRAY_ITEMS,
          EVENT_MAX_COMMAND_BYTES,
          'truncate',
          'truncate',
          truncations,
        );
        if (!expectedTests.ok) return expectedTests;
        sanitized['expected_tests'] = expectedTests.value;
      }

      if ('risk_level' in payload) {
        const rawRisk = toStringOrUndefined(payload['risk_level']);
        const riskLevel = rawRisk ? normalizeRiskLevel(rawRisk) : undefined;
        if (!riskLevel) {
          return invalid(type, '`risk_level` must be low, medium, or high');
        }
        sanitized['risk_level'] = riskLevel;
      }

      if ('estimated_lines' in payload) {
        const estimatedLines = toNumberOrUndefined(payload['estimated_lines']);
        if (estimatedLines === undefined || estimatedLines < 0) {
          return invalid(type, '`estimated_lines` must be a non-negative number');
        }
        sanitized['estimated_lines'] = estimatedLines;
      }

      return { ok: true, payload: attachTruncationMetadata(sanitized, truncations) };
    }

    case 'TICKET_RESULT': {
      const status = validateStringField(
        type,
        'status',
        payload['status'],
        EVENT_MAX_SMALL_STRING_BYTES,
        'reject',
        truncations,
      );
      if (!status.ok || !status.value) return invalid(type, '`status` is required and must be a string');
      sanitized['status'] = status.value;

      if ('changed_files' in payload) {
        const changedFiles = validateStringArrayField(
          type,
          'changed_files',
          payload['changed_files'],
          EVENT_MAX_STRING_ARRAY_ITEMS,
          EVENT_MAX_PATH_BYTES,
          'truncate',
          'truncate',
          truncations,
        );
        if (!changedFiles.ok) return changedFiles;
        sanitized['changed_files'] = changedFiles.value;
      } else {
        sanitized['changed_files'] = [];
      }

      if ('lines_added' in payload) {
        const linesAdded = toNumberOrUndefined(payload['lines_added']);
        if (linesAdded === undefined || linesAdded < 0) return invalid(type, '`lines_added` must be a non-negative number');
        sanitized['lines_added'] = linesAdded;
      } else {
        sanitized['lines_added'] = 0;
      }

      if ('lines_removed' in payload) {
        const linesRemoved = toNumberOrUndefined(payload['lines_removed']);
        if (linesRemoved === undefined || linesRemoved < 0) return invalid(type, '`lines_removed` must be a non-negative number');
        sanitized['lines_removed'] = linesRemoved;
      } else {
        sanitized['lines_removed'] = 0;
      }

      if ('diff' in payload && payload['diff'] !== null && typeof payload['diff'] !== 'string') {
        return invalid(type, '`diff` must be a string or null');
      }
      if ('diff' in payload && typeof payload['diff'] === 'string') {
        const diff = validateStringField(
          type,
          'diff',
          payload['diff'],
          EVENT_MAX_LARGE_STRING_BYTES,
          'truncate',
          truncations,
        );
        if (!diff.ok) return diff;
        sanitized['diff'] = diff.value;
      }
      if ('stdout' in payload && typeof payload['stdout'] !== 'string') {
        return invalid(type, '`stdout` must be a string');
      }
      if ('stdout' in payload && typeof payload['stdout'] === 'string') {
        const stdout = validateStringField(
          type,
          'stdout',
          payload['stdout'],
          EVENT_MAX_LARGE_STRING_BYTES,
          'truncate',
          truncations,
        );
        if (!stdout.ok) return stdout;
        sanitized['stdout'] = stdout.value;
      }
      if ('reason' in payload && typeof payload['reason'] !== 'string') {
        return invalid(type, '`reason` must be a string');
      }
      if ('reason' in payload && typeof payload['reason'] === 'string') {
        const reason = validateStringField(
          type,
          'reason',
          payload['reason'],
          EVENT_MAX_SMALL_STRING_BYTES,
          'truncate',
          truncations,
        );
        if (!reason.ok) return reason;
        sanitized['reason'] = reason.value;
      }
      return { ok: true, payload: attachTruncationMetadata(sanitized, truncations) };
    }

    case 'QA_COMMAND_RESULT': {
      const command = validateStringField(
        type,
        'command',
        payload['command'],
        EVENT_MAX_COMMAND_BYTES,
        'reject',
        truncations,
      );
      if (!command.ok || !command.value) return invalid(type, '`command` is required and must be a string');
      sanitized['command'] = command.value;

      const success = toBooleanOrUndefined(payload['success']);
      if (success === undefined) return invalid(type, '`success` is required and must be boolean');
      sanitized['success'] = success;

      if ('output' in payload) {
        const output = validateStringField(
          type,
          'output',
          payload['output'],
          EVENT_MAX_LARGE_STRING_BYTES,
          'truncate',
          truncations,
        );
        if (!output.ok) return output;
        sanitized['output'] = output.value;
      } else {
        sanitized['output'] = '';
      }

      if ('durationMs' in payload) {
        const durationMs = toNumberOrUndefined(payload['durationMs']);
        if (durationMs === undefined || durationMs < 0) return invalid(type, '`durationMs` must be a non-negative number');
        sanitized['durationMs'] = durationMs;
      } else {
        sanitized['durationMs'] = 0;
      }

      if ('timedOut' in payload) {
        const timedOut = toBooleanOrUndefined(payload['timedOut']);
        if (timedOut === undefined) return invalid(type, '`timedOut` must be boolean');
        sanitized['timedOut'] = timedOut;
      } else {
        sanitized['timedOut'] = false;
      }

      return { ok: true, payload: attachTruncationMetadata(sanitized, truncations) };
    }

    case 'QA_FAILED': {
      if ('failed_commands' in payload) {
        const failedCommands = payload['failed_commands'];
        if (typeof failedCommands === 'string') {
          const command = validateStringField(
            type,
            'failed_commands[0]',
            failedCommands,
            EVENT_MAX_COMMAND_BYTES,
            'truncate',
            truncations,
          );
          if (!command.ok) return command;
          sanitized['failed_commands'] = [command.value];
        } else {
          const commandArray = validateStringArrayField(
            type,
            'failed_commands',
            failedCommands,
            EVENT_MAX_STRING_ARRAY_ITEMS,
            EVENT_MAX_COMMAND_BYTES,
            'truncate',
            'truncate',
            truncations,
          );
          if (!commandArray.ok) return invalid(type, '`failed_commands` must be a string or array of strings');
          sanitized['failed_commands'] = commandArray.value;
        }
      }

      if ('command' in payload) {
        const command = validateStringField(
          type,
          'command',
          payload['command'],
          EVENT_MAX_COMMAND_BYTES,
          'truncate',
          truncations,
        );
        if (!command.ok) return command;
        sanitized['command'] = command.value;
      }

      if ('error' in payload) {
        const error = validateStringField(
          type,
          'error',
          payload['error'],
          EVENT_MAX_LARGE_STRING_BYTES,
          'truncate',
          truncations,
        );
        if (!error.ok) return error;
        sanitized['error'] = error.value;
      }

      if ('output' in payload) {
        const output = validateStringField(
          type,
          'output',
          payload['output'],
          EVENT_MAX_LARGE_STRING_BYTES,
          'truncate',
          truncations,
        );
        if (!output.ok) return output;
        sanitized['output'] = output.value;
      }
      return { ok: true, payload: attachTruncationMetadata(sanitized, truncations) };
    }

    case 'PR_CREATED': {
      if ('url' in payload && typeof payload['url'] !== 'string') {
        return invalid(type, '`url` must be a string');
      }
      if ('url' in payload && typeof payload['url'] === 'string') {
        const url = validateStringField(
          type,
          'url',
          payload['url'],
          EVENT_MAX_MEDIUM_STRING_BYTES,
          'truncate',
          truncations,
        );
        if (!url.ok) return url;
        sanitized['url'] = url.value;
      }
      if ('branch' in payload && typeof payload['branch'] !== 'string') {
        return invalid(type, '`branch` must be a string');
      }
      if ('branch' in payload && typeof payload['branch'] === 'string') {
        const branch = validateStringField(
          type,
          'branch',
          payload['branch'],
          EVENT_MAX_SMALL_STRING_BYTES,
          'truncate',
          truncations,
        );
        if (!branch.ok) return branch;
        sanitized['branch'] = branch.value;
      }
      return { ok: true, payload: attachTruncationMetadata(sanitized, truncations) };
    }

    case 'USER_OVERRIDE': {
      if ('hint' in payload) {
        const hint = validateStringField(
          type,
          'hint',
          payload['hint'],
          EVENT_MAX_MEDIUM_STRING_BYTES,
          'truncate',
          truncations,
        );
        if (!hint.ok) return hint;
        sanitized['hint'] = hint.value;
      }
      if ('cancel' in payload) {
        const cancel = toBooleanOrUndefined(payload['cancel']);
        if (cancel === undefined) return invalid(type, '`cancel` must be boolean');
        sanitized['cancel'] = cancel;
      }
      if ('skip_review' in payload) {
        const skipReview = toBooleanOrUndefined(payload['skip_review']);
        if (skipReview === undefined) return invalid(type, '`skip_review` must be boolean');
        sanitized['skip_review'] = skipReview;
      }
      return { ok: true, payload: attachTruncationMetadata(sanitized, truncations) };
    }

    default:
      return { ok: true, payload: attachTruncationMetadata(sanitized, truncations) };
  }
}

// ---------------------------------------------------------------------------
// Helpers — shared utilities
// ---------------------------------------------------------------------------

/** Atomic write: write to .tmp then rename, preventing corruption on crash */
export function atomicWriteJsonSync(filePath: string, data: unknown): void {
  const tmpPath = filePath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmpPath, filePath);
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
      await recordDedupEntry(rootPath, ticket.title, completed, reason);
    }
  } catch (err) {
    console.warn(`[promptwheel] recordTicketDedup: ${err instanceof Error ? err.message : String(err)}`);
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
    /(?:AssertionError|TypeError|ReferenceError|SyntaxError|RangeError|Error):\s*[^\n]{1,100}/,
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
