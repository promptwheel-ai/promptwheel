import { describe, it, expect } from 'vitest';
import { parseClaudeOutput } from '../scout/runner.js';

describe('parseClaudeOutput', () => {
  it('parses valid JSON directly', () => {
    const result = parseClaudeOutput('{"proposals": []}');
    expect(result).toEqual({ proposals: [] });
  });

  it('extracts JSON from markdown code block', () => {
    const input = 'Here is the result:\n```\n{"key": "value"}\n```\nDone.';
    expect(parseClaudeOutput(input)).toEqual({ key: 'value' });
  });

  it('extracts JSON from ```json code block', () => {
    const input = '```json\n{"foo": 42}\n```';
    expect(parseClaudeOutput(input)).toEqual({ foo: 42 });
  });

  it('finds JSON object in mixed text', () => {
    const input = 'Some text before\n{"found": true}\nSome text after';
    expect(parseClaudeOutput(input)).toEqual({ found: true });
  });

  it('returns null for invalid JSON', () => {
    expect(parseClaudeOutput('not json at all')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseClaudeOutput('')).toBeNull();
  });

  it('handles whitespace around JSON', () => {
    expect(parseClaudeOutput('  \n  {"a": 1}  \n  ')).toEqual({ a: 1 });
  });

  it('handles nested objects', () => {
    const input = '{"outer": {"inner": {"deep": true}}}';
    const result = parseClaudeOutput<{ outer: { inner: { deep: boolean } } }>(input);
    expect(result?.outer.inner.deep).toBe(true);
  });

  it('handles arrays', () => {
    const input = '[1, 2, 3]';
    expect(parseClaudeOutput(input)).toEqual([1, 2, 3]);
  });

  it('prefers direct parse over regex extraction', () => {
    // Valid JSON that is also parseable - direct parse should win
    const input = '{"direct": true}';
    expect(parseClaudeOutput(input)).toEqual({ direct: true });
  });
});
