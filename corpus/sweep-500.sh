#!/usr/bin/env bash
# PromptWheel 500-repo sweep — repos-300 + 200 more verified rows (2026-07-04).
here=$(cd "$(dirname "$0")" && pwd)
LIST="$here/repos-500.txt" W="${W:-/tmp/pw-corpus-500}" exec bash "$here/sweep-100.sh"
