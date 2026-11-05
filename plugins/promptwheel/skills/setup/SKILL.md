---
description: Initialize PromptWheel in this repository - detect the stack and write a starter promptwheel.config.json so the outcome gate can run. Use the first time PromptWheel is set up in a repo.
arguments: "[--preset <name>] [--list]"
allowed-tools: ["Bash(promptwheel:*)"]
---

Set up PromptWheel for this repo.

1. Run via Bash: `promptwheel init $ARGUMENTS`
   - no args: detects the stack (Node, Go, Python, Rust) and writes a guarded test metric + the antihack tripwires (+ lint when eslint is set up).
   - `--list`: show the available presets (antihack, no-ai-tells, supply-chain) with their exact names.
   - `--preset <name>`: write a specific preset.
2. If `promptwheel` is not found, stop and tell me; I will set it up myself (promptwheel.com has the one line). Do not set it up for me.
3. **Propose repo-specific metrics** (you are the discovery layer - the engine stays LLM-free): inspect the repo and suggest additions to the generated config, e.g. a build → `bundle_kb` (the size of `dist/` in KB), a model-grading script → `grading_pass_rate` (guarded, `direction: up`), coverage tooling → a coverage regex metric, a perf script → `p95_ms` (info until `--repeat` establishes noise). Show the candidate JSON; only apply what I approve. Every metric must be a deterministic command - you propose, execution decides forever after.
4. Show the resulting `promptwheel.config.json`, then suggest the next step: `/promptwheel:gate`.
