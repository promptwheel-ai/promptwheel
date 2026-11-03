---
description: Run an agent or shell command through PromptWheel's keep-if-improved loop - it gates the result and keeps the change only if a metric improved, otherwise reverts. Use to make a change that is automatically rolled back unless it provably helps.
arguments: "<the command/agent to run as the attempt, e.g. aider --message 'speed up the hot path'>"
allowed-tools: ["Bash(promptwheel:*)"]
---

Run one gated improvement attempt with PromptWheel.

1. Run via Bash: `promptwheel improve --attempt "$ARGUMENTS"`
2. If `promptwheel` is not found, stop and tell me to install the `promptwheel` package from npm globally; do not install it yourself.
3. Interpret the exit code (the loop contract, the same codes as `promptwheel run`):
   - **exit 0** - kept: a metric improved beyond noise; the change was committed.
   - **exit 1** - regression: a guarded metric regressed (or a mandate was violated); the change was reverted.
   - **exit 2** - GAMED: the metric only "improved" because the attempt edited a test, config, grader or golden file, not the source; the change was reverted. Do not retry the same edit to the test: fix the source so the win survives a source-only re-run.
   - **exit 3** - plateau or inconclusive: nothing moved beyond noise, or a guard was inert (its command never ran); the change was reverted. If inert, fix the metric command (or `setup` / `linkDirs` in `promptwheel.config.json`) before trying again.
   - **exit 64** - usage or config error (not a verdict): read the message, fix the config or flags.
4. Report which metrics moved and whether the change was kept or reverted.

To converge a loop, this can be repeated until it stops returning exit 0:
`while promptwheel improve --attempt "<cmd>"; do :; done`
