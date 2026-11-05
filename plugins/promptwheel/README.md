# PromptWheel - Claude Code plugin

A thin wrapper around the [`promptwheel`](https://github.com/promptwheel-ai/promptwheel) CLI, *a deterministic, zero-LLM check for your coding loop*, that brings the outcome gate into Claude Code as slash commands.

## Prerequisite

The plugin shells out to the CLI, so install it once:

```bash
npm install -g promptwheel
```

## Install the plugin

```
/plugin marketplace add promptwheel-ai/promptwheel
/plugin install promptwheel@promptwheel-ai
```

## Skills

Two skills ship in `skills/`:

| skill | wraps | what it does |
|---|---|---|
| `/promptwheel:setup` | `promptwheel init` | detect the stack, write a starter config |
| `/promptwheel:gate` | `promptwheel run --working` | gate uncommitted changes; reports the verdict (pass, fail, gamed, inconclusive) and what to do about each |

For repo history, install the Logbook plugin: `/plugin marketplace add promptwheel-ai/logbook`, then `/plugin install logbook@logbook`.

No hooks are registered by the plugin. A Claude Code Stop-hook that blocks a GAMED turn ships as a copyable example at [`examples/detect-gaming-stop.sh`](../../examples/detect-gaming-stop.sh); wiring is in [`docs/ENFORCEMENT.md`](../../docs/ENFORCEMENT.md).

It's the **signal inside your loop, not the driver**: `/promptwheel:gate` after a change tells you whether the turn earned its keep - measured in throwaway worktrees, never touching your working tree, never failing on noise. Full model in the [main repo](https://github.com/promptwheel-ai/promptwheel).

## What this plugin runs, writes, and sends (the full list)

**Programs it runs.** The two skills are instructions; the program they tell Claude to run is
the `promptwheel` CLI you installed (`promptwheel init|run`). `promptwheel run` also runs your repo's
own test or metric command (from `promptwheel.config.json`, or the detected test script) in throwaway
git worktrees, exactly as you would run it yourself. The plugin composes no command of its own and
registers no hooks and no mod.

**Files it writes.** Only inside the repo: `promptwheel.config.json` and a short block in
`AGENTS.md` (created if absent) and in `CLAUDE.md` and `.cursorrules` when those already exist,
written by `/promptwheel:setup` (`--no-agent-block` skips the block); and under the `supply-chain`
preset, a copy of the pack at `.promptwheel/packs/supply-chain/` and `promptwheel.lock.json`, which
you commit with the config.

**What it sends, and where.** Nothing. The check is deterministic and never calls a model or the
network; the only network traffic is npm fetching the packages. There is no telemetry.
