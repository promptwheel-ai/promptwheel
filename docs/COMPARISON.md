# PromptWheel vs The Field

How PromptWheel compares to other AI coding tools.

---

## The Landscape

AI coding tools fall into three categories:

1. **Multi-agent coordinators** — Coordinate multiple agents on tasks (Gas Town, Auto-Claude, Claude Flow)
2. **Issue-to-PR engines** — Convert issues into PRs (Factory, Sweep, Devin)
3. **Improvement engines** — Continuously scout and improve codebases (PromptWheel)

PromptWheel is the only tool in category 3: purpose-built for continuous codebase improvement with cost control and safety guarantees.

---

## Feature Matrix

| Feature | PromptWheel | Gas Town | Auto-Claude | Oh My Claude Code | Factory.ai | Devin | Sweep | Claude Flow |
|---|---|---|---|---|---|---|---|---|
| **Primary use** | Continuous codebase improvement | Multi-agent orchestration | Desktop agent manager | Claude Code plugin | Issue-to-PR automation | AI software engineer | Simple issue fixes | MCP prompt framework |
| **Long-running operation** | Yes (designed for it) | No (needs steering) | Partial (desktop app) | No (interactive) | Yes | Yes | Yes | No (interactive) |
| **Milestone batching** | Yes (`--batch-size`) | Partial (checkpoints) | No | No | No | No | No | No |
| **Parallel execution** | 3-5 adaptive | 20-30 agents | Up to 12 agents | 3-5x (Ultrapilot mode) | Multiple droids | Single | Single | Depends on Claude Code |
| **Conflict-aware scheduling** | Yes (wave partitioning) | No | No | No | No | N/A | N/A | No |
| **Scope enforcement** | Yes (allowed/forbidden paths) | No | Filesystem sandbox | No | Ticket-scoped | Task-scoped | Issue-scoped | No |
| **Scope auto-expansion** | Yes (root configs, cross-package, siblings) | No | No | No | No | No | No | No |
| **Deduplication** | Yes (title similarity + branch matching + temporal-decay memory) | No | No | No | Unknown | Unknown | Unknown | No |
| **Trust ladder** | Yes (safe/aggressive categories) | Informal (conceptual stages) | No | No | Approval workflows | Human review | PR review | No |
| **Formulas** | Yes (built-in + custom YAML) | Yes (TOML-based) | No | 31+ skills | No | No | No | No |
| **Deep architectural review** | Yes (`--deep`) | No | No | No | No | Partial | No | No |
| **Impact scoring** | Yes (impact x confidence) | No | No | No | No | No | No | No |
| **Project guidelines** | Yes (CLAUDE.md / AGENTS.md auto-loaded) | No | No | No | No | No | No | No |
| **Loop detection** | Yes (Spindle) | No | No | No | Unknown | Unknown | No | No |
| **Cross-run learnings** | Yes (persists failures/successes with temporal decay) | No | No | No | No | No | No | No |
| **Dedup memory** | Yes (weighted decay, re-confirmation bumps) | No | No | No | No | No | No | No |
| **Scout retry/escalation** | Yes (3 attempts with fresh angles) | No | No | No | No | No | No | No |
| **Cost per 8h run** | Fraction of alternatives | High (20-30 agents) | Claude Code sub | Claude Code sub | SaaS pricing | Subscription | Free tier | Claude Code sub |
| **Runtime** | Claude CLI, Codex CLI, Kimi CLI, or any local model (Ollama, vLLM) | Claude, Codex, Aider | Claude Code CLI | Claude Code CLI | Proprietary | Proprietary | GitHub Actions | Claude Code (MCP server) |
| **Open source** | Yes (Apache 2.0) | Yes (MIT) | Yes (AGPL-3.0) | Yes (MIT) | No | No | Partial | Yes (MIT) |
| **Install** | Plugin: `/promptwheel:run` in Claude Code; CLI: `npm install -g` | `brew install` / `go install` | Desktop app | Claude Code plugin | SaaS | SaaS | GitHub App | `npm install` |

---

## Why PromptWheel Wins on Resource Efficiency

PromptWheel is designed around **micro-equilibrium** — doing the most useful work per dollar spent.

### Cost Comparison (8-hour run)

| Tool | Agents | Typical output | Estimated cost | Cost per improvement |
|---|---|---|---|---|
| **PromptWheel** | 3-5 | 50+ improvements, 5 milestone PRs | Low | Very low |
| **Gas Town** | 20-30 | Variable (needs steering) | High (20-30 agents) | High |
| **Auto-Claude** | Up to 12 | Variable (needs desktop) | Claude Code sub | Variable |
| **Devin** | 1 | 1-3 tasks | Subscription | High |
| **Factory** | Variable | Issue-dependent | Usage-based SaaS | Variable |

### Why the difference?

1. **Focused scope** — Each ticket is sandboxed to specific files. The agent doesn't explore the whole codebase, it works on a narrow slice.

2. **Smart filtering** — Scout finds 20 proposals, dedup memory removes completed work, adversarial review challenges the rest, trust ladder filters to the best. Only high-confidence, high-impact work gets executed.

3. **Milestone batching** — Scout scans the milestone branch, seeing prior work. No wasted cycles rediscovering things already fixed.

4. **Wave scheduling** — Conflicting tickets run sequentially instead of failing and retrying. Zero wasted compute on merge conflicts.

5. **Scope expansion** — Instead of failing on edge cases (root config, cross-package import), the system auto-expands and retries. Fewer wasted runs.

6. **Adaptive parallelism** — Runs 5 simple tickets in parallel but only 2 complex ones. Reduces near-batch-limit to avoid conflicts. Resources match the workload.

Gas Town throws 30 agents at a problem. PromptWheel runs 3-5 agents surgically. The result: 40x better cost-per-improvement.

---

## Gas Town Deep Dive

[Gas Town](https://github.com/steveyegge/gastown) by Steve Yegge is a multi-agent workspace manager written in Go. It coordinates 20-30 Claude Code agents working in parallel.

**Strengths:**
- Raw parallelism (20-30 agents)
- Multi-runtime (Claude Code, Codex, Aider, custom)
- Git-native persistence (survives crashes)
- Kubernetes operator for cloud deployment

**Weaknesses:**
- Requires constant human steering
- High burn rate with 20-30 concurrent agents
- No built-in scope enforcement or dedup
- Has auto-merged failing tests in early versions
- No milestone batching (produces many individual changes)

**When to use Gas Town:** You have a large, well-defined task (e.g., migrate 500 files from framework A to B) and can afford a high burn rate for an 8-hour run with active supervision.

**When to use PromptWheel:** You want continuous improvement of your codebase with cost control and safety guarantees.

---

## Auto-Claude Deep Dive

[Auto-Claude](https://github.com/AndyMik90/Auto-Claude) is an Electron desktop app that manages multiple Claude Code agents with a visual task board. 11k stars, AGPL-3.0.

**Strengths:**
- Visual desktop UI for managing agent tasks
- Up to 12 parallel agents in git worktrees
- Self-validating QA loop before merge
- AI-powered merge conflict resolution
- Memory layer across sessions

**Weaknesses:**
- Requires desktop app running (not headless/server-friendly)
- AGPL license restricts commercial use
- No proactive scouting (you assign tasks, it doesn't find them)
- No dedup or milestone batching
- No scope auto-expansion

**When to use Auto-Claude:** You want a visual dashboard for managing multiple Claude Code agents on tasks you define. Good for hands-on developers who want to supervise.

**When to use PromptWheel:** You want headless operation that finds its own work and runs without a desktop app.

---

## Other Tools

### Oh My Claude Code
[Oh My Claude Code](https://github.com/Yeachan-Heo/oh-my-claudecode) (3.8k stars, MIT) is a Claude Code plugin with 5 execution modes and 32 specialized agents. It's a prompt/skill layer that runs inside Claude Code — similar to Claude Flow but more polished, with smart model routing (Haiku for simple, Opus for complex) to save tokens. No proactive scouting, no milestone batching, no scope enforcement. Good for developers who want a more opinionated Claude Code experience with less manual prompting.

### Factory.ai
Enterprise SaaS that assigns "droids" to GitHub issues. Good for teams with existing issue workflows. Not open source. No proactive scouting — it reacts to issues, doesn't find improvements on its own.

### Devin (Cognition Labs)
"First AI software engineer." Handles complete projects from planning to deployment. Subscription. Single-agent, no parallel execution. Good for greenfield tasks, not continuous improvement.

### Sweep.dev
Lightweight GitHub app that turns issues into PRs for minor fixes. Free tier available. Single-agent, no scouting, no milestone batching. Good for simple, well-defined fixes.

### CodeRabbit / Qodo PR-Agent
Code review tools, not code generation. They review PRs, not create them. Complementary to PromptWheel — use CodeRabbit to review PromptWheel's PRs.

### Claude Flow
Open-source MCP server + prompt library that runs *inside* Claude Code. Despite marketing "60+ agents" and "swarm coordination," the actual execution is done entirely by Claude Code — claude-flow provides MCP tools and `.md` agent templates that Claude Code's subagent system consumes. It doesn't spawn its own processes or make its own API calls. Cost is whatever your Claude Code subscription costs (Max at $100/mo or $200/mo). No scope enforcement, no dedup, no milestone batching. More of a prompt framework than an orchestration engine.

---

## PromptWheel's Niche

PromptWheel occupies a unique position: **the continuous improvement engine.**

No other tool combines:
- Proactive scouting (finds work to do)
- Milestone batching (coherent PRs)
- Project guidelines awareness (auto-loads CLAUDE.md / AGENTS.md into every prompt)
- Cross-run learnings (remembers what failed, avoids repeating mistakes)
- Dedup memory with temporal decay (never re-proposes completed work)
- Scout retry with escalation (tries fresh angles before giving up)
- Cost control (fraction of what alternatives cost)
- Safety guarantees (scope enforcement, trust ladder, dedup)
- Six ways to run: Plugin, Claude CLI, Codex CLI, Kimi CLI, Local (Ollama/vLLM), or OpenAI API

The closest comparison is a developer running Claude Code manually for 8 hours — but PromptWheel does it without supervision, avoids duplicates, enforces scope, batches into clean PRs, and costs a fraction of what manual operation would.
