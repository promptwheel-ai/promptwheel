---
name: run
description: Run BlockSpool — interactive codebase improvement. Scouts, presents a roadmap, executes approved changes. Use `wheel` for unattended continuous execution.
argument-hint: "[wheel] [hours=N] [formula=name] [cycles=N] [deep] [parallel=N]"
---

Start a BlockSpool session. Default mode is **orchestration**: scout → present roadmap → user approves → execute sequentially → done.
Pass `wheel` for unattended continuous mode with parallel subagents and stop-hook loop.

## Arguments

Parse from `$ARGUMENTS` (all optional, key=value format):
- **wheel** — Enable continuous autonomous mode (parallel subagents, stop hook, no human approval)
- **hours** — Time budget for multi-cycle runs (e.g. `hours=4`)
- **formula** — Formula to use (e.g. `security-audit`, `test-coverage`, `cleanup`)
- **cycles** — Number of scout→execute cycles (default: 1)
- **deep** — Enable deep architectural review mode
- **parallel** — Concurrent tickets in wheel mode (default 2, max 5). Ignored in orchestration mode.
- **batch_size** — Milestone batching (merge N tickets into one PR)
- **min_impact_score** — Filter proposals (1-10, default 3)
- **scope** — Directory to scan (auto-detected)
- **direct** — Edit in place without worktrees (default: true). Auto-disabled when using PRs or parallel>1.

## Mode Detection

Check `$ARGUMENTS` for the word `wheel`:
- If **present** → jump to **Wheel Mode** (continuous autonomous)
- If **absent** → follow **Orchestration Mode** (default)

---

## Orchestration Mode (Default)

Human-in-the-loop interactive mode. No subagents, no stop hook, no loop-state file. The user approves every step.

### Phase 1 — Setup

1. Call `blockspool_start_session` with the provided arguments, plus: `direct: true, parallel: 1, max_cycles: 1`
2. **Do NOT** write `.blockspool/loop-state.json` — the user can exit anytime.

### Phase 2 — Scout

3. Call `blockspool_advance` → returns a SCOUT prompt.
4. Execute the scout: read files, analyze code, generate proposals in a `<proposals>` block.
5. **Do NOT** call `blockspool_ingest_event` yet — collect the proposals first.

### Phase 3 — Roadmap (Human Approval)

6. Present the proposals to the user as a numbered roadmap:

```
## Roadmap (N proposals)

1. [category] Title (impact: X, confidence: Y%)
2. [category] Title (impact: X, confidence: Y%)
3. [category] Title (impact: X, confidence: Y%)
...

Which proposals should I implement? (all / 1,3,5 / none)
```

7. **Wait for the user's response.** Do not proceed without explicit approval.

8. Based on the response:
   - **"all"** → keep all proposals
   - **"none"** → call `blockspool_end_session`, done
   - **"1,3,5"** (comma-separated numbers) → keep only those proposals
   - **0 proposals found** → tell the user "No improvements found", call `blockspool_end_session`, done

9. Call `blockspool_ingest_event` with `SCOUT_OUTPUT` containing **only the approved proposals**. Rejected proposals are discarded — they never become tickets.

### Phase 4 — Execute (Sequential)

10. Call `blockspool_advance` → returns the next ticket prompt.
11. For each ticket:
    - Show the user what will be changed: **"Implementing: [ticket title]"**
    - Execute directly in the active session: read files, edit code, run tests, commit
    - Report the result via `blockspool_ingest_event`
    - Call `blockspool_advance` for the next ticket
12. Repeat until advance returns `next_action: "STOP"`.

**No Task subagents** — Claude Code's active session does all the work. The user sees every change as it happens.

### Phase 5 — Finalize

13. Call `blockspool_end_session`.
14. Show a summary: tickets completed, files changed, commits made.

---

## Wheel Mode (Continuous Autonomous)

Activated by passing `wheel` in `$ARGUMENTS`. Unattended parallel execution with stop-hook loop. Matches the CLI's `--wheel` flag for continuous pottery-wheel mode.

### Setup

1. Call `blockspool_start_session` with the provided arguments.
2. After receiving the response, write `.blockspool/loop-state.json` with:
   ```json
   { "run_id": "<run_id>", "session_id": "<session_id>", "phase": "SCOUT" }
   ```
   This file is read by the Stop hook to prevent premature exit.

### Main Loop

3. Call `blockspool_advance` to get the next action.
4. Check `next_action` in the response:
   - `"PROMPT"` → Execute the prompt (scout, plan, code, test, git), then report via `blockspool_ingest_event`
   - `"PARALLEL_EXECUTE"` → Spawn subagents (see Parallel Execution below)
   - `"STOP"` → Session is done, clean up
5. Update `.blockspool/loop-state.json` with the current phase after each advance.
6. Repeat until advance returns `next_action: "STOP"`.

### Task Tracking

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

### Parallel Execution

When advance returns `next_action: "PARALLEL_EXECUTE"`, spawn one subagent per ticket using the **Task tool**.

Each ticket in `parallel_tickets` has an `inline_prompt` field — a complete, self-contained prompt that includes guidelines, project metadata, constraints, worktree setup, implementation steps, QA verification, and PR creation. Subagents do **NOT** need MCP tools — they only use Bash, Read, Edit, Write, Glob, and Grep.

#### Why `general-purpose` (not `Bash`)

Subagents need file editing tools (Read, Edit, Write, Glob, Grep) plus Bash for git/test commands. Only `general-purpose` subagents have access to all of these. `Bash` subagents only have the Bash tool.

#### Launching — Single Message, All At Once

You **MUST** send all Task tool calls in a **single message** so they run concurrently:

```
// In ONE message, call Task for each ticket in parallel_tickets:
Task({ subagent_type: "general-purpose", description: "Ticket: <title>", prompt: parallel_tickets[0].inline_prompt })
Task({ subagent_type: "general-purpose", description: "Ticket: <title>", prompt: parallel_tickets[1].inline_prompt })
```

If you send them in separate messages, they run sequentially — defeating the purpose.

The `inline_prompt` field contains everything the subagent needs. Use it directly as the `prompt` parameter — do not modify it.

#### Background Execution (Optional)

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

#### After All Subagents Complete

1. Wait for ALL Task tool results to return (or read background output files)
2. Parse each subagent's output for the result block (TICKET_ID, STATUS, PR_URL, BRANCH, SUMMARY)
3. For each ticket, call `blockspool_ticket_event` to record the outcome:
   - Success: `type: "PR_CREATED"`, `payload: { ticket_id, url: "<pr-url>", branch: "<branch>" }`
   - Failure: `type: "TICKET_RESULT"`, `payload: { ticket_id, status: "failed", reason: "..." }`
4. Update task tracking: mark each ticket task as completed
5. Call `blockspool_advance` to continue (next batch or next scout cycle)

#### Sequential Fallback

When `parallel` is 1 (or only 1 ticket is ready), advance returns `"PROMPT"` instead of `"PARALLEL_EXECUTE"`. No subagents needed — execute directly in the main loop. Still create a task for the active ticket.

---

## Rules

- Always follow the constraints returned by advance (allowed_paths, denied_paths, max_lines).
- Always output structured XML blocks when requested (`<proposals>`, `<commit-plan>`, `<ticket-result>`).
- In wheel mode, the Stop hook will block premature exit while the session is active.
- In orchestration mode, no `.blockspool/loop-state.json` exists — the Stop hook is a no-op and the user can exit freely.
- When the session ends in wheel mode, delete `.blockspool/loop-state.json`.
