---
name: learnings
description: View, manage, or clear PromptWheel's cross-run learnings memory
---

PromptWheel remembers patterns from previous runs — what failed, what worked, and what to avoid. This skill lets you inspect and manage that memory.

## Arguments

Parse from `<args>` (optional):
- **view** (default) — Show current learnings with weight, category, and tags
- **clear** — Reset all learnings (start fresh)
- **stats** — Summary counts by category

## Implementation

### view (default)

1. Read `.promptwheel/learnings.json` from the project root.
2. If the file doesn't exist, tell the user: "No learnings yet. PromptWheel will start learning from your first session."
3. Parse the JSON array. Each entry has: `id`, `text`, `category`, `weight`, `tags`, `created_at`, `structured`.
4. Display learnings sorted by weight (highest first), grouped by category:

```
## Cross-Run Learnings (N total)

### Gotchas (N)
- [weight: 85] Plan rejected: file outside allowed paths — tags: path:src/auth
- [weight: 60] QA fails on auth module — TypeError: cannot read property... — tags: path:src/auth, cmd:npm test

### Patterns (N)
- [weight: 70] refactor succeeded: Extract shared validation — tags: path:src/utils

### Warnings (N)
- [weight: 45] Ticket failed on migration script — timeout after 30s — tags: path:src/db
```

5. If there are more than 20 learnings, show only the top 20 by weight and note: "Showing top 20 of N learnings."

### clear

1. Delete `.promptwheel/learnings.json` if it exists.
2. Confirm: "Learnings cleared. PromptWheel will start fresh on the next session."

### stats

1. Read `.promptwheel/learnings.json`.
2. Display summary:

```
## Learnings Stats

Total: N learnings
- gotcha: N (avg weight: X)
- pattern: N (avg weight: X)
- warning: N (avg weight: X)

Top tags: path:src/auth (5), cmd:npm test (3), path:src/utils (2)
Oldest: 2024-01-15, Newest: 2024-02-10
```
