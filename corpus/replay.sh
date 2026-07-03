#!/usr/bin/env bash
# Usage replay — real commits through the gate, as a user would run it.
# Every FAIL/GAMED on an honest merged commit is a presumptive false positive.
set -u
PW=${PW:-$(dirname $0)/../bin/promptwheel.mjs}
W=${W:-/tmp/pw-replay}
GO_BIN=${GO_BIN:-$(dirname $(command -v go 2>/dev/null) 2>/dev/null)}
TB_GATE=300; N_COMMITS=6
mkdir -p $W/repos $W/results $W/logs

run_one() {
  local lang=$1 repo=$2
  local name=$(sed 's|/|__|' <<<"$repo")
  local d=$W/repos/$name out=$W/results/$name.jsonl
  rm -rf "$d"; : > "$out"
  timeout 300 git clone -q --depth 50 "https://github.com/$repo" "$d" 2>/dev/null || { echo "{\"repo\":\"$repo\",\"stage\":\"clone\",\"ok\":false}" > "$out"; return; }
  git -C "$d" config user.email pw@replay; git -C "$d" config user.name pw

  local xp="" inst=true
  case $lang in
    ts|js|next)
      if   [ -f "$d/pnpm-lock.yaml" ]; then
        (cd "$d" && timeout 480 npx -y pnpm@9 i --frozen-lockfile --ignore-scripts >/dev/null 2>&1) \
        || (cd "$d" && timeout 480 npx -y pnpm@8 i --no-frozen-lockfile --ignore-scripts >/dev/null 2>&1) || inst=false
      elif [ -f "$d/yarn.lock" ]; then
        (cd "$d" && timeout 480 npx -y yarn@1 install --frozen-lockfile --ignore-scripts >/dev/null 2>&1) || inst=false
      elif [ -f "$d/package.json" ]; then
        (cd "$d" && timeout 480 npm i --ignore-scripts --no-audit --no-fund >/dev/null 2>&1) || inst=false
      fi ;;
    py)
      (cd "$d" && timeout 480 python3 -m venv .venv >/dev/null 2>&1 \
        && { .venv/bin/pip -q install -e . pytest >/dev/null 2>&1 || .venv/bin/pip -q install pytest >/dev/null 2>&1; }) || inst=false
      xp="$d/.venv/bin:" ;;
    go) xp="$GO_BIN:" ;;
  esac
  $inst || { echo "{\"repo\":\"$repo\",\"stage\":\"install\",\"ok\":false}" > "$out"; rm -rf "$d"; return; }

  (cd "$d" && PATH="$xp$PATH" node $PW init >/dev/null 2>&1)
  git -C "$d" add -A >/dev/null 2>&1; git -C "$d" commit -qm pw-config >/dev/null 2>&1

  # replay the most recent real (non-merge) commits, newest first, skipping our config commit
  for c in $(git -C "$d" rev-list --no-merges -n $N_COMMITS --skip=1 HEAD); do
    local t0=$(date +%s)
    local o; o=$(cd "$d" && PATH="$xp$PATH" timeout $TB_GATE node $PW run --base "$c~1" --head "$c" --no-record 2>&1); local code=$?
    local secs=$(( $(date +%s) - t0 ))
    local verdict=$(grep -oE 'VERDICT: [A-Z]+' <<<"$o" | head -1 | cut -d' ' -f2); [ $code -eq 124 ] && verdict=TIMEOUT
    local failed=$(grep 'GUARD✗' <<<"$o" | awk '{print $2}' | paste -sd, -)
    local gamed=no; grep -q '🚩 GAMED' <<<"$o" && gamed=yes
    local apfail=no; grep -q 'did not apply cleanly' <<<"$o" && apfail=yes
    local inert=no; grep -q 'never passed at either ref' <<<"$o" && inert=yes
    echo "{\"repo\":\"$repo\",\"lang\":\"$lang\",\"commit\":\"${c:0:8}\",\"exit\":$code,\"secs\":$secs,\"verdict\":\"${verdict:-none}\",\"failed_guards\":\"${failed:-}\",\"gamed\":\"$gamed\",\"apply_failed\":\"$apfail\",\"inert\":\"$inert\"}" >> "$out"
    { echo "=== $c (exit=$code, ${secs}s)"; tail -15 <<<"$o"; } >> "$W/logs/$name.log"
  done
  rm -rf "$d"
}

if [ "${1:-}" = one ]; then run_one "$2" "$3"; exit 0; fi
xargs -P 5 -n 2 bash "$0" one < $(dirname $0)/replay-live-repos.txt
cat $W/results/*.jsonl > $W/replay-results.jsonl
echo "DONE $(wc -l < $W/replay-results.jsonl) commit-gates"
