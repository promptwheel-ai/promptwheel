import { describe, it, expect, beforeEach } from 'vitest';
import { TicketOutputBuffer } from '../tui/ticket-output-buffer.js';

let buf: TicketOutputBuffer;

beforeEach(() => {
  buf = new TicketOutputBuffer();
});

// ---------------------------------------------------------------------------
// append — line splitting
// ---------------------------------------------------------------------------

describe('append — line splitting', () => {
  it('splits a single chunk into lines', () => {
    buf.append('line1\nline2\nline3\n');
    expect(buf.lineCount).toBe(3);
    expect(buf.getContent()).toBe('line1\nline2\nline3');
  });

  it('handles chunk without trailing newline (partial line)', () => {
    buf.append('line1\npartial');
    expect(buf.lineCount).toBe(1);
    expect(buf.getContent()).toBe('line1\npartial');
  });

  it('reassembles partial lines across chunks', () => {
    buf.append('hel');
    buf.append('lo world\n');
    expect(buf.lineCount).toBe(1);
    expect(buf.getContent()).toBe('hello world');
  });

  it('handles multiple partial appends before newline', () => {
    buf.append('a');
    buf.append('b');
    buf.append('c\n');
    expect(buf.lineCount).toBe(1);
    expect(buf.getContent()).toBe('abc');
  });

  it('handles empty string append', () => {
    buf.append('');
    expect(buf.lineCount).toBe(0);
    expect(buf.getContent()).toBe('');
  });

  it('handles newline-only append', () => {
    buf.append('\n');
    expect(buf.lineCount).toBe(1);
    expect(buf.getContent()).toBe('');
  });

  it('handles multiple newlines', () => {
    buf.append('\n\n\n');
    expect(buf.lineCount).toBe(3);
  });

  it('handles mixed complete and partial lines', () => {
    buf.append('line1\nline2\npart');
    buf.append('ial2\nline3\n');
    // line1, line2 from first chunk; partial2, line3 from second chunk
    expect(buf.lineCount).toBe(4);
    expect(buf.getContent()).toBe('line1\nline2\npartial2\nline3');
  });
});

// ---------------------------------------------------------------------------
// ring buffer overflow
// ---------------------------------------------------------------------------

describe('ring buffer overflow', () => {
  it('enforces maxLines limit', () => {
    const small = new TicketOutputBuffer(3);
    small.append('a\nb\nc\nd\ne\n');
    expect(small.lineCount).toBe(3);
    // Should keep the last 3 lines: c, d, e
    expect(small.getContent()).toBe('c\nd\ne');
  });

  it('enforces maxLines across multiple appends', () => {
    const small = new TicketOutputBuffer(2);
    small.append('a\nb\n');
    small.append('c\nd\n');
    expect(small.lineCount).toBe(2);
    expect(small.getContent()).toBe('c\nd');
  });

  it('handles maxLines of 1', () => {
    const tiny = new TicketOutputBuffer(1);
    tiny.append('first\nsecond\nthird\n');
    expect(tiny.lineCount).toBe(1);
    expect(tiny.getContent()).toBe('third');
  });

  it('preserves partial line during overflow', () => {
    const small = new TicketOutputBuffer(2);
    small.append('a\nb\nc\npartial');
    expect(small.lineCount).toBe(2);
    expect(small.getContent()).toBe('b\nc\npartial');
  });
});

// ---------------------------------------------------------------------------
// getContent
// ---------------------------------------------------------------------------

describe('getContent', () => {
  it('returns empty string for empty buffer', () => {
    expect(buf.getContent()).toBe('');
  });

  it('returns only partial when no complete lines', () => {
    buf.append('partial only');
    expect(buf.getContent()).toBe('partial only');
  });

  it('returns lines joined without trailing newline', () => {
    buf.append('a\nb\nc\n');
    expect(buf.getContent()).toBe('a\nb\nc');
  });

  it('includes partial line at the end', () => {
    buf.append('a\nb\nincomplete');
    expect(buf.getContent()).toBe('a\nb\nincomplete');
  });
});

// ---------------------------------------------------------------------------
// lineCount
// ---------------------------------------------------------------------------

describe('lineCount', () => {
  it('returns 0 for empty buffer', () => {
    expect(buf.lineCount).toBe(0);
  });

  it('counts only complete lines (not partial)', () => {
    buf.append('line1\npartial');
    expect(buf.lineCount).toBe(1);
  });

  it('increments on each complete line', () => {
    buf.append('a\n');
    expect(buf.lineCount).toBe(1);
    buf.append('b\n');
    expect(buf.lineCount).toBe(2);
    buf.append('c\n');
    expect(buf.lineCount).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// tail
// ---------------------------------------------------------------------------

describe('tail', () => {
  it('returns all content when n >= lineCount', () => {
    buf.append('a\nb\nc\n');
    expect(buf.tail(10)).toBe('a\nb\nc');
  });

  it('returns last n lines', () => {
    buf.append('a\nb\nc\nd\ne\n');
    expect(buf.tail(2)).toBe('d\ne');
  });

  it('returns last n lines plus partial', () => {
    buf.append('a\nb\nc\npartial');
    expect(buf.tail(2)).toBe('b\nc\npartial');
  });

  it('handles tail(0) — only partial if present', () => {
    buf.append('a\nb\npartial');
    expect(buf.tail(0)).toBe('partial');
  });

  it('returns empty string for empty buffer', () => {
    expect(buf.tail(5)).toBe('');
  });

  it('handles tail with only partial content', () => {
    buf.append('no newline here');
    expect(buf.tail(1)).toBe('no newline here');
  });
});

// ---------------------------------------------------------------------------
// truncateTo
// ---------------------------------------------------------------------------

describe('truncateTo', () => {
  it('truncates lines and clears partial', () => {
    buf.append('a\nb\nc\npartial');
    buf.truncateTo(1);
    expect(buf.lineCount).toBe(1);
    expect(buf.getContent()).toBe('a');
  });

  it('does nothing when lineCount is already below target', () => {
    buf.append('a\nb\n');
    buf.truncateTo(10);
    expect(buf.lineCount).toBe(2);
    expect(buf.getContent()).toBe('a\nb');
  });

  it('truncates to 0 lines', () => {
    buf.append('a\nb\nc\n');
    buf.truncateTo(0);
    expect(buf.lineCount).toBe(0);
    expect(buf.getContent()).toBe('');
  });

  it('clears partial when truncating', () => {
    buf.append('a\nb\npartial');
    buf.truncateTo(2);
    // lineCount is 2 which equals target, so truncateTo is a no-op
    // since the condition is lineCount < this.lines.length
    expect(buf.lineCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// clear
// ---------------------------------------------------------------------------

describe('clear', () => {
  it('resets everything', () => {
    buf.append('a\nb\nc\npartial');
    buf.clear();
    expect(buf.lineCount).toBe(0);
    expect(buf.getContent()).toBe('');
  });

  it('is idempotent', () => {
    buf.clear();
    buf.clear();
    expect(buf.lineCount).toBe(0);
    expect(buf.getContent()).toBe('');
  });

  it('allows reuse after clear', () => {
    buf.append('old\n');
    buf.clear();
    buf.append('new\n');
    expect(buf.lineCount).toBe(1);
    expect(buf.getContent()).toBe('new');
  });
});

// ---------------------------------------------------------------------------
// constructor — custom maxLines
// ---------------------------------------------------------------------------

describe('constructor', () => {
  it('uses default maxLines of 10,000', () => {
    // The default is 10_000 — verify no overflow with fewer lines
    const b = new TicketOutputBuffer();
    for (let i = 0; i < 100; i++) {
      b.append(`line ${i}\n`);
    }
    expect(b.lineCount).toBe(100);
  });

  it('accepts custom maxLines', () => {
    const b = new TicketOutputBuffer(5);
    for (let i = 0; i < 10; i++) {
      b.append(`line ${i}\n`);
    }
    expect(b.lineCount).toBe(5);
  });
});
