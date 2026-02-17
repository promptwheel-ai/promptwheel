# Plugin (Claude Code)

The BlockSpool plugin runs inside Claude Code sessions. It uses Claude Code's own authentication — no API key needed.

---

## Installation

```bash
# Add the marketplace (one-time)
/plugin marketplace add blockspool/blockspool

# Install the plugin
/plugin install blockspool@blockspool

# Restart Claude Code, then run:
/blockspool:run
```

If commands don't appear after restart, check that the plugin is enabled in `~/.claude/settings.json`:

```json
{
  "enabledPlugins": {
    "blockspool@blockspool": true
  }
}
```

### Updating

```bash
/plugin update blockspool@blockspool
```

---

## Skills

### `/blockspool:run`

Start an improvement session. Scouts the codebase, creates tickets, executes changes, and creates PRs.

| Argument | Description | Default |
|----------|-------------|---------|
| `hours` | Time budget in hours | unlimited |
| `cycles` | Number of scout-execute cycles | 1 |
| `formula` | Recipe name (`security-audit`, `test-coverage`, `type-safety`, `cleanup`, `docs`, `docs-audit`) | none |
| `deep` | Architectural review mode | `false` |
| `batch_size` | Milestone batching — merge N tickets into one PR | none (individual PRs) |
| `parallel` | Concurrent ticket execution (1-5) | 2 |
| `min_impact_score` | Minimum impact score (1-10) to filter proposals | 3 |
| `scope` | Directory to scan | auto-detected |
| `wheel` | Unattended wheel execution mode | `false` |

```
/blockspool:run                                  Single cycle
/blockspool:run wheel hours=4                    Wheel mode (unattended)
/blockspool:run hours=4 batch_size=20            4-hour run with milestone PRs
/blockspool:run formula=security-audit           Focus on vulnerabilities
/blockspool:run deep=true                        Architectural review
/blockspool:run cycles=5 parallel=3              5 cycles, 3 tickets at a time
```

### `/blockspool:status`

Show current session state: phase, budget, tickets completed, spindle risk.

### `/blockspool:nudge`

Send a hint to guide the next scout cycle.

```
/blockspool:nudge hint="focus on authentication module"
/blockspool:nudge hint="skip test files, focus on SQL injection"
```

### `/blockspool:cancel`

Gracefully end the current session. Displays summary of work completed.

### `/blockspool:scout`

Run a standalone scout pass — find improvements without executing them.

### `/blockspool:analytics`

View metrics: throughput, success rates, time per ticket, formula effectiveness.

### `/blockspool:audit`

Analyze ticket quality across the current session/project.

### `/blockspool:heal`

Diagnose and recover blocked tickets. Options: diagnose, retry, expand scope.

### `/blockspool:history`

View recent session runs with summary stats.

### `/blockspool:trajectory`

Manage improvement trajectories — list, show, activate, pause, resume, skip, or reset.

### `/blockspool:guidelines`

Audit, restructure, or generate CLAUDE.md/AGENTS.md project guidelines.

### `/blockspool:formulas`

List available formulas (built-in and custom from `.blockspool/formulas/`).

---

## How It Works

1. **Stop hook** prevents Claude Code from exiting while a session is active
2. **PreToolUse hook** blocks file writes outside the ticket's allowed scope (worktree-aware in parallel mode)
3. **MCP tools** provide the state machine: `advance` -> execute -> `ingest_event` -> repeat
4. **Parallel execution** spawns Task subagents per ticket in isolated worktrees. Each subagent gets a self-contained inline prompt — no MCP access needed by subagents.
5. **Formulas** customize what the scout looks for
6. **Spindle** detects loops (QA ping-pong, command failures, file churn) and aborts stuck agents
7. **Cross-run learnings** remember failures and successes across sessions
8. **Dedup memory** tracks completed/rejected proposals with temporal decay so the scout doesn't keep re-proposing the same work
9. **Project detection** auto-detects test runner, framework, linter, and language for correct CLI syntax

---

## Auth Note

The plugin uses Claude Code's own authentication — no API key is needed. However, if `ANTHROPIC_API_KEY` is set in your environment, Claude Code will prefer it over your Pro/Max subscription. This can result in unexpected API charges.

If you intend to use your subscription, make sure `ANTHROPIC_API_KEY` is **not** set when running Claude Code with the plugin.

---

## Manual MCP Setup (Alternative)

If you prefer not to use the marketplace, add the MCP server directly to your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "blockspool": {
      "command": "npx",
      "args": ["-y", "@blockspool/mcp"],
      "env": {}
    }
  }
}
```

This gives you the MCP tools (`blockspool_start_session`, `blockspool_advance`, etc.) but not the slash command skills or hooks.
