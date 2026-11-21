#!/usr/bin/env bash
# The downhill walk, and the floor that stops it.
#
# A score with a noise band of 10, and a proposer that makes the same trade every time: 10 off
# the cost for 5 off the score. Each step sits inside the band, so each one passes the gate on
# its own. Four steps later the score is 20 down. With --floor the loop also holds each change
# against the best score so far, and stops the walk at the edge of the band.
#
# It also counts how often the scorer is asked, with and without --base-cache.
#
#   ./run-demo.sh      # from a clone; uses the local bin/promptwheel.mjs
#
# No model is called and nothing outside a temp folder is touched. This shows the mechanics. It
# does not show that a loop makes anything better over time.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
WORK=$(mktemp -d "${TMPDIR:-/tmp}/improve-loop.XXXXXX") || { echo "could not make a temp folder, so nothing was run" >&2; exit 1; }
[ -n "$WORK" ] && [ -d "$WORK" ] || { echo "could not make a temp folder, so nothing was run" >&2; exit 1; }
trap 'rm -rf "$WORK"' EXIT

# the proposer: the same trade every time. It lives outside the repo.
cat > "$WORK/cut.sh" <<'EOF'
s=$(cat src/score.txt); c=$(cat src/cost.txt)
echo $(( s - 5 )) > src/score.txt; echo $(( c - 10 )) > src/cost.txt
EOF

build() {   # a fresh repo: score 100, cost 100, a band of 10 on the score
  rm -rf "$WORK/repo" "$WORK/asked" "$WORK/kept"; mkdir -p "$WORK/repo/src" && cd "$WORK/repo" || exit 1
  git init -q -b main . && git config user.email demo@example.com && git config user.name demo
  echo 100 > src/score.txt; echo 100 > src/cost.txt
  cat > promptwheel.config.json <<EOF
{
  "metrics": [
    { "name": "score", "cmd": "echo x >> $WORK/asked; cat src/score.txt", "extract": "number", "direction": "up", "guard": true, "noise": 10 },
    { "name": "cost", "cmd": "cat src/cost.txt", "extract": "number", "direction": "down", "guard": true }
  ],
  "evaluatorPaths": ["promptwheel.config.json"]
}
EOF
  git add -A && git commit -q -m "start: score 100, cost 100"
}

walk() {   # four tries of the same trade; the words after the name are extra flags for the step
  local name=$1; shift
  build
  echo "$name"
  for i in 1 2 3 4; do node "$HERE/improve.mjs" --attempt "sh $WORK/cut.sh" --label "cut $i (5 off the score, 10 off the cost)" --target score --cheaper cost "$@"; done
  echo "    ends at: score $(cat src/score.txt), cost $(cat src/cost.txt). The scorer was asked $(wc -l < "$WORK/asked" | tr -d ' ') times."
  echo
}

walk "Without a floor:"
walk "With --floor:" --floor
walk "With --floor and --base-cache:" --floor --base-cache "$WORK/kept"
