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
- `sweep-150.sh` + `repos-150.txt` — the 100-repo matrix plus 50 stratum-widening rows added
  2026-07-02 (same three probes, same harness — a thin wrapper over `sweep-100.sh` with `LIST`/`W`
  overridden). ~3 h. `repos-150.txt` is the 100-row baseline verbatim + 50 verified rows appended,
  so it is a strict superset (the 100-row prefix stays byte-identical for baseline comparison).
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
- **Matrix size: 150 (extended 2026-07-02, superseding the earlier ~100 cap).** The 100-repo
  rounds saturated discovery (3 classes per 10 repos in round one; 2 per 100 in round two, both
  in newly sampled strata). The matrix was extended to 150 on 2026-07-02 by decision, to widen
  stratum coverage; the 50 added rows are treated exactly like the rest — regressions against the
  committed baseline are findings, novelty is not sought. The saturation caveat still stands:
  do NOT grow past 150 speculatively. Further rows are added ONLY from evidence — a user-reported
  failure shape becomes a permanent fixture here, with the fix.
- Findings are published as aggregates and failure classes; repo names appear only as
  compat-matrix rows (standard CI-matrix practice), never with quality judgments.
