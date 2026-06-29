---
description: Initialize PromptWheel in this repository — detect the stack and write a starter promptwheel.config.json so the outcome gate can run. Use the first time PromptWheel is set up in a repo.
arguments: "[optional --preset <name> | --list]"
allowed-tools: ["Bash"]
---

Set up PromptWheel for this repo.

1. Run via Bash: `promptwheel init $ARGUMENTS`
   - no args: detects the stack (npm / go / pyproject / cargo) and writes a guarded test metric + lint.
   - `--list`: show available presets (`tests-pass`, `lint`, `bundle-size`, `llm-eval`).
   - `--preset <name>`: write a specific preset.
2. If `promptwheel` is not found, tell me to install it (`npm install -g promptwheel`) and stop.
3. Show the resulting `promptwheel.config.json`, then suggest the next step: `/promptwheel:gate`.
