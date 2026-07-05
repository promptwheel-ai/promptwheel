#!/usr/bin/env bash
# PromptWheel 1000-repo sweep — repos-500 + ~505 more verified rows (2026-07-04).
here=$(cd "$(dirname "$0")" && pwd)
LIST="$here/repos-1000.txt" W="${W:-/tmp/pw-corpus-1000}" exec bash "$here/sweep-100.sh"
