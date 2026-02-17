/**
 * Tests for packages/core/src/trace/shared.ts
 *
 * Covers all 5 trace analysis features:
 * 1. Compaction detection
 * 2. Per-tool token profiles
 * 3. Liveness / stall detection
 * 4. Semantic step decomposition
 * 5. Trigger evaluation
 */

import { describe, it, expect } from 'vitest';
import {
  parseStreamJsonLine,
  parseStreamJson,
  isStreamJsonOutput,
  reconstructText,
  detectCompactions,
  buildToolProfiles,
  computeLiveness,
  decomposeSteps,
  evaluateTriggers,
  analyzeTrace,
  type StreamJsonEvent,
  type TriggerRule,
  type TraceAnalysis,
  type ToolTokenProfile,
} from '../trace/shared.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAssistantEvent(content: StreamJsonEvent['message']['content'], usage?: { input_tokens: number; output_tokens: number }): StreamJsonEvent {
  return {
    type: 'assistant',
    message: {
      role: 'assistant',
      content,
      usage,
      model: 'claude-opus-4-6',
    },
  };
}

function makeSystemCompaction(): StreamJsonEvent {
  return {
    type: 'system',
    subtype: 'compaction',
    message: {
      role: 'system',
      content: [{ type: 'text', text: 'Context compacted' }],
      usage: { input_tokens: 40000, output_tokens: 0 },
    },
  };
}

function makeResultEvent(cost?: number): StreamJsonEvent {
  return {
    type: 'result',
    result: {
      cost_usd: cost,
      duration_ms: 5000,
      is_error: false,
      num_turns: 3,
    },
  };
}

// ---------------------------------------------------------------------------
// parseStreamJson tests
// ---------------------------------------------------------------------------

describe('parseStreamJsonLine', () => {
  it('parses valid assistant message with tool_use', () => {
    const line = JSON.stringify(makeAssistantEvent([
      { type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: '/foo' } },
    ]));
    const result = parseStreamJsonLine(line);
    expect(result).not.toBeNull();
    expect(result!.type).toBe('assistant');
    expect(result!.message!.content[0]).toHaveProperty('name', 'Read');
  });

  it('parses system compaction event', () => {
    const line = JSON.stringify(makeSystemCompaction());
    const result = parseStreamJsonLine(line);
    expect(result).not.toBeNull();
    expect(result!.type).toBe('system');
    expect(result!.subtype).toBe('compaction');
  });

  it('parses result event with cost', () => {
    const line = JSON.stringify(makeResultEvent(0.43));
    const result = parseStreamJsonLine(line);
    expect(result).not.toBeNull();
    expect(result!.type).toBe('result');
    expect(result!.result!.cost_usd).toBe(0.43);
  });

  it('skips invalid JSON lines', () => {
    expect(parseStreamJsonLine('not json')).toBeNull();
    expect(parseStreamJsonLine('{}')).toBeNull();
    expect(parseStreamJsonLine('{"type": "unknown"}')).toBeNull();
    expect(parseStreamJsonLine('')).toBeNull();
  });

  it('returns empty for empty input', () => {
    expect(parseStreamJson('')).toEqual([]);
  });
});

describe('parseStreamJson', () => {
  it('parses multi-line JSONL', () => {
    const lines = [
      JSON.stringify(makeAssistantEvent([{ type: 'text', text: 'hello' }])),
      'invalid line',
      JSON.stringify(makeResultEvent()),
    ].join('\n');
    const events = parseStreamJson(lines);
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe('assistant');
    expect(events[1].type).toBe('result');
  });
});

// ---------------------------------------------------------------------------
// isStreamJsonOutput tests
// ---------------------------------------------------------------------------

describe('isStreamJsonOutput', () => {
  it('detects valid stream-json first line', () => {
    const line = JSON.stringify(makeAssistantEvent([{ type: 'text', text: 'hi' }]));
    expect(isStreamJsonOutput(line)).toBe(true);
  });

  it('returns false for plain text', () => {
    expect(isStreamJsonOutput('I will read the file now.')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isStreamJsonOutput('')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// reconstructText tests
// ---------------------------------------------------------------------------

describe('reconstructText', () => {
  it('extracts text blocks from assistant messages', () => {
    const events = [
      makeAssistantEvent([{ type: 'text', text: 'Hello' }]),
      makeAssistantEvent([{ type: 'text', text: 'World' }]),
    ];
    expect(reconstructText(events)).toBe('Hello\nWorld');
  });

  it('extracts tool_result content', () => {
    const events = [
      makeAssistantEvent([{ type: 'tool_result', tool_use_id: 'tu1', content: 'file contents here' }]),
    ];
    expect(reconstructText(events)).toBe('file contents here');
  });

  it('returns empty for no text content', () => {
    const events = [
      makeAssistantEvent([{ type: 'thinking', thinking: 'hmm...' }]),
    ];
    expect(reconstructText(events)).toBe('');
  });
});

// ---------------------------------------------------------------------------
// detectCompactions tests
// ---------------------------------------------------------------------------

describe('detectCompactions', () => {
  it('no compactions in clean output', () => {
    const events = [
      makeAssistantEvent([{ type: 'text', text: 'hi' }]),
      makeResultEvent(),
    ];
    expect(detectCompactions(events)).toEqual([]);
  });

  it('detects system compaction event', () => {
    const events = [
      makeAssistantEvent([{ type: 'text', text: 'working' }], { input_tokens: 100000, output_tokens: 20000 }),
      makeSystemCompaction(),
      makeAssistantEvent([{ type: 'text', text: 'continuing' }]),
    ];
    const compactions = detectCompactions(events);
    expect(compactions).toHaveLength(1);
    expect(compactions[0].event_index).toBe(1);
  });

  it('records event index correctly', () => {
    const events = [
      makeAssistantEvent([{ type: 'text', text: 'a' }]),
      makeAssistantEvent([{ type: 'text', text: 'b' }]),
      makeSystemCompaction(),
    ];
    const compactions = detectCompactions(events);
    expect(compactions[0].event_index).toBe(2);
  });

  it('handles multiple compactions', () => {
    const events = [
      makeAssistantEvent([{ type: 'text', text: 'a' }]),
      makeSystemCompaction(),
      makeAssistantEvent([{ type: 'text', text: 'b' }]),
      makeSystemCompaction(),
    ];
    expect(detectCompactions(events)).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// buildToolProfiles tests
// ---------------------------------------------------------------------------

describe('buildToolProfiles', () => {
  it('empty events returns empty profiles', () => {
    expect(buildToolProfiles([])).toEqual([]);
  });

  it('single tool call creates single profile', () => {
    const events = [
      makeAssistantEvent([
        { type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: '/a' } },
      ], { input_tokens: 1000, output_tokens: 500 }),
    ];
    const profiles = buildToolProfiles(events);
    expect(profiles).toHaveLength(1);
    expect(profiles[0].tool_name).toBe('Read');
    expect(profiles[0].call_count).toBe(1);
  });

  it('multiple calls same tool are aggregated', () => {
    const events = [
      makeAssistantEvent([
        { type: 'tool_use', id: 'tu1', name: 'Read', input: {} },
      ], { input_tokens: 1000, output_tokens: 500 }),
      makeAssistantEvent([
        { type: 'tool_use', id: 'tu2', name: 'Read', input: {} },
      ], { input_tokens: 2000, output_tokens: 1000 }),
    ];
    const profiles = buildToolProfiles(events);
    expect(profiles).toHaveLength(1);
    expect(profiles[0].call_count).toBe(2);
  });

  it('error tool results are tracked', () => {
    const events = [
      makeAssistantEvent([
        { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'npm test' } },
      ]),
      makeAssistantEvent([
        { type: 'tool_result', tool_use_id: 'tu1', content: 'FAILED', is_error: true },
      ]),
    ];
    const profiles = buildToolProfiles(events);
    const bashProfile = profiles.find(p => p.tool_name === 'Bash');
    expect(bashProfile).toBeDefined();
    expect(bashProfile!.error_count).toBe(1);
  });

  it('multiple tools are sorted by total tokens', () => {
    const events = [
      makeAssistantEvent([
        { type: 'tool_use', id: 'tu1', name: 'Read', input: {} },
      ], { input_tokens: 5000, output_tokens: 3000 }),
      makeAssistantEvent([
        { type: 'tool_use', id: 'tu2', name: 'Edit', input: {} },
      ], { input_tokens: 15000, output_tokens: 8000 }),
    ];
    const profiles = buildToolProfiles(events);
    expect(profiles).toHaveLength(2);
    expect(profiles[0].tool_name).toBe('Edit');
    expect(profiles[1].tool_name).toBe('Read');
  });
});

// ---------------------------------------------------------------------------
// computeLiveness tests
// ---------------------------------------------------------------------------

describe('computeLiveness', () => {
  it('no stalls in fast output', () => {
    const events = [makeAssistantEvent([{ type: 'text', text: 'a' }])];
    const timestamps = [1000, 2000, 3000, 4000, 5000];
    const result = computeLiveness(events, timestamps);
    expect(result.stall_periods).toHaveLength(0);
    expect(result.max_gap_ms).toBe(1000);
    expect(result.idle_ratio).toBe(0);
  });

  it('detects long gap as stall', () => {
    const events = [makeAssistantEvent([{ type: 'text', text: 'a' }])];
    const timestamps = [1000, 2000, 42000]; // 40s gap
    const result = computeLiveness(events, timestamps);
    expect(result.stall_periods).toHaveLength(1);
    expect(result.stall_periods[0].duration_ms).toBe(40000);
  });

  it('computes idle ratio correctly', () => {
    const events = [makeAssistantEvent([{ type: 'text', text: 'a' }])];
    // Total = 20s, one 15s gap (>10s threshold)
    const timestamps = [0, 5000, 20000];
    const result = computeLiveness(events, timestamps);
    expect(result.idle_ratio).toBe(15000 / 20000);
  });

  it('handles single event', () => {
    const events = [makeAssistantEvent([{ type: 'text', text: 'a' }])];
    const result = computeLiveness(events, [1000]);
    expect(result.total_duration_ms).toBe(0);
    expect(result.max_gap_ms).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// decomposeSteps tests
// ---------------------------------------------------------------------------

describe('decomposeSteps', () => {
  it('groups consecutive Read/Glob into "Reading files"', () => {
    const events = [
      makeAssistantEvent([{ type: 'tool_use', id: 'tu1', name: 'Read', input: {} }]),
      makeAssistantEvent([{ type: 'tool_use', id: 'tu2', name: 'Glob', input: {} }]),
    ];
    const steps = decomposeSteps(events);
    expect(steps.some(s => s.label === 'Reading files')).toBe(true);
    const readStep = steps.find(s => s.label === 'Reading files')!;
    expect(readStep.tool_calls).toContain('Read');
    expect(readStep.tool_calls).toContain('Glob');
  });

  it('splits on category change', () => {
    const events = [
      makeAssistantEvent([{ type: 'tool_use', id: 'tu1', name: 'Read', input: {} }]),
      makeAssistantEvent([{ type: 'tool_use', id: 'tu2', name: 'Edit', input: {} }]),
    ];
    const steps = decomposeSteps(events);
    expect(steps.length).toBeGreaterThanOrEqual(2);
    expect(steps[0].label).toBe('Reading files');
    expect(steps[1].label).toBe('Editing code');
  });

  it('Bash test → "Running tests"', () => {
    const events = [
      makeAssistantEvent([{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'npm test' } }]),
    ];
    const steps = decomposeSteps(events);
    expect(steps.some(s => s.label === 'Running tests')).toBe(true);
  });

  it('Edit/Write → "Editing code"', () => {
    const events = [
      makeAssistantEvent([{ type: 'tool_use', id: 'tu1', name: 'Edit', input: {} }]),
      makeAssistantEvent([{ type: 'tool_use', id: 'tu2', name: 'Write', input: {} }]),
    ];
    const steps = decomposeSteps(events);
    expect(steps.some(s => s.label === 'Editing code')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// evaluateTriggers tests
// ---------------------------------------------------------------------------

describe('evaluateTriggers', () => {
  const baseAnalysis: Omit<TraceAnalysis, 'alerts'> = {
    compactions: [],
    tool_profiles: [],
    liveness: { total_duration_ms: 5000, event_count: 5, avg_gap_ms: 1000, max_gap_ms: 2000, stall_periods: [], idle_ratio: 0 },
    steps: [],
    total_input_tokens: 50000,
    total_output_tokens: 30000,
    is_stream_json: true,
  };

  it('no rules → no alerts', () => {
    expect(evaluateTriggers(baseAnalysis, [])).toEqual([]);
  });

  it('token threshold triggered', () => {
    const rules: TriggerRule[] = [{
      id: 'tok', name: 'High tokens', condition: { type: 'token_threshold', threshold: 60000 }, action: 'warn',
    }];
    const alerts = evaluateTriggers(baseAnalysis, rules);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].rule_id).toBe('tok');
    expect(alerts[0].action).toBe('warn');
  });

  it('token threshold not triggered when under', () => {
    const rules: TriggerRule[] = [{
      id: 'tok', name: 'High tokens', condition: { type: 'token_threshold', threshold: 200000 }, action: 'warn',
    }];
    expect(evaluateTriggers(baseAnalysis, rules)).toEqual([]);
  });

  it('stall duration threshold', () => {
    const analysis = { ...baseAnalysis, liveness: { ...baseAnalysis.liveness, max_gap_ms: 45000 } };
    const rules: TriggerRule[] = [{
      id: 'stall', name: 'Stall', condition: { type: 'stall_duration_ms', threshold: 30000 }, action: 'abort',
    }];
    const alerts = evaluateTriggers(analysis, rules);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].action).toBe('abort');
  });

  it('compaction count threshold', () => {
    const analysis = {
      ...baseAnalysis,
      compactions: [{ timestamp_ms: 0, event_index: 5 }, { timestamp_ms: 0, event_index: 10 }],
    };
    const rules: TriggerRule[] = [{
      id: 'comp', name: 'Compaction', condition: { type: 'compaction_count', threshold: 2 }, action: 'abort',
    }];
    const alerts = evaluateTriggers(analysis, rules);
    expect(alerts).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// analyzeTrace full pipeline tests
// ---------------------------------------------------------------------------

describe('analyzeTrace', () => {
  it('full JSONL sample → complete TraceAnalysis', () => {
    const jsonl = [
      JSON.stringify(makeAssistantEvent([
        { type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: '/a.ts' } },
      ], { input_tokens: 1000, output_tokens: 500 })),
      JSON.stringify(makeAssistantEvent([
        { type: 'tool_use', id: 'tu2', name: 'Edit', input: {} },
      ], { input_tokens: 3000, output_tokens: 1500 })),
      JSON.stringify(makeResultEvent(0.15)),
    ].join('\n');

    const analysis = analyzeTrace(jsonl);
    expect(analysis.is_stream_json).toBe(true);
    expect(analysis.tool_profiles.length).toBeGreaterThan(0);
    expect(analysis.steps.length).toBeGreaterThan(0);
    expect(analysis.total_input_tokens).toBeGreaterThan(0);
    expect(analysis.total_cost_usd).toBe(0.15);
  });

  it('plain text fallback → is_stream_json: false', () => {
    const analysis = analyzeTrace('I will now read the file and make changes.');
    expect(analysis.is_stream_json).toBe(false);
    expect(analysis.tool_profiles).toEqual([]);
    expect(analysis.compactions).toEqual([]);
  });

  it('with trigger rules → alerts populated', () => {
    const jsonl = [
      JSON.stringify(makeAssistantEvent([
        { type: 'text', text: 'working' },
      ], { input_tokens: 60000, output_tokens: 40000 })),
      JSON.stringify(makeResultEvent()),
    ].join('\n');

    const rules: TriggerRule[] = [{
      id: 'tok', name: 'High tokens',
      condition: { type: 'token_threshold', threshold: 80000 },
      action: 'warn',
    }];

    const analysis = analyzeTrace(jsonl, rules);
    expect(analysis.alerts).toHaveLength(1);
    expect(analysis.alerts[0].rule_id).toBe('tok');
  });
});

// ---------------------------------------------------------------------------
// Learning generators tests
// ---------------------------------------------------------------------------

