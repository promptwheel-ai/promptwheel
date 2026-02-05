# BlockSpool

**Your codebase improves itself. Scouts improvements, executes in parallel, batches into milestone PRs.**

BlockSpool scouts your codebase for improvements, executes them in parallel, and batches everything into milestone PRs — ready for your review.

---

## Quick Start

### Inside Claude Code (recommended)

```bash
# Add the marketplace (one-time)
/plugin marketplace add blockspool/blockspool

# Install the plugin
/plugin install blockspool@blockspool

# Restart Claude Code, then run:
/blockspool:run
```

The plugin uses your Claude Code subscription — no API key needed. It scouts, executes, creates PRs, and prevents Claude from exiting until the session is done.

### From the terminal

```bash
# Install
npm install -g @blockspool/cli

# Initialize in your repo
cd your-project
blockspool init

# Run with Claude (requires ANTHROPIC_API_KEY)
blockspool --hours 8 --batch-size 30

# Or run with Codex (no Anthropic key needed)
codex login
blockspool --codex --hours 8 --batch-size 30

# Or run with Kimi
blockspool --kimi --kimi-model kimi-k2.5

# Or run with local models (Ollama, vLLM, etc. — completely free)
blockspool --local --local-model qwen2.5-coder
```

Come back to 5 milestone PRs containing 50+ improvements.

---

## Six Ways to Run

| Route | Auth | Best for |
|-------|------|----------|
| **Plugin** (`/blockspool:run`) | Claude Code subscription | Interactive use, no API key setup |
| **CLI + Claude** (`blockspool`) | `ANTHROPIC_API_KEY` | CI, cron jobs, long runs |
| **CLI + Codex** (`blockspool --codex`) | `codex login` or `CODEX_API_KEY` | No Anthropic key, Codex-native teams |
| **CLI + Kimi** (`blockspool --kimi`) | `kimi /login` or `MOONSHOT_API_KEY` | Kimi-native teams |
| **CLI + Local** (`blockspool --local`) | None (local server) | Ollama, vLLM, SGLang, LM Studio |
| **CLI + OpenAI** (`blockspool-run --provider openai`) | `OPENAI_API_KEY` | OpenAI-native teams |

### Codex model availability

BlockSpool uses the official `codex exec` CLI. Not all models are available with `codex login` (ChatGPT subscription):

| Model | `codex login` | `CODEX_API_KEY` |
|-------|:---:|:---:|
| `gpt-5.2-codex` (default) | ✅ | ✅ |
| `gpt-5.1-codex-max` | ✅ | ✅ |
| `gpt-5.2-codex-high` | ❌ | ✅ |
| `gpt-5.2-codex-xhigh` | ❌ | ✅ |
| `gpt-5.1-codex-mini` | ❌ | ✅ |
| `gpt-5.2` / `-high` / `-xhigh` | ❌ | ✅ |

These restrictions are enforced by OpenAI's Codex CLI, not BlockSpool. If your saved model becomes incompatible (e.g., you switch from API key to `codex login`), BlockSpool will prompt you to re-select.

To change your saved model: `blockspool --codex --codex-model <name>`

### Kimi

```bash
# Login via OAuth (one-time, opens browser)
kimi   # then type /login inside the session

# Run with Kimi
blockspool --kimi --kimi-model kimi-k2.5

# Or use an API key instead
export MOONSHOT_API_KEY=...
blockspool --kimi
```

### Local models (Ollama, vLLM, SGLang, LM Studio)

Run with any OpenAI-compatible local server. The local backend uses an **agentic tool-use loop** — the LLM gets `read_file`, `write_file`, and `run_command` tools and iterates until done.

```bash
# Start Ollama (or any OpenAI-compatible server)
ollama serve

# Run with a local model
blockspool --local --local-model qwen2.5-coder

# Custom server URL (default: http://localhost:11434/v1)
blockspool --local --local-model deepseek-coder-v2 --local-url http://localhost:8080/v1

# Limit agentic loop iterations (default: 20)
blockspool --local --local-model qwen2.5-coder --local-max-iterations 10
```

No API key needed — runs entirely on your machine.

### Hybrid mode

For cost-effective runs, use Codex for scouting (cheap, high-volume) and Claude for execution (higher quality):

```bash
blockspool --scout-backend codex
```

Requires both `codex login` and `ANTHROPIC_API_KEY`.

---

## What It Does

```
$ blockspool --batch-size 10 --hours 8

BlockSpool Auto

  Mode: Continuous (Ctrl+C to stop gracefully)
  Time budget: 8 hours (until 6:00 AM)
  Categories: refactor, docs, types, perf, security, fix, cleanup
  PRs: ready-for-review
  Milestone mode: batch size 10

Milestone branch: blockspool/milestone-abc123

[Cycle 1] Scouting src...
  Found 20 improvements, processing 5...
  Conflict-aware scheduling: 2 waves
  Merged to milestone (1/10)
  Merged to milestone (2/10)
  ...
  Merged to milestone (10/10)

  Milestone PR: https://github.com/you/repo/pull/42
  New milestone branch: blockspool/milestone-def456

Final Summary
  Duration: 8h 2m
  Cycles: 32
  Milestone PRs: 5
  Total tickets merged: 50
```

---

## Key Features

| Feature | Description |
|---------|-------------|
| **Milestone Mode** | Batches N tickets into one PR instead of 50 individual PRs |
| **Parallel Execution** | CLI: 3-5 concurrent tickets (adaptive). Plugin: 2 concurrent via Task subagents (max 5) |
| **Wave Scheduling** | Detects overlapping file paths, serializes conflicting tickets |
| **Scope Enforcement** | Each ticket is sandboxed to specific file paths |
| **Scope Expansion** | Auto-expands for root configs, cross-package, sibling files |
| **Deduplication** | Title similarity + git branch matching + temporal-decay memory prevents duplicates |
| **Trust Ladder** | refactor, docs, types, perf, security, fix, cleanup by default; `--tests` to include tests; `--safe` to restrict |
| **Formulas** | Repeatable recipes: `--formula security-audit`, `--formula test-coverage` |
| **Deep Mode** | Principal-engineer-level architectural review (`--deep`) |
| **Impact Scoring** | Proposals ranked by `impact x confidence`, not confidence alone |
| **Quality Gating** | Minimum impact score filter (default: 3) rejects low-value lint/cleanup proposals |
| **Project Detection** | Auto-detects test runner (vitest, jest, pytest, cargo test, go test, rspec, etc.), framework, linter, language, and monorepo tool — ensures correct CLI syntax in prompts |
| **Spindle** | Loop detection prevents runaway agents. Detects oscillation, repetition, QA ping-pong, command failures, file churn, and time-based stalling (30min default) |
| **Symlink Safety** | Resolves symlinks before scope checks — blocks symlink-based path traversal out of worktrees |
| **Credential Detection** | Blocks writes containing AWS keys, PEM keys, GitHub PATs, Slack tokens, DB connection strings, JWTs, and `.env` secrets |
| **Auto-Prune** | Cleans up stale worktrees, run folders, history, artifacts, and archives on every session start |
| **Guidelines Context** | Loads CLAUDE.md (Claude) or AGENTS.md (Codex) into every prompt; auto-creates baseline if missing |
| **Scout Diversification** | Test proposals excluded by default (`--tests` to opt in); when enabled, hard-capped by `maxTestRatio` (default 0.4) |
| **QA Retry with Test Fix** | When a refactor/perf/types ticket breaks tests, automatically retries once — expanding scope to include test files and fixing them without reverting changes |

---

## How It Works

1. **Scout** — Analyzes your codebase for improvement opportunities
2. **Propose** — Creates tickets with confidence and impact scores
3. **Filter** — Auto-approves based on category, impact score, and dedup
4. **Execute** — Runs in isolated git worktrees (parallel)
5. **Merge** — Merges ticket branch into milestone branch (conflict-aware scheduling)
6. **PR** — Creates one milestone PR per batch

```
Scout ──▶ Filter ──▶ Execute (parallel) ──▶ Merge to milestone ──▶ PR
  │                                                                  │
  └──────────────── next cycle (sees prior work) ◀───────────────────┘
```

### Milestone Mode vs Individual PRs

| | Individual PRs | Milestone Mode |
|---|---|---|
| **PRs created** | 50 PRs for 50 fixes | 5 PRs (10 fixes each) |
| **Review burden** | High (50 reviews) | Low (5 reviews) |
| **Scout accuracy** | Rescans stale code, finds duplicates | Scans milestone branch, sees prior work |
| **Git noise** | 50 branches | 5 branches |

```bash
# Individual PRs (default)
blockspool --hours 4

# Milestone mode (recommended for long runs)
blockspool --hours 8 --batch-size 30
```

---

## Commands

### Initialize
```bash
blockspool init
```
Creates `.blockspool/` directory with SQLite database. No external services needed.

### Auto (default command)
```bash
# Single cycle (default — scout, execute, PR, done)
blockspool

# Multiple cycles
blockspool --cycles 3

# Time-based with milestones
blockspool --hours 8 --batch-size 30

# Run with Codex
blockspool --codex --cycles 3

# Dry run (show what would happen)
blockspool --dry-run

# Restrict to safe categories only
blockspool --safe

# Focus on specific improvements
blockspool --formula security-audit
blockspool --formula test-coverage
blockspool --deep

# Fix CI failures
blockspool ci

# Process existing tickets
blockspool work
```

### Other Commands
```bash
# Check prerequisites
blockspool doctor

# Manual scout
blockspool scout src/

# View status
blockspool status

# Run single ticket
blockspool run tkt_abc123

# Retry failed ticket (regenerates scope)
blockspool retry tkt_abc123

# Steer a running auto session
blockspool nudge "focus on auth module"
blockspool nudge --list
blockspool nudge --clear

# Clean up stale state
blockspool prune
blockspool prune --dry-run

# Interactive TUI
blockspool tui
```

All commands also work with the `solo` prefix for backwards compatibility: `blockspool solo auto`, `blockspool solo init`, etc.

---

## Plugin (Claude Code)

The BlockSpool plugin runs inside Claude Code sessions:

```
/blockspool:run                        Single cycle (scout → execute → PR)
/blockspool:run cycles=3               Run 3 cycles
/blockspool:run hours=4                Run for 4 hours
/blockspool:run formula=security-audit
/blockspool:run parallel=3             Execute 3 tickets concurrently
/blockspool:status                     Check progress
/blockspool:nudge hint="focus on auth" Steer the session
/blockspool:cancel                     Graceful shutdown
```

The plugin uses Claude Code's own auth — no API key needed. It includes:
- **Parallel execution** — spawns Task subagents per ticket in isolated worktrees (default: 2, max: 5). Each subagent gets a self-contained inline prompt — no MCP access needed.
- **Project detection** — auto-detects test runner, framework, linter, and language for correct CLI syntax (supports Node, Python, Rust, Go, Ruby, Elixir, Java, C#, PHP, Swift)
- **Quality gating** — minimum impact score filter (default: 3, configurable via `min_impact_score`) rejects low-value lint/cleanup proposals
- **Stop hook** — prevents Claude from exiting mid-session
- **PreToolUse hook** — enforces file scope per ticket (worktree-aware in parallel mode)
- **MCP tools** — session management, scouting, execution, git, per-ticket advance

Install: see [packages/plugin/README.md](./packages/plugin/README.md)

---

## Formulas

Formulas are repeatable recipes for specific goals:

```bash
blockspool --formula security-audit   # Focus on vulnerabilities
blockspool --formula test-coverage     # Add missing tests
blockspool --formula type-safety       # Improve TypeScript types
blockspool --formula cleanup           # Dead code, unused imports
blockspool --formula docs              # Documentation improvements
blockspool --formula docs-audit        # Find stale/inaccurate docs
blockspool --deep                      # Architectural review
```

### docs-audit

The `docs-audit` formula cross-references your markdown files (README, CONTRIBUTING, docs/) against the actual codebase to find stale, inaccurate, or outdated documentation.

**Automatic docs-audit:** BlockSpool automatically runs a docs-audit every 3 cycles, tracked across sessions in `.blockspool/run-state.json`. Whether you run one cycle at a time or in continuous mode, the counter persists — so your 1st, 2nd runs are normal, and the 3rd triggers a docs check.

```bash
# Change the interval (default: 3)
blockspool --docs-audit-interval 5

# Disable automatic docs-audit entirely
blockspool --no-docs-audit

# Run a one-off docs-audit manually
blockspool --formula docs-audit
```

**Guidelines context injection:** BlockSpool automatically loads your project guidelines and injects them into every scout and execution prompt, so agents follow your conventions. For Claude runs it searches for `CLAUDE.md`; for Codex runs it searches for `AGENTS.md`. If the preferred file isn't found, it falls back to the other. If neither exists, a baseline is auto-generated from your `package.json` (disable with `"autoCreateGuidelines": false`). The file is re-read periodically during long runs (default: every 10 cycles) to pick up edits. The full file content is injected without truncation.

| Backend | Primary | Fallback |
|---------|---------|----------|
| Claude | `CLAUDE.md` | `AGENTS.md` |
| Codex | `AGENTS.md` | `CLAUDE.md` |

**CLAUDE.md protection:** All scout runs read `CLAUDE.md` and `.claude/` for project context but **never propose changes** to them. To opt in to CLAUDE.md edits:

```bash
blockspool --include-claude-md
```

To override the exclusion list for docs-audit specifically, create a custom formula:

```yaml
# .blockspool/formulas/docs-audit.yml  (overrides built-in)
description: Docs audit with custom exclusions
categories: [docs]
min_confidence: 70
exclude: [CLAUDE.md, .claude/**, INTERNAL.md, docs/private/**]
prompt: |
  Cross-reference documentation files against the actual codebase
  to find inaccuracies. Only fix what is wrong or outdated.
```

### Custom formulas

Custom formulas live in `.blockspool/formulas/` and override built-ins with the same name:

```yaml
# .blockspool/formulas/my-formula.yml
description: Focus on error handling
categories: [refactor]
exclude: [vendor/**, generated/**]
prompt: |
  Look for error handling improvements:
  - Missing try/catch blocks
  - Silent error swallowing
  - Unhandled promise rejections
```

**Formula fields:**

| Field | Description |
|-------|-------------|
| `description` | What the formula does |
| `categories` | Proposal types: `security`, `test`, `types`, `refactor`, `perf`, `docs`, `cleanup` |
| `scope` | Directory to scan (default: `src`) |
| `min_confidence` | Confidence hint for scout (low values trigger planning preamble during execution) |
| `max_prs` | Max PRs to create |
| `exclude` | Glob patterns to skip (e.g., `CLAUDE.md`, `vendor/**`) |
| `prompt` | Instructions for the scout |
| `tags` | Organizational tags |

---

## Requirements

- **Node.js 18+**
- **Git repository** with GitHub remote
- **One of:**
  - Claude Code (for the plugin)
  - `ANTHROPIC_API_KEY` (for CLI + Claude)
  - `codex login` or `CODEX_API_KEY` (for CLI + Codex)
  - `kimi /login` or `MOONSHOT_API_KEY` (for CLI + Kimi)
  - A local OpenAI-compatible server (for CLI + Local — no key needed)

---

## Trust Ladder

BlockSpool uses a trust ladder to control what changes are auto-approved:

| Mode | Categories | Use Case |
|------|------------|----------|
| **Default** | refactor, docs, types, perf, security, fix, cleanup | All improvements (no tests) |
| **--tests** | + test | Opt-in to test proposals |
| **--safe** | refactor, docs, types, perf | Conservative — no security/fix/cleanup |

```bash
# Default (no test proposals)
blockspool

# Include test proposals
blockspool --tests

# Safe mode (restricted)
blockspool --safe
```

---

## Configuration

Optional `.blockspool/config.json`:

```json
{
  "auto": {
    "defaultScope": "src",
    "maxTestRatio": 0.4,
    "maxPrs": 20,
    "draftPrs": true,
    "docsAudit": true,
    "docsAuditInterval": 3,
    "pullEveryNCycles": 5,
    "pullPolicy": "halt",
    "guidelinesRefreshCycles": 10,
    "autoCreateGuidelines": true,
    "guidelinesPath": null,
    "minImpactScore": 3,
    "pluginParallel": 2,
    "batchTokenBudget": 20000,
    "scoutTimeoutMs": 300000,
    "maxFilesPerCycle": 60
  },
  "retention": {
    "maxRuns": 50,
    "maxHistoryEntries": 100
  }
}
```

#### `auto` settings

| Field | Default | Description |
|-------|---------|-------------|
| `defaultScope` | `"**"` | Glob scope for scanning. CLI also searches `src`, `lib`, `app`, `packages`, etc. |
| `maxTestRatio` | `0.4` | Max fraction of test proposals per batch. Prevents test-heavy batches; remaining slots go to refactors/perf. |
| `maxPrs` | `3` | Max PRs per run (20 in continuous mode) |
| `draftPrs` | `true` | Create draft PRs |
| `docsAudit` | `true` | Set `false` to disable auto docs-audit |
| `docsAuditInterval` | `3` | Auto docs-audit every N cycles |
| `pullEveryNCycles` | `5` | Pull from origin every N cycles in continuous mode (0 = disabled) |
| `pullPolicy` | `"halt"` | On pull divergence: `"halt"` stops the session, `"warn"` logs and continues |
| `guidelinesRefreshCycles` | `10` | Re-read guidelines file every N cycles during long runs (0 = disabled) |
| `autoCreateGuidelines` | `true` | Auto-create baseline AGENTS.md/CLAUDE.md if none exists (set `false` to disable) |
| `guidelinesPath` | `null` | Custom path to guidelines file relative to repo root (e.g. `"docs/CONVENTIONS.md"`). Set to `false` to disable guidelines entirely. `null` = default search. |
| `minImpactScore` | `3` | Minimum impact score (1-10) for proposals. Filters out low-value lint/cleanup. |
| `pluginParallel` | `2` | Number of parallel tickets in plugin mode (max: 5). Set to 1 for sequential. |
| `batchTokenBudget` | auto | Token budget per scout batch. Default: 20k (Codex), 10k (Claude). Higher = fewer batches, faster scouting. |
| `scoutTimeoutMs` | auto | Timeout per scout batch in ms. Default: 300000 (Codex), 120000 (Claude). |
| `maxFilesPerCycle` | `60` | Maximum files scanned per scout cycle. Increase for large repos with `--continuous`. |

---

## Retention & Cleanup

BlockSpool accumulates state over time (run folders, history, artifacts). The retention system caps all unbounded state with configurable item limits.

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

### `retention` settings

Add a `retention` section to `.blockspool/config.json`:

```json
{
  "retention": {
    "maxRuns": 25,
    "maxHistoryEntries": 50
  }
}
```

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

---

## How It Compares

See [docs/COMPARISON.md](./docs/COMPARISON.md) for a detailed comparison with Gas Town, Factory.ai, Devin, and others.

**TL;DR:** BlockSpool is the only tool designed for continuous codebase improvement with built-in cost control, scope enforcement, milestone batching, cross-run learnings, and dedup memory. Other tools either require constant steering (Gas Town), are SaaS-only (Factory, Devin), or handle only simple fixes (Sweep).

---

## FAQ

### How is this different from just running Claude Code?

BlockSpool adds:
- **Hours of continuous operation** (not just one task)
- **Milestone batching** (coherent PRs, not 50 tiny ones)
- **Parallel execution** with conflict-aware scheduling
- **Deduplication** (won't recreate similar work)
- **Trust ladder** (tests excluded by default; `--tests` to include; `--safe` to restrict)
- **Scope enforcement** (sandboxes each ticket to specific paths)

### Can I use it without an API key?

Yes — four ways:
1. **Plugin** (`/blockspool:run`): Uses your Claude Code subscription directly
2. **Codex CLI** (`blockspool --codex`): Uses `codex login` (OAuth, no API key env var needed)
3. **Kimi CLI** (`blockspool --kimi`): Uses `kimi /login` (OAuth, opens browser)
4. **Local** (`blockspool --local --local-model <name>`): Runs against Ollama or any local server — completely free

### Why can't I use `gpt-5.2-codex-high` with `codex login`?

OpenAI's Codex CLI restricts higher-reasoning models (like `-high`, `-xhigh`) and general-purpose models (like `gpt-5.2`) to API key authentication only. This is an OpenAI limitation, not a BlockSpool one. To use these models, set `CODEX_API_KEY` in your environment. With `codex login` you can use `gpt-5.2-codex` (default) and `gpt-5.1-codex-max`.

### Can third-party tools bypass these Codex model restrictions?

Some third-party tools intercept Codex OAuth tokens to access restricted models. **This likely violates OpenAI's Terms of Service** — users have reported account bans for similar approaches with other providers. BlockSpool only uses the official `codex exec` CLI and respects its model restrictions.

### How do I change my saved Codex model?

Run `blockspool --codex --codex-model <name>`. If your saved model is no longer compatible with your auth method, BlockSpool will automatically prompt you to pick a new one.

### Will it break my code?

- Every change runs through **typecheck and tests** before merging
- All changes are **draft PRs** by default
- Only touches files in scoped directories
- Failed tickets are automatically **blocked**, not merged
- Trust ladder controls approved categories (tests opt-in via `--tests`, `--safe` to restrict)
- **QA retry with test fix** — if a refactor breaks tests, BlockSpool retries once by expanding scope to include test files and fixing them (without reverting the refactor)

### Why does it keep generating mostly test proposals?

Test proposals are excluded by default. Use `blockspool --tests` to opt in, or `--formula test-coverage` for a dedicated test-writing run. When tests are enabled, the scout prompt limits them to 1 per batch and `maxTestRatio` (default 0.4) hard-caps them at the filter layer.

### Can I use local models like Qwen, DeepSeek, or Llama?

Yes. `blockspool --local --local-model <name>` works with any OpenAI-compatible server (Ollama, vLLM, SGLang, LM Studio). The local backend gives the LLM `read_file`, `write_file`, and `run_command` tools so it can iteratively explore and modify code. Quality depends on the model — larger coding models (Qwen 2.5 Coder 32B, DeepSeek Coder V2) work best.

### How much does it cost?

BlockSpool is free and open source. It uses your existing Claude Code subscription, Anthropic API key, or Codex/Kimi credentials. API costs depend on your codebase size, run duration, and provider pricing. The local backend (`--local`) is completely free.

### What are formulas?

Formulas are repeatable recipes for specific goals. Run `--formula security-audit` for vulnerabilities, `--formula test-coverage` for tests, or `--deep` for architectural review. You can also write your own.

---

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for guidelines.

---

## License

Apache 2.0 - See [LICENSE](./LICENSE)

---

<p align="center">
  <b>BlockSpool v0.5.47</b><br>
  <i>Set it. Forget it. Merge the PRs.</i>
</p>
