# BlockSpool

**Autonomous coding swarm that improves your codebase while you focus on what matters.**

BlockSpool scouts your codebase for improvements, executes them in parallel, and batches everything into milestone PRs — all running autonomously for hours.

---

## Quick Start

### Inside Claude Code (recommended)

If you're already using Claude Code, install the plugin and go:

```
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
```

Come back to 5 milestone PRs containing 50+ improvements.

---

## Four Ways to Run

| Route | Auth | Best for |
|-------|------|----------|
| **Plugin** (`/blockspool:run`) | Claude Code subscription | Interactive use, no API key setup |
| **CLI + Claude** (`blockspool`) | `ANTHROPIC_API_KEY` | CI, cron jobs, overnight runs |
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
  Draft PRs: yes
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
| **Parallel Execution** | Runs 3-5 tickets concurrently with adaptive parallelism |
| **Wave Scheduling** | Detects overlapping file paths, serializes conflicting tickets |
| **Scope Enforcement** | Each ticket is sandboxed to specific file paths |
| **Scope Expansion** | Auto-expands for root configs, cross-package, sibling files |
| **Deduplication** | Title similarity + git branch matching prevents duplicates |
| **Trust Ladder** | Safe categories by default (refactor, test, docs, types, perf) |
| **Formulas** | Repeatable recipes: `--formula security-audit`, `--formula test-coverage` |
| **Deep Mode** | Principal-engineer-level architectural review (`--deep`) |
| **Impact Scoring** | Proposals ranked by `impact x confidence`, not confidence alone |
| **Spindle** | Loop detection prevents runaway agents |

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

# Interactive TUI
blockspool tui
```

All commands also work with the `solo` prefix for backwards compatibility: `blockspool solo auto`, `blockspool solo init`, etc.

---

## Plugin (Claude Code)

The BlockSpool plugin runs inside Claude Code sessions:

```
/blockspool:run                    Single cycle (scout → execute → PR)
/blockspool:run cycles=3           Run 3 cycles
/blockspool:run hours=4            Run for 4 hours
/blockspool:run formula=security-audit
/blockspool:status                  Check progress
/blockspool:nudge hint="focus on auth"  Steer the session
/blockspool:cancel                  Graceful shutdown
```

The plugin uses Claude Code's own auth — no API key needed. It includes:
- **Stop hook** — prevents Claude from exiting mid-session
- **PreToolUse hook** — enforces file scope per ticket
- **MCP tools** — session management, scouting, execution, git

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
blockspool --deep                      # Architectural review
```

Custom formulas live in `.blockspool/formulas/`:

```yaml
# .blockspool/formulas/my-formula.yml
name: my-formula
description: Focus on error handling
prompt: |
  Look for error handling improvements:
  - Missing try/catch blocks
  - Silent error swallowing
  - Unhandled promise rejections
```

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
| **Default** | refactor, test, docs, types, perf | Safe overnight runs |
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
  "defaultScope": "src",
  "minConfidence": 70,
  "maxPrsPerRun": 20,
  "draftPrs": true
}
```

---

## How It Compares

See [docs/COMPARISON.md](./docs/COMPARISON.md) for a detailed comparison with Gas Town, Factory.ai, Devin, and others.

**TL;DR:** BlockSpool is the only tool designed for unattended overnight runs with built-in cost control, scope enforcement, and milestone batching. Other tools either require constant steering (Gas Town), are SaaS-only (Factory, Devin), or handle only simple fixes (Sweep).

---

## FAQ

### How is this different from just running Claude Code?

BlockSpool adds:
- **Hours of autonomous operation** (not just one task)
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
  <b>BlockSpool</b><br>
  <i>Set it. Forget it. Merge the PRs.</i>
</p>
