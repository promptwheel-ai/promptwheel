# PromptWheel - Claude Code plugin

A thin wrapper around the [`promptwheel`](https://github.com/promptwheel-ai/promptwheel) CLI - *the trustworthy per-turn reward for AI coding loops* - that brings the outcome gate into Claude Code as slash commands.

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
| `/promptwheel:logbook` | `@promptwheel/logbook` (separate package) | read a repo's git history as agent memory: hotspots, do-not-retry reverts, suppressions, fragile areas |

No hooks are registered by the plugin. A Claude Code Stop-hook that blocks a GAMED turn ships as a copyable example at [`examples/detect-gaming-stop.sh`](../../examples/detect-gaming-stop.sh); wiring is in [`docs/ENFORCEMENT.md`](../../docs/ENFORCEMENT.md).

It's the **signal inside your loop, not the driver**: `/promptwheel:gate` after a change tells you whether the turn earned its keep - measured in throwaway worktrees, never touching your working tree, never failing on noise. Full model in the [main repo](https://github.com/promptwheel-ai/promptwheel).
