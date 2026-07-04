#!/usr/bin/env bash
# PromptWheel 300-repo sweep — repos-150 + 150 more verified rows (added 2026-07-03).
# Same harness/probes as sweep-100; only the list and workdir differ.
here=$(cd "$(dirname "$0")" && pwd)
LIST="$here/repos-300.txt" W="${W:-/tmp/pw-corpus-300}" exec bash "$here/sweep-100.sh"
