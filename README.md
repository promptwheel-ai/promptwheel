# PromptWheel

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![npm](https://img.shields.io/npm/v/@promptwheel/cli)](https://www.npmjs.com/package/@promptwheel/cli)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-green.svg)](https://nodejs.org/)

**Point it at your codebase. It finds and fixes things. Run it for 5 minutes or 5 hours.**

PromptWheel scouts your codebase for improvements, executes them in parallel, and learns from each run. Every session builds on the last — sectors rotate, learnings accumulate, formulas adapt.

---

## Quick Start

### Inside Claude Code (recommended)

```bash
/plugin install promptwheel@promptwheel

/promptwheel:run
```

Uses your Claude Code subscription directly. No API key needed.

### From the terminal

```bash
npm install -g @promptwheel/cli
cd your-project
promptwheel init

# Quick cycle while you grab coffee
promptwheel

# Afternoon run while you step away
promptwheel --hours 2

# Overnight with milestones
promptwheel --hours 8 --batch-size 30

# Continuous until you stop it
promptwheel --spin
```

Also works with [Codex](docs/authentication.md) (`--codex`), [Kimi](docs/authentication.md) (`--kimi`), and [local models](docs/authentication.md) (`--local`).

---

## How It Gets Smarter

PromptWheel isn't a one-shot tool. Each session compounds on the last:

```
Session 1                    Session 5                    Session 20
Scout everywhere             Sectors rotate focus         High-yield sectors targeted
Execute, learn from failures Learnings prevent repeats    Polished sectors auto-skipped
Track what works             Formulas adapt (UCB1)        Category confidence tuned
                             Deep review triggers         Feedback loop tightening
```

**Sectors** — Your codebase is divided into logical regions. Each run focuses on different sectors using EMA-weighted rotation, concentrating effort where proposals succeed and skipping exhausted areas.

**Learnings** — Failures and successes persist across sessions with temporal decay. Relevant learnings are injected into future prompts so the same mistakes aren't repeated.

**Formula adaptation** — Built-in formulas (security, tests, types, cleanup, docs, deep) rotate using UCB1 bandit scoring — balancing what's worked before with exploration of less-tried approaches.

**Session arc** — Long runs progress through warmup (conservative), main (full rotation with deep triggers), and cooldown (light cleanup) phases automatically.

---

## Trajectories

For structured multi-step improvements, define a trajectory:

```yaml
# .promptwheel/trajectories/harden-auth.yaml
name: harden-auth
description: Security hardening for auth module
steps:
  - id: input-validation
    title: Add input validation to all auth endpoints
    scope: "src/auth/**"
    categories: [security]
    acceptance_criteria:
      - All endpoints validate input before processing
    verification_commands:
      - npm test -- src/auth

  - id: rate-limiting
    title: Add rate limiting to login and reset endpoints
    scope: "src/auth/**,src/middleware/**"
    depends_on: [input-validation]
    acceptance_criteria:
      - Login endpoint rate-limited to 5 attempts per minute
```

```bash
/promptwheel:trajectory activate harden-auth
/promptwheel:run
```

Each session focuses on the current step, advancing through the DAG as acceptance criteria are met. Steps can have dependencies, scoped paths, and verification commands.

---

## Formulas

Repeatable recipes for what to look for:

```bash
promptwheel --formula security-audit   # OWASP vulnerabilities
promptwheel --formula test-coverage    # Missing unit tests
promptwheel --formula type-safety      # Remove any/unknown casts
promptwheel --formula cleanup          # Dead code, unused imports
promptwheel --formula docs             # Documentation gaps
promptwheel --deep                     # Architectural review
```

Custom formulas live in `.promptwheel/formulas/` as YAML files with scope, categories, confidence thresholds, and optional measurement targets.

---

## Safety

- **Scope enforcement** — each ticket sandboxed to specific file paths
- **Typecheck + tests** — every change verified before merging
- **Trust ladder** — categories controlled; tests opt-in (`--tests`), safe mode (`--safe`)
- **Spindle detection** — catches oscillation, QA ping-pong, stalling, and token budget overruns
- **Adversarial review** — devil's advocate scoring challenges every proposal before execution
- **Draft PRs** by default — nothing merges without your review

---

## Core Loop

```
Scout ──> Filter ──> Execute (parallel) ──> QA ──> PR
  |                                                  |
  └──── next cycle (sectors rotate, learnings grow) ─┘
```

1. **Scout** — scans a sector for improvements using the active formula
2. **Filter** — dedup, impact scoring, adversarial review, trust ladder
3. **Execute** — parallel tickets in isolated git worktrees
4. **QA** — typecheck, tests, lint (retries with test-fix on failure)
5. **PR** — draft PR per ticket, or batched into milestone PRs

---

## Plugin (Claude Code)

```
/promptwheel:run                         Single cycle
/promptwheel:run spin hours=4            Timed continuous run
/promptwheel:run formula=security-audit  Focused formula
/promptwheel:run deep                    Architectural review
/promptwheel:trajectory activate <name>  Start a trajectory
/promptwheel:status                      Check progress
/promptwheel:analytics                   View system metrics
/promptwheel:nudge hint="focus on auth"  Steer mid-run
```

See [Plugin Reference](docs/plugin.md) for all 14 slash commands.

---

## Commands

```bash
promptwheel                     # Single cycle (scout, execute, PR)
promptwheel --hours 4           # Time-based run
promptwheel --spin              # Continuous until Ctrl+C
promptwheel --formula <name>    # Use a specific formula
promptwheel --deep              # Architectural review
promptwheel --dry-run           # Scout only, no execution
promptwheel nudge "hint"        # Steer a running session
promptwheel status              # View current state
promptwheel doctor              # Check prerequisites
```

See [CLI Reference](docs/cli-reference.md) for the complete list.

---

## Requirements

- **Node.js 18+**
- **Git repository**
- **Claude Code** (plugin) or an **API key** (Anthropic, OpenAI, Moonshot, or local)

---

## Configuration

Optional `.promptwheel/config.json`. See [Configuration](docs/configuration.md).

---

## FAQ

**How is this different from just running Claude Code?**
PromptWheel adds continuous operation, cross-run memory, parallel execution with conflict-aware scheduling, scope enforcement, deduplication, and structured progression via trajectories and formulas.

**Will it break my code?**
Every change runs through typecheck and tests. Failed tickets are blocked, not merged. Scope enforcement sandboxes each ticket. All PRs are drafts by default.

**How much does it cost?**
PromptWheel is free and open source. It uses your existing AI credentials. The local backend (`--local`) is completely free.

---

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

---

## License

Apache 2.0 - See [LICENSE](./LICENSE)

---

<p align="center">
  <b>PromptWheel v0.6.1</b>
</p>
