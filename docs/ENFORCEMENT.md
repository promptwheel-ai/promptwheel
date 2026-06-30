# Enforcing `--detect-gaming` — making "the agent can't skip it" real

A check the agent *chooses* to run is a suggestion. **Enforcement** means: a `GAMED` verdict **mechanically blocks the thing the agent is trying to get** — a kept commit, a merge, a "done" — and the gate is run by **something the agent doesn't control.**

There are exactly three places to put it, ordered from softest to hardest. Use the loop or the hook for fast in-session feedback; use CI for the gate that genuinely can't be bypassed.

---

## 1. The `improve` loop — PromptWheel holds the commit (hardest for a loop you drive)

When you wrap an agent in `promptwheel improve`, **PromptWheel does the `git commit`, not the agent.** A gamed turn is reverted (`git reset --hard`) and the loop reports exit `1`. The change is *gone* — the agent never had the keys to the commit.

```bash
while promptwheel improve --attempt "$YOUR_AGENT_CMD" --detect-gaming; do :; done
#   exit 0 = kept a real win · 1 = regression OR gamed (reverted) · 3 = plateau (reverted)
```

This is the cleanest enforcement: nothing gamed can persist, because the thing that decides "keep or revert" is PromptWheel, not the thing being judged.

## 2. CI + branch protection — the hard backstop (can't be looped past)

The Action runs `--detect-gaming` on every PR; a `GAMED` verdict fails the check. Then a **branch-protection rule** makes that check a *merge requirement* — the merge button is disabled until it's green, and the PR author (human or agent) can't change the rule.

```yaml
# .github/workflows/promptwheel.yml  (the repo already ships action.yml)
name: PromptWheel
on: pull_request
permissions: { contents: read, pull-requests: write }
jobs:
  detect-gaming:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - run: npx promptwheel run --detect-gaming   # exit 2 = GAMED → check fails
```

Then in **Settings → Branches → Branch protection rules**: require the `PromptWheel` check to pass before merging (and "Include administrators" if you want it to bind you too). This runs on GitHub's servers — the agent has no access to the runner or the protection rule, so it's the layer that truly can't be skipped.

## 3. A Claude Code Stop-hook — the in-session nudge

Fires the instant the agent tries to finish a turn. On a gamed change it exits `2`, which tells Claude Code **not to let the agent stop** and feeds the reason back to the model, so it has to go fix the source. The script is tested and ships at [`plugins/promptwheel/hooks/detect-gaming-stop.sh`](../plugins/promptwheel/hooks/detect-gaming-stop.sh).

Wire it in `settings.json` (schema confirmed against the Claude Code hooks docs):

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          { "type": "command",
            "command": "${CLAUDE_PROJECT_DIR}/.claude/hooks/detect-gaming-stop.sh" }
        ]
      }
    ]
  }
}
```

- Copy the script to `.claude/hooks/detect-gaming-stop.sh` (commit it) and make it executable. `promptwheel` must be on `PATH` (`npm i -g promptwheel`) or set `PROMPTWHEEL="npx promptwheel"` in the script.
- **Where to put the hook config:** `~/.claude/settings.json` (your global user settings) is the version an in-repo agent **can't edit** — best for "can't disable." `.claude/settings.json` (committed) shares it with the team but the agent *could* edit the file; `.claude/settings.local.json` (gitignored) is local-only.
- **Loop safety:** the script reads stdin and bails out if `stop_hook_active` is already true, so it nudges once and won't trap the agent in an infinite block loop — CI (#2) is the hard stop if the agent keeps gaming.

It blocks a gamed turn, ignores honest work, and won't loop:

```
GAMED change, normal stop                 → exit 2  (blocked, reason sent to agent)
GAMED change, stop_hook_active already    → exit 0  (no infinite loop; CI is the backstop)
honest source fix                         → exit 0  (allowed)
```

---

## The honest caveat — protect the gate's own config (*quis custodiet*)

None of this is airtight if the agent's diff can edit the **gate itself** — the workflow file, `promptwheel.config.json`, the branch-protection rule, or the hook settings — to neuter the check. Mitigate it:

- Put gate files behind **CODEOWNERS** so changes to `.github/`, `promptwheel.config.json`, and `.claude/` require a *human* review.
- Keep the hook config in `~/.claude/settings.json` (outside the working repo), and rely on **CI + branch protection** as the layer the agent structurally cannot reach (it has no access to the runner or the repo settings).

## The threat model — why this is enough

Enforcement here isn't about stopping **you**: a human admin can always override their own gate, and should be able to. It's about stopping **the agent you delegated to, while you're not watching.** The agent didn't set up the gate, can't approve its own merge, and can't keep a reverted commit. Against *that* — an unattended or fast-moving loop silently faking a green — the gate holds. You're not policing yourself; you're policing the thing you handed the keyboard to.

> **Rule of thumb:** loop-revert for loops you drive · Stop-hook for live in-session feedback · **CI + branch protection for the gate that can't be bypassed.** Layer them.
