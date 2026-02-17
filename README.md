# BlockSpool

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![npm](https://img.shields.io/npm/v/@blockspool/cli)](https://www.npmjs.com/package/@blockspool/cli)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-green.svg)](https://nodejs.org/)

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

## Five Ways to Run

| Route | Auth | Best for |
|-------|------|----------|
| **Plugin** (`/blockspool:run`) | Claude Code subscription | Interactive use, no API key setup |
| **CLI + Claude** (`blockspool`) | `ANTHROPIC_API_KEY` | CI, cron jobs, long runs |
| **CLI + Codex** (`blockspool --codex`) | `codex login` or `OPENAI_API_KEY` | No Anthropic key, Codex-native teams |
| **CLI + Kimi** (`blockspool --kimi`) | `kimi /login` or `MOONSHOT_API_KEY` | Kimi-native teams |
| **CLI + Local** (`blockspool --local`) | None (local server) | Ollama, vLLM, SGLang, LM Studio |

See [Authentication & Backends](docs/authentication.md) for Codex model availability, Kimi setup, local models, and hybrid mode.

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

- **Milestone Mode** — batches N tickets into one PR instead of 50 individual PRs
- **Parallel Execution** — 3-5 concurrent tickets in isolated git worktrees
- **Wave Scheduling** — detects overlapping file paths, serializes conflicting tickets
- **Scope Enforcement** — each ticket sandboxed to specific paths with auto-expansion
- **Trust Ladder** — controls approved categories; tests opt-in (`--tests`), safe mode (`--safe`)
- **Impact Scoring** — proposals ranked by `impact x confidence` with adversarial review
- **Cross-Run Learnings** — remembers failures across sessions, avoids repeating mistakes
- **Deduplication** — title similarity + git branch matching + temporal-decay memory
- **Spindle** — loop detection prevents runaway agents (oscillation, QA ping-pong, stalling)
- **Formulas** — repeatable recipes: `--formula security-audit`, `--deep`

See [Features](docs/features.md) for the full list including safety guardrails, intelligence, and operations.

---

## How It Works

1. **Scout** — Analyzes your codebase for improvement opportunities
2. **Propose** — Creates tickets with confidence and impact scores
3. **Filter** — Auto-approves based on category, impact score, dedup, and adversarial review
4. **Execute** — Runs in isolated git worktrees (parallel)
5. **Merge** — Merges ticket branch into milestone branch (conflict-aware scheduling)
6. **PR** — Creates one milestone PR per batch

```
Scout ──▶ Filter ──▶ Execute (parallel) ──▶ Merge to milestone ──▶ PR
  │                                                                  │
  └──────────────── next cycle (sees prior work) ◀───────────────────┘
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

See [CLI Reference](docs/cli-reference.md) for the complete command list.

---

## Plugin (Claude Code)

```
/blockspool:run                        Single cycle (scout → execute → PR)
/blockspool:run wheel hours=4          Wheel mode (unattended parallel execution)
/blockspool:run formula=security-audit Focus on vulnerabilities
/blockspool:run deep                   Architectural review
/blockspool:status                     Check progress
/blockspool:nudge hint="focus on auth" Steer the session
/blockspool:cancel                     Graceful shutdown
```

The plugin uses Claude Code's own auth — no API key needed. It includes parallel execution, scope enforcement hooks, and 12 slash commands.

See [Plugin Reference](docs/plugin.md) for installation, all skills, and how it works.

---

## Formulas

```bash
blockspool --formula security-audit   # Focus on vulnerabilities
blockspool --formula test-coverage     # Add missing tests
blockspool --formula type-safety       # Improve TypeScript types
blockspool --formula cleanup           # Dead code, unused imports
blockspool --formula docs              # Documentation improvements
blockspool --formula docs-audit        # Find stale/inaccurate docs
blockspool --deep                      # Architectural review
```

Custom formulas live in `.blockspool/formulas/` as YAML files.

See [Formulas](docs/formulas.md) for docs-audit, guidelines context, custom formulas, and the fields reference.

---

## Requirements

- **Node.js 18+**
- **Git repository** with GitHub remote
- **One of:**
  - Claude Code (for the plugin)
  - `ANTHROPIC_API_KEY` (for CLI + Claude)
  - `codex login` or `OPENAI_API_KEY` (for CLI + Codex)
  - `kimi /login` or `MOONSHOT_API_KEY` (for CLI + Kimi)
  - A local OpenAI-compatible server (for CLI + Local — no key needed)

---

## Configuration

Optional `.blockspool/config.json`. See [Configuration](docs/configuration.md) for the full reference.

---

## How It Compares

See [docs/COMPARISON.md](./docs/COMPARISON.md) for a detailed comparison with Gas Town, Factory.ai, Devin, and others.

**TL;DR:** BlockSpool is the only tool designed for continuous codebase improvement with built-in cost control, scope enforcement, milestone batching, cross-run learnings, and dedup memory.

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

### Will it break my code?

- Every change runs through **typecheck and tests** before merging
- All changes are **draft PRs** by default
- Only touches files in scoped directories
- Failed tickets are automatically **blocked**, not merged
- Trust ladder controls approved categories (tests opt-in via `--tests`, `--safe` to restrict)
- **QA retry with test fix** — if a refactor breaks tests, BlockSpool retries once by expanding scope to include test files and fixing them (without reverting the refactor)

### How much does it cost?

BlockSpool is free and open source. It uses your existing Claude Code subscription, Anthropic API key, or Codex/Kimi credentials. API costs depend on your codebase size, run duration, and provider pricing. The local backend (`--local`) is completely free.

---

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for guidelines.

---

## License

Apache 2.0 - See [LICENSE](./LICENSE)

---

<p align="center">
  <b>BlockSpool v0.5.63</b><br>
  <i>Set it. Forget it. Merge the PRs.</i>
</p>
