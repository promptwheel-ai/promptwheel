# Roadmap

Sequenced so each phase ships something usable and feeds the next. The ordering is deliberate: **prove the gate → make it usable → accumulate the moat → distribute → close the loop.** Learning/discovery come *last*, gated on real outcome data existing.

## Phase 0 — the gate ✅ (done, v0)
- Before/after metric measurement in isolated git worktrees (never touches your tree).
- `extract` modes: `number` / `lines` / `exit` / `{regex}`.
- `direction` (`up`/`down`/`pass`) + regression **guards** (fail the gate / exit 1).
- **Noise/confidence:** `--repeat N` → median + observed noise band; a delta inside the band is `inconclusive` and never fails a guard. `confidence ∈ {high, medium, low, unverified}`.
- Human + `--json` output.

## Phase 1 — usable on local work ✅
- `--working` mode: measure **uncommitted** changes — tracked **and** untracked (temp-index snapshot) — useful in the inner loop, not just CI. ✅
- Better base resolution + clear errors when refs/metrics are missing.

## Phase 2 — the moat: persisted reward stream ✅
- Append every gated change to `.promptwheel/outcomes.jsonl`: `{ts, base, head, metric, before, after, delta, confidence, verdict}`.
- This is the compounding, per-repo "which change-types move which metrics" record — the asset a base vendor can't replicate, and the training signal for everything in Phase 5.

## Phase 3 — distribution (the OSS front) ✅
- **GitHub Action / PR-comment wrapper:** run the gate on every PR, post a verdict comment, set a status check. ✅ (`action.yml`, `--markdown`, zero-install via the action's own checkout)
- `npx promptwheel` zero-install path; a 60-second quickstart. ✅ (README)
- _Remaining: **publish to npm** (`v0` tag already pushed) so `npx promptwheel` resolves — the lead-magnet launch gate._

## Phase 4 — close the loop ✅
- Agent loop: **propose change → gate → keep only if a metric improved (beyond noise)**. ✅ `improve --attempt "<cmd>"` — agent-agnostic (claude -p / aider / any script); keeps on improvement, reverts on regression or no-op.
- **Loop-consumable** ✅: `improve` exits `0` kept / `1` regression / `3` plateau + `--json result`, so `while improve; do :; done` converges — any driver (`/loop`, Ralph, Beads) without parsing.
- _Remaining (optional): Beads (`bd`) integration to file gated wins/regressions as graph issues (docs pattern, not engine)._

## Phase 4.5 — onboarding ✅
- `promptwheel init [--preset <name> | --list]`: detect stack → write a **guarded-only** starter config (tests-pass + lint); presets `tests-pass / lint / bundle-size / llm-eval`. Kills the blank-config wall (the #1 adoption bounce); a configless first run is pointed at `init`.

## Phase 5 — learning & discovery 🌱 seeded (full build gated on data)

> **FROZEN (DECISIONS D7):** beyond the shipped `insights` seed, no Phase 5/6 engine work until **≥1 paid engagement** OR the LEARNING.md data + compounding gate is met. Building selfcheck / attestation / ACE / UCB now is roadmap-costume procrastination.

- ✅ **Seed shipped:** `promptwheel insights` aggregates the reward stream into per-metric lever scores (`improved/runs`) — the honest substrate, no model. Design in [`LEARNING.md`](LEARNING.md).
- **Learning:** an ACE-style (Stanford 2510.04618) structured, deduped, decaying "what moves what" playbook keyed by subsystem/failure-mode — *driven by the Phase 2 outcome record*, not free-text in CLAUDE.md.
- **Work-discovery:** UCB/bandit-scored proposal of the next high-value change, scored against the outcome record (the principled prioritization nobody publishes).
- **Paid:** hosted cross-repo intelligence + dashboards over the aggregate.

## Phase 6 — credibility & evidence (harvested from the securitychecks/blockspool lineage, 2026-06-26)

Disciplines the earlier verification projects actually shipped; they protect the gate's own credibility and are the basis of the paid tier. See `../../explorations/ripcut-backup.md`.

- **Golden self-eval + accuracy-regression canary.** A labeled `test/fixtures/` of changes with known outcomes (a true win, a true no-op, a true regression, a deliberately flaky benchmark) + `promptwheel selfcheck` that asserts the gate's own verdict accuracy, and a CI canary that fails if an engine change degrades it. (securitychecks shipped recall/precision-bench + a benchmark-canary.) We measure the change; we don't yet prove our verdict is right.
- **Portable attestation artifact.** Make each outcome record a self-contained, hashable/signable bundle (cmd + env fingerprint + raw repeat samples + median + band + verdict) that a third party / the future cloud can independently re-verify *without the repo*. Turns "prove" into "produce a checkable proof"; the technical basis of the paid cross-repo tier.
- **Pre-flight `unmeasurable` gate.** Classify a change with no derivable metric/extract target as `unmeasurable` and skip the worktree experiment before spending compute, rather than emitting a junk verdict.

## Guardrails (non-negotiable)
- **Ship now.** The window is closing (Auto-Memory + Routines creeping in).
- **Stay radically thin.** Ride the platform (Agent SDK, `/loop`, `bd`, git). Zero deps in the core.
- **Prove compounding.** If the outcome record doesn't measurably improve an agent loop, this is a feature, not a company — and that's fine to learn fast.
