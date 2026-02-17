import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { loadTriggerRules } from '../lib/trigger-config.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

function triggersFile(): string {
  return path.join(tmpDir, '.promptwheel', 'triggers.json');
}

function writeTriggersJson(data: unknown): void {
  fs.mkdirSync(path.dirname(triggersFile()), { recursive: true });
  fs.writeFileSync(triggersFile(), JSON.stringify(data), 'utf-8');
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trigger-config-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// loadTriggerRules
// ---------------------------------------------------------------------------

describe('loadTriggerRules', () => {
  // ---------------------------------------------------------------------------
  // Missing / empty
  // ---------------------------------------------------------------------------

  it('returns empty array when triggers.json does not exist', () => {
    expect(loadTriggerRules(tmpDir)).toEqual([]);
  });

  it('returns empty array for empty rules array', () => {
    writeTriggersJson({ rules: [] });
    expect(loadTriggerRules(tmpDir)).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // Valid rules
  // ---------------------------------------------------------------------------

  it('loads a valid rule with action "warn"', () => {
    writeTriggersJson({
      rules: [{
        id: 'r1',
        name: 'Token limit',
        condition: { type: 'token_threshold', threshold: 100000 },
        action: 'warn',
      }],
    });
    const rules = loadTriggerRules(tmpDir);
    expect(rules).toHaveLength(1);
    expect(rules[0].id).toBe('r1');
    expect(rules[0].action).toBe('warn');
  });

  it('loads a valid rule with action "abort"', () => {
    writeTriggersJson({
      rules: [{
        id: 'r2',
        name: 'Hard limit',
        condition: { type: 'compaction_count', threshold: 5 },
        action: 'abort',
      }],
    });
    const rules = loadTriggerRules(tmpDir);
    expect(rules).toHaveLength(1);
    expect(rules[0].action).toBe('abort');
  });

  it('loads a valid rule with action "log"', () => {
    writeTriggersJson({
      rules: [{
        id: 'r3',
        name: 'Info only',
        condition: { type: 'token_threshold', threshold: 50000 },
        action: 'log',
      }],
    });
    const rules = loadTriggerRules(tmpDir);
    expect(rules).toHaveLength(1);
    expect(rules[0].action).toBe('log');
  });

  it('loads multiple valid rules', () => {
    writeTriggersJson({
      rules: [
        { id: 'a', name: 'A', condition: { type: 'x' }, action: 'warn' },
        { id: 'b', name: 'B', condition: { type: 'y' }, action: 'abort' },
        { id: 'c', name: 'C', condition: { type: 'z' }, action: 'log' },
      ],
    });
    const rules = loadTriggerRules(tmpDir);
    expect(rules).toHaveLength(3);
    expect(rules.map(r => r.id)).toEqual(['a', 'b', 'c']);
  });

  // ---------------------------------------------------------------------------
  // Invalid action values
  // ---------------------------------------------------------------------------

  it('filters out rules with invalid action value', () => {
    writeTriggersJson({
      rules: [
        { id: 'ok', name: 'OK', condition: { type: 'x' }, action: 'warn' },
        { id: 'bad', name: 'Bad', condition: { type: 'x' }, action: 'panic' },
      ],
    });
    const rules = loadTriggerRules(tmpDir);
    expect(rules).toHaveLength(1);
    expect(rules[0].id).toBe('ok');
  });

  it('filters out rules with numeric action', () => {
    writeTriggersJson({
      rules: [
        { id: 'r', name: 'R', condition: { type: 'x' }, action: 42 },
      ],
    });
    expect(loadTriggerRules(tmpDir)).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // Missing fields
  // ---------------------------------------------------------------------------

  it('filters out rules missing id', () => {
    writeTriggersJson({
      rules: [{ name: 'N', condition: { type: 'x' }, action: 'warn' }],
    });
    expect(loadTriggerRules(tmpDir)).toEqual([]);
  });

  it('filters out rules missing name', () => {
    writeTriggersJson({
      rules: [{ id: 'r', condition: { type: 'x' }, action: 'warn' }],
    });
    expect(loadTriggerRules(tmpDir)).toEqual([]);
  });

  it('filters out rules missing condition', () => {
    writeTriggersJson({
      rules: [{ id: 'r', name: 'N', action: 'warn' }],
    });
    expect(loadTriggerRules(tmpDir)).toEqual([]);
  });

  it('filters out rules missing action', () => {
    writeTriggersJson({
      rules: [{ id: 'r', name: 'N', condition: { type: 'x' } }],
    });
    expect(loadTriggerRules(tmpDir)).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // Null condition
  // ---------------------------------------------------------------------------

  it('filters out rules with null condition', () => {
    writeTriggersJson({
      rules: [{ id: 'r', name: 'N', condition: null, action: 'warn' }],
    });
    expect(loadTriggerRules(tmpDir)).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // Non-object entries
  // ---------------------------------------------------------------------------

  it('filters out non-object entries in rules array', () => {
    writeTriggersJson({
      rules: [
        'not an object',
        42,
        null,
        true,
        { id: 'ok', name: 'OK', condition: { type: 'x' }, action: 'warn' },
      ],
    });
    const rules = loadTriggerRules(tmpDir);
    expect(rules).toHaveLength(1);
    expect(rules[0].id).toBe('ok');
  });

  // ---------------------------------------------------------------------------
  // Malformed JSON
  // ---------------------------------------------------------------------------

  it('returns empty array for malformed JSON', () => {
    fs.mkdirSync(path.dirname(triggersFile()), { recursive: true });
    fs.writeFileSync(triggersFile(), '{not valid json}', 'utf-8');
    expect(loadTriggerRules(tmpDir)).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // Data without rules array
  // ---------------------------------------------------------------------------

  it('returns empty array when data has no rules property', () => {
    writeTriggersJson({ something: 'else' });
    expect(loadTriggerRules(tmpDir)).toEqual([]);
  });

  it('returns empty array when rules is not an array', () => {
    writeTriggersJson({ rules: 'not an array' });
    expect(loadTriggerRules(tmpDir)).toEqual([]);
  });

  it('returns empty array when data is null', () => {
    writeTriggersJson(null);
    expect(loadTriggerRules(tmpDir)).toEqual([]);
  });

  it('returns empty array when data is a plain array (not object with rules)', () => {
    writeTriggersJson([{ id: 'r', name: 'N', condition: {}, action: 'warn' }]);
    expect(loadTriggerRules(tmpDir)).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // Mixed valid and invalid
  // ---------------------------------------------------------------------------

  it('returns only valid rules from a mixed set', () => {
    writeTriggersJson({
      rules: [
        { id: 'ok1', name: 'OK1', condition: { type: 'a' }, action: 'warn' },
        { id: 'bad1', name: 'Bad1', condition: null, action: 'warn' },
        { id: 'ok2', name: 'OK2', condition: { type: 'b' }, action: 'log' },
        { name: 'no-id', condition: { type: 'c' }, action: 'abort' },
        { id: 'bad2', name: 'Bad2', condition: { type: 'd' }, action: 'explode' },
      ],
    });
    const rules = loadTriggerRules(tmpDir);
    expect(rules).toHaveLength(2);
    expect(rules.map(r => r.id)).toEqual(['ok1', 'ok2']);
  });
});
