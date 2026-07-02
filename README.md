# PromptWheel

[![CI](https://github.com/promptwheel-ai/promptwheel/actions/workflows/ci.yml/badge.svg)](https://github.com/promptwheel-ai/promptwheel/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE) ![Node ≥18](https://img.shields.io/badge/node-%E2%89%A518-brightgreen) ![deps: zero](https://img.shields.io/badge/deps-zero-blue)

**Catch your agent cheating** — the deterministic auditor that flags when your AI coding agent gamed its own success metric.

PromptWheel re-proves every "win" using the agent's **source edits alone**. If the gate only went green because the agent edited the test, mocked the grader, suppressed the error (`@ts-ignore` / `eslint-disable`), or deleted the feature, the win evaporates when those edits are reverted → **`VERDICT GAMED`, exit 2**. No LLM in the loop — a diff partition plus a re-run, so every flag is reproducible in seconds with a human-readable reason.

It's built on an **outcome gate**: for any change it re-runs your metric commands (tests, lint, `tsc`, coverage, bundle, eval) in throwaway git worktrees before and after, and refuses to trust a delta inside the measurement noise. The gate everyone ships asks *"did the number move?"* — PromptWheel also asks *"did the agent **earn** it?"*

PromptWheel is the **signal, not the loop driver**: wire it as the verifier inside Claude Code `/loop`, a Ralph `while`-loop, or a Beads pull-loop. Each turn it answers one question — *did this turn earn its keep, and did the agent earn it honestly?* — so the loop improves instead of confidently degrading. (In CI it's the **outcome gate for AI code**: the same verdict, as a PR check.)

> Same name, new meaning. The "wheel" is the **improvement flywheel**: every turn only counts if it **provably moved a metric without regressing another.** Orchestration (the old "wheel of prompts") *and the outcome gate itself* are now solved, commoditized problems; the open one is **catching when the agent games that gate** — making the reward signal one you can't cheat.

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

## Catch your agent cheating — on by default

The headline feature, and it runs **by default** (in both `run` and `improve`; pass `--no-detect-gaming` for the bare outcome gate). After the normal gate, every *win* is re-proven using the agent's source edits **alone**: PromptWheel splits the diff into production source vs. `{test, config, grader, golden}` files, rebuilds a clean worktree at the base with **only the source slice** applied, and re-runs the gate. If the win doesn't survive — because it only passed by skipping/deleting a test, mocking the grader, editing a golden, relaxing a config, or the "win" touched zero source files — the verdict is **`GAMED` (exit 2)**:

```
$ promptwheel run

PromptWheel  base → head
  ▲ tests_pass    0 → 1  (+1, improved) [guard✓, high]
      🚩 GAMED — the "win" changed zero production-source files — only test/config/grader/golden
  VERDICT: GAMED  — a metric "improved" by editing the goalposts, not the source
```

Inline source-file suppressions (`@ts-nocheck`, `eslint-disable`, `# noqa`) — and the quieter cheat of *weakening the suite while the metric stays flat* — are a different shape, caught by **tripwire guards** (`test_count`, `skipped_tests`, `suppressions`, `assertions`) that fail when a "win" introduces them. The plain `init` default includes these tripwires, so gutting a test file fails the gate out of the box:

```bash
npx promptwheel init                      # guarded tests + antihack tripwires by default
npx promptwheel run                       # detection ON by default · exit 0 win · 1 regression · 2 GAMED
                                          #   (add --no-detect-gaming for just the outcome gate)
```

Deterministic, zero-LLM, zero-network: an LLM judge asking "did you cheat?" is itself gameable; this is a diff partition plus a re-run, so a flag is trustworthy without a human in the loop. The 50%-of-gain-survives threshold is the default and is tunable via `gamingThreshold` (config-level, or per-metric).

This is **one layer**, not a silver bullet: it catches the evaluator-tampering class (test/grader/golden/config edits) deterministically and for free, so the expensive layers — held-out tests for semantically-weak wins, an LLM judge or a human for intent and leakage — are reserved for the calls only they can make. See **[docs/DETECTION-LAYERS.md](docs/DETECTION-LAYERS.md)** for the coverage matrix and honest scope, and **[bench/RESULTS.md](bench/RESULTS.md)** for the measured numbers (`node bench/gaming-bench.mjs` to reproduce — it includes a cross-stack table with a real pytest run + a numeric eval-pass-rate metric). **Gate your own stack** — pytest · tsc · coverage · bundle · llm-eval — copy a config from **[examples/](examples/)**.

## Use

```bash
# 0. write a starter config for your stack (or hand-write promptwheel.config.json)
npx promptwheel init                      # detects stack → guarded tests + antihack tripwires (+ lint if eslint is set up)
npx promptwheel init --list               # presets: tests-pass · lint · bundle-size · llm-eval · antihack

# measure a change
npx promptwheel run                       # base = merge-base with main, head = HEAD · reward-hack detection ON
npx promptwheel run --working             # measure UNCOMMITTED changes (incl. newly added files)
npx promptwheel run --repeat 5 --json     # measure 5× to establish a noise band, emit JSON

# the loop: run any agent/script, keep the change ONLY if a metric improved
npx promptwheel improve --attempt "claude -p 'reduce lint errors'"
#   exit 0 = kept a real win · 1 = guarded regression (reverted) · 3 = plateau (reverted) · add --json

# what's actually responding in this repo? (aggregates .promptwheel/outcomes.jsonl)
npx promptwheel insights
```

**Footprint:** it never touches your working tree — every measurement runs in a throwaway git worktree **in your system temp dir** (one at a time; `node_modules` is symlinked, not copied), removed when the run finishes. The only thing PromptWheel writes to your repo is the optional `.promptwheel/outcomes.jsonl` record — commit it to build the per-repo "what moves what" history, or `.gitignore` it (`--no-record` to skip entirely). A hard-killed run can't leave clutter behind: the next run **self-heals** any orphaned worktree (stale registry entry + abandoned temp checkout).

## Loop patterns

PromptWheel is the gate *inside* a loop you don't have to write:

```bash
# converge: keep spinning while each turn earns its keep; stop on plateau (3) or regression (1)
while npx promptwheel improve --attempt "claude -p 'speed up the hot path'"; do :; done

# read-only signal inside a driver you control (e.g. Claude Code /loop): gate without committing
npx promptwheel run --working --json    # branch on .verdict / per-metric .status
```

The exit code is the contract — `0` kept · `1` regression · `3` plateau — so any driver (`/loop`, a Ralph `while`, a Beads pull-loop) converges without parsing anything. PromptWheel never drives the loop; it only says whether the turn counted.

**Two callers, by design.** Your *agent* consumes the verdict — it's the loop's per-turn reward (`improve` / `run --working --json`; exit `0` kept · `1`/`2` reverted · `3` plateau). The *harness* (a Stop-hook or CI) runs `--detect-gaming` — the audit the agent **can't self-clear**, because a contestant can't referee itself (see [docs/ENFORCEMENT.md](docs/ENFORCEMENT.md)). Same tool; *who calls it* is the difference between a reward and an audit.

## In Claude Code — plugin

Bring the gate into Claude Code as slash commands:

```
/plugin marketplace add promptwheel-ai/promptwheel
/plugin install promptwheel@promptwheel-ai
```

Then `/promptwheel:setup` (write a config) · `/promptwheel:gate` (gate uncommitted changes) · `/promptwheel:improve <cmd>` (keep-if-improved) · `/promptwheel:insights`. The plugin wraps the CLI, so install that too (`npm i -g promptwheel`). See [`plugins/promptwheel/`](plugins/promptwheel/).

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
- **gamingCheck** — `false` exempts a metric from `--detect-gaming`'s source-only re-run. Use it for tripwire / test-side guards (assertion counts, test counts) whose gains legitimately live in test files — otherwise adding real tests would be flagged as gaming. The `antihack` preset sets this on its tripwires.
- **gamingThreshold** — the fraction of a win that must survive the source-only re-run to count as earned (default `0.5`). Config-level scalar, overridable per metric; inherited through `extends` like `repeat`.

## Guardrails & inheritance

To see what's actually enforced in a repo — including guards inherited from a shared config:

```bash
promptwheel guards
```

Teams keep one shared base config and have every repo inherit it via `extends`:

```json
// promptwheel.config.json
{ "extends": "./promptwheel.base.json",
  "metrics": [ { "name": "cost_per_run_usd", "guard": false } ] }   // loosen one inherited guard, locally
```

`extends` takes a path (or array of paths) to base configs: a repo **inherits** their guardrails, and a local metric of the same name **overrides** the inherited one (tighten, loosen, or disable). `promptwheel guards` shows the effective set with provenance — `inherited ← base.json`, `local`, or `local override` — plus each guard's flag record from the outcome stream.

Read this way, `extends` is **the shared invariants — the "business rules" — your agents inherit and are held to**: enforced as *measured guards* (a trusted regression fails the gate / reverts the commit), not advisory text an agent can quietly ignore. (Natural-language conventions belong in `AGENTS.md`; only deterministic, measurable guards belong here.)

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

- [docs/DETECTION-LAYERS.md](docs/DETECTION-LAYERS.md) — how `--detect-gaming` fits as the **deterministic layer** alongside held-out tests, LLM judges, and human review: the coverage matrix, the compose-as-a-pipeline model, and the honest in/out-of-scope boundary.
- [docs/ENFORCEMENT.md](docs/ENFORCEMENT.md) — making "the agent can't skip it" real: the three places to enforce (loop-revert · CI + branch protection · a tested Claude Code Stop-hook), the exact wiring, and the *protect-the-gate's-own-config* caveat.
- [docs/VISION.md](docs/VISION.md) — why we pivoted from orchestrator to outcome gate, the thesis, the moat, the open-core model.
- [docs/ROADMAP.md](docs/ROADMAP.md) — the phased plan and the ship-now/stay-thin guardrails.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — how the engine works: schemas, extract modes, the trust/noise model.
- [docs/LEARNING.md](docs/LEARNING.md) — the (research-gated) Phase-5 design: ACE-style playbook + UCB work-discovery.
- [CLAUDE.md](CLAUDE.md) — the constitution for anyone (human or agent) working in this repo.

## Develop

```bash
npm test     # the dep-free suite (node:test) — unit + integration, no dependencies
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
- [x] `--detect-gaming` — reward-hack detection: re-prove the win from source edits alone + `antihack` preset
- [x] npm publish — `promptwheel@0.1.0` (the lead magnet, shipped 2026-06)
- [ ] ACE-style learning + UCB work-discovery (**frozen** — gated on data + ≥1 paid engagement; see [docs/LEARNING.md](docs/LEARNING.md))

> Status: **published** (npm `promptwheel`, v0.2.0) — all core phases built. Lineage: CommandLayer → BlockSpool → PromptWheel (orchestrator, archived) → **PromptWheel (outcome gate)**.
