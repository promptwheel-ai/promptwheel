# BlockSpool - Claude Guide

## What is BlockSpool?

BlockSpool is a coding tool that scouts your codebase for improvements, executes them in parallel, and creates PRs — all running locally with zero external infrastructure.

## Quick Start

```bash
blockspool init                               # Initialize SQLite database
blockspool                                     # Scout + fix + PR (single cycle)
blockspool --hours 8 --batch-size 30           # Long run with milestone PRs
blockspool --continuous                        # Run until stopped (Ctrl+C)
blockspool nudge "focus on auth"               # Steer a running session
```

### Features

- **SQLite** backend (no external database needed)
- **Claude Code CLI** for execution (default model: **opus**)
- **Ready-for-review PRs** with single commits
- **Deduplication** to avoid recreating similar work
- **Trust ladder** (safe categories by default)
- **Formulas** for repeatable recipes: `--formula security-audit`
- **Deep mode** (`--deep`) for architectural/structural review
- **Impact scoring** — proposals ranked by `impact x confidence`
- **Quality gating** — minimum impact score filter rejects low-value proposals
- **Adversarial review** — devil's advocate scoring challenges every proposal
- **Cross-run learnings** — remembers failures across sessions, confirms what works
- **Codebase index** — lightweight structural index injected into scout prompts
- **Project detection** — auto-detects test runner, framework, linter, language (10+ ecosystems)
- **Spindle** loop detection — catches QA ping-pong, command failure loops, file churn
- **Parallel** execution (default: 3-5 concurrent tickets, adaptive)
- **Milestone mode** (`--batch-size N`) — batches N tickets into one milestone PR
- **Wave scheduling** — conflict-aware partitioning prevents merge conflicts
- **Scope enforcement** — each ticket sandboxed to `allowed_paths` with auto-expansion
- **Rebase-retry** — rebases ticket branch on merge conflict, retries before blocking
- **Balanced continuous mode** — deep architectural scan every 5 cycles
- **Live steering** (`nudge`) — add hints mid-run, consumed in next scout cycle
- **Guidelines context** — loads CLAUDE.md (Claude) or AGENTS.md (Codex) into every prompt; auto-creates baseline if missing; re-reads every 10 cycles

## How It Works

```
blockspool --hours 4
```

1. **Scout** — scans your codebase for improvement opportunities
2. **Filter** — applies trust ladder, deduplication, impact scoring, adversarial review
3. **Execute** — runs tickets in parallel using Claude Code CLI in isolated worktrees
4. **QA** — runs your test/lint commands to verify changes
5. **PR** — creates draft PRs (or merges to milestone branch)
6. **Repeat** — next cycle scouts again, sees prior work

## File Structure

```
packages/
├── cli/          # CLI application
│   ├── src/
│   │   ├── commands/   # Command modules (solo-auto, solo-exec, etc.)
│   │   ├── lib/        # Core logic (auto, hints, formulas, spindle, learnings, etc.)
│   │   ├── tui/        # Terminal UI
│   │   └── test/       # Tests
├── core/         # Core types, scout, and utilities
│   ├── src/
│   │   ├── scout/      # Scout prompt, parser, runner
│   │   ├── repos/      # Data access (tickets, projects, runs)
│   │   ├── services/   # Scout service, QA
│   │   ├── db/         # Database adapter interface
│   │   ├── exec/       # Claude CLI execution
│   │   └── utils/      # ID generation, JSON parsing
└── sqlite/       # SQLite database adapter
```

## TOS Compliance

BlockSpool uses the **official Claude Code CLI** on the user's own machine with their own credentials. This is the same as running `claude` in a shell script or CI pipeline — explicitly permitted.

- Each user uses their own API key/subscription
- No credentials are shared, proxied, or stored
- BlockSpool is a workflow tool, not an AI service

## Key Commands

```bash
# Run tests
npm test

# Type check
npm run typecheck

# Lint
npm run lint
```

## Concepts Glossary

| Term | Definition |
|------|------------|
| **Auto** | The main execution mode. Scouts, proposes, executes, and PRs improvements continuously. |
| **Scout** | The discovery phase. Scans code to find improvement opportunities. |
| **Ticket** | A unit of work. Created from a proposal, executed in isolation. |
| **Proposal** | A candidate improvement found by scouting. Becomes a ticket when approved. |
| **Formula** | A recipe for what to scout for. Built-ins: `security-audit`, `test-coverage`, `type-safety`, `cleanup`, `docs`, `deep`. User-defined formulas live in `.blockspool/formulas/`. |
| **Deep** | Built-in formula (`--deep`) for principal-engineer-style architectural review. Auto-staggered every 5th cycle in continuous mode. |
| **Impact Score** | 1-10 rating of how much a proposal matters. Proposals ranked by `impact x confidence`. |
| **Spindle** | Loop detection system. Catches QA ping-pong, command failure loops, and file churn. |
| **Worktree** | An isolated git checkout where a ticket executes. Enables parallel execution. |
| **Learnings** | Cross-run memory. Records failures and successes, injects relevant learnings into future prompts. |
| **Hint / Nudge** | Live guidance for a running auto session. Added via `nudge "text"` or stdin, consumed in the next scout cycle. |
| **Guidelines** | Project conventions loaded from CLAUDE.md (Claude) or AGENTS.md (Codex) and injected into every prompt. Auto-created from `package.json` if missing. Re-read every 10 cycles. |
