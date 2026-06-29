# PromptWheel — Claude Code plugin

A thin wrapper around the [`promptwheel`](https://github.com/promptwheel-ai/promptwheel) CLI — *the trustworthy per-turn reward for AI coding loops* — that brings the outcome gate into Claude Code as slash commands.

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

## Commands

| command | wraps | what it does |
|---|---|---|
| `/promptwheel:setup` | `promptwheel init` | detect the stack, write a starter config |
| `/promptwheel:gate` | `promptwheel run --working` | gate uncommitted changes (the reward signal) |
| `/promptwheel:improve <cmd>` | `promptwheel improve --attempt "<cmd>"` | keep a change only if a metric improved, else revert |
| `/promptwheel:insights` | `promptwheel insights` | which metrics actually respond (loop memory) |

It's the **signal inside your loop, not the driver**: `/promptwheel:gate` after a change tells you whether the turn earned its keep — measured in throwaway worktrees, never touching your working tree, never failing on noise. Full model in the [main repo](https://github.com/promptwheel-ai/promptwheel).
