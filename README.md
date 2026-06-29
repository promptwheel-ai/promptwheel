# PromptWheel

[![CI](https://github.com/promptwheel-ai/promptwheel/actions/workflows/ci.yml/badge.svg)](https://github.com/promptwheel-ai/promptwheel/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE) ![Node ≥18](https://img.shields.io/badge/node-%E2%89%A518-brightgreen) ![deps: zero](https://img.shields.io/badge/deps-zero-blue)

**The trustworthy per-turn reward for AI coding loops — proves a turn moved a metric without regressing another.**

PromptWheel is the **signal, not the loop driver**: wire it as the verifier inside Claude Code `/loop`, a Ralph `while`-loop, or a Beads pull-loop. Each turn it measures your real repo metrics in throwaway worktrees, refuses to trust a delta inside the noise, and answers one question — *did this turn earn its keep?* — so the loop improves instead of confidently degrading. (In CI it's the **outcome gate for AI code**: the same verdict, as a PR check.)

> Same name, new meaning. The "wheel" is the **improvement flywheel**: every turn only counts if it **provably moved a metric without regressing another.** Orchestration (the old "wheel of prompts") is a solved, commoditized problem; the trustworthy reward signal is the open one.

AI coding agents (and humans) declare success when a change *compiles and tests pass*. They almost never verify that a change **improved a real measurable thing without regressing another** — and outcome data rots in dashboards (DORA, Swarmia) disconnected from the change that caused it. PromptWheel closes that loop.

For any change (`base` → `head`), it measures each configured metric in an **isolated git worktree** before and after, **refuses to trust a delta inside the measurement noise band**, enforces **regression guards**, and emits a structured verdict:

```
PromptWheel  a1b2c3d → e4f5g6h  (×5)

  = tests_pass              1 →        1  (0, unchanged)     [guard✓, high]
  ▼ lint_errors            12 →        7  (-5, improved)     [guard✓, high]
  ▲ bundle_kb             340 →      352  (+12, regressed)   [info, medium]
  ▼ p95_ms                210 →      208  (-2, inconclusive) [info, low]

  VERDICT: PASS
```

Exit `0` on pass, `1` on fail (CI-friendly). No build step, zero dependencies, Node 18+.

## Use

```bash
# 0. write a starter config for your stack (or hand-write promptwheel.config.json)
npx promptwheel init                      # detects stack → guarded test metric + lint
npx promptwheel init --list               # presets: tests-pass · lint · bundle-size · llm-eval

# measure a change
npx promptwheel run                       # base = merge-base with main, head = HEAD
npx promptwheel run --working             # measure UNCOMMITTED changes (incl. newly added files)
npx promptwheel run --repeat 5 --json     # measure 5× to establish a noise band, emit JSON

# the loop: run any agent/script, keep the change ONLY if a metric improved
npx promptwheel improve --attempt "claude -p 'reduce lint errors'"
#   exit 0 = kept a real win · 1 = guarded regression (reverted) · 3 = plateau (reverted) · add --json

# what's actually responding in this repo? (aggregates .promptwheel/outcomes.jsonl)
npx promptwheel insights
```

It never touches your working tree — every measurement runs in a throwaway worktree. Every gated run appends to `.promptwheel/outcomes.jsonl` (commit it to build the per-repo "what moves what" record; `--no-record` to skip).

## Loop patterns

PromptWheel is the gate *inside* a loop you don't have to write:

```bash
# converge: keep spinning while each turn earns its keep; stop on plateau (3) or regression (1)
while npx promptwheel improve --attempt "claude -p 'speed up the hot path'"; do :; done

# read-only signal inside a driver you control (e.g. Claude Code /loop): gate without committing
npx promptwheel run --working --json    # branch on .verdict / per-metric .status
```

The exit code is the contract — `0` kept · `1` regression · `3` plateau — so any driver (`/loop`, a Ralph `while`, a Beads pull-loop) converges without parsing anything. PromptWheel never drives the loop; it only says whether the turn counted.

## In CI — GitHub Action

Drop this in your repo (it posts a verdict comment on every PR and fails the check on a guarded regression beyond noise):

```yaml
# .github/workflows/promptwheel.yml
name: PromptWheel
on: pull_request
permissions: { contents: read, pull-requests: write }
jobs:
  outcome-gate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: promptwheel-ai/promptwheel@v0
        with: { repeat: '3' }
```

The Action runs straight from its own checkout — no npm install, no build. See [`action.yml`](action.yml).

## Config — `promptwheel.config.json`

```json
{
  "repeat": 1,
  "metrics": [
    { "name": "tests_pass",  "cmd": "npm test --silent",            "extract": "exit",   "direction": "pass", "guard": true },
    { "name": "lint_errors", "cmd": "npx eslint . | grep -c error", "extract": "number", "direction": "down", "guard": true },
    { "name": "bundle_kb",   "cmd": "du -sk dist | cut -f1",        "extract": "number", "direction": "down", "guard": false }
  ]
}
```

- **cmd** — any shell command, run inside the worktree.
- **extract** — reduce its output to a number: `number` (last number, default) · `lines` (count non-empty lines) · `exit` (1 if exit 0 else 0) · `{ "regex": "coverage: (\\d+)" }` (first capture).
- **direction** — `up` (higher better) · `down` (lower better) · `pass` (boolean 0/1).
- **guard** — `true` = a *trusted* regression **fails** the gate; `false` = informational.

## Trust model — the point of the whole thing

A number that jumps around between runs is worthless as a signal. PromptWheel won't pretend otherwise:

- `--repeat N` measures each metric N times at both refs and uses the **median**; the **noise band** is the observed spread.
- A delta **inside the noise band** is reported `inconclusive` with `low` confidence and **does not fail a guard** (no flaky CI failures).
- **Confidence:** `high` (deterministic extract, or zero observed noise) · `medium` (delta clears the noise band) · `low` (delta inside noise) · `unverified` (single read — run `--repeat` to earn trust).

The accumulated record of **which change-types move which metrics** is the asset: a per-repo reward signal a base tool can't replicate, and the spine that lets an agent loop learn what actually helps.

## Where PromptWheel fits (and where it doesn't)

- **vs single-axis CI gates** (Codspeed, Bencher, size-limit, Lighthouse-CI): they own deep statistics on *one* metric; PromptWheel is the **cross-metric gate that composes them** — "did `eval_pass_rate` **and** cost improve without regressing the guards?" in one verdict. Wrap any of them as a metric `cmd` and let `--repeat` handle the noise.
- **vs loop/agent frameworks** (Ralph, GEPA, reward models): PromptWheel is the **execution-grounded reward they lack** — it runs your real suite with zero deps; it does not drive the loop or do test-time search.
- **When NOT to use it:** if you only care that tests pass, your base verifier already has you covered. PromptWheel earns its place when you have a **graded numeric metric** beyond pass/fail (eval score, $/run, latency, size) that a change could quietly move.

## Docs

- [docs/VISION.md](docs/VISION.md) — why we pivoted from orchestrator to outcome gate, the thesis, the moat, the open-core model.
- [docs/ROADMAP.md](docs/ROADMAP.md) — the phased plan and the ship-now/stay-thin guardrails.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — how the engine works: schemas, extract modes, the trust/noise model.
- [docs/LEARNING.md](docs/LEARNING.md) — the (research-gated) Phase-5 design: ACE-style playbook + UCB work-discovery.
- [CLAUDE.md](CLAUDE.md) — the constitution for anyone (human or agent) working in this repo.

## Develop

```bash
npm test     # 20 dep-free tests (node:test) — unit + integration, no dependencies
```

The engine is one importable file; pure helpers are exported for unit tests, the CLI runs only when invoked directly. Add a test with every behavior change.

## Roadmap

- [x] before/after worktree measurement + regression guards
- [x] noise band + confidence (don't trust a delta inside the jitter)
- [x] `--working` mode — measure uncommitted changes (tracked **and** untracked)
- [x] persisted reward stream (`.promptwheel/outcomes.jsonl`) — the compounding "what moves what" record
- [x] GitHub Action / PR-comment wrapper (open-core distribution surface)
- [x] agent loop: `improve` — propose → gate → keep only if a metric improved
- [x] loop-consumable `improve`: exit `0` kept / `1` regression / `3` plateau + `--json result`
- [x] `promptwheel init` + presets — zero-config onboarding
- [x] `insights` — reward-stream aggregation (Phase-5 seed)
- [ ] npm publish (the lead magnet) · ACE-style learning + UCB work-discovery (**frozen** — gated on data + ≥1 paid engagement; see [docs/LEARNING.md](docs/LEARNING.md))

> Status: v0, runnable, all core phases built. Lineage: CommandLayer → BlockSpool → PromptWheel (orchestrator, archived) → **PromptWheel (outcome gate)**.
