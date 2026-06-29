---
description: Gate the current uncommitted changes through PromptWheel — prove they moved a metric without regressing another (the per-turn reward for an AI coding loop). Use after making a change that should improve a measurable outcome.
arguments: "[optional flags, e.g. --repeat 5]"
allowed-tools: ["Bash"]
---

Run the PromptWheel outcome gate on the current uncommitted changes.

1. Run via Bash: `promptwheel run --working $ARGUMENTS`
2. If the command is not found, tell me to install it first (`npm install -g promptwheel`), then stop.
3. If there is no `promptwheel.config.json` in the repo, run `promptwheel init` first (it detects the stack and writes a starter config), then re-run the gate.
4. Read the verdict and report concisely:
   - **PASS** — which metrics improved (plus any informational / within-noise ones).
   - **FAIL** — which *guarded* metric regressed beyond the noise band, and by how much.
   - Flag any `inconclusive` metrics (delta inside the measurement noise — not trusted; suggest `--repeat N` to earn confidence).

PromptWheel is the signal, not the driver — this tells you whether the change earned its keep; it never touches the working tree.
