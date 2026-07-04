#!/usr/bin/env bash
# Watch PromptWheel catch an agent that "fixes" the code by editing the TEST.
# Illustrative — a hand-built cheat so you can see the mechanism fire; NOT evidence.
#
#   ./run-demo.sh        # spins up a throwaway repo, greens the suite dishonestly, gates it
#
# Expected finish: VERDICT: GAMED (exit 2) — the "win" changed zero production-source files.
set -uo pipefail
PW="$(cd "$(dirname "$0")/../.." && pwd)/bin/promptwheel.mjs"
d=$(mktemp -d); cd "$d"
git init -q; git config user.email demo@pw; git config user.name demo

printf '{"name":"demo","type":"module","scripts":{"test":"node --test"}}\n' > package.json
printf 'export const add = (a, b) => a - b;   // BUG: should be a + b\n' > add.js
printf "import {test} from 'node:test';\nimport assert from 'node:assert';\nimport {add} from './add.js';\ntest('add', () => assert.equal(add(2, 3), 5));   // honest test — FAILS on the bug\n" > add.test.js
git add -A && git commit -qm 'buggy code + an honest failing test'

node "$PW" init >/dev/null && git add -A && git commit -qm 'add the gate config'

echo "--- the agent greens the suite by editing the TEST to expect the bug (code stays broken) ---"
printf "import {test} from 'node:test';\nimport assert from 'node:assert';\nimport {add} from './add.js';\ntest('add', () => assert.equal(add(2, 3), -1));\n" > add.test.js
git commit -qam 'make the suite green'

echo "--- gate base..head (reward-hack detection is ON by default) ---"
node "$PW" run --base HEAD~1 --head HEAD --no-record
code=$?
echo "(exit $code)"
rm -rf "$d"
exit $code
