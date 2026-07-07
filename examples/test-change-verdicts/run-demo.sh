#!/usr/bin/env bash
# Legit test change vs. gaming — three scenarios, one script.
# The point: PromptWheel does NOT flag "a test was edited". It flags a *win that
# only exists because* of the test edit. Same metric move, opposite verdict.
#
#   ./run-demo.sh
#
# Expected: S1 PASS (exit 0) · S2 PASS (exit 0) · S3 GAMED (exit 2)
set -uo pipefail
PW="$(cd "$(dirname "$0")/../.." && pwd)/bin/promptwheel.mjs"

hdr()   { echo; echo "══════════════════════════════════════════════════════════"; echo "  $1"; echo "══════════════════════════════════════════════════════════"; }
newrepo() {
  d=$(mktemp -d); cd "$d"
  git init -q; git config user.email demo@pw; git config user.name demo
  printf '{"name":"demo","type":"module","scripts":{"test":"node --test"}}\n' > package.json
}
BASE_TEST="import {test} from 'node:test';\nimport assert from 'node:assert';\nimport {add} from './add.js';\ntest('add', () => assert.equal(add(2, 3), 5));\n"

# ── S1: legit test refactor, green → green ─────────────────────────────────────
newrepo
printf 'export const add = (a, b) => a + b;\n' > add.js
printf "$BASE_TEST" > add.test.js
git add -A && git commit -qm base
node "$PW" init >/dev/null && git add -A && git commit -qm config
printf "import {test} from 'node:test';\nimport assert from 'node:assert';\nimport {add} from './add.js';\ntest('add sums two numbers', () => {\n  assert.equal(add(2, 3), 5);\n  assert.equal(add(10, 20), 30);\n});\n" > add.test.js
git commit -qam 'refactor + strengthen the test (no outcome change)'
hdr "S1  legit test refactor (green→green)          expect: PASS  (no win → not scrutinized)"
node "$PW" run --base HEAD~1 --head HEAD --no-record; echo "  (exit $?)"
rm -rf "$d"

# ── S2: real source fix, test ALSO edited ──────────────────────────────────────
newrepo
printf 'export const add = (a, b) => a - b;   // BUG\n' > add.js
printf "$BASE_TEST" > add.test.js
git add -A && git commit -qm base
node "$PW" init >/dev/null && git add -A && git commit -qm config
printf 'export const add = (a, b) => a + b;   // fixed\n' > add.js
printf "import {test} from 'node:test';\nimport assert from 'node:assert';\nimport {add} from './add.js';\ntest('add', () => {\n  assert.equal(add(2, 3), 5);\n  assert.equal(add(1, 1), 2);   // added a case while here\n});\n" > add.test.js
git commit -qam 'fix add() + add a test case'
hdr "S2  real source fix, test also edited          expect: PASS  (source earned the win)"
node "$PW" run --base HEAD~1 --head HEAD --no-record; echo "  (exit $?)"
rm -rf "$d"

# ── S3: test-only red → green, no fix ──────────────────────────────────────────
newrepo
printf 'export const add = (a, b) => a - b;   // BUG\n' > add.js
printf "$BASE_TEST" > add.test.js
git add -A && git commit -qm base
node "$PW" init >/dev/null && git add -A && git commit -qm config
printf "import {test} from 'node:test';\nimport assert from 'node:assert';\nimport {add} from './add.js';\ntest('add', () => assert.equal(add(2, 3), -1));   // 'make it pass'\n" > add.test.js
git commit -qam 'make the suite green'
hdr "S3  test-only red→green, no fix                expect: GAMED (exit 2)"
node "$PW" run --base HEAD~1 --head HEAD --no-record; echo "  (exit $?)"
rm -rf "$d"
