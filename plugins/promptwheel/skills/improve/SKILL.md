---
description: Run an agent or shell command through PromptWheel's keep-if-improved loop — it gates the result and keeps the change only if a metric improved, otherwise reverts. Use to make a change that is automatically rolled back unless it provably helps.
arguments: "<the command/agent to run as the attempt, e.g. aider --message 'speed up the hot path'>"
allowed-tools: ["Bash"]
---

Run one gated improvement attempt with PromptWheel.

1. Run via Bash: `promptwheel improve --attempt "$ARGUMENTS"`
2. If `promptwheel` is not found, tell me to install it (`npm install -g promptwheel`) and stop.
3. Interpret the exit code (the loop contract):
   - **exit 0** — kept: a metric improved beyond noise; the change was committed.
   - **exit 1** — regression: a guarded metric regressed; the change was reverted.
   - **exit 3** — plateau: nothing moved beyond noise; the change was reverted.
4. Report which metrics moved and whether the change was kept or reverted.

To converge a loop, this can be repeated until it stops returning exit 0:
`while promptwheel improve --attempt "<cmd>"; do :; done`
