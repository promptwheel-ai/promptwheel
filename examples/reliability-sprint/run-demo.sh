#!/usr/bin/env bash
# Self-contained demo: builds a throwaway repo with 3 commits of a sample AI
# feature (v1 → improved v2 → a regression) and runs PromptWheel on it.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
PW="$(cd "$HERE/../.." && pwd)/bin/promptwheel.mjs"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
cp "$HERE"/{golden.json,eval.mjs,estimate-cost.mjs,bench.mjs,promptwheel.config.json} "$T"/
cd "$T"; git init -q; git config user.email d@d.d; git config user.name d
printf '.promptwheel/\n' > .gitignore
cp "$HERE/feature.v1.mjs" feature.mjs; git add -A; git commit -qm "v1: naive prompt"
cp "$HERE/feature.v2.mjs" feature.mjs; git commit -qam "v2: better prompt, cheaper"
cp "$HERE/feature.v3.mjs" feature.mjs; git commit -qam "v3: a 'helpful' edit that regresses"
echo "### PASS — v1 → v2 (improvement):"
node "$PW" run --base HEAD~2 --head HEAD~1 --repeat 3 || true
echo; echo "### FAIL — v2 → v3 (passes tests, drops quality):"
node "$PW" run --base HEAD~1 --head HEAD --repeat 3 || echo "(exit 1 — gate caught it ✓)"
