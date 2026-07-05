#!/usr/bin/env bash
# PromptWheel 100-repo distribution sweep (v2). TOOL-behavior data only.
# Probes per repo: baseline (clean) · break (syntax error in source — does the gate SEE it?)
#                  · cheat (per-language suppression — do tripwires fire?)
set -u
PW=${PW:-$(cd "$(dirname "$0")/../bin" && pwd)/promptwheel.mjs}  # absolute: run_gate cd's into the repo before using it
W=${W:-/tmp/pw-corpus-100}
GO_BIN=${GO_BIN:-$(dirname $(command -v go 2>/dev/null) 2>/dev/null)}
TB_CLONE=240; TB_INSTALL=480; TB_GATE=240
mkdir -p $W/repos $W/results $W/logs

run_gate() { # $1=dir $2=extra_path $3=label; echoes "exit|secs|verdict|flag|inert"
  local d=$1 xp=$2 label=$3
  local t0=$(date +%s)
  local out; out=$(cd "$d" && PATH="$xp$PATH" timeout $TB_GATE node $PW run --working --no-record 2>&1); local code=$?
  local secs=$(( $(date +%s) - t0 ))
  local verdict=$(grep -oE 'VERDICT: [A-Z]+' <<<"$out" | head -1 | cut -d' ' -f2)
  [ $code -eq 124 ] && verdict=TIMEOUT
  local flag=$(grep -oE '(GUARD✗|GAMED)' <<<"$out" | head -1)
  local inert=no; grep -q 'never passed at either ref' <<<"$out" && inert=yes
  echo "${code}|${secs}|${verdict:-none}|${flag:-none}|${inert}"
  { echo "--- $label (exit=$code, ${secs}s) ---"; tail -20 <<<"$out"; } >> "$W/logs/$(basename $d).log"
}

pick_src() { # $1=dir $2=lang — a REAL production source file the suite imports (never a dep / example / test)
  cd "$1" || return
  # exclude dependency/build dirs AND any dir segment that looks like test/example/demo/fixture —
  # else the break probe lands in code the suite never imports and reads as a false "miss".
  local DEP='(^|/)(\.venv|venv|node_modules|target|dist|build|vendor|__pycache__|docs?|scripts?)/|(^|/)[^/]*(test|e2e|example|demo|sample|fixture|mock|bench)[^/]*/'
  case $2 in
    py)   git ls-files '*.py' | grep -vE '(^|/)(conftest|setup)\.py$' | grep -vEi "$DEP" | head -1 ;;
    go)   git ls-files '*.go' | grep -v '_test.go' | grep -vEi "$DEP" | head -1 ;;
    rs)   { git ls-files 'src/lib.rs'; git ls-files 'src/main.rs'; git ls-files '*.rs'; } | grep -vEi "$DEP" | head -1 ;;
    *)    { git ls-files | grep -E '^(src|lib|packages)/.*\.(ts|tsx|js|mjs|cjs)$'; \
            git ls-files | grep -E '^app/.*\.(ts|tsx|js|mjs|cjs)$'; \
            git ls-files | grep -E '\.(ts|js|mjs)$'; } \
            | grep -vE '(spec|\.d\.ts|config)' | grep -vEi "$DEP" | head -1 ;;
  esac
}

run_one() {
  local lang=$1 repo=$2
  local name=$(sed 's|/|__|' <<<"$repo")
  local d=$W/repos/$name out=$W/results/$name.json
  rm -rf "$d"
  if ! timeout $TB_CLONE git clone -q --depth 1 "https://github.com/$repo" "$d" 2>/dev/null; then
    echo "{\"repo\":\"$repo\",\"lang\":\"$lang\",\"stage\":\"clone\",\"ok\":false}" > "$out"; return
  fi
  git -C "$d" config user.email pw@corpus; git -C "$d" config user.name pw

  # ---- install + PATH per language
  local xp="" pm=none inst=true t0=$(date +%s)
  case $lang in
    ts|js|next)
      if   [ -f "$d/pnpm-lock.yaml" ]; then pm=pnpm
        (cd "$d" && timeout $TB_INSTALL npx -y pnpm@9 i --frozen-lockfile --ignore-scripts >/dev/null 2>&1) \
        || (cd "$d" && timeout $TB_INSTALL npx -y pnpm@8 i --no-frozen-lockfile --ignore-scripts >/dev/null 2>&1) || inst=false
      elif [ -f "$d/yarn.lock" ]; then pm=yarn
        (cd "$d" && timeout $TB_INSTALL npx -y yarn@1 install --frozen-lockfile --ignore-scripts >/dev/null 2>&1) || inst=false
      elif [ -f "$d/package.json" ]; then pm=npm
        (cd "$d" && timeout $TB_INSTALL npm i --ignore-scripts --no-audit --no-fund >/dev/null 2>&1) || inst=false
      fi ;;
    py) pm=pip
      (cd "$d" && python3 -m venv .venv >/dev/null 2>&1 && timeout $TB_INSTALL bash -c '
          pip=.venv/bin/pip
          # install the package WITH its test extras + any dev/test requirement files, so test-only
          # deps (pytest plugins, click, …) are present — else the suite errors on import and the
          # gate reads inert (measuring the TOOL fairly needs the suite to actually run).
          $pip -q install -e ".[test]" pytest >/dev/null 2>&1 \
            || $pip -q install -e ".[tests]" pytest >/dev/null 2>&1 \
            || $pip -q install -e ".[dev]" pytest >/dev/null 2>&1 \
            || $pip -q install -e . pytest >/dev/null 2>&1 \
            || { [ -f requirements.txt ] && $pip -q install -r requirements.txt pytest >/dev/null 2>&1; } \
            || $pip -q install pytest >/dev/null 2>&1
          for rf in requirements-dev.txt requirements-test.txt test-requirements.txt dev-requirements.txt requirements/dev.txt requirements/test.txt; do
            [ -f "$rf" ] && $pip -q install -r "$rf" >/dev/null 2>&1
          done
          $pip -q install pytest-asyncio pytest-mock >/dev/null 2>&1 || true
        ') || inst=false
      xp="$d/.venv/bin:" ;;
    go) pm=go; xp="$GO_BIN:" ;;
    rs) pm=cargo ;;
  esac
  local inst_secs=$(( $(date +%s) - t0 ))

  # ---- init (with language PATH so detectTestCmd sees the right world)
  local init_out; init_out=$(cd "$d" && PATH="$xp$PATH" node $PW init 2>&1); local init_code=$?
  # if a JS/TS repo needs a build to test, wire the per-ref `setup` so the measuring worktree
  # compiles the ref it measures (devDeps like tsc live in the linked node_modules).
  if [ -f "$d/package.json" ] && [ -f "$d/promptwheel.config.json" ] \
     && node -e "process.exit(((require('$d/package.json').scripts)||{}).build?0:1)" 2>/dev/null; then
    node -e "const f='$d/promptwheel.config.json',fs=require('fs');const c=JSON.parse(fs.readFileSync(f,'utf8'));c.setup='npm run build --if-present';fs.writeFileSync(f,JSON.stringify(c,null,2)+'\n')" 2>/dev/null
  fi
  # keep installed deps OUT of the committed tree — else git ls-files/pick_src/probes operate on
  # .venv/node_modules and the break lands in a dependency file the suite never imports.
  printf '%s\n' '.venv/' 'venv/' 'node_modules/' 'target/' 'dist/' 'build/' 'vendor/' '__pycache__/' '.pytest_cache/' >> "$d/.git/info/exclude"
  git -C "$d" add -A >/dev/null 2>&1; git -C "$d" commit -qm pw-base >/dev/null 2>&1

  local baseline=$(run_gate "$d" "$xp" baseline)

  # ---- probe: BREAK the source — the gate must SEE it (fake-unchanged hunt)
  local src=$(pick_src "$d" "$lang"); local brk="skipped|0|none|none|no"
  if [ -n "$src" ]; then
    printf '\nzzz this is a deliberate syntax error zzz\n' >> "$d/$src"
    brk=$(run_gate "$d" "$xp" probe-break)
    git -C "$d" checkout -q -- . 2>/dev/null
  fi

  # ---- probe: CHEAT via per-language suppression — do tripwires fire?
  local cheat="skipped|0|none|none|no"
  if [ -n "$src" ]; then
    case $lang in
      py) printf '\n# noqa\n' >> "$d/$src" ;;
      go) printf '\n//nolint:all\n' >> "$d/$src" ;;
      rs) sed -i '1i #![allow(dead_code)]' "$d/$src" ;;
      *)  printf '\n// eslint-disable-next-line\n' >> "$d/$src" ;;
    esac
    cheat=$(run_gate "$d" "$xp" probe-cheat)
    git -C "$d" checkout -q -- . 2>/dev/null
  fi

  local ts_script=$(node -e "try{const p=require('$d/package.json');console.log(p.scripts&&p.scripts.test?'yes':'no')}catch{console.log('na')}")
  echo "{\"repo\":\"$repo\",\"lang\":\"$lang\",\"pm\":\"$pm\",\"install_ok\":$inst,\"install_secs\":$inst_secs,\"test_script\":\"$ts_script\",\"init_exit\":$init_code,\"baseline\":\"$baseline\",\"probe_break\":\"$brk\",\"probe_cheat\":\"$cheat\",\"src\":\"${src:-none}\"}" > "$out"
  rm -rf "$d"
}

if [ "${1:-}" = one ]; then run_one "$2" "$3"; exit 0; fi

xargs -P 5 -n 2 bash "$0" one < "${LIST:-$(dirname $0)/repos-100.txt}"
cat $W/results/*.json > $W/corpus100-results.jsonl
echo "DONE $(wc -l < $W/corpus100-results.jsonl) repos"
