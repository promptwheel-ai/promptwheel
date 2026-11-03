#!/usr/bin/env bash
# PromptWheel Stop-hook: block an agent from finishing a turn on a GAMED win.
# Wire it into settings.json (see docs/ENFORCEMENT.md). On a gamed change it exits 2,
# which tells Claude Code NOT to stop and feeds the reason back to the agent so it must
# fix the SOURCE. On honest work it exits 0. Zero deps. The agent can't vote.
# Gaming detection is on by default in `promptwheel run`, so no extra flag is needed.
input=$(cat 2>/dev/null)
# Safety: if we already blocked once this turn and Claude is re-prompting, don't loop forever.
# (CI + branch protection is the hard backstop; the hook is the in-session nudge.)
case "$input" in *'"stop_hook_active":true'*|*'"stop_hook_active": true'*) exit 0 ;; esac
PW="${PROMPTWHEEL:-promptwheel}"
out=$($PW run --working --no-record --json 2>/dev/null) || true
verdict=$(printf '%s' "$out" | grep -oE '"verdict": *"(pass|fail|gamed|inconclusive)"' | grep -oE 'pass|fail|gamed|inconclusive' | head -1)
if [ "$verdict" = "gamed" ]; then
  echo "PromptWheel: this turn's win survives only because tests/config/grader/golden were edited, not the source. Fix the SOURCE; do not move the goalposts." >&2
  exit 2
fi
exit 0
