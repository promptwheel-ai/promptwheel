# Vision

## The pivot (June 2026)

PromptWheel was an autonomous agent orchestrator (scout → scored tickets → parallel workers in worktrees → learnings loop). That product is **dead by commoditization**: in 2026 the base tools absorbed the entire orchestration layer —

- **Claude Code**: Dynamic Workflows (GA May 2026), subagents, background agents, ~26-event hooks, Plan mode, cloud Routines (cron/API/GitHub), an official `ralph-wiggum` loop plugin + `/loop`, and shallow Auto-Memory.
- **Cursor** (~$2B ARR): Background Agents + Bugbot.

Building any of that as a product = building next quarter's free base-tool feature. The casualties confirm it: Sweep pivoted off issue→PR, Continue was acqui-hired, Roo wound down. (Full landscape: `../explorations/research/agentic-landscape-2026.md`.)

## The surviving thesis

Two independent research passes converged on one unowned, durable niche: **outcome verification as a control signal.**

> Today *everyone* verifies "the diff applied / tests passed." **Nobody verifies "a real metric actually moved, without regression," and feeds that back as a reward.** Outcome data rots in dashboards (DORA, Swarmia) disconnected from the change that caused it.

This is the **keystone** — concretely, the **per-turn reward an agentic coding loop consumes** to keep improving instead of confidently drifting. A trustworthy per-change "did metric X improve without regressing Y" signal is also the prerequisite that makes the other two coveted capabilities *honest* —

- **Cross-run learning** is unproven without it (the one controlled coding-memory benchmark, Mar 2026, found memory saves tokens but does **not** improve quality).
- **Autonomous work-discovery** has no principled prioritization without an outcome signal to score against.

So PromptWheel builds the keystone first.

## The moat

The accumulated, per-repo record of **which change-types move which metrics** is a compounding asset the base vendor cannot replicate — it's specific to *your* codebase and *your* history. That record is also the reward stream a learning/discovery loop would later train on. Code is copyable; the outcome history is not.

## Positioning

**PromptWheel — the trustworthy per-turn reward for AI coding loops** (and the outcome gate for AI code in CI). Prove a turn moved a metric without regressing another.

- Audience: teams running AI changes in a loop (`/loop`, Ralph, agents) who can't tell improvement from churn (AI code ships ~1.7× more issues; the "feel 20% faster, are 19% slower" paradox).
- Wedge: the **cross-metric, noise-aware reward** a loop consumes — it composes single-axis gates (Codspeed/Bencher) into one "did X improve without regressing Y" verdict; in CI it fails a PR on a guarded regression beyond noise.
- Boundary (a feature, not a gap): it is for **graded numeric outcomes**; a change with no number is correctly out of scope, and it is the *signal*, never the loop driver.

## Business model — open-core

- **OSS (MIT):** the CLI + the GitHub Action / PR-comment wrapper. This is the distribution engine; adoption is the strategy.
- **Paid (later):** hosted **cross-repo intelligence** + dashboards over the accumulated outcome record — "your agents improved p95 in 3 repos this month; here's what change-types reliably help." Never bake this into the core.

## The honest risk

The window is **narrow and closing** — Anthropic's Auto-Memory + Routines are creeping toward this, and an ACE-grade native memory/outcome feature would shut it. Viability requires three things, in this order: **ship now**, **stay radically thin** (ride the platform), and **demonstrably compound** (prove the outcome record makes an agent loop measurably better). If we can't show compounding, this is a feature, not a company — and that's an acceptable outcome to learn fast.
