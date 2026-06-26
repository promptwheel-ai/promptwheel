# Roadmap

Sequenced so each phase ships something usable and feeds the next. The ordering is deliberate: **prove the gate → make it usable → accumulate the moat → distribute → close the loop.** Learning/discovery come *last*, gated on real outcome data existing.

## Phase 0 — the gate ✅ (done, v0)
- Before/after metric measurement in isolated git worktrees (never touches your tree).
- `extract` modes: `number` / `lines` / `exit` / `{regex}`.
- `direction` (`up`/`down`/`pass`) + regression **guards** (fail the gate / exit 1).
- **Noise/confidence:** `--repeat N` → median + observed noise band; a delta inside the band is `inconclusive` and never fails a guard. `confidence ∈ {high, medium, low, unverified}`.
- Human + `--json` output.

## Phase 1 — usable on local work
- `--working` mode: measure **uncommitted** changes (stash-based) so it's useful in the inner loop, not just CI.
- Better base resolution + clear errors when refs/metrics are missing.

## Phase 2 — the moat: persisted reward stream
- Append every gated change to `.promptwheel/outcomes.jsonl`: `{ts, base, head, metric, before, after, delta, confidence, verdict}`.
- This is the compounding, per-repo "which change-types move which metrics" record — the asset a base vendor can't replicate, and the training signal for everything in Phase 5.

## Phase 3 — distribution (the OSS front)
- **GitHub Action / PR-comment wrapper:** run the gate on every PR, post a verdict comment, set a status check. This is the open-core acquisition surface (where users actually come from).
- `npx promptwheel` zero-install path; a 60-second quickstart.

## Phase 4 — close the loop
- Agent loop: **propose change → gate → keep only if a metric improved (beyond noise)**. Reuse Claude Code Agent SDK / `/loop`; do not rebuild orchestration.
- Optional Beads (`bd`) integration: file gated wins/regressions as graph issues.

## Phase 5 — learning & discovery (only once the reward stream exists)
- **Learning:** an ACE-style (Stanford 2510.04618) structured, deduped, decaying "what moves what" playbook keyed by subsystem/failure-mode — *driven by the Phase 2 outcome record*, not free-text in CLAUDE.md.
- **Work-discovery:** UCB/bandit-scored proposal of the next high-value change, scored against the outcome record (the principled prioritization nobody publishes).
- **Paid:** hosted cross-repo intelligence + dashboards over the aggregate.

## Guardrails (non-negotiable)
- **Ship now.** The window is closing (Auto-Memory + Routines creeping in).
- **Stay radically thin.** Ride the platform (Agent SDK, `/loop`, `bd`, git). Zero deps in the core.
- **Prove compounding.** If the outcome record doesn't measurably improve an agent loop, this is a feature, not a company — and that's fine to learn fast.
