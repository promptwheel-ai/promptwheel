/**
 * Lightweight instrumentation for measuring system value.
 * Tracks when optimization systems trigger and their outcomes.
 *
 * Data stored in .promptwheel/metrics.ndjson
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface MetricEvent {
  ts: number;           // timestamp
  system: string;       // which system: learnings, sectors, wave, dedup, spindle, qa-stats
  event: string;        // what happened: applied, blocked, triggered, skipped
  data?: Record<string, any>;  // context
}

let metricsBuffer: MetricEvent[] = [];
let metricsPath: string | null = null;
let flushInterval: NodeJS.Timeout | null = null;

/**
 * Initialize metrics for a session
 */
export function initMetrics(repoRoot: string): void {
  const dir = path.join(repoRoot, '.promptwheel');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  metricsPath = path.join(dir, 'metrics.ndjson');
  metricsBuffer = [];

  // Flush every 10 seconds
  if (flushInterval) clearInterval(flushInterval);
  flushInterval = setInterval(() => flushMetrics(), 10000);
}

/**
 * Record a metric event
 */
export function metric(system: string, event: string, data?: Record<string, any>): void {
  metricsBuffer.push({
    ts: Date.now(),
    system,
    event,
    data,
  });

  // Auto-flush if buffer gets large
  if (metricsBuffer.length >= 50) {
    flushMetrics();
  }
}

/**
 * Flush buffered metrics to disk
 */
export function flushMetrics(): void {
  if (!metricsPath || metricsBuffer.length === 0) return;

  const lines = metricsBuffer.map(m => JSON.stringify(m)).join('\n') + '\n';
  fs.appendFileSync(metricsPath, lines, 'utf-8');
  metricsBuffer = [];
}

/**
 * Close metrics (flush and stop interval)
 */
export function closeMetrics(): void {
  flushMetrics();
  if (flushInterval) {
    clearInterval(flushInterval);
    flushInterval = null;
  }
}

/**
 * Read all metrics from a repo
 */
export function readMetrics(repoRoot: string): MetricEvent[] {
  const filePath = path.join(repoRoot, '.promptwheel', 'metrics.ndjson');
  if (!fs.existsSync(filePath)) return [];

  const content = fs.readFileSync(filePath, 'utf-8');
  return content
    .split('\n')
    .filter(line => line.trim())
    .map(line => {
      try {
        return JSON.parse(line) as MetricEvent;
      } catch {
        return null;
      }
    })
    .filter((m): m is MetricEvent => m !== null);
}

/**
 * Analyze metrics and return summary
 */
export function analyzeMetrics(repoRoot: string): MetricsSummary {
  const events = readMetrics(repoRoot);

  const summary: MetricsSummary = {
    totalEvents: events.length,
    bySystem: {},
    timeRange: { start: 0, end: 0 },
  };

  if (events.length === 0) return summary;

  summary.timeRange.start = events[0].ts;
  summary.timeRange.end = events[events.length - 1].ts;

  for (const event of events) {
    if (!summary.bySystem[event.system]) {
      summary.bySystem[event.system] = { total: 0, events: {} };
    }
    summary.bySystem[event.system].total++;
    summary.bySystem[event.system].events[event.event] =
      (summary.bySystem[event.system].events[event.event] || 0) + 1;
  }

  return summary;
}

export interface MetricsSummary {
  totalEvents: number;
  bySystem: Record<string, {
    total: number;
    events: Record<string, number>;
  }>;
  timeRange: { start: number; end: number };
}
