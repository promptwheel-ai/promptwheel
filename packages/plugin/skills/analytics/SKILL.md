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

### Performance Breakdown
Scout: 4.2m avg (18%) | Execute: 12.1m avg (52%) | QA: 5.3m avg (23%) | Git: 1.6m avg (7%)
(From `.promptwheel/history.ndjson` entries with `phaseTiming`)

### Category Performance
refactor  85% (17/20)  conf: +5
test      60% (6/10)   conf: -5
docs      45% (5/11)   conf: -10
(From `.promptwheel/run-state.json` → `categoryStats`)

### PR Outcomes
Created: 15 | Merged: 12 (80%) | Closed: 2 | Open: 1
Avg time-to-merge: 2.3h
(From `.promptwheel/pr-outcomes.ndjson`)

### Error Patterns (last 30 days)
type_error: 8 (top cmd: tsc) | test_assertion: 5 (top cmd: vitest)
(From `.promptwheel/error-ledger.ndjson`)

### Cost (last 7 days)
$18.50 across 8 sessions | Avg $0.34/ticket
(From `.promptwheel/history.ndjson` entries with `tokenUsage`)

### Learning ROI
72% effective | 3 low performers flagged
(From `.promptwheel/run-state.json` → `learningSnapshots`)

### Spindle Incidents
5 incidents | stalling (3), oscillation (1), token_budget (1)
(From `.promptwheel/spindle-incidents.ndjson`)

## Recommendations
Systems with low activity may not be providing value.
Run more sessions to gather data.
```

If `raw` argument is present, just output the last 100 events as JSON lines.
If `system` argument is present, filter to only that system.

## Data Sources

| Section | File | Key |
|---------|------|-----|
| System metrics | `.promptwheel/metrics.ndjson` | system, event |
| Run history | `.promptwheel/history.ndjson` | phaseTiming, tokenUsage |
| Category stats | `.promptwheel/run-state.json` | categoryStats |
| Learning snapshots | `.promptwheel/run-state.json` | learningSnapshots |
| Error patterns | `.promptwheel/error-ledger.ndjson` | failureType, failedCommand |
| PR outcomes | `.promptwheel/pr-outcomes.ndjson` | outcome, timeToResolveMs |
| Spindle incidents | `.promptwheel/spindle-incidents.ndjson` | trigger, confidence |

All files are optional — gracefully show "no data" if missing.
