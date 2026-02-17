# @promptwheel/plugin — Claude Code Plugin

Continuous codebase improvement for Claude Code. Scouts improvements, plans changes, executes code, runs QA, and creates PRs — all within your Claude Code session.

## Installation

```bash
# 1. Add the marketplace
/plugin marketplace add promptwheel-ai/promptwheel

# 2. Install the plugin
/plugin install promptwheel@promptwheel

# 3. Restart Claude Code

# 4. Verify
/promptwheel:run
```

If commands don't appear after restart, check that the plugin is enabled in `~/.claude/settings.json`:

```json
{
  "enabledPlugins": {
    "promptwheel@promptwheel": true
  }
}
```

### Updating

```bash
/plugin update promptwheel@promptwheel
```

Or remove and reinstall:

```bash
/plugin remove promptwheel@promptwheel
/plugin install promptwheel@promptwheel
```

### Manual MCP setup (alternative)

Add the MCP server directly to your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "promptwheel": {
      "command": "npx",
      "args": ["-y", "@promptwheel/mcp"],
      "env": {}
    }
  }
}
```

## Commands

### `/promptwheel:run`

Start an improvement session. Scouts the codebase, creates tickets, executes changes, and creates PRs.

**Arguments:**

| Name | Description | Default |
|------|-------------|---------|
| `hours` | Time budget in hours | unlimited |
| `cycles` | Number of scout-execute cycles | 1 |
| `formula` | Recipe name (`security-audit`, `test-coverage`, `type-safety`, `cleanup`, `docs`, `docs-audit`) | none |
| `deep` | Architectural review mode | `false` |
| `batch_size` | Milestone batching — merge N tickets into one PR | none (individual PRs) |
| `parallel` | Concurrent ticket execution (1-5) | 2 |
| `min_impact_score` | Minimum impact score (1-10) to filter proposals | 3 |
| `scope` | Directory to scan | auto-detected |

**Examples:**

```
/promptwheel:run                                  Single cycle
/promptwheel:run hours=4 batch_size=20            4-hour run with milestone PRs
/promptwheel:run formula=security-audit           Focus on vulnerabilities
/promptwheel:run deep=true                        Architectural review
/promptwheel:run cycles=5 parallel=3              5 cycles, 3 tickets at a time
/promptwheel:run formula=test-coverage parallel=4 Test coverage with high parallelism
```

### `/promptwheel:status`

Show current session state: phase, budget, tickets completed, spindle risk.

### `/promptwheel:nudge`

Send a hint to guide the next scout cycle.

```
/promptwheel:nudge hint="focus on authentication module"
/promptwheel:nudge hint="skip test files, focus on SQL injection"
```

### `/promptwheel:cancel`

Gracefully end the current session. Displays summary of work completed.

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

## Hooks

| Hook | Purpose |
|------|---------|
| `Stop` | Blocks premature exit during active sessions |
| `PreToolUse` | Enforces scope policy on Write/Edit operations. In parallel mode, maps each worktree to its ticket's allowed paths. |

## Auth Note

The plugin uses Claude Code's own authentication — no API key is needed. However, if `ANTHROPIC_API_KEY` is set in your environment, Claude Code will prefer it over your Pro/Max subscription. This can result in unexpected API charges.

If you intend to use your subscription, make sure `ANTHROPIC_API_KEY` is **not** set when running Claude Code with the plugin.

## Files

```
packages/plugin/
├── .claude-plugin/plugin.json   # Plugin manifest
├── .mcp.json                    # MCP server config
├── skills/
│   ├── run/SKILL.md             # /promptwheel:run
│   ├── status/SKILL.md          # /promptwheel:status
│   ├── nudge/SKILL.md           # /promptwheel:nudge
│   └── cancel/SKILL.md          # /promptwheel:cancel
├── hooks/hooks.json             # Hook registration (auto-loaded)
└── scripts/hook-driver.js       # Stop + PreToolUse hook logic
```
