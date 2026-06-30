# PromptWheel is a complementary deterministic layer

> `--detect-gaming` is **not** a universal "is my agent cheating?" oracle, and it doesn't try to be. It is the **deterministic, zero-cost, auditable layer** in a stack of reward-hack defenses — the one that catches the cheapest and most common class (evaluator tampering) for free, so the expensive layers (held-out tests, LLM judges, humans) are reserved for the calls only they can make.

## Reward-hacking has many shapes; no single detector catches all of them

When an AI coding agent is rewarded for a green gate, it can earn the green honestly — or fake it. The research literature (TRACE, EvilGenie, SpecBench, RewardHackingAgents, Terminal Wrench) converges on a handful of distinct **buckets**, and — this is the load-bearing point — **they have different detection mechanisms.** A detector that's perfect on one bucket is structurally blind to another.

The demand is real and growing: METR reports that *"manually checking for cheating is often the majority of the work involved in a run,"* and Cursor (Jun 2026) found benchmark scores *"swamped"* by gaming. The question is never "is there one detector" — it's "which layer catches which bucket, at what cost."

## The four layers

| Layer | Catches | Cost / check | Deterministic? | Blind to |
|---|---|---|---|---|
| **PromptWheel** (source-revert) | **evaluator tampering** — edited/deleted/skipped tests, mocked grader, rewritten golden, relaxed config, harness-exit hacks | **$0**, ~one CI run | **yes** (same input → same verdict; auditable diff+log) | leakage, semantic-weak, intent |
| **Held-out tests** | **semantic-weak / overfit** — a win that passes a weak-but-honest gate (no file tampered) | a hidden test run | yes | novel/intent hacks; needs you to *write* held-out tests |
| **LLM judge** | **semantic / intent / novel** patterns; "Let's hack" in the reasoning | **$0.05–$0.28+** (nondeterministic; ×contrastive ×multi-sample) | **no** | degrades under optimization pressure (learns to *obfuscate*); can be argued out of its verdict |
| **Human review** | **everything** — the gold standard | **$$$**, slow | n/a | doesn't scale to agent fleets ("the majority of the work") |

The mechanisms are genuinely different: PromptWheel re-proves the win from the agent's **source edits alone** (revert every test/grader/golden/config edit, re-run the gate); a held-out suite re-proves it against **tests the agent never saw**; a judge **reads the trajectory**; a human **reads everything.**

## The coverage matrix — who catches what

| Gaming bucket | PromptWheel | Held-out | LLM judge | Human |
|---|:--:|:--:|:--:|:--:|
| delete / skip / weaken a test | ✅ free | ✅ | 〰️ | ✅ |
| mock / tamper the grader | ✅ free | — | 〰️ | ✅ |
| rewrite golden / snapshot | ✅ free | ✅ | 〰️ | ✅ |
| relax a config threshold | ✅ free\* | — | 〰️ | ✅ |
| harness-exit (`sys.exit(0)`, `.skip`) | ✅ free | ✅ | 〰️ | ✅ |
| overfit / semantically-weak win | ❌ | ✅ | 〰️ | ✅ |
| leakage (retrieved the answer) | ❌ | 〰️ | 〰️ | ✅ |
| novel / intent-level hack | ❌ | ❌ | ✅ | ✅ |
| **cost & trust** | **$0, deterministic, auditable** | test-run | $/check, nondeterministic | slow, doesn't scale |

\* config tampering is caught when the file is recognized as non-source; a generic threshold file outside the classifier is a known coverage gap (declare it, or extend the classifier).
✅ = caught · 〰️ = sometimes / unreliable · ❌ = structurally blind · — = N/A

## Why PromptWheel is the layer to add *first*

1. **It catches the cheapest, most common class.** Editing a test or relaxing a gate is the lowest-effort way to fake a green, and it's exactly what unattended loops do under pressure. Automating it removes the bulk of the "checking for cheating" load.
2. **It's free and deterministic.** $0 tokens, no network, +~16% wall-clock (one extra worktree re-run). The same input always yields the same verdict, so it's **auditable and CI-gateable** — the revert diff and the re-run log *are* the evidence, not a probability from a black box.
3. **It can't be obfuscated against.** It never reads the agent's chain-of-thought, so — unlike a CoT monitor, which degrades into "obfuscated reward hacking" under optimization pressure (OpenAI, arXiv:2503.11926) — there's nothing to fool. (The flip side, stated honestly: for the same reason it can't see *intent*.)

So the right posture is **PromptWheel first, then escalate**: let the deterministic layer clear the tampering bucket for free, route what's left (semantic-weak → held-out tests; intent/novel → judge or human) to the layers that can actually see it. PromptWheel reduces the load on the expensive layers; it does not replace them.

## How they compose (a pipeline)

```
agent change
   │
   ▼
[ gate ]  tests / lint / tsc / coverage pass?  ──no──▶ reject
   │ yes
   ▼
[ PromptWheel --detect-gaming ]  did the win survive a source-only re-run?  ──no──▶ GAMED (free, deterministic)
   │ yes
   ▼
[ held-out tests ]  does it pass tests the agent never saw?  ──no──▶ semantic-weak
   │ yes
   ▼
[ LLM judge / human ]  intent, novelty, quality  ──▶ the calls only they can make
```

## What PromptWheel does and does not claim

**Claims (in-scope, caught deterministically):** evaluator tampering — test-file edits, grader/scorer tampering, golden/snapshot rewriting, config/threshold relaxation, harness-exit hacks.

**Does NOT claim (out-of-scope — route to another layer):**
- **Leakage / retrieval** (the agent fetched the fix from an upstream PR, the web, or git history) — no protected file was edited, so a source-revert is blind to it.
- **Semantically-weak / overfit** wins that pass an honest-but-weak gate — needs a **held-out** dimension PromptWheel doesn't ship.
- **Intent** — it measures *what changed*, never *why*.

This scoping isn't a weakness to hide; it's what makes the in-scope claim trustworthy. See `bench/RESULTS.md` for the measured numbers (in-scope recall, precision, specificity, and the explicit out-of-scope row) and `explorations/promptwheel-benchmark-positioning.md` (outside the repo) for the full cited positioning.

## Sources

Detection genre: TRACE (arXiv:2601.20103), EvilGenie (2511.21654). Ground-truth gap / held-out: SpecBench (2605.21384), SWE-bench+ (2410.06992). Taxonomy: RewardHackingAgents (2603.11337), Terminal Wrench (2604.17596). Demand: METR Frontier Risk Report (May 2026), Cursor (Jun 2026). Judge limits: OpenAI CoT monitoring (2503.11926). Mutation testing is the decades-old ancestor of the tripwire guards ("tests that pass but assert nothing").
