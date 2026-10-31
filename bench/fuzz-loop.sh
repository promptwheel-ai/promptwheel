#!/usr/bin/env bash
# Keep running the property bench with fresh random seeds; surface any surprise.
# Zero model cost — it just loops prop-bench.mjs, logs each run's seed, and flags an
# FP/FN (prop-bench exits nonzero only on those; a bonus out-of-scope catch is fine).
#
#   ./fuzz-loop.sh                      # 20 runs of N=40
#   ITERS=100 N=60 ./fuzz-loop.sh       # 100 runs of N=60
#   ITERS=0 ./fuzz-loop.sh              # forever (Ctrl-C to stop; prints a summary)
#   STOP_ON_SURPRISE=1 ./fuzz-loop.sh   # halt on the first surprise
#
# Exit code is nonzero if any run surprised, so it drops into CI or a watch loop. Each
# surprise prints `SEED=<n>` to reproduce exactly:  SEED=<n> node bench/prop-bench.mjs
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ITERS="${ITERS:-20}"; N="${N:-40}"
i=0; clean=0; surprised=0; seeds=""

summary() {
  echo
  echo "fuzz-loop: ${clean} clean / ${surprised} surprised over ${i} run(s) (N=${N})"
  [ -n "$seeds" ] && echo "  reproduce:${seeds}"
}
trap 'summary; exit 1' INT TERM

while [ "$ITERS" = 0 ] || [ "$i" -lt "$ITERS" ]; do
  i=$((i + 1))
  out="$(N="$N" node "$HERE/prop-bench.mjs" 2>&1)"; code=$?
  seed="$(printf '%s\n' "$out" | sed -n 's/^seed \([0-9]*\).*/\1/p' | head -1)"
  if [ "$code" -eq 0 ] && printf '%s' "$out" | grep -q "no surprises"; then
    clean=$((clean + 1))
    printf 'run %4d  seed %-12s  clean\n' "$i" "$seed"
  else
    surprised=$((surprised + 1))
    det="$(printf '%s\n' "$out" | grep -E 'FALSE|bonus' | sed 's/^ *//' | paste -sd '; ' -)"
    printf 'run %4d  seed %-12s  SURPRISE: %s\n' "$i" "$seed" "$det"
    seeds="${seeds} SEED=${seed}"
    [ "${STOP_ON_SURPRISE:-0}" = 1 ] && break
  fi
done

summary
[ "$surprised" -gt 0 ] && exit 1 || exit 0
