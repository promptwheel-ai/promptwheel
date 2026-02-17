# @promptwheel/mcp — MCP Server

Stateful MCP server that powers PromptWheel's improvement loop. Exposes tools for session management, scouting, execution, and git operations.

## Quick Start

```bash
# As stdio MCP server (for Claude Code plugin)
npx @promptwheel/mcp

# Or via the DirectClient API (for any LLM)
import { DirectClient } from '@promptwheel/mcp/direct-client';

const client = await DirectClient.create({ projectPath: '.' });
client.startSession({ scope: 'src/**', formula: 'security-audit' });

while (true) {
  const resp = await client.advance();
  if (resp.next_action === 'STOP') break;
  // ... call your LLM with resp.prompt ...
  await client.ingestEvent('SCOUT_OUTPUT', { proposals: [...] });
}

client.endSession();
await client.close();
```

## MCP Tool Reference

### Session Management

| Tool | Description | Parameters |
|------|-------------|------------|
| `promptwheel_start_session` | Initialize a session | `hours?`, `formula?`, `deep?`, `scope?`, `categories?`, `min_confidence?`, `max_prs?`, `step_budget?`, `ticket_step_budget?`, `draft_prs?` |
| `promptwheel_advance` | Get next action (main loop driver) | — |
| `promptwheel_ingest_event` | Report event, trigger state transitions | `type`, `payload` |
| `promptwheel_session_status` | Current session state | — |
| `promptwheel_end_session` | Finalize session | — |
| `promptwheel_nudge` | Add hint for next scout cycle | `hint` |
| `promptwheel_list_formulas` | List available formulas | — |
| `promptwheel_get_scope_policy` | Get scope policy for current ticket | `file_path?` |

### Execution

| Tool | Description | Parameters |
|------|-------------|------------|
| `promptwheel_next_ticket` | Get next ticket to work on | — |
| `promptwheel_validate_scope` | Check changed files against scope | `ticketId`, `changedFiles[]` |
| `promptwheel_complete_ticket` | Mark ticket done, run QA | `ticketId`, `runId`, `summary?` |
| `promptwheel_fail_ticket` | Mark ticket failed | `ticketId`, `runId`, `reason` |

### Git

| Tool | Description | Parameters |
|------|-------------|------------|
| `promptwheel_git_setup` | Create/checkout branch for ticket | `ticketId`, `baseBranch?` |

## Canonical Loop Protocol

The core protocol is adapter-agnostic. Any client repeats:

```
advance() → get prompt + constraints
         → execute prompt (any LLM)
         → ingest_event(type, payload)
         → repeat until STOP
```

### Event Types

| Event | When | Payload |
|-------|------|---------|
| `SCOUT_OUTPUT` | After scouting | `{ proposals: [...] }` |
| `PLAN_SUBMITTED` | After planning | `{ ticket_id, files_to_touch, estimated_lines, risk_level }` |
| `TICKET_RESULT` | After execution | `{ status, changed_files, lines_added, lines_removed }` |
| `QA_COMMAND_RESULT` | Per QA command | `{ command, success, output }` |
| `QA_PASSED` | All QA passes | `{ summary }` |
| `QA_FAILED` | QA fails | `{ error }` |
| `PR_CREATED` | PR created | `{ url, branch }` |
| `USER_OVERRIDE` | Hint or cancel | `{ hint }` or `{ cancel: true }` |

### Phase State Machine

```
SCOUT → NEXT_TICKET → PLAN → EXECUTE → QA → PR → NEXT_TICKET → DONE

Terminal states: DONE, BLOCKED_NEEDS_HUMAN, FAILED_BUDGET, FAILED_VALIDATION, FAILED_SPINDLE
```

## Formulas

Built-in formulas customize scout behavior:

| Formula | Description | Categories |
|---------|-------------|------------|
| `security-audit` | OWASP vulnerabilities | security |
| `test-coverage` | Missing unit tests | test |
| `type-safety` | Remove any/unknown | types |
| `cleanup` | Dead code, unused imports | refactor |
| `deep` | Architecture review | refactor, perf, security |
| `docs` | Missing JSDoc | docs |

### Custom Formulas

Create `.promptwheel/formulas/<name>.yaml`:

```yaml
description: Find and fix error handling issues
categories: [refactor, security]
min_confidence: 75  # hint only — does not filter proposals
risk_tolerance: medium
prompt: |
  Find functions with missing error handling.
  Look for uncaught promises, empty catch blocks,
  and functions that silently swallow errors.
tags: [quality]
```

## Run Folder Anatomy

Each session creates a run folder at `.promptwheel/runs/<run_id>/`:

```
.promptwheel/runs/run_abc123/
├── state.json          # Current RunState (overwritten each step)
├── events.ndjson       # Append-only event log (one JSON per line)
├── diffs/              # Patch files per step
│   └── 5-tkt_xyz.patch
└── artifacts/          # QA logs, scout proposals, etc.
    ├── 1-scout-proposals.json
    ├── 3-ticket-result.json
    ├── 4-qa-npm-test-pass.log
    └── 5-pr-created.json
```

### Debugging a Failed Run

1. **Check phase**: `cat .promptwheel/runs/<id>/state.json | jq .phase`
2. **Read events**: `cat .promptwheel/runs/<id>/events.ndjson | jq .`
3. **Find the failure**: `grep FAILED .promptwheel/runs/<id>/events.ndjson`
4. **Check spindle**: `cat .promptwheel/runs/<id>/state.json | jq .spindle`
5. **Read QA logs**: `cat .promptwheel/runs/<id>/artifacts/*qa*`

### state.json Fields

| Field | Description |
|-------|-------------|
| `phase` | Current state machine phase |
| `step_count` / `step_budget` | Progress tracking |
| `tickets_completed` / `tickets_failed` | Work summary |
| `spindle` | Loop detection state (output_hashes, diff_hashes, iterations_since_change) |
| `current_ticket_id` | Active ticket being worked on |
| `plan_approved` | Whether commit plan was approved |
| `hints` | Pending hints from nudge |

## Architecture

```
Claude Code / Any LLM
  └─ MCP: @promptwheel/mcp (stdio)
       ├─ advance()          — deterministic state machine
       ├─ processEvent()     — event-driven transitions
       ├─ checkSpindle()     — loop detection
       ├─ deriveScopePolicy()— scope enforcement
       ├─ loadFormula()      — formula system
       ├─ loadGuidelines()   — CLAUDE.md context injection
       └─ SQLite state       — tickets, runs, proposals
```

## Project Guidelines Context

The advance engine automatically loads project guidelines and prepends them to scout and execute prompts. This ensures agents follow project conventions without any configuration.

- **Claude runs** search for `CLAUDE.md` first, then fall back to `AGENTS.md`
- **Codex runs** search for `AGENTS.md` first, then fall back to `CLAUDE.md`
- Loaded fresh on every `advance()` call (MCP sessions are stateless between calls)
- Wrapped in `<project-guidelines>` XML tags
- Full file content injected (no truncation)
