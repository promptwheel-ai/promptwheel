# Features

Detailed reference for BlockSpool's capabilities.

---

## Trust Ladder

The trust ladder controls which categories of changes are auto-approved:

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

Test proposals are excluded by default because they tend to dominate scout output. When enabled via `--tests`, the scout prompt limits them to 1 per batch and `maxTestRatio` (default 0.4) hard-caps them at the filter layer.

---

## Milestone Mode

Milestone mode batches N tickets into a single PR instead of creating individual PRs for each fix.

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

In milestone mode, the scout scans the milestone branch (not `main`), so it sees all prior work from the current run. This prevents duplicate proposals and ensures each cycle builds on the last.

---

## Safety & Guardrails

### Scope Enforcement

Each ticket is sandboxed to specific file paths (`allowed_paths`). The PreToolUse hook blocks writes outside this scope. Scope is auto-expanded for:

- Root config files (package.json, tsconfig.json, etc.)
- Cross-package imports in monorepos
- Sibling files (e.g., `.test.ts` alongside `.ts`)

### Spindle (Loop Detection)

Spindle prevents runaway agents by detecting:

- **Oscillation** — reverting then re-applying the same change
- **Repetition** — running the same command repeatedly
- **QA ping-pong** — fix breaks test, fix test breaks code, repeat
- **Command failures** — same command failing multiple times
- **File churn** — excessive edits to the same file
- **Time-based stalling** — no progress for 30 minutes (configurable)

When detected, the ticket is aborted and marked as blocked.

### Symlink Safety

Resolves symlinks before scope checks. Blocks symlink-based path traversal that could escape worktree isolation.

### Credential Detection

Blocks writes containing:

- AWS access keys and secret keys
- PEM private keys
- GitHub Personal Access Tokens
- Slack tokens
- Database connection strings
- JWTs
- `.env` secrets

### QA Retry with Test Fix

When a refactor/perf/types ticket breaks tests, BlockSpool automatically retries once — expanding scope to include test files and fixing them without reverting the original changes.

### Rebase-Retry

When a merge to the milestone branch conflicts, BlockSpool rebases the ticket branch onto the milestone tip and retries before marking the ticket as blocked.

---

## Intelligence

### Impact Scoring

Proposals are ranked by `impact x confidence`, not confidence alone. This surfaces high-impact improvements even when confidence is moderate.

### Quality Gating

A minimum impact score filter (default: 3, configurable via `minImpactScore`) rejects low-value lint/cleanup proposals before execution.

### Adversarial Review

Every proposal goes through a devil's advocate scoring challenge before approval. This catches proposals that look good superficially but would introduce problems.

### Cross-Run Learnings

BlockSpool remembers failures and successes across sessions. Relevant learnings are injected into future scout and execution prompts so agents avoid repeating mistakes and build on what works.

### Codebase Index

A lightweight structural index of your codebase is injected into scout prompts. This helps the scout target the right files and understand project structure without scanning everything.

### Deduplication

Three layers prevent duplicate work:

- **Title similarity** — compares new proposals against recent ones
- **Git branch matching** — detects if similar work already has a branch
- **Temporal-decay memory** — tracks completed/rejected proposals with decay, so stale entries eventually expire

### Project Detection

Auto-detects test runner (vitest, jest, pytest, cargo test, go test, rspec, etc.), framework, linter, language, and monorepo tool. Ensures correct CLI syntax in all prompts. Supports Node, Python, Rust, Go, Ruby, Elixir, Java, C#, PHP, and Swift ecosystems.

### Scout Diversification

Test proposals are excluded by default (`--tests` to opt in). When enabled, they're hard-capped by `maxTestRatio` (default 0.4) to prevent test-heavy batches. Remaining slots go to refactors, perf, and other categories.

---

## Operations

### Wave Scheduling

Detects overlapping file paths across tickets and serializes conflicting ones into sequential waves. Non-conflicting tickets run in parallel within each wave.

### Parallel Execution

- **CLI:** 3-5 concurrent tickets (adaptive based on system resources)
- **Plugin:** 2 concurrent via Task subagents (max 5, configurable via `pluginParallel`)

Each ticket runs in an isolated git worktree.

### Auto-Prune

On every session start, stale items are cleaned up automatically: run folders, history, artifacts, spool archives, deferred proposals, completed tickets, and orphaned worktrees. See [Configuration](configuration.md) for retention settings.

### Guidelines Context

Loads CLAUDE.md (Claude) or AGENTS.md (Codex) into every prompt. Auto-creates a baseline from `package.json` if neither exists. Re-reads the file periodically during long runs (default: every 10 cycles) to pick up edits.

### Live Steering

Steer a running session with nudges:

```bash
blockspool nudge "focus on auth module"
blockspool nudge --list
blockspool nudge --clear
```

Nudges are consumed in the next scout cycle and appended to the scout prompt.
