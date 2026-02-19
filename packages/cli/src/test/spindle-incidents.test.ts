/**
 * Unit tests for spindle-incidents.ts — spindle abort event persistence and analysis.
 *
 * Exercises:
 * - NDJSON append (appendSpindleIncident)
 * - Trigger grouping, count, lastSeen, sort order (analyzeSpindleIncidents)
 * - Edge cases: missing file, malformed lines, empty file
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  appendSpindleIncident,
  analyzeSpindleIncidents,
} from '../lib/spindle-incidents.js';
import type { SpindleIncident } from '../lib/spindle-incidents.js';

let tmpDir: string;

function incidentsFile(): string {
  return path.join(tmpDir, '.promptwheel', 'spindle-incidents.ndjson');
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spindle-incidents-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeIncident(overrides: Partial<SpindleIncident> = {}): SpindleIncident {
  return {
    ts: 1700000000000,
    ticketId: 'tkt_1',
    ticketTitle: 'Fix auth',
    trigger: 'repeated_failure',
    confidence: 85,
    iteration: 3,
    diagnosticsSummary: 'Same error 3 times',
    ...overrides,
  };
}

describe('appendSpindleIncident', () => {
  it('creates .promptwheel directory and file on first write', () => {
    const incident = makeIncident();
    appendSpindleIncident(tmpDir, incident);

    expect(fs.existsSync(incidentsFile())).toBe(true);
    const content = fs.readFileSync(incidentsFile(), 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toEqual(incident);
  });

  it('appends multiple incidents as NDJSON lines', () => {
    appendSpindleIncident(tmpDir, makeIncident({ ticketId: 'tkt_1' }));
    appendSpindleIncident(tmpDir, makeIncident({ ticketId: 'tkt_2' }));
    appendSpindleIncident(tmpDir, makeIncident({ ticketId: 'tkt_3' }));

    const content = fs.readFileSync(incidentsFile(), 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[1]).ticketId).toBe('tkt_2');
  });
});

describe('analyzeSpindleIncidents', () => {
  it('returns empty array when file does not exist', () => {
    expect(analyzeSpindleIncidents(tmpDir)).toEqual([]);
  });

  it('returns empty array for empty file', () => {
    fs.mkdirSync(path.dirname(incidentsFile()), { recursive: true });
    fs.writeFileSync(incidentsFile(), '', 'utf-8');

    expect(analyzeSpindleIncidents(tmpDir)).toEqual([]);
  });

  it('groups incidents by trigger', () => {
    appendSpindleIncident(tmpDir, makeIncident({ ts: 1000, trigger: 'repeated_failure' }));
    appendSpindleIncident(tmpDir, makeIncident({ ts: 2000, trigger: 'repeated_failure' }));
    appendSpindleIncident(tmpDir, makeIncident({ ts: 3000, trigger: 'no_progress' }));

    const summaries = analyzeSpindleIncidents(tmpDir);
    expect(summaries).toHaveLength(2);
    expect(summaries[0].trigger).toBe('repeated_failure');
    expect(summaries[0].count).toBe(2);
    expect(summaries[1].trigger).toBe('no_progress');
    expect(summaries[1].count).toBe(1);
  });

  it('tracks lastSeen as the maximum timestamp per trigger', () => {
    appendSpindleIncident(tmpDir, makeIncident({ ts: 1000, trigger: 'repeated_failure' }));
    appendSpindleIncident(tmpDir, makeIncident({ ts: 5000, trigger: 'repeated_failure' }));
    appendSpindleIncident(tmpDir, makeIncident({ ts: 3000, trigger: 'repeated_failure' }));

    const summaries = analyzeSpindleIncidents(tmpDir);
    expect(summaries).toHaveLength(1);
    expect(summaries[0].lastSeen).toBe(5000);
  });

  it('sorts by count descending', () => {
    // 1x no_progress
    appendSpindleIncident(tmpDir, makeIncident({ trigger: 'no_progress' }));
    // 3x repeated_failure
    appendSpindleIncident(tmpDir, makeIncident({ trigger: 'repeated_failure' }));
    appendSpindleIncident(tmpDir, makeIncident({ trigger: 'repeated_failure' }));
    appendSpindleIncident(tmpDir, makeIncident({ trigger: 'repeated_failure' }));
    // 2x timeout
    appendSpindleIncident(tmpDir, makeIncident({ trigger: 'timeout' }));
    appendSpindleIncident(tmpDir, makeIncident({ trigger: 'timeout' }));

    const summaries = analyzeSpindleIncidents(tmpDir);
    expect(summaries).toHaveLength(3);
    expect(summaries[0].trigger).toBe('repeated_failure');
    expect(summaries[0].count).toBe(3);
    expect(summaries[1].trigger).toBe('timeout');
    expect(summaries[1].count).toBe(2);
    expect(summaries[2].trigger).toBe('no_progress');
    expect(summaries[2].count).toBe(1);
  });

  it('skips malformed NDJSON lines', () => {
    fs.mkdirSync(path.dirname(incidentsFile()), { recursive: true });
    fs.writeFileSync(
      incidentsFile(),
      JSON.stringify(makeIncident({ trigger: 'valid' })) + '\n' +
      'not valid json\n' +
      JSON.stringify(makeIncident({ trigger: 'valid' })) + '\n',
      'utf-8',
    );

    const summaries = analyzeSpindleIncidents(tmpDir);
    expect(summaries).toHaveLength(1);
    expect(summaries[0].trigger).toBe('valid');
    expect(summaries[0].count).toBe(2);
  });
});
