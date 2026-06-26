# PromptWheel — working notes for agents

**What this is now:** the **outcome gate for AI code** — a tiny CLI that proves a change *moved a measurable metric without regressing another*. It is NOT (anymore) an agent orchestrator. That product was retired in June 2026 because base tools (Claude Code Workflows/subagents/hooks/Routines, Cursor) commoditized orchestration. See `docs/VISION.md` for the full why.

> The "wheel" = the **improvement flywheel**: every turn only counts if it provably improved something. The outcome gate is the hub.

## The constitution (do not violate without a decision)

1. **Radically thin. Zero runtime deps. No build step.** The entire tool is `bin/promptwheel.mjs` (Node ESM). Adding a dependency needs a strong, written reason. Thinness is the strategy, not an accident — the research said this niche is only viable if we ride the platform instead of rebuilding it.
2. **Ride the platform; never reimplement it.** Use Claude Code Agent SDK / `/loop`, Beads (`bd`) for issue graphs, git for everything. We do NOT rebuild orchestration, scheduling, worktrees-as-a-service, or memory frameworks.
3. **Never trust noise.** A delta inside the measured jitter band is `inconclusive`, not a regression. Guards must never fail on noise. This is the credibility feature — protect it.
4. **Never touch the user's working tree.** All measurement happens in throwaway git worktrees.
5. **Outcome over orchestration.** Every feature must serve the question "did a real metric move, provably?" If it doesn't, it belongs in a different tool.
6. **Open-core.** The CLI + GitHub Action are OSS (MIT). The paid surface is *later*: hosted cross-repo intelligence + dashboards over the accumulated outcome record. Don't build billing/cloud into the core.

## Layout

- `bin/promptwheel.mjs` — the whole engine (config load → worktree measure ×N → median + noise band → evaluate → verdict). ~200 LOC.
- `promptwheel.config.json` — example metrics config.
- `docs/VISION.md` — why we pivoted, the thesis, the moat, open-core model.
- `docs/ROADMAP.md` — phased plan + the guardrails (ship thin, the window is closing).
- `docs/ARCHITECTURE.md` — how the engine works, schemas, the trust model.

## Run / verify

```bash
node bin/promptwheel.mjs run --base <ref> --head <ref> [--repeat N] [--json]
```

There is no test suite yet (v0). When adding one, keep it dep-free (node:test) and treat `bin/promptwheel.mjs` as the single source of behavior.

## Don'ts

- Don't re-add orchestration, "spin", trajectories, or formulas — that lineage is archived (`_archive/promptwheel-orchestration`, recoverable from GitHub).
- Don't add heavy deps, a framework, or a build pipeline.
- Don't let a guard fail on a within-noise delta.
- Don't bake cloud/billing into the OSS core.
