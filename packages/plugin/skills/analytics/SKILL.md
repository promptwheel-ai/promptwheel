---
name: analytics
description: View PromptWheel system metrics and identify what's providing value
argument-hint: "[raw] [system=name]"
---

Display metrics collected from PromptWheel instrumentation to identify which systems are valuable.

## Arguments

Parse from `$ARGUMENTS` (all optional):
- **raw** — Show raw metrics events (last 100)
- **system** — Filter by system name (learnings, dedup, spindle, sectors, wave)

## Implementation

1. Read the metrics file at `.promptwheel/metrics.ndjson`
2. If file doesn't exist, inform user: "No metrics data yet. Run `/run` to generate metrics."
3. Parse NDJSON (one JSON object per line)
4. Aggregate by system and event type

## Output Format

Display a summary like:

```
## System Value Analysis

Data from: <start_date> to <end_date>
Total events: <count>

### Learnings System
- Loaded: N times
- Selected: N times
- Value: Active / Not used

### Dedup Memory
- Loaded: N times
- Duplicates blocked: N
- Value: Saving work / No duplicates found

### Spindle (Loop Detection)
- Checks passed: N
- Triggered: N
- Value: Preventing loops / No loops detected

### Sectors (Scope Rotation)
- Picks: N
- Value: Rotating coverage / Minimal rotation

### Wave Scheduling
- Partitions: N
- Value: Parallelizing work / Sequential only

## Recommendations
Systems with low activity may not be providing value.
Run more sessions to gather data.
```

If `raw` argument is present, just output the last 100 events as JSON lines.
If `system` argument is present, filter to only that system.
