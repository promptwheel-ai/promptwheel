#!/usr/bin/env bash
# PromptWheel stranger-corpus hardening sweep — TOOL-behavior data only.
# Per repo: clone → install → init → baseline gate → legit probe → cheat probe.
# Output: one JSON line per repo in corpus-results.jsonl (aggregate later).
set -u
PW=${PW:-$(dirname $0)/../bin/promptwheel.mjs}
WORK=${WORK:-/tmp/pw-corpus-10}
OUT=$WORK/corpus-results.jsonl
mkdir -p $WORK/repos
: > $OUT

# tool-behavior timeboxes: install 420s, each gate call 300s (a hang = a finding, not a wait)
TB_INSTALL=420; TB_GATE=300

run_gate() { # $1=dir $2=label $3...=args → echoes "exit|secs|verdict|firstflag"
  local d=$1; shift; local label=$1; shift
  local t0=$(date +%s)
  local out; out=$(cd "$d" && timeout $TB_GATE node $PW "$@" 2>&1); local code=$?
  local secs=$(( $(date +%s) - t0 ))
  local verdict=$(grep -oE 'VERDICT: [A-Z]+' <<<"$out" | head -1 | cut -d' ' -f2)
  [ $code -eq 124 ] && verdict=TIMEOUT
  local flag=$(grep -oE '(GUARD✗|GAMED)' <<<"$out" | head -1)
  echo "${code}|${secs}|${verdict:-none}|${flag:-none}"
  echo "--- $label (exit=$code, ${secs}s) ---" >> "$d/../$(basename $d).log"
  echo "$out" | tail -25 >> "$d/../$(basename $d).log"
}

json_escape() { sed 's/\\/\\\\/g; s/"/\\"/g' <<<"$1"; }

while read -r repo; do
  [ -z "$repo" ] && continue
  name=$(basename "$repo")
  d=$WORK/repos/$name
  echo "=== $repo ==="
  rm -rf "$d"
  if ! timeout 180 git clone -q --depth 1 "https://github.com/$repo" "$d" 2>/dev/null; then
    echo "{\"repo\":\"$repo\",\"stage\":\"clone\",\"ok\":false}" >> $OUT; continue
  fi
  git -C "$d" config user.email pw@corpus; git -C "$d" config user.name pw

  # --- install (detect package manager; a failed install is recorded, repo skipped)
  pm=none; inst_ok=true; t0=$(date +%s)
  if   [ -f "$d/pnpm-lock.yaml" ]; then pm=pnpm; (cd "$d" && timeout $TB_INSTALL npx -y pnpm@9 i --frozen-lockfile --ignore-scripts >/dev/null 2>&1) || (cd "$d" && timeout $TB_INSTALL npx -y pnpm@8 i --no-frozen-lockfile --ignore-scripts >/dev/null 2>&1) || inst_ok=false
  elif [ -f "$d/yarn.lock" ];      then pm=yarn; (cd "$d" && timeout $TB_INSTALL npx -y yarn@1 install --frozen-lockfile --ignore-scripts >/dev/null 2>&1) || inst_ok=false
  elif [ -f "$d/package.json" ];   then pm=npm;  (cd "$d" && timeout $TB_INSTALL npm i --ignore-scripts --no-audit --no-fund >/dev/null 2>&1) || inst_ok=false
  fi
  inst_secs=$(( $(date +%s) - t0 ))
  has_test_script=$(node -e "try{const p=require('$d/package.json');console.log(p.scripts&&p.scripts.test?'yes':'no')}catch{console.log('nopkg')}")

  # --- init
  init_out=$(cd "$d" && node $PW init 2>&1); init_code=$?
  git -C "$d" add -A >/dev/null 2>&1; git -C "$d" commit -qm pw-base >/dev/null 2>&1

  # --- NON_SOURCE false-sweep scan (static): source-looking paths classified non-source
  sweep=$(cd "$d" && node --input-type=module -e "
    import { isNonSource } from '$PW';
    import { execSync } from 'node:child_process';
    const files = execSync('git ls-files', {encoding:'utf8'}).split('\n').filter(Boolean);
    const sus = files.filter(f => /\.(ts|tsx|js|jsx|mjs)$/.test(f) && isNonSource(f)
      && !/(test|spec|mock|fixture|snap|golden|eval|grader|e2e|conftest)/i.test(f));
    console.log(JSON.stringify(sus.slice(0,5)));" 2>/dev/null || echo '[]')

  # --- baseline gate on a clean tree (fast no-op expected; hangs/junk = findings)
  base=$(run_gate "$d" baseline run --working --no-record)

  # --- probe 1: legit source edit (comment appended to a real source file) → expect no flag
  src=$(cd "$d" && git ls-files | grep -E '^(src|app|lib|packages)/.*\.(ts|tsx|js|mjs)$' | grep -vE '(test|spec|__|\.d\.ts)' | head -1)
  [ -z "$src" ] && src=$(cd "$d" && git ls-files | grep -E '\.(ts|js|mjs)$' | grep -vE '(test|spec|config)' | head -1)
  # legit probe = an untracked new file (linter-proof; also exercises the snapshot path)
  printf 'promptwheel corpus probe\n' > "$d/pw-corpus-probe.txt"
  legit=$(run_gate "$d" probe-legit run --working --no-record)
  rm -f "$d/pw-corpus-probe.txt"

  # --- probe 2: the cheat (suppression added to source) → expect tripwire FAIL (exit 1)
  cheat="skipped|0|none|none"
  if [ -n "$src" ]; then
    printf '\n// eslint-disable-next-line no-unused-vars\n' >> "$d/$src"
    cheat=$(run_gate "$d" probe-cheat run --working --no-record)
    git -C "$d" checkout -q -- . 2>/dev/null
  fi

  echo "{\"repo\":\"$repo\",\"pm\":\"$pm\",\"install_ok\":$inst_ok,\"install_secs\":$inst_secs,\"test_script\":\"$has_test_script\",\"init_exit\":$init_code,\"init_note\":\"$(json_escape "$(head -1 <<<"$init_out")")\",\"sweep_suspects\":$sweep,\"baseline\":\"$base\",\"probe_legit\":\"$legit\",\"probe_cheat\":\"$cheat\",\"src\":\"${src:-none}\"}" >> $OUT
done < $(dirname $0)/repos-10.txt
echo DONE
