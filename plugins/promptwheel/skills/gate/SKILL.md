---
description: Gate the current uncommitted changes through PromptWheel - prove they moved a metric without regressing another (the per-turn reward for an AI coding loop). Use after making a change that should improve a measurable outcome.
arguments: "[optional flags, e.g. --repeat 5]"
allowed-tools: ["Bash(promptwheel:*)"]
---

Run the PromptWheel outcome gate on the current uncommitted changes.

1. Run via Bash: `promptwheel run --working $ARGUMENTS`
2. If the command is not found, stop and tell me; I will set it up myself (promptwheel.com has the one line). Do not set it up for me.
3. If there is no `promptwheel.config.json` in the repo, run `promptwheel init` first (it detects the stack and writes a starter config), then re-run the gate.
4. Read the verdict (the exit code is the contract) and report concisely:
   - **PASS (exit 0)** - which metrics improved (plus any informational / within-noise ones).
   - **FAIL (exit 1)** - which *guarded* metric regressed beyond the noise band, and by how much; or which mandate (protected path) was touched. Revert the regression, or leave the protected path alone.
   - **GAMED (exit 2)** - the metric only "improved" because a test, config, grader or golden file was edited, not the source (the win does not survive a source-only re-run). Restore the test / config / grader to what it was and fix the SOURCE so the win is earned; never weaken, skip or delete a test to go green. If the test change really was intended (a wrong assertion, an obsolete test), say so and use `--allow "<reason>"` or a `Promptwheel-Allow: <reason>` commit trailer so the override is recorded.
   - **INCONCLUSIVE (exit 3)** - a guarded metric is inert (its command never ran, same value at both refs), so nothing was verified. Fix the metric command, or add `setup` / `linkDirs` in `promptwheel.config.json` so the command can run in a throwaway worktree, then re-run the gate.
   - **exit 64** - a usage or config error, not a verdict: read the message and fix `promptwheel.config.json` or the flags.
   - Flag any `inconclusive` metrics (delta inside the measurement noise - not trusted; suggest `--repeat N` to earn confidence), and any "gate definition changed" line (the config itself changed in this diff; review it with the code).

PromptWheel is the signal, not the driver - this tells you whether the change earned its keep; it never touches the working tree.
