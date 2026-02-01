---
name: nudge
description: Send a hint to guide the current BlockSpool session
arguments:
  - name: hint
    description: The guidance text to inject into the next scout cycle
    required: true
---

Call the `blockspool_nudge` MCP tool with the provided hint text.

The hint will be consumed in the next scout cycle and appended to the scout prompt.
Examples: "focus on auth module", "skip test files", "look for SQL injection".
