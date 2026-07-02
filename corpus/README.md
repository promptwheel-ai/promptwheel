# Distribution corpus — the stranger-repo regression matrix

Deterministic harnesses that run the gate against real public repos and record
**tool behavior only** (does `init` detect the stack, does the gate run without
hanging, do the tripwires catch a scripted cheat, does a syntax break get seen).
No per-repo test-quality findings are produced or published — this measures
*PromptWheel*, not the repos.

## Files
- `sweep-10.sh` + `repos-10.txt` — the small matrix (JS/TS + Next.js shapes). ~15 min serial.
- `sweep-100.sh` + `repos-100.txt` — the full matrix (TS/JS/Next/Python/Go/Rust, 5-way parallel,
  per-language installs, three probes per repo). ~2 h. Requires `go` on PATH for the Go rows.
- `results-100-v0.2.1.jsonl` — the raw run that produced the 0.2.2 findings (baseline snapshot).

## Probes (per repo)
1. **baseline** — clean tree; hunts hangs, junk verdicts, and validates the inert-guard warning.
2. **break** — a syntax error appended to production source; the gate MUST see `tests_pass` drop
   on any repo whose suite genuinely runs (a miss = the fake-unchanged class, e.g. the Python
   editable-install blindness found 2026-07-02).
3. **cheat** — a per-language suppression (`eslint-disable`, `# noqa`, `//nolint`, `#![allow]`);
   the tripwires must flag it.

## Policy (decided 2026-07-02 — keep this from becoming forever-polish)
- **Run `sweep-10` before each release; `sweep-100` before majors.** Compare against the
  committed baseline results — regressions in a fixed matrix are findings; novelty is not sought.
- **Do NOT grow the matrix speculatively.** The discovery rate saturated at ~100 repos
  (3 classes found per 10 repos in round one; 2 per 100 in round two, both in newly sampled
  strata). New rows are added ONLY from evidence: a user-reported failure shape becomes a
  permanent fixture here, with the fix.
- Findings are published as aggregates and failure classes; repo names appear only as
  compat-matrix rows (standard CI-matrix practice), never with quality judgments.
