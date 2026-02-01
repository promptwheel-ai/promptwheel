---
name: cancel
description: Cancel the current BlockSpool session gracefully
---

1. Call `blockspool_ingest_event` with type `USER_OVERRIDE` and payload `{ "cancel": true }`.
2. Call `blockspool_end_session` to finalize.
3. Delete `.blockspool/loop-state.json` to release the Stop hook.
4. Delete `.blockspool/scope-policy.json` to clear cached scope policy.

Display the session summary including tickets completed and any in-progress work.
