---
name: heal
description: Diagnose and recover blocked tickets
argument-hint: "<ticket_id> [retry|expand_scope]"
---

Diagnose why a ticket is blocked and optionally apply a recovery action.

## Arguments

Parse from `$ARGUMENTS`:
- **ticket_id** (required) — The ticket ID to diagnose/heal
- **action** (optional) — One of: `retry`, `expand_scope`. If omitted, defaults to `diagnose` (read-only).

## Implementation

1. Parse ticket_id and optional action from `$ARGUMENTS`
2. If no ticket_id provided, call `promptwheel_audit_tickets` with `status_filter=blocked` to list blocked tickets, then ask the user which one to heal
3. Call `promptwheel_heal_blocked` MCP tool with `ticket_id` and `action`
4. Display diagnosis and any applied changes

## Output Format

Display results like:

```
## Ticket Diagnosis: <ticket_id>

Title: <title>
Status: <status>

### Diagnosis
<diagnosis text — explains why the ticket is blocked>

### Suggested Actions
- retry — reset retry count and status to ready
- expand_scope — widen allowed_paths for related files

### Applied
<if an action was requested, show what was done>
```

## Actions

- **diagnose** (default): Read-only analysis. Shows what's wrong and suggests fixes.
- **retry**: Resets the ticket status to `ready` and clears the retry count. Use after fixing the underlying issue.
- **expand_scope**: Widens the ticket's allowed_paths to include sibling directories. Use when the ticket failed due to scope restrictions.
