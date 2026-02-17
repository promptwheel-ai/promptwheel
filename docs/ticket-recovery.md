# Ticket Recovery Guide

When tickets fail or get blocked, PromptWheel provides tools to diagnose and recover them.

## Understanding Ticket States

| State | Meaning | Action needed? |
|-------|---------|---------------|
| `ready` | Waiting to be picked up | No — will execute automatically |
| `in_progress` | Currently executing | No — wait for completion |
| `done` | Completed successfully | No |
| `blocked` | Failed QA or execution | Yes — diagnose and recover |
| `cancelled` | Manually cancelled | No |

## Why Tickets Get Blocked

### QA Failures

The most common reason. PromptWheel classifies QA failures into categories:

| Error Class | Description | Auto-retries |
|-------------|-------------|-------------|
| `code` | Test or lint failure from the change itself | 3 |
| `environment` | Missing dependency, network issue, flaky test | 2 |
| `timeout` | Command exceeded time limit | 1 |
| `unknown` | Unclassified error | 2 |

PromptWheel retries automatically based on error class. A ticket is blocked only after exhausting retries.

### Plan Rejections

If a ticket's plan references files outside its `allowed_paths`, the plan is rejected. After 3 rejections, the ticket is blocked.

### Execution Failures

Claude CLI crashes, context overflow, or other execution-level errors.

### Loop Detection (Spindle)

PromptWheel's spindle system detects and aborts stuck tickets:
- **QA ping-pong** — alternating between the same pass/fail states
- **File churn** — repeatedly modifying the same files without progress
- **Command failure loops** — same command failing repeatedly
- **Stalling** — no meaningful progress after many steps

## Diagnosing Blocked Tickets

### Check Session Status

**CLI:**
```bash
promptwheel solo status
```

**Plugin:**
```
/promptwheel:status
```

This shows blocked tickets with their last error.

### Diagnose a Specific Ticket

**Plugin:**
```
/promptwheel:heal <ticket-id>
```

This runs diagnosis and reports:
- Why the ticket is blocked
- What error class was detected
- Whether scope expansion might help
- Suggested recovery action

### Check QA Details

The session status now includes QA failure details:
- Failed commands (which test/lint/typecheck failed)
- Error snippet (first 200 chars of error output)
- Error classification

## Recovery Options

### 1. Retry

Reset the ticket to `ready` so it gets picked up again:

**Plugin:**
```
/promptwheel:heal <ticket-id>
```
Choose "retry" when prompted.

Best for: environment errors, flaky tests, timeouts.

### 2. Expand Scope

Widen the ticket's `allowed_paths` to include files it needs:

**Plugin:**
```
/promptwheel:heal <ticket-id>
```
Choose "expand_scope" when prompted.

Best for: plan rejections where the ticket genuinely needs access to more files.

### 3. Skip and Move On

If a ticket isn't worth fixing, cancel it:

```
/promptwheel:cancel
```

Or start a new session — the learnings system will remember this failure and avoid similar proposals in future runs.

### 4. Manual Fix

For complex failures:

1. Check what the ticket was trying to do (title, description, allowed_paths)
2. Look at the error output to understand what went wrong
3. Fix the issue manually in your codebase
4. The next scout cycle will see the improvement is no longer needed

## Prevention

### Keep QA Commands Fast

Slow QA commands increase timeout risk. Aim for:
- Tests: under 60 seconds
- Lint: under 30 seconds
- Typecheck: under 30 seconds

### Add Project Guidelines

A `CLAUDE.md` with clear conventions reduces plan rejections and code quality issues:
- List your test/lint/build commands
- Note any patterns agents should follow
- Flag files or directories that should not be modified

### Use Scope Narrowing

For large projects, narrow the scope to reduce noise:

```bash
promptwheel --scope "src/**"
```

### Set Minimum Impact Score

Filter out low-value proposals that are more likely to fail:

```bash
promptwheel --min-impact-score 5
```

## Cross-Run Learnings

PromptWheel remembers failures across sessions. When a ticket fails:
- The error pattern is recorded as a "gotcha"
- Future scouts see relevant learnings and avoid similar proposals
- Success patterns are also recorded to reinforce what works

View learnings:
```
/promptwheel:learnings
```

Clear learnings to start fresh:
```
/promptwheel:learnings clear
```

## Common Patterns

### "Tests pass locally but fail in PromptWheel"

PromptWheel runs tests in isolated git worktrees. Check for:
- Hardcoded paths or environment variables
- Files not committed to git
- Dependencies on running services (databases, APIs)

### "Ticket keeps modifying the same files"

Spindle will catch this, but if it persists:
- The improvement may be too ambiguous
- Add clearer guidelines in CLAUDE.md
- Use `--min-impact-score 7` to filter out uncertain proposals

### "Plan rejected: file outside allowed_paths"

The scout proposed changes to specific files, but execution needs additional files. Use `/promptwheel:heal` with expand_scope, or add related files to the scope in your next run.

## Getting Help

If recovery doesn't work:

1. Check [Troubleshooting](./troubleshooting.md) for common issues
2. Review the session's learnings to see accumulated failure patterns
3. File an issue at [GitHub](https://github.com/promptwheel-ai/promptwheel/issues) with:
   - Ticket ID and error output
   - Your QA commands
   - Project type and size
