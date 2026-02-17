import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  initMetrics,
  metric,
  flushMetrics,
  closeMetrics,
  readMetrics,
  analyzeMetrics,
  type MetricEvent,
} from '../lib/metrics.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

function metricsFile(): string {
  return path.join(tmpDir, '.promptwheel', 'metrics.ndjson');
}

function writeMetricsFile(events: MetricEvent[]): void {
  fs.mkdirSync(path.join(tmpDir, '.promptwheel'), { recursive: true });
  const lines = events.map(e => JSON.stringify(e)).join('\n') + '\n';
  fs.writeFileSync(metricsFile(), lines, 'utf-8');
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metrics-test-'));
});

afterEach(() => {
  // Critical: clean up module-level state (timers, buffer, path)
  closeMetrics();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// readMetrics
// ---------------------------------------------------------------------------

describe('readMetrics', () => {
  it('returns empty array when metrics file does not exist', () => {
    expect(readMetrics(tmpDir)).toEqual([]);
  });

  it('reads valid NDJSON events', () => {
    const events: MetricEvent[] = [
      { ts: 1000, system: 'learnings', event: 'loaded' },
      { ts: 2000, system: 'dedup', event: 'duplicate_found', data: { title: 'foo' } },
    ];
    writeMetricsFile(events);

    const result = readMetrics(tmpDir);
    expect(result).toHaveLength(2);
    expect(result[0].system).toBe('learnings');
    expect(result[0].event).toBe('loaded');
    expect(result[1].data).toEqual({ title: 'foo' });
  });

  it('skips malformed lines', () => {
    fs.mkdirSync(path.join(tmpDir, '.promptwheel'), { recursive: true });
    fs.writeFileSync(metricsFile(), [
      JSON.stringify({ ts: 1000, system: 'spindle', event: 'check_passed' }),
      'not valid json',
      '',
      JSON.stringify({ ts: 2000, system: 'wave', event: 'partitioned' }),
    ].join('\n'), 'utf-8');

    const result = readMetrics(tmpDir);
    expect(result).toHaveLength(2);
    expect(result[0].system).toBe('spindle');
    expect(result[1].system).toBe('wave');
  });

  it('returns empty array for completely invalid file', () => {
    fs.mkdirSync(path.join(tmpDir, '.promptwheel'), { recursive: true });
    fs.writeFileSync(metricsFile(), 'garbage\nnot json\n', 'utf-8');

    expect(readMetrics(tmpDir)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// analyzeMetrics
// ---------------------------------------------------------------------------

describe('analyzeMetrics', () => {
  it('returns empty summary when no metrics exist', () => {
    const summary = analyzeMetrics(tmpDir);
    expect(summary.totalEvents).toBe(0);
    expect(summary.bySystem).toEqual({});
    expect(summary.timeRange).toEqual({ start: 0, end: 0 });
  });

  it('aggregates events by system and event type', () => {
    writeMetricsFile([
      { ts: 1000, system: 'learnings', event: 'loaded' },
      { ts: 2000, system: 'learnings', event: 'selected' },
      { ts: 3000, system: 'learnings', event: 'selected' },
      { ts: 4000, system: 'dedup', event: 'duplicate_found' },
      { ts: 5000, system: 'spindle', event: 'check_passed' },
    ]);

    const summary = analyzeMetrics(tmpDir);
    expect(summary.totalEvents).toBe(5);
    expect(summary.timeRange.start).toBe(1000);
    expect(summary.timeRange.end).toBe(5000);

    expect(summary.bySystem['learnings'].total).toBe(3);
    expect(summary.bySystem['learnings'].events['loaded']).toBe(1);
    expect(summary.bySystem['learnings'].events['selected']).toBe(2);

    expect(summary.bySystem['dedup'].total).toBe(1);
    expect(summary.bySystem['dedup'].events['duplicate_found']).toBe(1);

    expect(summary.bySystem['spindle'].total).toBe(1);
  });

  it('handles single event', () => {
    writeMetricsFile([
      { ts: 42, system: 'session', event: 'started' },
    ]);

    const summary = analyzeMetrics(tmpDir);
    expect(summary.totalEvents).toBe(1);
    expect(summary.timeRange.start).toBe(42);
    expect(summary.timeRange.end).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// initMetrics / metric / flushMetrics / closeMetrics lifecycle
// ---------------------------------------------------------------------------

describe('metric buffering lifecycle', () => {
  it('initMetrics creates .promptwheel directory and sets up metrics path', () => {
    initMetrics(tmpDir);
    // After init, flushing should work (even with no buffered events)
    flushMetrics();
    // File may not exist yet (no events buffered), but dir should exist
    expect(fs.existsSync(path.join(tmpDir, '.promptwheel'))).toBe(true);
  });

  it('metric + flushMetrics writes events to NDJSON file', () => {
    initMetrics(tmpDir);

    metric('learnings', 'loaded', { count: 5 });
    metric('dedup', 'duplicate_found');

    flushMetrics();

    const events = readMetrics(tmpDir);
    expect(events).toHaveLength(2);
    expect(events[0].system).toBe('learnings');
    expect(events[0].event).toBe('loaded');
    expect(events[0].data).toEqual({ count: 5 });
    expect(events[1].system).toBe('dedup');
    expect(events[1].event).toBe('duplicate_found');
    // Timestamps should be valid numbers
    expect(typeof events[0].ts).toBe('number');
    expect(events[0].ts).toBeGreaterThan(0);
  });

  it('flushMetrics is a no-op when buffer is empty', () => {
    initMetrics(tmpDir);
    flushMetrics();
    // File should not exist (no events)
    expect(fs.existsSync(metricsFile())).toBe(false);
  });

  it('flushMetrics writes to the initialized path', () => {
    // After closeMetrics in afterEach, metricsPath may still be set from prior test.
    // Re-init to a known path to test clean state.
    initMetrics(tmpDir);
    metric('test', 'event');
    flushMetrics();

    const events = readMetrics(tmpDir);
    expect(events).toHaveLength(1);
    expect(events[0].system).toBe('test');
  });

  it('multiple flushes append to the same file', () => {
    initMetrics(tmpDir);

    metric('spindle', 'check_passed');
    flushMetrics();

    metric('spindle', 'triggered');
    flushMetrics();

    const events = readMetrics(tmpDir);
    expect(events).toHaveLength(2);
    expect(events[0].event).toBe('check_passed');
    expect(events[1].event).toBe('triggered');
  });

  it('closeMetrics flushes remaining events', () => {
    initMetrics(tmpDir);

    metric('session', 'started');
    // Don't call flushMetrics manually — closeMetrics should flush

    closeMetrics();

    const events = readMetrics(tmpDir);
    expect(events).toHaveLength(1);
    expect(events[0].system).toBe('session');
  });

  it('closeMetrics is safe to call multiple times', () => {
    initMetrics(tmpDir);
    metric('session', 'started');

    closeMetrics();
    closeMetrics(); // second call should be a no-op
    closeMetrics(); // third call too

    const events = readMetrics(tmpDir);
    expect(events).toHaveLength(1);
  });

  it('auto-flushes when buffer reaches 50 events', () => {
    initMetrics(tmpDir);

    // Write 50 events — should trigger auto-flush
    for (let i = 0; i < 50; i++) {
      metric('bulk', `event_${i}`);
    }

    // File should exist due to auto-flush (without manual flushMetrics call)
    const events = readMetrics(tmpDir);
    expect(events).toHaveLength(50);
  });

  it('reinitializing resets buffer and path', () => {
    initMetrics(tmpDir);
    metric('old', 'event');

    // Reinit to a different dir
    const tmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'metrics-test2-'));
    try {
      initMetrics(tmpDir2);

      // Old buffered event should be lost (buffer is reset)
      flushMetrics();

      // Nothing in tmpDir (old event was in buffer, not flushed before reinit)
      expect(readMetrics(tmpDir)).toEqual([]);
      // Nothing in tmpDir2 (buffer was reset, no new events)
      expect(readMetrics(tmpDir2)).toEqual([]);

      // New events go to tmpDir2
      metric('new', 'event');
      flushMetrics();
      expect(readMetrics(tmpDir2)).toHaveLength(1);
      expect(readMetrics(tmpDir2)[0].system).toBe('new');
    } finally {
      fs.rmSync(tmpDir2, { recursive: true, force: true });
    }
  });
});
