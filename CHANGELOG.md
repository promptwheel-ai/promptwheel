# Changelog

## Unreleased

- **New: `promptwheel flaky`** — noise-source attribution for the reward signal. Re-runs the
  test command in a throwaway worktree across the four classic causes of "passes locally,
  fails in CI" — seed (20), order (25), time/TZ (25), db-isolation (20, config-only) — plus
  base-instability (30), and emits a weighted 0–100 flakiness score with per-axis fixes.
  Axes the framework can't express are skipped and reported, never guessed. When the suite
  is unstable at rest, axis flips are declared unattributable (fix base first) instead of
  being scored. Probes strip `NODE_TEST_CONTEXT` so a nested `node --test` cannot false-green.
  Labeled benchmark: `bench/flaky-bench.mjs` (6/6 fixture classes correctly attributed).
  Weights and remediation mapping descend from the harmonic_belt lineage (2025).

## 0.4.2 — 2026-07-07 — reposition: "add a referee to your coding loop"

- **Repositioned** the README and npm description around the **referee** frame — a neutral, un-gameable check you add to your coding loop that verifies a win was *earned*. Catching the test-editing cheat is the referee's signature call, not the whole pitch. **No engine change** — the mechanism, verdicts, exit codes, and demos are identical to 0.4.1.
- **`examples/test-change-verdicts/`** — a runnable three-scenario demo answering "won't this flag my legit test edits?": a green→green refactor **PASSES**, a real fix that also edits a test **PASSES**, a test-only red→green is **GAMED**. Same metric move, opposite verdict — it keys on whether *source* carried the win, not whether a test was touched.
- **Corpus:** distribution regression matrix extended to **1,000 repos** (verified rows across TS/JS/Next/Python/Go/Rust).

## 0.4.1 — 2026-07-03 — honest verdicts + cross-ecosystem measurement

- **Inert guards no longer report a green PASS.** A guarded pass/fail metric that never actually runs (stuck at 0 across both refs — a missing or misconfigured test command) now yields `VERDICT: INCONCLUSIVE` (exit 3) instead of a misleading `PASS` with a buried warning. `improve` reverts on it; PR/markdown gets a yellow state. A gate must not certify a pass it never measured. *(Surfaced by the 150-repo sweep, where ~76% of real repos were silently reading a fake green.)*
- **Generalized the worktree dependency-bridge beyond `node_modules`.** New config keys: `linkDirs` (dirs to symlink into the measuring worktree; default `["node_modules"]`), `env` (vars for metric commands; `{wt}` → worktree path), and `setup` (a per-ref build/install, run after the source patch). `init` auto-writes stack defaults — Python: `linkDirs:['.venv']` + `PYTHONPATH="{wt}/src:{wt}"` + `.venv/bin/pytest` (fixes editable-install blindness on `src/`-layout repos, so the *measured ref* is imported, not your original checkout); Rust: `linkDirs:['target']`. `linkNodeModules` kept as back-compat.
- **Corpus:** distribution regression matrix extended to 150 repos; sweep parametrized (`LIST`), the `PW` path made absolute, and the Python/JS install path now pulls test deps + wires the per-ref `setup` build so the gate measures a real suite.

## 0.4.0 — 2026-07-03 — backfill: the cold-start harvest

- **`promptwheel backfill [-n N | --since <ref>]`** — seed the ledger by replaying git history through the *current* metrics (LEARNING.md harvest path 1), so `playbook`/`suggest`/`insights` are useful on day one instead of starting empty. Deterministic, no LLM. Rows are **cohort-tagged `backfill`** (historical human commits are not live agent-loop evidence — segmented, flagged on disagreement, never averaged in), the **conventional-commit type becomes the change-type label** for free (`fix`/`feat`/`refactor`/…), commits replay oldest-first so decay stays honest, re-runs are idempotent, root commits are skipped, and commits that no longer build record as `unmeasurable` — never faked. Gaming detection is off by default for history (`--detect-gaming` to audit the past too).
- Plugin `setup` skill: Claude now *proposes* repo-specific metrics at config time (build → `bundle_kb`, evals → `eval_pass_rate`, …) and offers the backfill — the LLM is the discovery layer only; every metric is a deterministic shell command and the engine stays LLM-free.

## 0.3.0 — 2026-07-02 — Phase 5, experimental (D7 overturned by explicit founder decision)

The learning layer, built under the constraints that survive the unfreeze — pure view, evidence-gated, claim-gated:

- **`promptwheel playbook`** — the outcome-curated playbook (adapting Agentic Context Engineering, Stanford 2510.04618): decayed (half-life 20 runs), Beta-smoothed, evidence-gated claims re-derived from `.promptwheel/outcomes.jsonl` on every read. No curator state, no model. Keys: `metric`, `metric @ subsystem`, `metric # label`; cohorts that disagree are flagged, not averaged. `--json` / markdown output for agent consumption.
- **`promptwheel suggest`** — UCB work-discovery over the lever scores: proposes where the next attempt should go (measured targets only, never code advice). Thin records are labeled as such.
- **Record enrichment** — every outcome row now carries `cohort` (ci/local), `subsystems` (top source dirs of the diff), and `label` (`--label`, or the `improve` attempt command) — the keys the playbook learns over.
- **`bench/compounding-ab.mjs`** — the acceptance harness: playbook arm vs control arm through `improve`, judged by the gate. Self-test included. **The claim gate: no public compounding statement until this passes on real usage data.**

## 0.2.3 — 2026-07-02 — usage replay

Replayed 136 real merged commits from 22 live-suite corpus repos through the gate as a user would (`run --base <c>~1 --head <c>`, detection on, default config): **123 PASS · 9 FAIL · 1 GAMED · 3 TIMEOUT — a 7.5% block rate on presumptively-honest commits**, under the 10% ship bar, with most blocks semantically correct (commits that genuinely added suppressions/skips, suites red at one ref, one red→green achieved purely via test-file edits — flagged GAMED, accurately). One refinement from the data:

- **FAIL verdicts now coach the intentional case** — one line pointing at loosening the specific guard locally (`guard:false` / named override) and at `promptwheel guards` — so a maintainer who *meant* to add that suppression knows the escape hatch instead of feeling gate-harassed.

## 0.2.2 — 2026-07-02 — 100-repo distribution sweep

Ran the gate across ~100 public repos (TS/JS libs, Next.js apps, Python, Go, Rust; 5-way parallel, per-language installs, three probes each: clean baseline · syntax-break · suppression-cheat). Aggregate: 0 hangs, cheat caught 72/72 on JS/TS/Next/Python; every break-probe miss on live suites triaged to uncovered-file probe picks — except one real class, plus one pattern gap:

- **Python editable installs can blind the gate — now detected and warned.** With src-layout `pip install -e .`, the worktree's tests import the ORIGINAL checkout at both refs, so every delta reads 0 (confirmed by controlled repro: a broken working tree measured `0 → 0 unchanged` while clean HEAD should read 1). The gate now detects an editable install of the measured repo (`__editable__*`/`.pth`/`.egg-link` in the active python's site-packages) and prints a loud warning with the workaround. A Node CLI cannot fix Python import semantics; refusing to pretend beats silently lying.
- **Suppression tripwire now covers Go and Rust** (`//nolint`, `#![allow(...)]`) — measured 0/27 caught before the fix, confirmed caught on a live Go repo after.
- Corpus context for honesty: many stranger repos' suites don't run under a fresh `--ignore-scripts` install (workspace links, build steps, missing env) — the 0.2.1 inert-guard warning fired correctly on all of these rather than reporting fake green.

## 0.2.1 — 2026-07-02 — corpus-hardened

Ran the gate against a 10-repo public corpus (Next.js apps, vitest/jest/ava TS libs, pnpm monorepos): 10/10 `init` correct, 10/10 scripted cheats caught, 0 hangs. Three failure classes found and fixed:

- **Inert-guard warning (the fake-green class).** A guarded `pass` metric that is 0 at *both* refs (broken test command, missing script, failed install — 5/10 corpus repos) now prints `⚠ never passed at either ref — this guard is protecting nothing` in human and markdown output instead of folding silently into a green verdict.
- **`init` writes the self-describing placeholder when `package.json` has no test script** (very common in app repos), instead of a `npm test` command that can never pass.
- **`NON_SOURCE` no longer sweeps tool-named production source.** Config detection now requires a `.config`/`.conf`/`.setup` segment (plus `tsconfig*.json`), so a real source file like `src/installers/eslint.ts` stays in the source slice — previously an honest win there could be flagged GAMED.
- Minor: the `assertions` tripwire now also counts ava-style `t.is()`/`t.deepEqual()` assertions.

## 0.2.0 — 2026-07-02 — the polished gate

- **Default `init` config now includes the antihack tripwires** (`test_count`, `skipped_tests`, `suppressions`, `assertions`). The quiet cheat — weaken the suite while the target metric stays flat — previously PASSED under the default config because gaming detection only audits *wins*; now it fails the gate out of the box. "Catch your agent cheating" is true without a preset.
- **`gamingThreshold` is now actually tunable** (config-level scalar or per-metric; inherited through `extends`), as the README already claimed. Default unchanged at `0.5`; the GAMED reason string names the threshold in effect.
- **`init` only writes the `lint_errors` metric when eslint is actually set up** (config file or dependency). Previously it reported a constant `0 (unverified)` on repos without eslint — a metric that can't move is noise, not signal.
- Tests: gamed-verdict boundary (`retained === 0.5` → earned), unmeasurable-guard short-circuit, regex-extract fixture that distinguishes the regex path from the last-number fallback, threshold end-to-end, and the gut-the-suite scenario against the default config. Suite: 43 tests. (Several of these gaps were found by mutation-testing the gate itself — the tool's own medicine.)

## 0.1.2 — 2026-06-30

- **Reward-hack detection ON by default** in `run` and `improve`; `--no-detect-gaming` opts out. Exit `2` = GAMED.
- Benchmark: cross-stack/cross-metric track (real pytest + numeric eval-pass-rate); cost stated structurally (one gate re-run per win).
- CI dogfoods the gate; bench surfaces the plain-CI-PASS vs PromptWheel-GAMED contrast.

## 0.1.1 — 2026-06-28

- Fix: tripwire-guard false positive (test-side gains are exempt from the source-only re-run via `gamingCheck: false`).
- Gaming-detection benchmark + scoreboard (`bench/RESULTS.md`).

## 0.1.0 — 2026-06-27 — reward-hack detection

- **`--detect-gaming`**: re-prove every win from the agent's source edits alone; verdict **GAMED** when the gain came from editing tests/config/grader/golden. `antihack` preset (target + tripwires).
- **`extends`** config inheritance (diamond-safe cycle detection) + **`guards`** observability command with provenance and flag record.
- Self-heal for orphaned worktrees/temp indexes from hard-killed runs; empty-repo `--working` guard; npm metadata. First npm publish.

## 0.0.2 — 2026-06-26 — roadmap phases 1–5

- **`--working` mode** — measure uncommitted (tracked) changes via `git stash create`; never disturbs the working tree.
- **Reward stream** — every gated run appends to `.promptwheel/outcomes.jsonl` (`--no-record` to skip). The per-repo "what moves what" record.
- **`improve --attempt "<cmd>"`** — the flywheel: run any agent/script, gate the result, **keep only if a metric improved** (commit), else revert. Agent-agnostic.
- **`--markdown`** output + **GitHub Action** (`action.yml`) — PR-comment verdict + status check, zero-install (runs from the action's own checkout). Example workflow included.
- **`insights`** — aggregate the reward stream into per-metric lever scores (Phase-5 seed; design in `docs/LEARNING.md`).
- Internals: extracted a shared `gate()` core used by `run` and `improve`.
- **Tests:** 20 dep-free `node:test` tests (unit + integration); engine made importable (pure helpers exported, CLI guarded behind a direct-invocation check). `npm test`.
- Docs: `ARCHITECTURE.md` covers the full command set + reward stream + testing.

## 0.0.1 — 2026-06-26 — the pivot

PromptWheel rebooted from an **agent orchestrator** into **the outcome gate for AI code**. Orchestration was retired (commoditized by Claude Code Workflows/subagents/hooks/Routines and Cursor); the prior codebase is archived at `_archive/promptwheel-orchestration` (recoverable from GitHub `promptwheel-ai/promptwheel` + `CodeWheel-AI/promptwheel`).

**v0 — the gate (runnable):**
- Before/after metric measurement in isolated, throwaway git worktrees (never touches your working tree).
- Config-driven metrics: `cmd` + `extract` (`number`/`lines`/`exit`/`{regex}`) + `direction` (`up`/`down`/`pass`) + `guard`.
- Regression guards: a trusted regression fails the gate (exit 1) — CI-friendly.
- **Noise-aware trust model** (`--repeat N`): median + observed noise band; a delta inside the band is `inconclusive` and never fails a guard. Confidence: `high`/`medium`/`low`/`unverified`.
- Human and `--json` output.

See `docs/VISION.md` for the why, `docs/ROADMAP.md` for what's next, `docs/ARCHITECTURE.md` for how it works.
