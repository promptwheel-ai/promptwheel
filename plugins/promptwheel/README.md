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

Five skills ship in `skills/`:

| skill | wraps | what it does |
|---|---|---|
| `/promptwheel:setup` | `promptwheel init` | detect the stack, write a starter config |
| `/promptwheel:gate` | `promptwheel run --working` | gate uncommitted changes; reports PASS / FAIL / GAMED / INCONCLUSIVE and what to do about each |
| `/promptwheel:improve <cmd>` | `promptwheel improve --attempt "<cmd>"` | keep a change only if a metric improved, else revert (exit 0 kept, 1 regression, 2 gamed, 3 plateau) |
| `/promptwheel:insights` | `promptwheel insights` | which metrics actually respond (loop memory) |
| `/promptwheel:logbook` | `@promptwheel/logbook` (separate package) | the memory engine's skill, carried here because the two engines are a pair: read a repo's git history as agent memory (hotspots, do-not-retry reverts, suppressions, fragile areas) |

No hooks are registered by the plugin. A Claude Code Stop-hook that blocks a GAMED turn ships as a copyable example at [`examples/detect-gaming-stop.sh`](../../examples/detect-gaming-stop.sh); wiring is in [`docs/ENFORCEMENT.md`](../../docs/ENFORCEMENT.md).

It's the **signal inside your loop, not the driver**: `/promptwheel:gate` after a change tells you whether the turn earned its keep - measured in throwaway worktrees, never touching your working tree, never failing on noise. Full model in the [main repo](https://github.com/promptwheel-ai/promptwheel).

## What this plugin runs, writes, and sends (the full list)

**Programs it runs.** The five skills are instructions; the programs they tell Claude to run are
the `promptwheel` CLI you installed (`promptwheel init|run|improve|insights`) and, for the logbook
skill, `npx -y @promptwheel/logbook@0.9.8` (pinned to that version). `promptwheel run` and `improve`
also run your repo's own test or metric command (from `promptwheel.config.json`, or the detected
test script) in throwaway git worktrees, exactly as you would run it yourself. `/promptwheel:improve`
takes an attempt command from you (`--attempt "<the command you name>"`, for example an agent
invocation) and runs exactly that command in the repo to make the change it then gates; the plugin
composes no command of its own. The plugin registers no hooks and no mod.

**Files it writes.** Only inside the repo: `promptwheel.config.json` and a short block in
`AGENTS.md` / `CLAUDE.md` when you run `/promptwheel:setup` (`--no-agent-block` skips the block),
the outcome record `.promptwheel/outcomes.jsonl` (pass `--no-record` to skip), and, for the logbook
skill, the memory engine's cache of that repo's own git history (`events.jsonl`, `LOGBOOK.md`),
which includes the commit author names already in the git log.

**What it sends, and where.** Nothing. The check is deterministic and never calls a model or the
network; the only network traffic is npm fetching the packages. There is no telemetry.
