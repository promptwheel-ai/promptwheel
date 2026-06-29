# Learning & discovery (Phase 5) — design, gated on data

> **FROZEN — not built** (only the `insights` seed exists). Gated on **≥ a few hundred real gated runs + proof of compounding**; unfreezes only on that data gate *or* ≥1 paid engagement (see DECISIONS **D7** / the Phase 5–6 freeze). The loop-native reframe does **not** unfreeze this.

This is the *speculative* layer. It is deliberately **not built** beyond the `insights` seed command, because the research is clear that the value here is unproven until the reward stream (Phase 2) holds real per-repo data. Build order is non-negotiable: **outcomes first, learning second.**

## What exists now (the seed)

`promptwheel insights` aggregates `.promptwheel/outcomes.jsonl` into per-metric stats: runs, improved/regressed/inconclusive counts, net delta, and a **lever score** (`improved / runs`) — how reliably a metric actually responds. That's the honest substrate; no model, no RL.

## What Phase 5 becomes (only once there's data)

### 1. Outcome-driven learning — an ACE-style playbook
Per the research (`../../explorations/research/`), the only learning approach that ships as open-core (no RL training) is a **structured, deduped, decaying playbook**, not free-text appended to CLAUDE.md. Adapt **ACE** (Agentic Context Engineering, Stanford 2510.04618): a Generator/Reflector/Curator loop that maintains versioned tactics keyed by `(subsystem, metric, change-type)`, each entry earned from a **measured** outcome ("refactoring X reliably cut p95; touching Y reliably regressed lint"). The reward stream is the training signal; entries decay if they stop predicting.

### 2. Work-discovery — UCB over the lever scores
The unowned gap is **principled prioritization** (nobody publishes a work-selection policy). Use the `insights` lever scores as priors in a **UCB/bandit** loop: propose the next change against the highest expected-improvement metric, balanced by exploration. This is the one place PromptWheel's archived orchestrator had a real idea (UCB1 formula rotation) worth carrying forward — but now grounded in *measured outcomes*, not heuristics.

### 3. Paid surface
Cross-repo aggregation of the playbook + lever data ("change-types that reliably help across your fleet") is the hosted product. Never in the OSS core.

## Harvested data-quality guards (from the securitychecks/blockspool lineage, 2026-06-26)

The reward stream and any future playbook are only as good as the data feeding them. Three disciplines the earlier projects learned the hard way (see `../../explorations/ripcut-backup.md`), to build *before* the playbook:

- **Typed override reasons gate what feeds learning.** When a human overrides a verdict, require a typed reason (`false_signal` / `flaky_metric` / `acceptable_tradeoff` / `duplicate`). Only `false_signal`/`flaky_metric` may adjust a metric's noise model or lever score; an `acceptable_tradeoff` must **never** teach "this change-type is bad." A `VERDICT_MAP` from typed action → reward, never free-text. (securitychecks: "don't auto-learn from generic waive — risk of learning to suppress real issues.")
- **Cohort-segmented reliability, not one global number.** Fingerprint each outcome with an environment/cohort tag (CI vs local, benchmark-class, machine) and segment lever scores + noise bands by cohort. securitychecks precision was ~100% on SaaS repos but ~30–50% on frameworks — "don't chase a single universal FP rate." Also a marketing-honesty guard: don't claim "works on any repo."
- **Composite lever score = effect-size × confidence, Beta-smoothed.** Replace raw `improved/runs` with a Beta(α,β) posterior mean (smooths low-sample metrics) times the median effect size; drop metrics below an effect-size floor from prioritization. (securitychecks ranked by confidence×severity; blockspool's UCB1 used a Beta posterior + impact floor.)

## Hard gates before building any of this
- **≥ a few hundred gated runs** of real outcome data in a real repo (else the playbook overfits to noise).
- **Proof of compounding**: an `improve` loop using the playbook must beat the same loop without it, *measured by the gate itself*. If it doesn't, this layer is a research dead-end and we stop — cheaply.
- Still zero-dep / thin. If ACE/UCB needs heavy ML deps, it belongs in the paid cloud, not the CLI.

## Why the discipline
The controlled coding-memory benchmark (Mar 2026) found cross-run memory saves tokens but does **not** improve code quality. We only earn the right to build learning by first having an outcome signal that can *prove* it helps. That signal is the whole point of Phases 0–2.
