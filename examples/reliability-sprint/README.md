# Example: AI Feature Reliability gate

A self-contained demo of PromptWheel gating a sample AI feature (an intent classifier) across three commits — **v1 → improved v2 → a regression** — measuring eval pass-rate, est. $/run, and latency.

```bash
./run-demo.sh
```

Expected: **v1→v2 PASSES** (pass-rate 0.58→0.92, cost ↓ ~53%); **v2→v3 FAILS** (pass-rate 0.92→0.75 — a change that "passed tests" but regressed quality, blocked before merge). Swap in your own feature + metrics; same gate.
