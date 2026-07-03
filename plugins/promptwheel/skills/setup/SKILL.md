---
description: Initialize PromptWheel in this repository — detect the stack and write a starter promptwheel.config.json so the outcome gate can run. Use the first time PromptWheel is set up in a repo.
arguments: "[optional --preset <name> | --list]"
allowed-tools: ["Bash"]
---

Set up PromptWheel for this repo.

1. Run via Bash: `promptwheel init $ARGUMENTS`
   - no args: detects the stack (npm / go / pyproject / cargo) and writes a guarded test metric + the antihack tripwires (+ lint when eslint is set up).
   - `--list`: show available presets (`tests-pass`, `lint`, `bundle-size`, `llm-eval`, `antihack`).
   - `--preset <name>`: write a specific preset.
2. If `promptwheel` is not found, tell me to install it (`npm install -g promptwheel`) and stop.
3. **Propose repo-specific metrics** (you are the discovery layer — the engine stays LLM-free): inspect the repo and suggest additions to the generated config, e.g. a build → `bundle_kb` (`du -sk dist | cut -f1`), an eval script → `eval_pass_rate` (guarded, `direction: up`), coverage tooling → a coverage regex metric, a perf script → `p95_ms` (info until `--repeat` establishes noise). Show the candidate JSON; only apply what I approve. Every metric must be a deterministic shell command — you propose, execution decides forever after.
4. Offer to seed the record: `promptwheel backfill -n 30` replays recent commits through the metrics (cohort-tagged `backfill`, conventional-commit types become labels) so `playbook`/`suggest`/`insights` are useful immediately instead of starting empty.
5. Show the resulting `promptwheel.config.json`, then suggest the next step: `/promptwheel:gate`.
