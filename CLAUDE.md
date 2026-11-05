# PromptWheel - working notes for agents

**What this is now:** the engine behind Sawbuck and the **outcome gate for AI code** in CI - a tiny CLI that proves a change *moved a measurable metric without regressing another*. It is the signal a loop *consumes*, not the loop driver. It is NOT (anymore) an agent orchestrator. That product was retired in June 2026 because base tools (Claude Code Workflows/subagents/hooks/Routines, Cursor) commoditized orchestration. See `docs/history/VISION.md` for the full why.

> The "wheel" = the **improvement flywheel**: every turn only counts if it provably improved something. The outcome gate is the hub.

## The constitution (do not violate without a decision)

1. **Radically thin. Zero runtime deps. No build step.** The entire tool is `bin/promptwheel.mjs` (Node ESM). Adding a dependency needs a strong, written reason. Thinness is the strategy, not an accident - the research said this niche is only viable if we ride the platform instead of rebuilding it.
2. **Ride the platform; never reimplement it.** Use Claude Code Agent SDK / `/loop`, Beads (`bd`) for issue graphs, git for everything. We do NOT rebuild orchestration, scheduling, worktrees-as-a-service, or memory frameworks.
3. **Never trust noise.** A delta inside the measured jitter band is `inconclusive`, not a regression. Guards must never fail on noise. This is the credibility feature - protect it.
4. **Never touch the user's working tree.** All measurement happens in throwaway git worktrees.
5. **Outcome over orchestration.** Every feature must serve the question "did a real metric move, provably?" If it doesn't, it belongs in a different tool.
6. **Open-core.** The CLI + GitHub Action are OSS (Apache-2.0). The paid surface is *later*: hosted cross-repo intelligence + dashboards. Don't build billing/cloud into the core.

## Layout

- `bin/promptwheel.mjs` - the whole engine (config load → worktree measure ×N → median + noise band → evaluate → verdict + the source-only re-run, evaluatorPaths auto-fail and gate integrity; commands run/init/lock/pr-allow). ~1400 LOC. `bin/promptwheel.d.ts` is its hand-written type declaration (no build step; a test keeps it in step with the export list).
- `promptwheel.config.json` - example metrics config.
- `docs/ARCHITECTURE.md` - how the engine works, schemas, the trust model.
- `docs/history/` - the original pivot rationale (`VISION.md`) and the phased plan (`ROADMAP.md`); historical, not maintained.

## Run / verify

```bash
node bin/promptwheel.mjs run --base <ref> --head <ref> [--repeat N] [--json]
npm test          # 136 dep-free node:test tests (unit + integration)
```

Tests live in `test/promptwheel.test.mjs` - keep them **dep-free** (`node:test`): import the pure helpers for unit tests, shell out to the CLI for integration. `bin/promptwheel.mjs` is the single source of behavior; **add/adjust a test with every behavior change**. The engine is importable (pure helpers exported; the CLI runs only when invoked directly) - don't break that, the tests rely on it.

## Don'ts

- Don't re-add orchestration, "spin", trajectories, or formulas - that lineage was retired in June 2026 and is not in this repo (it survives only in git history before the pivot).
- Don't add heavy deps, a framework, or a build pipeline.
- Don't let a guard fail on a within-noise delta.
- Don't bake cloud/billing into the OSS core.
