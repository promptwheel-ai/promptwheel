---
name: nudge
description: Send a hint to guide the current PromptWheel session
argument-hint: "<hint text>"
---

Call the `promptwheel_nudge` MCP tool with `$ARGUMENTS` as the hint text.

The hint will be consumed in the next scout cycle and appended to the scout prompt.
Examples: "focus on auth module", "skip test files", "look for SQL injection".
