# Changelog

## 0.0.2 — 2026-06-26 — roadmap phases 1–5

- **`--working` mode** — measure uncommitted (tracked) changes via `git stash create`; never disturbs the working tree.
- **Reward stream** — every gated run appends to `.promptwheel/outcomes.jsonl` (`--no-record` to skip). The per-repo "what moves what" record.
- **`improve --attempt "<cmd>"`** — the flywheel: run any agent/script, gate the result, **keep only if a metric improved** (commit), else revert. Agent-agnostic.
- **`--markdown`** output + **GitHub Action** (`action.yml`) — PR-comment verdict + status check, zero-install (runs from the action's own checkout). Example workflow included.
- **`insights`** — aggregate the reward stream into per-metric lever scores (Phase-5 seed; design in `docs/LEARNING.md`).
- Internals: extracted a shared `gate()` core used by `run` and `improve`.

## 0.0.1 — 2026-06-26 — the pivot

PromptWheel rebooted from an **agent orchestrator** into **the outcome gate for AI code**. Orchestration was retired (commoditized by Claude Code Workflows/subagents/hooks/Routines and Cursor); the prior codebase is archived at `_archive/promptwheel-orchestration` (recoverable from GitHub `promptwheel-ai/promptwheel` + `CodeWheel-AI/promptwheel`).

**v0 — the gate (runnable):**
- Before/after metric measurement in isolated, throwaway git worktrees (never touches your working tree).
- Config-driven metrics: `cmd` + `extract` (`number`/`lines`/`exit`/`{regex}`) + `direction` (`up`/`down`/`pass`) + `guard`.
- Regression guards: a trusted regression fails the gate (exit 1) — CI-friendly.
- **Noise-aware trust model** (`--repeat N`): median + observed noise band; a delta inside the band is `inconclusive` and never fails a guard. Confidence: `high`/`medium`/`low`/`unverified`.
- Human and `--json` output.

See `docs/VISION.md` for the why, `docs/ROADMAP.md` for what's next, `docs/ARCHITECTURE.md` for how it works.
