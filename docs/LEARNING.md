# Learning & discovery (Phase 5) — design, gated on data

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

## Hard gates before building any of this
- **≥ a few hundred gated runs** of real outcome data in a real repo (else the playbook overfits to noise).
- **Proof of compounding**: an `improve` loop using the playbook must beat the same loop without it, *measured by the gate itself*. If it doesn't, this layer is a research dead-end and we stop — cheaply.
- Still zero-dep / thin. If ACE/UCB needs heavy ML deps, it belongs in the paid cloud, not the CLI.

## Why the discipline
The controlled coding-memory benchmark (Mar 2026) found cross-run memory saves tokens but does **not** improve code quality. We only earn the right to build learning by first having an outcome signal that can *prove* it helps. That signal is the whole point of Phases 0–2.
