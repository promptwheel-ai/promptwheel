# Configuration Reference

BlockSpool configuration is stored in `.blockspool/config.json`. All settings are optional — sensible defaults are used when omitted.

## Example Configuration

```json
{
  "auto": {
    "defaultScope": "src",
    "maxTestRatio": 0.4,
    "maxPrs": 20,
    "draftPrs": true,
    "docsAudit": true,
    "docsAuditInterval": 3,
    "minImpactScore": 3,
    "pluginParallel": 2,
    "batchTokenBudget": 20000,
    "scoutTimeoutMs": 300000,
    "maxFilesPerCycle": 60
  },
  "retention": {
    "maxRuns": 50,
    "maxHistoryEntries": 100
  },
  "qa": {
    "commands": [
      { "name": "typecheck", "cmd": "npm run typecheck" },
      { "name": "lint", "cmd": "npm run lint" },
      { "name": "test", "cmd": "npm test" }
    ]
  }
}
```

---

## `auto` Settings

| Field | Default | Description |
|-------|---------|-------------|
| `defaultScope` | `"**"` | Glob scope for scanning. CLI also searches `src`, `lib`, `app`, `packages`, etc. |
| `maxTestRatio` | `0.4` | Max fraction of test proposals per batch. Prevents test-heavy batches; remaining slots go to refactors/perf. |
| `maxPrs` | `3` | Max PRs per run (unlimited in wheel mode) |
| `draftPrs` | `true` | Create draft PRs |
| `docsAudit` | `true` | Set `false` to disable auto docs-audit |
| `docsAuditInterval` | `3` | Auto docs-audit every N cycles |
| `pullEveryNCycles` | `5` | Pull from origin every N cycles in wheel mode (0 = disabled) |
| `pullPolicy` | `"halt"` | On pull divergence: `"halt"` stops the session, `"warn"` logs and continues |
| `guidelinesRefreshCycles` | `10` | Re-read guidelines file every N cycles during long runs (0 = disabled) |
| `autoCreateGuidelines` | `true` | Auto-create baseline AGENTS.md/CLAUDE.md if none exists (set `false` to disable) |
| `guidelinesPath` | `null` | Custom path to guidelines file relative to repo root (e.g. `"docs/CONVENTIONS.md"`). Set to `false` to disable guidelines entirely. `null` = default search. |
| `minImpactScore` | `3` | Minimum impact score (1-10) for proposals. Filters out low-value lint/cleanup. |
| `pluginParallel` | `2` | Number of parallel tickets in plugin mode (max: 5). Set to 1 for sequential. |
| `batchTokenBudget` | auto | Token budget per scout batch. Default: 20k (Codex), 10k (Claude). Higher = fewer batches, faster scouting. |
| `scoutTimeoutMs` | auto | Timeout per scout batch in ms. Default: 300000 (Codex), 120000 (Claude). |
| `maxFilesPerCycle` | `60` | Maximum files scanned per scout cycle. Increase for large repos with `--wheel`. |
| `learningsEnabled` | `true` | Enable cross-run learning from failures |
| `learningsBudget` | `2000` | Character budget for learnings in prompts |

---

## `retention` Settings

BlockSpool accumulates state over time (run folders, history, artifacts). The retention system caps all unbounded state with configurable item limits.

| Field | Default | Description |
|-------|---------|-------------|
| `maxRuns` | `50` | Keep last N run folders |
| `maxHistoryEntries` | `100` | Keep last N lines in history.ndjson |
| `maxArtifactsPerRun` | `20` | Keep newest N artifact files per run |
| `maxSpoolArchives` | `5` | Keep last N archived spool files |
| `maxDeferredProposals` | `20` | Max deferred proposals in run-state |
| `maxCompletedTickets` | `200` | Hard-delete oldest completed tickets beyond cap |
| `maxSpindleFileEditKeys` | `50` | Cap file_edit_counts keys in spindle state |
| `maxMergedBranches` | `10` | Keep last N local blockspool/* branches |

### Auto-prune

On every `blockspool` session start, stale items are pruned automatically: run folders, history, artifacts, spool archives, deferred proposals, completed tickets, and orphaned worktrees.

### Manual prune

`blockspool prune` runs the full cleanup including merged git branches (which are skipped during auto-prune to avoid touching git state on startup).

```bash
# See what would be deleted
blockspool prune --dry-run

# Delete stale items
blockspool prune
```

---

## `qa` Settings

Configure commands that verify code quality after changes. Commands run in order; all must pass for a ticket to complete.

```json
{
  "qa": {
    "commands": [
      { "name": "typecheck", "cmd": "npm run typecheck" },
      { "name": "lint", "cmd": "npm run lint" },
      { "name": "test", "cmd": "npm test" }
    ]
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `commands` | Array | List of QA commands |
| `commands[].name` | String | Display name for the command |
| `commands[].cmd` | String | Shell command to run |

QA commands are auto-detected from `package.json` for Node.js projects. You only need to configure this section if auto-detection doesn't work for your setup.

### Language-specific examples

**Python:**
```json
{
  "qa": {
    "commands": [
      { "name": "typecheck", "cmd": "mypy src/" },
      { "name": "lint", "cmd": "ruff check src/" },
      { "name": "test", "cmd": "pytest" }
    ]
  }
}
```

**Go:**
```json
{
  "qa": {
    "commands": [
      { "name": "build", "cmd": "go build ./..." },
      { "name": "lint", "cmd": "golangci-lint run" },
      { "name": "test", "cmd": "go test ./..." }
    ]
  }
}
```

**Rust:**
```json
{
  "qa": {
    "commands": [
      { "name": "build", "cmd": "cargo build" },
      { "name": "lint", "cmd": "cargo clippy" },
      { "name": "test", "cmd": "cargo test" }
    ]
  }
}
```

---

## Database Configuration

### SQLite (Default)

No configuration needed. Database stored at `.blockspool/state.sqlite`.

### PostgreSQL

Set the `DATABASE_URL` environment variable:

```bash
export DATABASE_URL="postgresql://user:password@localhost:5432/blockspool"
```

Or in `.env`:
```
DATABASE_URL=postgresql://user:password@localhost:5432/blockspool
```

---

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `ANTHROPIC_API_KEY` | Anthropic API key for CLI + Claude | — |
| `OPENAI_API_KEY` | OpenAI API key for CLI + Codex | — |
| `MOONSHOT_API_KEY` | Moonshot API key for CLI + Kimi | — |
| `DATABASE_URL` | PostgreSQL connection string | SQLite |
| `BLOCKSPOOL_CONFIG` | Config file path | `.blockspool/config.json` |
| `BLOCKSPOOL_LOG_LEVEL` | Logging level | `info` |
| `GITHUB_TOKEN` | GitHub token for PR creation | From `gh` CLI |

---

## .gitignore Recommendations

Add to your `.gitignore`:

```gitignore
# BlockSpool
.blockspool/state.sqlite
.blockspool/state.sqlite-journal
.blockspool/state.sqlite-wal
```

Keep in version control:
- `.blockspool/config.json` — share configuration with your team
- `.blockspool/formulas/` — custom formulas
