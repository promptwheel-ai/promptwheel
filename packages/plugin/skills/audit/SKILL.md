---
name: audit
description: Audit ticket quality and throughput across the current project
argument-hint: "[status=ready|blocked|done] [days=N]"
---

Analyze ticket health and throughput metrics for the current PromptWheel project.

## Arguments

Parse from `$ARGUMENTS` (all optional):
- **status** — Filter audit by ticket status (e.g., `status=ready`, `status=blocked`, `status=done`)
- **days** — Number of days to look back for throughput stats (default: 7)

## Implementation

1. Call `promptwheel_audit_tickets` MCP tool (pass `status_filter` if provided)
2. Call `promptwheel_ticket_stats` MCP tool (pass `days` if provided)
3. Combine results into a unified report

## Output Format

Display a summary like:

```
## Ticket Audit

Total tickets: N
By status: ready (N), blocked (N), done (N), aborted (N)
By category: refactor (N), test (N), security (N), ...

### Quality Issues
- N ticket(s) missing description
- N ticket(s) missing verification commands
- N ticket(s) with no allowed_paths
- N ticket(s) exhausted retries

### Throughput (last N days)
Completed: N tickets
Success rate: N%
Avg duration: Nms

Completions by day:
  2026-02-04: N
  2026-02-03: N
  ...

### Recommendations
- If blocked count is high: suggest running `/heal` on stuck tickets
- If success rate is low: suggest simplifying ticket scope
- If missing verification: suggest adding test commands
```

If no session is active, the tool will use the current project context.
