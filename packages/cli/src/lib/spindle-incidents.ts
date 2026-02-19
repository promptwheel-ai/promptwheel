/**
 * Spindle incident log.
 *
 * Persists spindle abort events to `.promptwheel/spindle-incidents.ndjson`
 * so loop-detection patterns can be surfaced by analytics.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface SpindleIncident {
  ts: number;
  ticketId: string;
  ticketTitle: string;
  trigger: string;
  confidence: number;
  iteration: number;
  diagnosticsSummary: string;
}

export interface SpindleTriggerSummary {
  trigger: string;
  count: number;
  lastSeen: number;
}

const INCIDENTS_FILE = 'spindle-incidents.ndjson';

function incidentsPath(repoRoot: string): string {
  return path.join(repoRoot, '.promptwheel', INCIDENTS_FILE);
}

/**
 * Append a spindle incident. Lazily creates the file on first write.
 */
export function appendSpindleIncident(repoRoot: string, entry: SpindleIncident): void {
  const fp = incidentsPath(repoRoot);
  const dir = path.dirname(fp);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.appendFileSync(fp, JSON.stringify(entry) + '\n', 'utf-8');
}

/**
 * Analyze spindle incidents: group by trigger, count, last occurrence.
 */
export function analyzeSpindleIncidents(repoRoot: string): SpindleTriggerSummary[] {
  const fp = incidentsPath(repoRoot);
  if (!fs.existsSync(fp)) return [];

  const content = fs.readFileSync(fp, 'utf-8');
  const lines = content.trim().split('\n').filter(l => l.length > 0);

  const grouped = new Map<string, SpindleTriggerSummary>();

  for (const line of lines) {
    try {
      const entry: SpindleIncident = JSON.parse(line);
      const existing = grouped.get(entry.trigger);
      if (existing) {
        existing.count++;
        existing.lastSeen = Math.max(existing.lastSeen, entry.ts);
      } else {
        grouped.set(entry.trigger, {
          trigger: entry.trigger,
          count: 1,
          lastSeen: entry.ts,
        });
      }
    } catch {
      // Skip malformed lines
    }
  }

  return [...grouped.values()].sort((a, b) => b.count - a.count);
}
