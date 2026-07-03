#!/usr/bin/env bash
# PromptWheel 150-repo sweep — the 100-repo matrix + 50 stratum-widening rows (added 2026-07-02).
# Identical harness/probes to sweep-100 (baseline/break/cheat); only the repo list and workdir differ.
# W is passed through the environment so the parallel workers inherit the same workdir.
here=$(cd "$(dirname "$0")" && pwd)
LIST="$here/repos-150.txt" W="${W:-/tmp/pw-corpus-150}" exec bash "$here/sweep-100.sh"
