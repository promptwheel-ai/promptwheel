---
name: cancel
description: Cancel the current PromptWheel session gracefully
---

1. Call `promptwheel_ingest_event` with type `USER_OVERRIDE` and payload `{ "cancel": true }`.
2. Call `promptwheel_end_session` to finalize.
3. Delete `.promptwheel/loop-state.json` to release the Stop hook.
4. Delete `.promptwheel/scope-policy.json` to clear cached scope policy.

Display the session summary including tickets completed and any in-progress work.
