/**
 * Execution Trace Analysis — pure functions, no I/O.
 *
 * Parses Claude Code `--output-format stream-json` JSONL output and extracts:
 * 1. Compaction events (context limit hits)
 * 2. Per-tool-call token profiles
 * 3. Liveness / stall detection
 * 4. Semantic step decomposition
 * 5. Configurable trigger/alert evaluation
 *
 * Shared by @promptwheel/cli and @promptwheel/mcp.
 */

// ---------------------------------------------------------------------------
// Types — Raw JSONL events
// ---------------------------------------------------------------------------

export interface StreamJsonEvent {
  type: 'assistant' | 'system' | 'result';
  subtype?: string;
  message?: {
    role: string;
    content: ContentBlock[];
    usage?: { input_tokens: number; output_tokens: number };
    model?: string;
  };
  result?: {
    cost_usd?: number;
    duration_ms?: number;
    is_error?: boolean;
    num_turns?: number;
  };
}

export type ContentBlock =
  | { type: 'thinking'; thinking: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }
  | { type: 'text'; text: string };

// ---------------------------------------------------------------------------
// Types — Feature 1: Compaction
// ---------------------------------------------------------------------------

export interface CompactionEvent {
  timestamp_ms: number;
  event_index: number;
  tokens_before?: number;
  tokens_after?: number;
}

// ---------------------------------------------------------------------------
// Types — Feature 2: Token profiles
// ---------------------------------------------------------------------------

export interface ToolTokenProfile {
  tool_name: string;
  call_count: number;
  total_input_tokens: number;
  total_output_tokens: number;
  avg_input_tokens: number;
  avg_output_tokens: number;
  error_count: number;
}

// ---------------------------------------------------------------------------
// Types — Feature 3: Liveness
// ---------------------------------------------------------------------------

export interface LivenessSnapshot {
  total_duration_ms: number;
  event_count: number;
  avg_gap_ms: number;
  max_gap_ms: number;
  stall_periods: { start_ms: number; end_ms: number; duration_ms: number }[];
  /** Fraction of total time with gaps > 10s (0-1) */
  idle_ratio: number;
}

// ---------------------------------------------------------------------------
// Types — Feature 4: Semantic steps
// ---------------------------------------------------------------------------

export interface SemanticStep {
  label: string;
  tool_calls: string[];
  start_index: number;
  end_index: number;
  duration_ms?: number;
}

// ---------------------------------------------------------------------------
// Types — Feature 5: Triggers
// ---------------------------------------------------------------------------

export interface TriggerRule {
  id: string;
  name: string;
  condition: TriggerCondition;
  action: 'warn' | 'abort' | 'log';
  message?: string;
}

export type TriggerCondition =
  | { type: 'token_threshold'; threshold: number }
  | { type: 'compaction_count'; threshold: number }
  | { type: 'error_pattern'; pattern: string }
  | { type: 'stall_duration_ms'; threshold: number }
  | { type: 'tool_error_rate'; tool: string; threshold: number };

export interface TriggerAlert {
  rule_id: string;
  rule_name: string;
  action: 'warn' | 'abort' | 'log';
  message: string;
  timestamp_ms: number;
}

// ---------------------------------------------------------------------------
// Types — Combined analysis result
// ---------------------------------------------------------------------------

export interface TraceAnalysis {
  compactions: CompactionEvent[];
  tool_profiles: ToolTokenProfile[];
  liveness: LivenessSnapshot;
  steps: SemanticStep[];
  alerts: TriggerAlert[];
  total_input_tokens: number;
  total_output_tokens: number;
  total_cost_usd?: number;
  model?: string;
  is_stream_json: boolean;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** Parse a single JSONL line into a StreamJsonEvent, or null if invalid. */
export function parseStreamJsonLine(line: string): StreamJsonEvent | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed[0] !== '{') return null;
  try {
    const obj = JSON.parse(trimmed);
    if (typeof obj.type === 'string' && (obj.type === 'assistant' || obj.type === 'system' || obj.type === 'result')) {
      return obj as StreamJsonEvent;
    }
    return null;
  } catch {
    return null;
  }
}

/** Parse raw multi-line output into an array of StreamJsonEvents. */
export function parseStreamJson(rawOutput: string): StreamJsonEvent[] {
  if (!rawOutput) return [];
  const lines = rawOutput.split('\n');
  const events: StreamJsonEvent[] = [];
  for (const line of lines) {
    const evt = parseStreamJsonLine(line);
    if (evt) events.push(evt);
  }
  return events;
}

/** Check if the first line of output looks like stream-json. */
export function isStreamJsonOutput(firstLine: string): boolean {
  const trimmed = firstLine.trim();
  if (!trimmed || trimmed[0] !== '{') return false;
  try {
    const obj = JSON.parse(trimmed);
    return typeof obj.type === 'string' && (obj.type === 'assistant' || obj.type === 'system' || obj.type === 'result');
  } catch {
    return false;
  }
}

/** Reconstruct plain text from JSONL events for backward compat with spindle/detectPhase. */
export function reconstructText(events: StreamJsonEvent[]): string {
  const parts: string[] = [];
  for (const evt of events) {
    if (evt.message?.content) {
      for (const block of evt.message.content) {
        if (block.type === 'text') {
          parts.push(block.text);
        } else if (block.type === 'tool_result') {
          parts.push(block.content);
        }
      }
    }
  }
  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Feature 1: Compaction Detection
// ---------------------------------------------------------------------------

/** Extract compaction events from stream-json output. */
export function detectCompactions(events: StreamJsonEvent[]): CompactionEvent[] {
  const compactions: CompactionEvent[] = [];
  for (let i = 0; i < events.length; i++) {
    const evt = events[i];
    if (evt.type === 'system' && evt.subtype === 'compaction') {
      const ce: CompactionEvent = {
        timestamp_ms: Date.now(),
        event_index: i,
      };
      // Extract token counts from the message if available
      if (evt.message?.usage) {
        ce.tokens_after = evt.message.usage.input_tokens;
      }
      // Look at previous assistant message for tokens_before
      if (i > 0 && events[i - 1].message?.usage) {
        ce.tokens_before = events[i - 1].message!.usage!.input_tokens + events[i - 1].message!.usage!.output_tokens;
      }
      compactions.push(ce);
    }
  }
  return compactions;
}

// ---------------------------------------------------------------------------
// Feature 2: Per-Tool-Call Token Profiles
// ---------------------------------------------------------------------------

/** Build per-tool token usage profiles from stream-json events. */
export function buildToolProfiles(events: StreamJsonEvent[]): ToolTokenProfile[] {
  const profileMap = new Map<string, {
    call_count: number;
    total_input: number;
    total_output: number;
    error_count: number;
  }>();

  // Track tool_use IDs to their tool names for matching with tool_results
  const toolUseMap = new Map<string, string>();

  // Track cumulative token usage so we can compute deltas
  let prevCumulativeInput = 0;
  let prevCumulativeOutput = 0;

  for (const evt of events) {
    if (!evt.message?.content) continue;

    // Update cumulative tokens from this message's usage
    const msgInputTokens = evt.message.usage?.input_tokens ?? 0;
    const msgOutputTokens = evt.message.usage?.output_tokens ?? 0;

    // Compute delta for this message
    const inputDelta = msgInputTokens > prevCumulativeInput
      ? msgInputTokens - prevCumulativeInput : 0;
    const outputDelta = msgOutputTokens > prevCumulativeOutput
      ? msgOutputTokens - prevCumulativeOutput : 0;

    if (msgInputTokens > 0) prevCumulativeInput = msgInputTokens;
    if (msgOutputTokens > 0) prevCumulativeOutput = msgOutputTokens;

    // Count tool_use blocks and map their IDs
    const toolUseBlocks: string[] = [];
    for (const block of evt.message.content) {
      if (block.type === 'tool_use') {
        toolUseMap.set(block.id, block.name);
        toolUseBlocks.push(block.name);

        const p = profileMap.get(block.name) ?? { call_count: 0, total_input: 0, total_output: 0, error_count: 0 };
        p.call_count++;
        profileMap.set(block.name, p);
      } else if (block.type === 'tool_result') {
        const toolName = toolUseMap.get(block.tool_use_id);
        if (toolName && block.is_error) {
          const p = profileMap.get(toolName);
          if (p) p.error_count++;
        }
      }
    }

    // Distribute token delta across tool_use blocks in this message
    if (toolUseBlocks.length > 0 && (inputDelta > 0 || outputDelta > 0)) {
      const perToolInput = Math.floor(inputDelta / toolUseBlocks.length);
      const perToolOutput = Math.floor(outputDelta / toolUseBlocks.length);
      for (const name of toolUseBlocks) {
        const p = profileMap.get(name)!;
        p.total_input += perToolInput;
        p.total_output += perToolOutput;
      }
    }
  }

  // Build sorted result
  const profiles: ToolTokenProfile[] = [];
  for (const [name, p] of profileMap) {
    profiles.push({
      tool_name: name,
      call_count: p.call_count,
      total_input_tokens: p.total_input,
      total_output_tokens: p.total_output,
      avg_input_tokens: p.call_count > 0 ? Math.round(p.total_input / p.call_count) : 0,
      avg_output_tokens: p.call_count > 0 ? Math.round(p.total_output / p.call_count) : 0,
      error_count: p.error_count,
    });
  }

  // Sort by total tokens descending
  profiles.sort((a, b) =>
    (b.total_input_tokens + b.total_output_tokens) - (a.total_input_tokens + a.total_output_tokens)
  );

  return profiles;
}

// ---------------------------------------------------------------------------
// Feature 3: Liveness Detection
// ---------------------------------------------------------------------------

const STALL_THRESHOLD_MS = 30_000;
const IDLE_THRESHOLD_MS = 10_000;

/** Compute liveness metrics from event timestamps. */
export function computeLiveness(events: StreamJsonEvent[], timestamps: number[]): LivenessSnapshot {
  if (timestamps.length <= 1) {
    return {
      total_duration_ms: 0,
      event_count: timestamps.length,
      avg_gap_ms: 0,
      max_gap_ms: 0,
      stall_periods: [],
      idle_ratio: 0,
    };
  }

  const totalDuration = timestamps[timestamps.length - 1] - timestamps[0];
  const gaps: number[] = [];
  for (let i = 1; i < timestamps.length; i++) {
    gaps.push(timestamps[i] - timestamps[i - 1]);
  }

  const maxGap = Math.max(...gaps);
  const avgGap = gaps.reduce((sum, g) => sum + g, 0) / gaps.length;

  const stallPeriods: { start_ms: number; end_ms: number; duration_ms: number }[] = [];
  let idleTime = 0;

  for (let i = 1; i < timestamps.length; i++) {
    const gap = timestamps[i] - timestamps[i - 1];
    if (gap >= STALL_THRESHOLD_MS) {
      stallPeriods.push({
        start_ms: timestamps[i - 1],
        end_ms: timestamps[i],
        duration_ms: gap,
      });
    }
    if (gap >= IDLE_THRESHOLD_MS) {
      idleTime += gap;
    }
  }

  return {
    total_duration_ms: totalDuration,
    event_count: timestamps.length,
    avg_gap_ms: Math.round(avgGap),
    max_gap_ms: maxGap,
    stall_periods: stallPeriods,
    idle_ratio: totalDuration > 0 ? Math.min(1, idleTime / totalDuration) : 0,
  };
}

// ---------------------------------------------------------------------------
// Feature 4: Semantic Step Decomposition
// ---------------------------------------------------------------------------

type StepCategory = 'Reading files' | 'Editing code' | 'Running tests' | 'Git operations' | 'Planning' | 'Responding' | 'Searching' | 'Running command';

function classifyBlock(block: ContentBlock): StepCategory | null {
  if (block.type === 'thinking') return 'Planning';
  if (block.type === 'text') return 'Responding';
  if (block.type === 'tool_use') {
    const name = block.name;
    if (name === 'Read' || name === 'Glob' || name === 'Grep') return 'Reading files';
    if (name === 'Edit' || name === 'Write' || name === 'NotebookEdit') return 'Editing code';
    if (name === 'Bash') {
      const cmd = typeof block.input?.command === 'string' ? block.input.command : '';
      const lower = cmd.toLowerCase();
      if (lower.includes('test') || lower.includes('vitest') || lower.includes('jest') || lower.includes('pytest')) return 'Running tests';
      if (lower.includes('git ')) return 'Git operations';
      return 'Running command';
    }
    if (name === 'WebSearch' || name === 'WebFetch') return 'Searching';
    return 'Running command';
  }
  return null;
}

/** Group raw tool calls into semantic steps. */
export function decomposeSteps(events: StreamJsonEvent[]): SemanticStep[] {
  const steps: SemanticStep[] = [];
  let currentCategory: StepCategory | null = null;
  let currentTools: string[] = [];
  let startIndex = 0;

  for (let i = 0; i < events.length; i++) {
    const evt = events[i];
    if (!evt.message?.content) continue;

    for (const block of evt.message.content) {
      const cat = classifyBlock(block);
      if (!cat) continue;

      if (cat !== currentCategory) {
        // Close previous step
        if (currentCategory !== null) {
          steps.push({
            label: currentCategory,
            tool_calls: currentTools,
            start_index: startIndex,
            end_index: i,
          });
        }
        currentCategory = cat;
        currentTools = [];
        startIndex = i;
      }

      if (block.type === 'tool_use') {
        currentTools.push(block.name);
      }
    }
  }

  // Close final step
  if (currentCategory !== null) {
    steps.push({
      label: currentCategory,
      tool_calls: currentTools,
      start_index: startIndex,
      end_index: events.length - 1,
    });
  }

  return steps;
}

// ---------------------------------------------------------------------------
// Feature 5: Trigger Evaluation
// ---------------------------------------------------------------------------

/** Evaluate trigger rules against a trace analysis. */
export function evaluateTriggers(
  analysis: Omit<TraceAnalysis, 'alerts'>,
  rules: TriggerRule[],
): TriggerAlert[] {
  const alerts: TriggerAlert[] = [];
  const now = Date.now();

  for (const rule of rules) {
    let fired = false;
    const cond = rule.condition;

    switch (cond.type) {
      case 'token_threshold':
        fired = (analysis.total_input_tokens + analysis.total_output_tokens) > cond.threshold;
        break;
      case 'compaction_count':
        fired = analysis.compactions.length >= cond.threshold;
        break;
      case 'error_pattern': {
        const re = new RegExp(cond.pattern);
        // Match pattern against tool names that have errors
        for (const p of analysis.tool_profiles) {
          if (p.error_count > 0 && re.test(p.tool_name)) {
            fired = true;
            break;
          }
        }
        break;
      }
      case 'stall_duration_ms':
        fired = analysis.liveness.max_gap_ms > cond.threshold;
        break;
      case 'tool_error_rate': {
        const profile = analysis.tool_profiles.find(p => p.tool_name === cond.tool);
        if (profile && profile.call_count > 0) {
          fired = (profile.error_count / profile.call_count) > cond.threshold;
        }
        break;
      }
    }

    if (fired) {
      alerts.push({
        rule_id: rule.id,
        rule_name: rule.name,
        action: rule.action,
        message: rule.message ?? `Trigger ${rule.name} fired`,
        timestamp_ms: now,
      });
    }
  }

  return alerts;
}

// ---------------------------------------------------------------------------
// Combined Analysis Pipeline
// ---------------------------------------------------------------------------

/** Run full trace analysis on raw output. Falls back gracefully for plain text. */
export function analyzeTrace(rawOutput: string, triggerRules?: TriggerRule[]): TraceAnalysis {
  const firstLine = rawOutput.split('\n')[0] ?? '';
  const isJson = isStreamJsonOutput(firstLine);

  if (!isJson) {
    // Fallback: no structured data available
    return {
      compactions: [],
      tool_profiles: [],
      liveness: {
        total_duration_ms: 0,
        event_count: 0,
        avg_gap_ms: 0,
        max_gap_ms: 0,
        stall_periods: [],
        idle_ratio: 0,
      },
      steps: [],
      alerts: [],
      total_input_tokens: 0,
      total_output_tokens: 0,
      is_stream_json: false,
    };
  }

  const events = parseStreamJson(rawOutput);

  // Collect totals from result event or last assistant message
  let totalInput = 0;
  let totalOutput = 0;
  let totalCost: number | undefined;
  let model: string | undefined;

  for (const evt of events) {
    if (evt.message?.usage) {
      // Usage fields are cumulative in stream-json — take the max
      if (evt.message.usage.input_tokens > totalInput) {
        totalInput = evt.message.usage.input_tokens;
      }
      if (evt.message.usage.output_tokens > totalOutput) {
        totalOutput = evt.message.usage.output_tokens;
      }
    }
    if (evt.message?.model) {
      model = evt.message.model;
    }
    if (evt.result?.cost_usd !== undefined) {
      totalCost = evt.result.cost_usd;
    }
  }

  const compactions = detectCompactions(events);
  const toolProfiles = buildToolProfiles(events);
  // Generate synthetic timestamps for liveness (equally spaced as fallback)
  const now = Date.now();
  const timestamps = events.map((_, i) => now + i * 1000);
  const liveness = computeLiveness(events, timestamps);
  const steps = decomposeSteps(events);

  const partial: Omit<TraceAnalysis, 'alerts'> = {
    compactions,
    tool_profiles: toolProfiles,
    liveness,
    steps,
    total_input_tokens: totalInput,
    total_output_tokens: totalOutput,
    total_cost_usd: totalCost,
    model,
    is_stream_json: true,
  };

  const alerts = evaluateTriggers(partial, triggerRules ?? []);

  return { ...partial, alerts };
}

