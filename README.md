# BlockSpool

**Your codebase improves itself. Scouts improvements, executes in parallel, batches into milestone PRs.**

BlockSpool scouts your codebase for improvements, executes them in parallel, and batches everything into milestone PRs — ready for your review.

---

## Quick Start

### Inside Claude Code (recommended)

```bash
# Add the marketplace and install the plugin
claude plugin marketplace add blockspool/blockspool
claude plugin install blockspool@blockspool

# Then inside any Claude Code session:
/blockspool:run

# Update to the latest version:
claude plugin update blockspool@blockspool
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
```

Come back to 5 milestone PRs containing 50+ improvements.

---

## Four Ways to Run

| Route | Auth | Best for |
|-------|------|----------|
| **Plugin** (`/blockspool:run`) | Claude Code subscription | Interactive use, no API key setup |
| **CLI + Claude** (`blockspool`) | `ANTHROPIC_API_KEY` | CI, cron jobs, long runs |
| **CLI + Codex** (`blockspool --codex`) | `codex login` (or `CODEX_API_KEY`) | No Anthropic key, Codex-native teams |
| **CLI + OpenAI** (`blockspool-run --provider openai`) | `OPENAI_API_KEY` | OpenAI-native teams |

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
  Categories: refactor, test, docs, types, perf
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
| **Deduplication** | Title similarity + git branch matching prevents duplicates |
| **Trust Ladder** | Safe categories by default (refactor, test, docs, types, perf) |
| **Formulas** | Repeatable recipes: `--formula security-audit`, `--formula test-coverage` |
| **Deep Mode** | Principal-engineer-level architectural review (`--deep`) |
| **Impact Scoring** | Proposals ranked by `impact x confidence`, not confidence alone |
| **Quality Gating** | Minimum impact score filter (default: 3) rejects low-value lint/cleanup proposals |
| **Project Detection** | Auto-detects test runner (vitest, jest, pytest, cargo test, go test, rspec, etc.), framework, linter, language, and monorepo tool — ensures correct CLI syntax in prompts |
| **Spindle** | Loop detection prevents runaway agents |
| **Guidelines Context** | Loads CLAUDE.md (Claude) or AGENTS.md (Codex) into every prompt; auto-creates baseline if missing |

---

## How It Works

1. **Scout** — Analyzes your codebase for improvement opportunities
2. **Propose** — Creates tickets with confidence and impact scores
3. **Filter** — Auto-approves based on category, confidence, and dedup
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

# Include more categories
blockspool --aggressive

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

**Guidelines context injection:** BlockSpool automatically loads your project guidelines and injects them into every scout and execution prompt, so agents follow your conventions. For Claude runs it searches for `CLAUDE.md`; for Codex runs it searches for `AGENTS.md`. If the preferred file isn't found, it falls back to the other. If neither exists, a baseline is auto-generated from your `package.json` (disable with `"autoCreateGuidelines": false`). The file is re-read periodically during long runs (default: every 10 cycles) to pick up edits. Content is truncated to 4000 chars if needed.

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
| `min_confidence` | Minimum confidence threshold 0-100 |
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

---

## Trust Ladder

BlockSpool uses a trust ladder to control what changes are auto-approved:

| Mode | Categories | Use Case |
|------|------------|----------|
| **Default** | refactor, test, docs, types, perf | Safe default |
| **Aggressive** | + security, fix, cleanup | When you want more |

```bash
# Default (safe)
blockspool

# Aggressive (more categories)
blockspool --aggressive
```

---

## Configuration

Optional `.blockspool/config.json`:

```json
{
  "auto": {
    "defaultScope": "src",
    "minConfidence": 70,
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
    "pluginParallel": 2
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
| `minConfidence` | `70` | Minimum confidence threshold |
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

---

## Retention & Cleanup

BlockSpool accumulates state over time (run folders, history, artifacts). The retention system caps all unbounded state with configurable item limits.

### Auto-prune

On every `blockspool` session start, stale items are pruned automatically: run folders, history, artifacts, spool archives, deferred proposals, and completed tickets.

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

**TL;DR:** BlockSpool is the only tool designed for continuous codebase improvement with built-in cost control, scope enforcement, and milestone batching. Other tools either require constant steering (Gas Town), are SaaS-only (Factory, Devin), or handle only simple fixes (Sweep).

---

## FAQ

### How is this different from just running Claude Code?

BlockSpool adds:
- **Hours of continuous operation** (not just one task)
- **Milestone batching** (coherent PRs, not 50 tiny ones)
- **Parallel execution** with conflict-aware scheduling
- **Deduplication** (won't recreate similar work)
- **Trust ladder** (safe categories by default)
- **Scope enforcement** (sandboxes each ticket to specific paths)

### Can I use it without an API key?

Yes — two ways:
1. **Plugin** (`/blockspool:run`): Uses your Claude Code subscription directly
2. **Codex CLI** (`blockspool --codex`): Uses `codex login` (OAuth, no API key env var needed)

### Will it break my code?

- Every change runs through **typecheck and tests** before merging
- All changes are **draft PRs** by default
- Only touches files in scoped directories
- Failed tickets are automatically **blocked**, not merged
- Trust ladder limits to safe categories

### How much does it cost?

BlockSpool is free and open source. It uses your existing Claude Code subscription, Anthropic API key, or Codex credentials. API costs depend on your codebase size, run duration, and provider pricing.

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
  <b>BlockSpool v0.5.0</b><br>
  <i>Set it. Forget it. Merge the PRs.</i>
</p>
