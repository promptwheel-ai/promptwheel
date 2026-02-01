---
name: run
description: Run BlockSpool — scouts, plans, executes, and PRs improvements continuously
arguments:
  - name: hours
    description: Time budget for multi-cycle runs (e.g. hours=4). Omit for a single cycle.
    required: false
  - name: formula
    description: Formula to use (e.g. security-audit, test-coverage, cleanup)
    required: false
  - name: cycles
    description: Number of scout→execute cycles (default: 1)
    required: false
  - name: deep
    description: Enable deep architectural review mode
    required: false
  - name: parallel
    description: Number of tickets to execute in parallel (default 2, max 5). Set to 1 for sequential.
    required: false
---

Start a BlockSpool session. By default runs one cycle: scout → execute tickets → PR → done.
Pass `cycles=3` for multiple rounds or `hours=4` for time-based runs.

## Setup

1. Call `blockspool_start_session` with the provided arguments.
2. After receiving the response, write `.blockspool/loop-state.json` with:
   ```json
   { "run_id": "<run_id>", "session_id": "<session_id>", "phase": "SCOUT" }
   ```
   This file is read by the Stop hook to prevent premature exit.

## Main Loop

3. Call `blockspool_advance` to get the next action.
4. Check `next_action` in the response:
   - `"PROMPT"` → Execute the prompt (scout, plan, code, test, git), then report via `blockspool_ingest_event`
   - `"PARALLEL_EXECUTE"` → Spawn subagents (see Parallel Execution below)
   - `"STOP"` → Session is done, clean up
5. Update `.blockspool/loop-state.json` with the current phase after each advance.
6. Repeat until advance returns `next_action: "STOP"`.

## Task Tracking

Use Claude Code's built-in task tracking to mirror the ticket lifecycle. This gives the user a live progress view.

**On session start:**
```
TaskCreate({ subject: "BlockSpool: Scout codebase", activeForm: "Scouting codebase" })
```

**When entering EXECUTE (sequential) or PARALLEL_EXECUTE:**
For each ticket, create a task:
```
TaskCreate({
  subject: "Ticket: <title>",
  description: "<ticket description>\nID: <ticket_id>\nAllowed paths: <paths>",
  activeForm: "Executing: <title>"
})
```
Then immediately `TaskUpdate({ taskId: "<id>", status: "in_progress" })`.

**When a ticket completes or PR is created:**
```
TaskUpdate({ taskId: "<id>", status: "completed" })
```

**When a ticket fails:**
```
TaskUpdate({ taskId: "<id>", status: "completed" })
```
(Mark completed, not stuck — the failure is recorded in BlockSpool's state.)

## Parallel Execution

When advance returns `next_action: "PARALLEL_EXECUTE"`, spawn one subagent per ticket using the **Task tool**.

Each ticket in `parallel_tickets` has an `inline_prompt` field — a complete, self-contained prompt that includes guidelines, project metadata, constraints, worktree setup, implementation steps, QA verification, and PR creation. Subagents do **NOT** need MCP tools — they only use Bash, Read, Edit, Write, Glob, and Grep.

### Why `general-purpose` (not `Bash`)

Subagents need file editing tools (Read, Edit, Write, Glob, Grep) plus Bash for git/test commands. Only `general-purpose` subagents have access to all of these. `Bash` subagents only have the Bash tool.

### Launching — Single Message, All At Once

You **MUST** send all Task tool calls in a **single message** so they run concurrently:

```
// In ONE message, call Task for each ticket in parallel_tickets:
Task({ subagent_type: "general-purpose", description: "Ticket: <title>", prompt: parallel_tickets[0].inline_prompt })
Task({ subagent_type: "general-purpose", description: "Ticket: <title>", prompt: parallel_tickets[1].inline_prompt })
```

If you send them in separate messages, they run sequentially — defeating the purpose.

The `inline_prompt` field contains everything the subagent needs. Use it directly as the `prompt` parameter — do not modify it.

### Background Execution (Optional)

For long-running tickets, use `run_in_background: true`:

```
Task({
  subagent_type: "general-purpose",
  description: "Ticket: <title>",
  run_in_background: true,
  prompt: parallel_tickets[i].inline_prompt
})
```

This returns an `output_file` path immediately. Use `Read` to check progress. For short sessions, foreground is simpler.

### After All Subagents Complete

1. Wait for ALL Task tool results to return (or read background output files)
2. Parse each subagent's output for the result block (TICKET_ID, STATUS, PR_URL, BRANCH, SUMMARY)
3. For each ticket, call `blockspool_ticket_event` to record the outcome:
   - Success: `type: "PR_CREATED"`, `payload: { ticket_id, url: "<pr-url>", branch: "<branch>" }`
   - Failure: `type: "TICKET_RESULT"`, `payload: { ticket_id, status: "failed", reason: "..." }`
4. Update task tracking: mark each ticket task as completed
5. Call `blockspool_advance` to continue (next batch or next scout cycle)

### Sequential Fallback

When `parallel` is 1 (or only 1 ticket is ready), advance returns `"PROMPT"` instead of `"PARALLEL_EXECUTE"`. No subagents needed — execute directly in the main loop. Still create a task for the active ticket.

## Rules

- Always follow the constraints returned by advance (allowed_paths, denied_paths, max_lines).
- Always output structured XML blocks when requested (`<proposals>`, `<commit-plan>`, `<ticket-result>`).
- The Stop hook will block premature exit while the session is active.
- When the session ends, delete `.blockspool/loop-state.json`.
