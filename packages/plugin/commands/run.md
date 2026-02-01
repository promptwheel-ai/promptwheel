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

### Why `general-purpose` (not `Bash`)

Subagents need MCP tool access (`blockspool_advance_ticket`, `blockspool_ingest_ticket_event`) plus file editing tools (Read, Edit, Write, Glob, Grep) plus Bash for git/test commands. Only `general-purpose` subagents have access to all of these. `Bash` subagents only have the Bash tool.

### Launching — Single Message, All At Once

You **MUST** send all Task tool calls in a **single message** so they run concurrently. Example with 2 tickets:

```
// In ONE message, call Task twice:
Task({ subagent_type: "general-purpose", description: "Execute ticket: Fix auth bug", prompt: "..." })
Task({ subagent_type: "general-purpose", description: "Execute ticket: Add tests", prompt: "..." })
```

If you send them in separate messages, they run sequentially — defeating the purpose.

### Background Execution (Optional)

For long-running tickets (complex changes, multi-file refactors), you can use `run_in_background: true`:

```
Task({
  subagent_type: "general-purpose",
  description: "Execute ticket: <title>",
  run_in_background: true,
  prompt: "..."
})
```

This returns an `output_file` path immediately. Use `Read` to check progress, or wait for the background task notification. This keeps you responsive while tickets execute.

For short sessions (1 cycle, few tickets), foreground is simpler — just wait for all to return.

### Subagent Prompt Template

For each ticket in `parallel_tickets`, fill in this template as the `prompt` parameter:

```
You are executing a BlockSpool ticket in an isolated git worktree.

**Ticket ID:** {ticket_id}
**Title:** {title}
**Description:** {description}

**Constraints:**
- Allowed paths: {constraints.allowed_paths}
- Denied paths: {constraints.denied_paths}
- Max files: {constraints.max_files}
- Max lines: {constraints.max_lines}
- Verification commands: {constraints.required_commands}

## Setup

1. Create the worktree if it doesn't exist:
   ```bash
   git worktree add .blockspool/worktrees/{ticket_id} -b blockspool/{ticket_id}/{slug}
   ```
2. All work MUST happen inside `.blockspool/worktrees/{ticket_id}`

## Execution Loop

Repeat until done:

1. Call `blockspool_advance_ticket` with `ticket_id: "{ticket_id}"`
2. Read the response:
   - `action: "PROMPT"` → Execute the prompt (read files, edit code, run tests, create PR)
   - `action: "DONE"` → Ticket complete, stop
   - `action: "FAILED"` → Ticket failed, stop
3. After executing the prompt, report results via `blockspool_ingest_ticket_event`:
   - For plans: `type: "PLAN_SUBMITTED"`, `payload: { ticket_id, files_to_touch, estimated_lines, risk_level, ... }`
   - For execution: `type: "TICKET_RESULT"`, `payload: { status: "done", changed_files, lines_added, lines_removed, summary }`
   - For QA commands: `type: "QA_COMMAND_RESULT"`, `payload: { command, success, output }`
   - For QA summary: `type: "QA_PASSED"` or `type: "QA_FAILED"`, `payload: { ... }`
   - For PR: `type: "PR_CREATED"`, `payload: { url, branch }`
4. Go back to step 1

## Important

- Stay inside the worktree directory for all file operations
- Follow the constraints strictly — the scope policy hook will block out-of-scope writes
- Do NOT modify files in the main working tree — only in your worktree
- Use the exact test runner syntax from the verification commands (do not guess CLI flags)
```

### After All Subagents Complete

1. Wait for ALL Task tool results to return (or read background output files)
2. Update task tracking: mark each ticket task as completed
3. Call `blockspool_advance` to continue (next batch or next scout cycle)

### Sequential Fallback

When `parallel` is 1 (or only 1 ticket is ready), advance returns `"PROMPT"` instead of `"PARALLEL_EXECUTE"`. No subagents needed — execute directly in the main loop. Still create a task for the active ticket.

## Rules

- Always follow the constraints returned by advance (allowed_paths, denied_paths, max_lines).
- Always output structured XML blocks when requested (`<proposals>`, `<commit-plan>`, `<ticket-result>`).
- The Stop hook will block premature exit while the session is active.
- When the session ends, delete `.blockspool/loop-state.json`.
