# PromptWheel

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![npm](https://img.shields.io/npm/v/@promptwheel/cli)](https://www.npmjs.com/package/@promptwheel/cli)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-green.svg)](https://nodejs.org/)

**Orchestrate AI coding agents. Plan, execute, learn, repeat.**

PromptWheel coordinates autonomous coding agents across your codebase — executing in parallel, learning across runs, and producing draft PRs you review before merging.

---

## Quick Start

### Inside Claude Code (recommended)

```bash
/plugin install promptwheel-ai/promptwheel

/promptwheel:run
```

Uses your Claude Code subscription directly. No API key needed.

### From the terminal

```bash
npm install -g @promptwheel/cli
cd your-project
promptwheel init

# Quick spin while you grab coffee
promptwheel

# Afternoon run while you step away
promptwheel --hours 2

# Overnight with milestones
promptwheel --hours 8 --batch-size 30

# Human-in-the-loop planning mode
promptwheel --plan
```

Also works with [Codex](docs/authentication.md) (`--codex`).

---

## How It Gets Smarter

PromptWheel isn't a one-shot tool. Each session compounds on the last:

```
Session 1                    Session 5                    Session 20
Scout everywhere             Focus shifts to weak areas   High-yield areas targeted
Execute, learn from failures Learnings prevent repeats    Confidence tuned per category
Track what works             Drill generates trajectories Feedback loop tightening
```

**Learnings** — Failures and successes persist across sessions with temporal decay. Relevant learnings are injected into future prompts so the same mistakes aren't repeated.

**Drill** — In spin mode, PromptWheel auto-generates multi-step trajectories from scout proposals, sequencing related improvements and adapting ambition based on completion history.

---

## Trajectories

For structured multi-step improvements, define a trajectory:

```yaml
# .promptwheel/trajectories/harden-api.yaml
name: harden-api
description: Security hardening for API layer
steps:
  - id: input-validation
    title: Add input validation to all API endpoints
    scope: "src/api/**"
    categories: [security]
    acceptance_criteria:
      - All endpoints validate input before processing
    verification_commands:
      - npm test -- src/api

  - id: rate-limiting
    title: Add rate limiting to login and reset endpoints
    scope: "src/api/**,src/middleware/**"
    depends_on: [input-validation]
    acceptance_criteria:
      - Login endpoint rate-limited to 5 attempts per minute
```

```bash
/promptwheel:trajectory activate harden-auth
/promptwheel:run
```

Each session focuses on the current step, advancing through the DAG as acceptance criteria are met. Steps can have dependencies, scoped paths, and verification commands.

### Drill Mode (Auto-Trajectories)

In spin mode, PromptWheel automatically generates multi-step trajectories from scout proposals. Each trajectory sequences related improvements into ordered steps.

```bash
promptwheel                               # Spin with drill (default)
promptwheel --no-drill                    # Spin without drill
promptwheel solo nudge --drill-pause      # Pause drill during a session
```

Configure in `.promptwheel/config.json`:
```json
{ "auto": { "drill": { "enabled": true, "cooldownStalled": 5, "minProposals": 3 } } }
```

---

## Integrations

Connect external MCP tools that run on a schedule during spin mode:

```yaml
# .promptwheel/integrations.yaml
providers:
  - name: securitychecks
    command: "npx @securitychecks/mcp-server"
    tool: security_scan
    every: 5
    feed: proposals

  - name: patternstack
    command: "npx @patternstack/mcp-server"
    tool: analyze_patterns
    every: 10
    feed: learnings
```

Each provider is an MCP server that PromptWheel spawns and queries on cadence.
Results feed back as proposals (scout output), learnings (cross-run memory), or nudges (session guidance).

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
  └──── next cycle (learnings grow, drill adapts) ────┘
```

1. **Scout** — scans your codebase for improvements
2. **Filter** — dedup, impact scoring, adversarial review, trust ladder
3. **Execute** — parallel tickets in isolated git worktrees
4. **QA** — typecheck, tests, lint (retries with test-fix on failure)
5. **PR** — draft PR per ticket, or direct commits

---

## Plugin (Claude Code)

```
/promptwheel:run                         Spin+drill (default)
/promptwheel:run plan                    Planning mode (approve first)
/promptwheel:run hours=4                 Timed spin
/promptwheel:run deep                    Architectural review
/promptwheel:trajectory activate <name>  Start a trajectory
/promptwheel:status                      Check progress
/promptwheel:nudge hint="focus on auth"  Steer mid-run
```

See [Plugin Reference](docs/plugin.md) for all slash commands.

---

## Commands

```bash
promptwheel                     # Spin+drill (default)
promptwheel --hours 4           # Timed spin
promptwheel --plan              # Planning mode (scout, approve, execute)
promptwheel --deep              # Architectural review
promptwheel --dry-run           # Scout only, no execution
promptwheel nudge "hint"        # Steer a running session
promptwheel status              # View current state
```

See [CLI Reference](docs/cli-reference.md) for the complete list.

---

## Requirements

- **Node.js 18+**
- **Git repository**
- **Claude Code** (plugin) or an **Anthropic API key**

---

## Configuration

Optional `.promptwheel/config.json`. See [Configuration](docs/configuration.md).

---

## FAQ

**How is this different from just running Claude Code?**
PromptWheel is an orchestration layer. It coordinates autonomous agents in parallel, tracks learnings across runs, enforces scope isolation, deduplicates work, and progresses through structured trajectories — producing draft PRs you review before merging.

**Will it break my code?**
Every change runs through typecheck and tests. Failed tickets are blocked, not merged. Scope enforcement sandboxes each ticket. All PRs are drafts by default.

**How much does it cost?**
PromptWheel is free and open source. It uses your existing Claude Code subscription or Anthropic API key.

---

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

---

## License

Apache 2.0 - See [LICENSE](./LICENSE)

---

<p align="center">
  <b>PromptWheel v0.7.39</b>
</p>
