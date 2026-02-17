---
name: scout
description: Run a standalone scout pass — find improvements without executing them
argument-hint: "[formula=name] [scope=path] [deep] [min_impact_score=N]"
---

Run a scout-only session that finds improvement proposals without executing them. Useful for previewing what PromptWheel would do.

## Arguments

Parse from `$ARGUMENTS` (all optional, key=value format):
- **formula** — Formula to use (e.g., `security-audit`, `test-coverage`)
- **scope** — Directory/glob to scan
- **deep** — Enable deep architectural review
- **min_impact_score** — Minimum impact score filter (1-10, default 3)

## Implementation

1. Call `promptwheel_start_session` with:
   - `max_cycles: 1`
   - `direct: true`
   - `parallel: 1`
   - Any provided arguments (formula, scope, deep, min_impact_score)

2. Call `promptwheel_advance` — returns a SCOUT prompt

3. Execute the scout: read files, analyze code, generate proposals in a `<proposals>` block

4. Call `promptwheel_ingest_event` with `SCOUT_OUTPUT` containing the proposals

5. **Do NOT execute any tickets.** Instead, display the proposals as a read-only report:

```
## Scout Report

Found N proposals:

1. [category] **Title** (impact: X, confidence: Y%)
   Description of the improvement...
   Files: path/to/file.ts, path/to/other.ts

2. [category] **Title** (impact: X, confidence: Y%)
   ...
```

6. Call `promptwheel_end_session` to clean up

7. Tell the user: "To execute these proposals, run `/promptwheel:run`"
