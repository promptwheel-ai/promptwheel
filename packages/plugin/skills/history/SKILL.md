---
name: history
description: View recent PromptWheel session runs and outcomes
argument-hint: "[limit=N]"
---

Show recent session run history for the current project.

## Arguments

Parse from `$ARGUMENTS` (optional):
- **limit** — Number of runs to show (default: 10)

## Implementation

1. Call `promptwheel_history` MCP tool with `limit` if provided
2. Display results in a formatted summary

## Output Format

```
## Session History

Total runs: N | Success: N | Failed: N | Success rate: N%

| # | Type | Status | Duration | Date |
|---|------|--------|----------|------|
| 1 | worker | success | 45s | 2026-02-15 |
| 2 | worker | failure | 12s | 2026-02-15 |
...
```

If no runs exist, inform the user: "No session history yet. Run `/promptwheel:run` to start."
