import { describe, it, expect } from 'vitest';
import { parseClaudeOutput } from '../scout/runner.js';
import { batchFiles, type ScannedFile } from '../scout/scanner.js';

// ---------------------------------------------------------------------------
// parseClaudeOutput
// ---------------------------------------------------------------------------
describe('parseClaudeOutput', () => {
  it('parses valid JSON directly', () => {
    const result = parseClaudeOutput<{ x: number }>('{"x": 1}');
    expect(result).toEqual({ x: 1 });
  });

  it('parses JSON with surrounding whitespace', () => {
    const result = parseClaudeOutput<{ a: string }>('  \n  {"a":"b"}  \n  ');
    expect(result).toEqual({ a: 'b' });
  });

  it('extracts JSON from markdown code block', () => {
    const input = 'Here is the result:\n```json\n{"proposals": [1, 2]}\n```\nDone.';
    const result = parseClaudeOutput<{ proposals: number[] }>(input);
    expect(result).toEqual({ proposals: [1, 2] });
  });

  it('extracts JSON from code block without json tag', () => {
    const input = '```\n{"key": "value"}\n```';
    const result = parseClaudeOutput<{ key: string }>(input);
    expect(result).toEqual({ key: 'value' });
  });

  it('extracts JSON object from mixed text', () => {
    const input = 'Some preamble text\n{"found": true}\nSome trailing text';
    const result = parseClaudeOutput<{ found: boolean }>(input);
    expect(result).toEqual({ found: true });
  });

  it('returns null for completely invalid input', () => {
    const result = parseClaudeOutput('no json here at all');
    expect(result).toBeNull();
  });

  it('returns null for empty string', () => {
    const result = parseClaudeOutput('');
    expect(result).toBeNull();
  });

  it('parses JSON arrays', () => {
    const result = parseClaudeOutput<number[]>('[1, 2, 3]');
    expect(result).toEqual([1, 2, 3]);
  });

  it('handles nested objects', () => {
    const input = '{"a": {"b": {"c": 1}}}';
    const result = parseClaudeOutput<{ a: { b: { c: number } } }>(input);
    expect(result?.a.b.c).toBe(1);
  });

  it('prefers direct parse over code block extraction', () => {
    // If the entire string is valid JSON, it should parse directly
    const input = '{"direct": true}';
    const result = parseClaudeOutput<{ direct: boolean }>(input);
    expect(result).toEqual({ direct: true });
  });

  it('handles JSON with special characters in strings', () => {
    const input = '{"msg": "hello\\nworld"}';
    const result = parseClaudeOutput<{ msg: string }>(input);
    expect(result?.msg).toBe('hello\nworld');
  });

  it('returns null for malformed JSON in code block', () => {
    const input = '```json\n{invalid json}\n```';
    const result = parseClaudeOutput(input);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// batchFiles
// ---------------------------------------------------------------------------
describe('batchFiles', () => {
  function makeFile(name: string): ScannedFile {
    return { path: name, content: `// ${name}`, size: 10 };
  }

  it('returns empty array for empty input', () => {
    expect(batchFiles([])).toEqual([]);
  });

  it('creates a single batch when files <= batchSize', () => {
    const files = [makeFile('a.ts'), makeFile('b.ts')];
    const batches = batchFiles(files, 3);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(2);
  });

  it('splits files into correct number of batches', () => {
    const files = Array.from({ length: 7 }, (_, i) => makeFile(`f${i}.ts`));
    const batches = batchFiles(files, 3);
    expect(batches).toHaveLength(3);
    expect(batches[0]).toHaveLength(3);
    expect(batches[1]).toHaveLength(3);
    expect(batches[2]).toHaveLength(1);
  });

  it('uses default batchSize of 3', () => {
    const files = Array.from({ length: 6 }, (_, i) => makeFile(`f${i}.ts`));
    const batches = batchFiles(files);
    expect(batches).toHaveLength(2);
    expect(batches[0]).toHaveLength(3);
    expect(batches[1]).toHaveLength(3);
  });

  it('handles batchSize of 1', () => {
    const files = [makeFile('a.ts'), makeFile('b.ts'), makeFile('c.ts')];
    const batches = batchFiles(files, 1);
    expect(batches).toHaveLength(3);
    batches.forEach(b => expect(b).toHaveLength(1));
  });

  it('preserves file order across batches', () => {
    const files = [makeFile('a.ts'), makeFile('b.ts'), makeFile('c.ts'), makeFile('d.ts')];
    const batches = batchFiles(files, 2);
    expect(batches[0][0].path).toBe('a.ts');
    expect(batches[0][1].path).toBe('b.ts');
    expect(batches[1][0].path).toBe('c.ts');
    expect(batches[1][1].path).toBe('d.ts');
  });

  it('handles single file', () => {
    const batches = batchFiles([makeFile('only.ts')], 5);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(1);
  });

  it('handles exact multiple of batchSize', () => {
    const files = Array.from({ length: 9 }, (_, i) => makeFile(`f${i}.ts`));
    const batches = batchFiles(files, 3);
    expect(batches).toHaveLength(3);
    batches.forEach(b => expect(b).toHaveLength(3));
  });
});
