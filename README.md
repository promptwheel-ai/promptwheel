# PromptWheel

**The outcome gate for AI code — prove every change moved a metric.**

> Same name, new meaning. The "wheel" is no longer a wheel of prompts (orchestration — a solved, commoditized problem). It's the **improvement flywheel**: every turn only counts if it **provably moved a metric without regressing another.** The outcome gate is the hub.

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
# in your repo, with a promptwheel.config.json
npx promptwheel run                       # base = merge-base with main, head = HEAD
npx promptwheel run --repeat 5 --json     # measure 5× to establish a noise band, emit JSON
```

It never touches your working tree — every measurement runs in a throwaway worktree.

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

## Docs

- [docs/VISION.md](docs/VISION.md) — why we pivoted from orchestrator to outcome gate, the thesis, the moat, the open-core model.
- [docs/ROADMAP.md](docs/ROADMAP.md) — the phased plan and the ship-now/stay-thin guardrails.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — how the engine works: schemas, extract modes, the trust/noise model.
- [CLAUDE.md](CLAUDE.md) — the constitution for anyone (human or agent) working in this repo.

## Roadmap

- [x] before/after worktree measurement + regression guards
- [x] noise band + confidence (don't trust a delta inside the jitter)
- [ ] `--working` mode: measure uncommitted changes (stash-based) for local dev
- [ ] persisted reward stream (`.promptwheel/outcomes.jsonl`) → the compounding "what moves what" record
- [ ] GitHub Action / PR-comment wrapper (the open-core distribution surface)
- [ ] agent loop: propose change → gate → keep only if a metric improved

> Status: v0, runnable. Lineage: CommandLayer → BlockSpool → PromptWheel (orchestrator, archived) → **PromptWheel (outcome gate)**.
