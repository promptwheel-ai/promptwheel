# BlockSpool

**Autonomous coding tool. Finds improvements, fixes them, opens PRs.**

```bash
npm install -g @blockspool/cli
cd your-project
blockspool solo init
blockspool solo auto
```

That's it. BlockSpool scouts your code, runs fixes in parallel, and creates draft PRs.

---

## Try It (15 minutes)

```bash
# Quick run — scout, fix, and PR a few improvements
blockspool solo auto --minutes 15
```

You'll see BlockSpool find improvements, execute them, and open draft PRs. Review them, merge what you like.

### Ready for more?

```bash
# Run for a few hours
blockspool solo auto --hours 4

# Overnight with milestone PRs (batches fixes into fewer PRs)
blockspool solo auto --hours 8 --batch-size 30

# Run until you stop it
blockspool solo auto --continuous
```

---

## What It Looks Like

```
$ blockspool solo auto --minutes 15

BlockSpool Auto

  Model: eco (sonnet for simple, opus for complex)
  Scout: sonnet
  Categories: refactor, test, docs, types, perf
  Draft PRs: yes

Step 1: Scouting src...
  Found 8 improvements, processing 3...

Will process:
  • Extract repeated validation into shared helper
    refactor | simple | 85% | sonnet
  • Add missing error boundary to dashboard route
    fix | moderate | 78% | opus
  • Add unit tests for date formatting utils
    test | trivial | 92% | sonnet

  ✓ PR created
    https://github.com/you/repo/pull/42
  ✓ PR created
    https://github.com/you/repo/pull/43
  ✓ PR created
    https://github.com/you/repo/pull/44

Summary
  Duration: 12m
  PRs created: 3
```

---

## Key Features

| Feature | Description |
|---------|-------------|
| **Eco Model Routing** | Default on: trivial/simple → sonnet, moderate/complex → opus. `--no-eco` for full opus. |
| **Auto-Learning** | Records failures and injects lessons into future scout cycles |
| **AI Merge Resolution** | Claude resolves merge conflicts before blocking tickets |
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
4. **Execute** — Runs Claude Code CLI in isolated git worktrees (parallel)
5. **Merge** — Merges ticket branch into milestone branch (with conflict-aware scheduling)
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
blockspool solo auto --hours 4

# Milestone mode (recommended for long runs)
blockspool solo auto --hours 8 --batch-size 30
```

---

## Commands

### Initialize
```bash
blockspool solo init
```

You'll be prompted to authorize the repo:

```
Authorize repository for BlockSpool

  Repository:  user/my-repo
  Remote:      git@github.com:user/my-repo.git
  Local path:  /home/user/my-repo

BlockSpool will scout this repo, execute changes in isolated
worktrees, and create draft PRs. All changes go through QA.

Authorize user/my-repo? [Y/n]
```

Creates `.blockspool/` directory with SQLite database and registers the repo in `~/.blockspool/allowed-repos.json`. No external services needed.

For CI/scripting, skip the prompt:

```bash
blockspool solo init --yes                                    # Auto-detect remote, skip prompt
blockspool solo init --repo git@github.com:user/repo.git      # Explicit remote, skip prompt
```

### Auto (Main Command)
```bash
# Run overnight with milestone PRs (eco mode, sonnet scout)
blockspool solo auto --hours 8 --batch-size 30

# Full opus run — maximum quality, maximum cost
blockspool solo auto --no-eco --scout-deep --hours 8 --batch-size 30

# Run until stopped (Ctrl+C finalizes partial milestone)
blockspool solo auto --continuous --batch-size 20

# Dry run (show what would happen)
blockspool solo auto --dry-run

# Include more categories
blockspool solo auto --aggressive

# Focus on specific improvements
blockspool solo auto --formula security-audit
blockspool solo auto --formula test-coverage
blockspool solo auto --deep
```

### Model Routing

Eco mode is on by default — routes trivial/simple tickets to sonnet and moderate/complex to opus.

```bash
blockspool solo auto                          # Eco mode (default)
blockspool solo auto --no-eco                 # Force opus for all tickets
blockspool solo auto --model sonnet           # Force sonnet for all tickets
blockspool solo auto --scout-deep             # Use opus for scout phase
blockspool solo auto --no-eco --scout-deep    # Full opus everything
```

### Other Commands
```bash
# List authorized repos
blockspool solo repos

# Deauthorize a repo
blockspool solo repos --remove user/my-repo

# Check prerequisites
blockspool solo doctor

# Manual scout
blockspool solo scout src/

# View status
blockspool solo status

# Run single ticket
blockspool solo run tkt_abc123

# Retry failed ticket (regenerates scope)
blockspool solo retry tkt_abc123

# Steer a running auto session
blockspool solo nudge "focus on auth module"
blockspool solo nudge --list
blockspool solo nudge --clear

# Interactive TUI
blockspool solo tui
```

---

## Formulas

Formulas are repeatable recipes for specific goals:

```bash
blockspool solo auto --formula security-audit   # Focus on vulnerabilities
blockspool solo auto --formula test-coverage     # Add missing tests
blockspool solo auto --formula type-safety       # Improve TypeScript types
blockspool solo auto --formula cleanup           # Dead code, unused imports
blockspool solo auto --formula docs              # Documentation improvements
blockspool solo auto --deep                      # Architectural review
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
- **Claude Code CLI** installed (`npm i -g @anthropic-ai/claude-code`)

---

## Trust Ladder

BlockSpool uses a trust ladder to control what changes are auto-approved:

| Mode | Categories | Use Case |
|------|------------|----------|
| **Default** | refactor, test, docs, types, perf | Safe overnight runs |
| **Aggressive** | + security, fix, cleanup | When you want more |

```bash
# Default (safe)
blockspool solo auto

# Aggressive (more categories)
blockspool solo auto --aggressive
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

**TL;DR:** BlockSpool is built for unattended overnight runs with eco model routing, auto-learning, scope enforcement, and milestone batching. Other tools optimize for different trade-offs: Gas Town for high-parallelism defined tasks, Factory/Devin for SaaS issue-to-PR workflows, Sweep for simple fixes.

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

### Will it break my code?

- Every change runs through **typecheck and tests** before merging
- All changes are **draft PRs** by default
- Only touches files in scoped directories
- Failed tickets are automatically **blocked**, not merged
- Trust ladder limits to safe categories

### How much does it cost?

BlockSpool is free and open source. It uses your Claude Code subscription or API key. Eco mode (default) routes simple tickets to sonnet to reduce costs. Use `--no-eco` for full opus if cost isn't a concern.

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
