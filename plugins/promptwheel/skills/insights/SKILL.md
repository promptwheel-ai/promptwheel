---
description: Summarize PromptWheel's accumulated outcome record — which metrics actually respond to changes in this repo (the loop's memory). Use to see what is worth optimizing.
allowed-tools: ["Bash"]
---

Show what PromptWheel has learned in this repo.

1. Run via Bash: `promptwheel insights`
2. If there is no outcome record yet, tell me to run the gate a few times first (`/promptwheel:gate`).
3. Report each metric's **lever score** (how reliably it improves when changed) and which metrics are highest-leverage — where an agent loop should spend its attempts.
