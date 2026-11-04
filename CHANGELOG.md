# Changelog

## 0.7.9 (2026-11-03): a win the engine cannot re-prove is never a pass

- **A source-only patch that fails to apply no longer reads PASS.** An improved metric whose source
  slice could not be re-applied used to come back `gamed: null`, which the verdict counted as not
  gamed, so a green earned by editing the test passed whenever the source patch would not apply
  (a binary file under `src/`, a `-diff` attribute, a conflicting hunk). The patch is now built with
  `git diff --binary` so binary source edits apply, and a win that still cannot be re-proven marks
  the metric `unprovable` and the verdict `inconclusive` (exit 3). `conformsToContract` rejects a
  `pass` that carries one. The verdict precedence is now one pure, exported function,
  `deriveVerdict`.
- **Production files named `evaluate.ts`, `evaluation.js`, `scoreboard.js`, `scores.ts` stay in the
  source slice.** The grader/eval/score classifier was a prefix match, so an honest fix in such a
  file read GAMED ("zero production-source files"). It now matches the whole name token
  (`eval.ts`, `grader-x.js`, `score.test.mjs`, `scoring.ts`), never a prefix.
- **Git preconditions exit 64, never 1.** A non-repo cwd, a base or head ref missing from a shallow
  checkout (the `actions/checkout` default is `fetch-depth: 1`), and a single-commit or shallow clone
  with no `--base` used to throw a stack trace with exit 1, the FAIL verdict code, so a PR gate
  failed as a regression. Each is a ConfigError now, with the fix in the message (`fetch-depth: 0`,
  pass `--base`, or `--working`); `check()` throws the same ConfigError.
- **`check({ repo })` with a subdirectory runs at the repository root**, where the config lives and
  `.promptwheel/` is written, exactly as the CLI does from that directory.
- **Self-heal never removes another repo's checkout.** Every temp dir the engine creates carries a
  short hash of its owning repo in the name; the stale-worktree sweep prunes only this repo's own
  (older than 1 h), leaves another repo's alone however old, and removes an untagged dir from an
  older engine only after a full day.
- **The repo's own `tests_passing` metric forces the TAP reporter** (`node --test --test-reporter=tap`):
  Node 24 prints the spec reporter even when piped, so the metric's `grep -cE "^ok "` counted zero and
  the gate read its own suite as unmeasurable. If your config counts `ok` lines, do the same.
- **One patched worktree re-proves every improved metric.** The source-only phase checked out,
  patched and set up a worktree once per improved metric; it does it once per run.

## 0.7.8 (2026-11-03): every precondition of check() is a ConfigError

- **Library:** `check()` threw a plain `Error` for three preconditions (not a git repository, `auto: false` with no config, an `options.config` without a non-empty `metrics` array) while the config loaders threw the `ConfigError` 0.7.7 introduced. All of them now carry `name: 'ConfigError'` and `exitCode: 64`, as the types say, and the duplicated doc comment on `check` is one again.

## 0.7.7 (2026-11-03): a narrowed mandate stays in force, and the library never exits your process

- **Mandates: narrowing a rule in the change that breaks it no longer clears it.** 0.7.5 kept a mandate in force for the change that *deletes* it, but matched base and head mandates by name only, so a change that rewrote `paths: ["test/**"]` to `paths: ["test/legacy/**"]` and edited `test/a.js` in the same commit passed with only a gate-changed warning. The base version of a mandate is now tested too unless head carries it unchanged (same name, same paths); a hit on the edited base version is reported with `edited: true` and the CLI line says so. One entry per mandate name (files unioned). `MandateViolation.edited` is declared in the types.
- **`check()` throws instead of exiting.** A malformed config, a missing `extends` target, an inheritance cycle, an empty `metrics` list, or a repo with no commits used to reach `die()` and exit the *host* process with code 64 from inside the library call. They now throw an `Error` with `name: 'ConfigError'` and `exitCode: 64`; `promptwheel run` catches it in `main()` and exits 64 exactly as before.
- **Plugin 0.1.9:** the disclosure says that `/promptwheel:improve` runs the attempt command you name (nothing the plugin composes), and the logbook skill pins `npx -y @promptwheel/logbook@0.9.8` (the same text as logbook's own `plugin/SKILL.md`).

## 0.7.6 (2026-11-03): types, a lean plugin skill, and the security-pack gitignore trap

- **Types for library consumers:** `bin/promptwheel.d.ts` is hand-written (no build step, no TypeScript dependency) and declares every runtime export plus the `Report`, `CheckOptions` and `Config` shapes. `package.json` points `types` and the `.` export's `types` condition at it, and a test keeps the declaration list in step with the engine's exports.
- **`init --preset security` warns when the copied pack is gitignored.** The pack is copied from the installed package into `.promptwheel/packs/security/` and the metric runs it from there (unchanged). But the gate measures in clean worktrees, so in a repo whose `.gitignore` covers `.promptwheel/` (common: the outcome record lives there) the pack was absent at both refs, `security_findings` read `unmeasurable`, and every run was a FAIL with no hint why. `init` now says so and names the rule to change (`.promptwheel/*` plus `!.promptwheel/packs/`). The pack README leads with the preset instead of an `extends` path that only resolves inside this repository.
- **Plugin:** the logbook skill is the lean, deterministic-layer version (the same text as logbook's own `plugin/SKILL.md`); the reviewed-decision commands are opt-in and documented in the logbook repo.
- **Repo:** the research corpus (repo lists and sweep scripts) left the public repo; the catch-a-cheat example's quoted output refreshed for 0.7.5.

## 0.7.5 (2026-11-03): exit-code hygiene, a real mandate fingerprint, and a smaller surface

- **Exit codes are no longer overloaded.** Usage and config errors (a malformed config, a missing `extends` target, an unknown command or preset, `improve` without `--attempt`) now exit `64` (`EX_USAGE`) through one `die()` helper. They used to exit `2`, the same code as `GAMED`, so a CI step could read a typo as a gamed win. Verdict codes are unchanged: `0` pass, `1` fail, `2` gamed, `3` inconclusive. `promptwheel --version` / `-v` print the version and exit 0; `--help` / `-h` / no command print the banner and exit 0; an unknown command prints it and exits 64 (all four used to exit 2).
- **`improve` exits `2` on a gamed attempt** (it returned `1`, indistinguishable from a regression, and the docs disagreed with each other). Same codes as `run` now: `0` kept, `1` regression, `2` gamed, `3` plateau or inconclusive.
- **Fixed: the gate fingerprint did not actually cover mandates at the base ref.** The base-ref gate definition collected metrics, `gamingThreshold` and `evaluatorPaths` but not `mandates`, while the head fingerprint hashed the live config's mandates. Measured on 0.7.4: a repo with the same mandate at both refs reported *different* base/head fingerprints, and a repo that deleted the mandate at head reported *identical* ones, the inverse of what the README claimed, and nothing was triggered either way because the fingerprint was record-only. Mandates are now resolved at the base ref through the `extends` chain exactly like `resolveConfig`; a differing fingerprint sets `gate.changed: true` and prints a "gate definition changed" line in the human and markdown reports.
- **Fixed: deleting a mandate in the same change that violated it cleared it.** The mandates in force are now the union of the base ref's and the head's, so that change still fails (the violation is reported with `removed: true` and the report says the mandate was deleted in the same change). Retiring a mandate in its own change, protected path untouched, passes with `gate.changed` recorded.
- **Fixed: a bare `run` on the trunk compared HEAD to itself.** The default base is the merge-base with `main`/`master`; on that branch the merge-base is HEAD, which produced a trivial PASS that verified nothing. When the merge-base equals HEAD the base is now the last commit (`HEAD~1`), the same thing `--working` and `sawbuck check` do.
- **Removed the Phase 5 learning layer:** the `playbook`, `suggest` and `backfill` commands, the `cohort`/`label`/`subsystems` record fields, the `--since`/`-n`/`--limit`/`--label` flags, `bench/compounding-ab.mjs` and `docs/LEARNING.md`. `insights` stays (plain per-metric counts). Existing `.promptwheel/outcomes.jsonl` files still read fine; the extra fields on older rows are ignored.
- **Smaller surface:** the undocumented `--antihack` / `--no-antihack` / `--md` aliases, the `pw` bin alias, the `./packs/*` package export and the `outcome-gate.config.json` back-compat lookup are gone. The editable-install probe (which spawned `python3` on every run) moved from `gate()` to `init`, so `check()` no longer spawns or prints.
- **Allow trailer:** `Promptwheel-Allow: <reason>` is the documented name; `Sawbuck-Allow:` stays as an alias; the silently accepted `Allow-Gamed:` is dropped.
- **Plugin:** the gate skill now covers `GAMED` and `INCONCLUSIVE` (what the agent should do for each), the plugin README lists the five skills that ship, and the unregistered Stop-hook moved to `examples/detect-gaming-stop.sh`. The sample PR workflow moved from `.github/workflows/example.yml` (where it ran on every PR of this repo) to `examples/github-action.yml`.
- **Docs:** README restructured around the 60-second catch demo (one copy of it; lineage notes, the roadmap and loop-framework jargon cut); one tagline everywhere; CHANGELOG entries for 0.7.3 and 0.7.4; stale facts fixed (eight presets, Rust `linkDirs`, `check()` options, counts); `docs/ROADMAP.md` and `docs/VISION.md` moved to `docs/history/`; INTEGRATE.md's logbook/harness sections trimmed to one Related paragraph.

## 0.7.4 (2026-11-02): mandates (protected-path hard rules)

- **`mandates`: named hard rules that fail the gate before any metric is read.** A `mandates` config entry names a protected-path rule (for example, never touch `src/auth/**`) that compiles to a deterministic, zero-LLM gate: any change touching a protected path fails the gate regardless of metrics (verdict `fail`, exit 1), rides at the top of the human and markdown report with its reason, inherits through `extends` (a parent scope's rule holds for every repo beneath it), and is folded into the gate fingerprint. This is the contract-vs-request line: `AGENTS.md` asks; a mandate will not let the change past the gate. `conformsToContract` accepts the optional `mandates` record.
- **Fixed:** `git apply --3way` printed "Applied patch ... cleanly" to stderr during gaming detection, which corrupted `--json` for callers that fold stderr into stdout. Silenced.
- **CI: cross-OS proof of the headline claim.** A `gamed-catch` job stages a red-to-green-by-editing-the-test win on ubuntu, macos and windows and asserts it is caught (never exit 0) and flagged `GAMED`. README gained a Portability note: the core check is git-only; the starter grep tripwires need a GNU-grep-compatible shell and fail closed (unmeasurable, verdict `FAIL`) where one is absent, so a gamed green is still never passed.

## 0.7.3 (2026-11-01): evaluatorPaths content-hash auto-fail + provenance receipt + Apache-2.0

- **Declared gate files are gamed by declaration.** A path listed in `evaluatorPaths` whose content changed between base and head, in the same diff that improves a metric, is now `gamed` deterministically (a content-hash check), even when the source-only re-run reads inert. Recorded in `gate.evaluatorChanged`. Only declared files trigger it, so the opt-in semantics hold: an undeclared config file still counts as source (the documented miss).
- **Provenance receipt on every verdict.** `report.provenance = { tool, toolVersion, baseSha, headSha, configHash, verdictHash }`, so a skeptic can re-run `(base, head, config)` and get the same `verdictHash`. Additive; never changes the verdict.
- **Relicensed MIT to Apache-2.0** (canonical text in `LICENSE`, copyright in `NOTICE`, `license` fields updated). Still permissive; adds the explicit patent grant.
- **bench:** `redteam-bench.mjs` emits `bench/redteam-claims.json`, the single source of truth for outward claims (ecosystems, scenarios, caught classes, the honest caught scope, the opt-in misses); `--claims-only` regenerates it without the full run.

## 0.7.2 (2026-11-01): agent-orienting starter block + output hygiene

- **`init` writes an agent-orienting gate block.** `promptwheel init` now writes a short "when to run the gate / what GAMED means" block into `AGENTS.md` (and `CLAUDE.md` / `.cursorrules` when present), sentinel-delimited and idempotent, so the coding agent (or a loop) runs the gate itself, not just the human. `--no-agent-block` skips it. The README documents the block too (for manual paste). Status line bumped to the current version.
- **Output hygiene:** removed em-dashes from the Stop-hook stderr (`plugins/promptwheel/hooks/detect-gaming-stop.sh`, shown to the agent) and the `examples/reliability-sprint` demo banners. Docs/output only; no engine change.

## 0.7.1 (2026-10-31): docs + shipped-output hygiene

- **`packs/security/scan.mjs`**: the `--list` finding lines now separate fields with `·` instead of an em-dash. Output format only; the metric value (the finding count on stdout) is unchanged.
- **README**: documented the declared-override escape hatch (`Sawbuck-Allow:` trailer / `--allow` / the `allow` option on `check()`), and refreshed the roadmap/status to 0.7.0 (added the 0.5.0 gate-integrity, 0.6.0 zero-config, and 0.7.0 declared-override + build-setup-detection milestones).

## 0.7.0 (2026-10-31): declared override (Sawbuck-Allow) + build-setup detection

- **`init` detects a build/install step** (a `build` npm script, or a Python editable install) and writes it to `setup`, so a gate whose test needs a build first *measures* instead of reading inert. A 10-repo replay found the auto-detected test command was inert ~2/3 of the time, and a missing build was a leading cause. Kept out of the zero-config default so the fast per-turn path stays fast; a failed setup is still honest (inconclusive, never a fake green).
- **A sanctioned, auditable way to allow an intentional test/config change.** A `Sawbuck-Allow: <reason>` trailer on the commit (or `--allow "<reason>"` on the CLI / the `allow` option on `check`) acknowledges an intentional goalpost change, so a win that would read `GAMED` reads `pass` with the acknowledgment recorded in `report.allowed` (the reason, and the metric or gate names it cleared). It covers an edit, a delete, or a new file alike. An UNdeclared test-only win is still `gamed`; a reasonless trailer does not override. The check does not judge intent, it forces intent to be explicit and auditable (the declaration lives in the commit, so a reviewer sees the reason instead of a silent green). `conformsToContract` validates `allowed`; CONTRACT section 3 documents it.

## 0.6.0 (2026-10-31): zero-config

- **`run` and `check()` work with no committed config.** When there is no promptwheel.config.json, the engine auto-detects a default gate (your stack's test command with gaming detection on, the same detection `init` uses) instead of exiting. `init` becomes optional, for *customizing* what you measure. A repo with no test command gets a sentinel that reads inert -> INCONCLUSIVE (never a fake green), with a message pointing at the fix. `--no-auto` (CLI) / `auto:false` (the `check` library option) restore the require-a-config behavior.
- The inert-guard warning now explains *why* a guard did not run (same value at both refs) and how to fix it (a build step, deps, or the wrong test command).

## 0.5.1 (2026-10-31): document the per-turn cost

- **README: a "Per-turn cost" note.** A check runs your metric in two throwaway worktrees plus a source-only re-run, so it costs roughly 2-3x the metric command's runtime + ~40ms of worktree overhead (measured). Point the per-turn gate at a *fast* metric and keep the slow full suite for CI. Docs only; no engine change.

## 0.5.0 (2026-10-31): importable library API + gate integrity

- **Public library API.** `import { check } from 'promptwheel'` runs the gate in process and returns the Verified-Outcome Contract verdict object (no `process.exit`, no printing, an optional in-process `config`). Also `verdictExitCode()`, `conformsToContract(report)`, the frozen vocab exports (`VERDICTS`/`METRIC_STATUSES`/`DIRECTIONS`), and `CONTRACT_VERSION`. An `exports` map makes the package importable while keeping the bin and `package.json` resolvable. See **INTEGRATE.md** for the four integration paths (conform, shell, import, MCP).
- **`promptwheel conformance [file|-] [--cmd C]`.** Self-check a verdict JSON, or a command's `--json` stdout and exit code, against the Contract.
- **Gate integrity: catch a weakened gate.** A change that disables a guard (`guard:false`) or deletes a guarded metric in the same diff it passes is now caught. The gate is resolved as of the base ref (following `extends`), a dropped guard is re-measured under its base definition, and the pass reads `GAMED` only if that guard **would have failed** at head, so a legitimate guard retirement is not a false positive. The verdict gains an optional `gate` record with a truncated SHA-256 fingerprint of the gate definition at base and head.

## 0.4.7 (2026-10-30): reconcile the engine (evaluatorPaths, security-antihack, classifier)

- Brought the published engine in line with the dev copy, all additive, no change to the verdict/exit contract:
  - **`evaluatorPaths`**: opt-in glob allowlist for repo-declared gate files (a threshold, a budget, a CI limit), reverted in the source-only re-run like a test/grader, so a win that moved only by editing a declared gate is GAMED.
  - **`security-antihack` preset**: security-invariant findings gate + the antihack tripwires + a starter `evaluatorPaths` ("guard the guards"); pairs with `--detect-gaming`.
  - **compiled-language test-filename classifier**: a weakened `foo_test.c` / `FooTest.java` / `handler_test.go` / `calc_test.rb` now reads as non-source (a red-team finding).
  - `# nosec` added to the suppressions tripwire.

## 0.4.6 (2026-10-30): the no-ai-tells preset

- **New opt-in preset `no-ai-tells`**: a guard that fails if the em-dash count rises (an AI writing tell). `promptwheel init --preset no-ai-tells`. (Was intended for 0.4.5 but landed after it published.)
- Tidied the npm description (removed a duplicated clause).

## 0.4.5 (2026-10-30): the check, not the referee

- **Re-voiced off the "referee" frame.** The README and npm description now describe PromptWheel plainly as the deterministic check; the un-gameable point stays (the code being checked never grades itself). PromptWheel is now documented as the reference check for the [Verified-Outcome Contract](https://github.com/sawbuck-ai/sawbuck/blob/master/CONTRACT.md).
- **Fixed: measured commands no longer inherit the harness's `node:test` context.** When PromptWheel runs under a test runner, `NODE_TEST_CONTEXT` leaked into metric subprocesses (a `node --test` metric would act as a child reporter and report a bogus exit code). The measured gate now runs with a clean child env; no change to real-world behavior.

## 0.4.2 - 2026-07-07 - reposition: "add a referee to your coding loop"

- **Repositioned** the README and npm description around the **referee** frame - a neutral, un-gameable check you add to your coding loop that verifies a win was *earned*. Catching the test-editing cheat is the referee's signature call, not the whole pitch. **No engine change** - the mechanism, verdicts, exit codes, and demos are identical to 0.4.1.
- **`examples/test-change-verdicts/`** - a runnable three-scenario demo answering "won't this flag my legit test edits?": a green→green refactor **PASSES**, a real fix that also edits a test **PASSES**, a test-only red→green is **GAMED**. Same metric move, opposite verdict - it keys on whether *source* carried the win, not whether a test was touched.
- **Corpus:** distribution regression matrix extended to **1,000 repos** (verified rows across TS/JS/Next/Python/Go/Rust).

## 0.4.1 - 2026-07-03 - honest verdicts + cross-ecosystem measurement

- **Inert guards no longer report a green PASS.** A guarded pass/fail metric that never actually runs (stuck at 0 across both refs - a missing or misconfigured test command) now yields `VERDICT: INCONCLUSIVE` (exit 3) instead of a misleading `PASS` with a buried warning. `improve` reverts on it; PR/markdown gets a yellow state. A gate must not certify a pass it never measured. *(Surfaced by the 150-repo sweep, where ~76% of real repos were silently reading a fake green.)*
- **Generalized the worktree dependency-bridge beyond `node_modules`.** New config keys: `linkDirs` (dirs to symlink into the measuring worktree; default `["node_modules"]`), `env` (vars for metric commands; `{wt}` → worktree path), and `setup` (a per-ref build/install, run after the source patch). `init` auto-writes stack defaults - Python: `linkDirs:['.venv']` + `PYTHONPATH="{wt}/src:{wt}"` + `.venv/bin/pytest` (fixes editable-install blindness on `src/`-layout repos, so the *measured ref* is imported, not your original checkout); Rust: `linkDirs:['target']`. `linkNodeModules` kept as back-compat.
- **Corpus:** distribution regression matrix extended to 150 repos; sweep parametrized (`LIST`), the `PW` path made absolute, and the Python/JS install path now pulls test deps + wires the per-ref `setup` build so the gate measures a real suite.

## 0.4.0 - 2026-07-03 - backfill: the cold-start harvest

- **`promptwheel backfill [-n N | --since <ref>]`** - seed the ledger by replaying git history through the *current* metrics (LEARNING.md harvest path 1), so `playbook`/`suggest`/`insights` are useful on day one instead of starting empty. Deterministic, no LLM. Rows are **cohort-tagged `backfill`** (historical human commits are not live agent-loop evidence - segmented, flagged on disagreement, never averaged in), the **conventional-commit type becomes the change-type label** for free (`fix`/`feat`/`refactor`/…), commits replay oldest-first so decay stays honest, re-runs are idempotent, root commits are skipped, and commits that no longer build record as `unmeasurable` - never faked. Gaming detection is off by default for history (`--detect-gaming` to audit the past too).
- Plugin `setup` skill: Claude now *proposes* repo-specific metrics at config time (build → `bundle_kb`, evals → `eval_pass_rate`, …) and offers the backfill - the LLM is the discovery layer only; every metric is a deterministic shell command and the engine stays LLM-free.

## 0.3.0 - 2026-07-02 - Phase 5, experimental (D7 overturned by explicit founder decision)

The learning layer, built under the constraints that survive the unfreeze - pure view, evidence-gated, claim-gated:

- **`promptwheel playbook`** - the outcome-curated playbook (adapting Agentic Context Engineering, Stanford 2510.04618): decayed (half-life 20 runs), Beta-smoothed, evidence-gated claims re-derived from `.promptwheel/outcomes.jsonl` on every read. No curator state, no model. Keys: `metric`, `metric @ subsystem`, `metric # label`; cohorts that disagree are flagged, not averaged. `--json` / markdown output for agent consumption.
- **`promptwheel suggest`** - UCB work-discovery over the lever scores: proposes where the next attempt should go (measured targets only, never code advice). Thin records are labeled as such.
- **Record enrichment** - every outcome row now carries `cohort` (ci/local), `subsystems` (top source dirs of the diff), and `label` (`--label`, or the `improve` attempt command) - the keys the playbook learns over.
- **`bench/compounding-ab.mjs`** - the acceptance harness: playbook arm vs control arm through `improve`, judged by the gate. Self-test included. **The claim gate: no public compounding statement until this passes on real usage data.**

## 0.2.3 - 2026-07-02 - usage replay

Replayed 136 real merged commits from 22 live-suite corpus repos through the gate as a user would (`run --base <c>~1 --head <c>`, detection on, default config): **123 PASS · 9 FAIL · 1 GAMED · 3 TIMEOUT - a 7.5% block rate on presumptively-honest commits**, under the 10% ship bar, with most blocks semantically correct (commits that genuinely added suppressions/skips, suites red at one ref, one red→green achieved purely via test-file edits - flagged GAMED, accurately). One refinement from the data:

- **FAIL verdicts now coach the intentional case** - one line pointing at loosening the specific guard locally (`guard:false` / named override) and at `promptwheel guards` - so a maintainer who *meant* to add that suppression knows the escape hatch instead of feeling gate-harassed.

## 0.2.2 - 2026-07-02 - 100-repo distribution sweep

Ran the gate across ~100 public repos (TS/JS libs, Next.js apps, Python, Go, Rust; 5-way parallel, per-language installs, three probes each: clean baseline · syntax-break · suppression-cheat). Aggregate: 0 hangs, cheat caught 72/72 on JS/TS/Next/Python; every break-probe miss on live suites triaged to uncovered-file probe picks - except one real class, plus one pattern gap:

- **Python editable installs can blind the gate - now detected and warned.** With src-layout `pip install -e .`, the worktree's tests import the ORIGINAL checkout at both refs, so every delta reads 0 (confirmed by controlled repro: a broken working tree measured `0 → 0 unchanged` while clean HEAD should read 1). The gate now detects an editable install of the measured repo (`__editable__*`/`.pth`/`.egg-link` in the active python's site-packages) and prints a loud warning with the workaround. A Node CLI cannot fix Python import semantics; refusing to pretend beats silently lying.
- **Suppression tripwire now covers Go and Rust** (`//nolint`, `#![allow(...)]`) - measured 0/27 caught before the fix, confirmed caught on a live Go repo after.
- Corpus context for honesty: many stranger repos' suites don't run under a fresh `--ignore-scripts` install (workspace links, build steps, missing env) - the 0.2.1 inert-guard warning fired correctly on all of these rather than reporting fake green.

## 0.2.1 - 2026-07-02 - corpus-hardened

Ran the gate against a 10-repo public corpus (Next.js apps, vitest/jest/ava TS libs, pnpm monorepos): 10/10 `init` correct, 10/10 scripted cheats caught, 0 hangs. Three failure classes found and fixed:

- **Inert-guard warning (the fake-green class).** A guarded `pass` metric that is 0 at *both* refs (broken test command, missing script, failed install - 5/10 corpus repos) now prints `⚠ never passed at either ref - this guard is protecting nothing` in human and markdown output instead of folding silently into a green verdict.
- **`init` writes the self-describing placeholder when `package.json` has no test script** (very common in app repos), instead of a `npm test` command that can never pass.
- **`NON_SOURCE` no longer sweeps tool-named production source.** Config detection now requires a `.config`/`.conf`/`.setup` segment (plus `tsconfig*.json`), so a real source file like `src/installers/eslint.ts` stays in the source slice - previously an honest win there could be flagged GAMED.
- Minor: the `assertions` tripwire now also counts ava-style `t.is()`/`t.deepEqual()` assertions.

## 0.2.0 - 2026-07-02 - the polished gate

- **Default `init` config now includes the antihack tripwires** (`test_count`, `skipped_tests`, `suppressions`, `assertions`). The quiet cheat - weaken the suite while the target metric stays flat - previously PASSED under the default config because gaming detection only audits *wins*; now it fails the gate out of the box. "Catch your agent cheating" is true without a preset.
- **`gamingThreshold` is now actually tunable** (config-level scalar or per-metric; inherited through `extends`), as the README already claimed. Default unchanged at `0.5`; the GAMED reason string names the threshold in effect.
- **`init` only writes the `lint_errors` metric when eslint is actually set up** (config file or dependency). Previously it reported a constant `0 (unverified)` on repos without eslint - a metric that can't move is noise, not signal.
- Tests: gamed-verdict boundary (`retained === 0.5` → earned), unmeasurable-guard short-circuit, regex-extract fixture that distinguishes the regex path from the last-number fallback, threshold end-to-end, and the gut-the-suite scenario against the default config. Suite: 43 tests. (Several of these gaps were found by mutation-testing the gate itself - the tool's own medicine.)

## 0.1.2 - 2026-06-30

- **Reward-hack detection ON by default** in `run` and `improve`; `--no-detect-gaming` opts out. Exit `2` = GAMED.
- Benchmark: cross-stack/cross-metric track (real pytest + numeric eval-pass-rate); cost stated structurally (one gate re-run per win).
- CI dogfoods the gate; bench surfaces the plain-CI-PASS vs PromptWheel-GAMED contrast.

## 0.1.1 - 2026-06-28

- Fix: tripwire-guard false positive (test-side gains are exempt from the source-only re-run via `gamingCheck: false`).
- Gaming-detection benchmark + scoreboard (`bench/RESULTS.md`).

## 0.1.0 - 2026-06-27 - reward-hack detection

- **`--detect-gaming`**: re-prove every win from the agent's source edits alone; verdict **GAMED** when the gain came from editing tests/config/grader/golden. `antihack` preset (target + tripwires).
- **`extends`** config inheritance (diamond-safe cycle detection) + **`guards`** observability command with provenance and flag record.
- Self-heal for orphaned worktrees/temp indexes from hard-killed runs; empty-repo `--working` guard; npm metadata. First npm publish.

## 0.0.2 - 2026-06-26 - roadmap phases 1–5

- **`--working` mode** - measure uncommitted (tracked) changes via `git stash create`; never disturbs the working tree.
- **Reward stream** - every gated run appends to `.promptwheel/outcomes.jsonl` (`--no-record` to skip). The per-repo "what moves what" record.
- **`improve --attempt "<cmd>"`** - the flywheel: run any agent/script, gate the result, **keep only if a metric improved** (commit), else revert. Agent-agnostic.
- **`--markdown`** output + **GitHub Action** (`action.yml`) - PR-comment verdict + status check, zero-install (runs from the action's own checkout). Example workflow included.
- **`insights`** - aggregate the reward stream into per-metric lever scores (Phase-5 seed; design in `docs/LEARNING.md`).
- Internals: extracted a shared `gate()` core used by `run` and `improve`.
- **Tests:** 20 dep-free `node:test` tests (unit + integration); engine made importable (pure helpers exported, CLI guarded behind a direct-invocation check). `npm test`.
- Docs: `ARCHITECTURE.md` covers the full command set + reward stream + testing.

## 0.0.1 - 2026-06-26 - the pivot

PromptWheel rebooted from an **agent orchestrator** into **the outcome gate for AI code**. Orchestration was retired (commoditized by Claude Code Workflows/subagents/hooks/Routines and Cursor); the prior codebase is archived at `_archive/promptwheel-orchestration` (recoverable from GitHub `promptwheel-ai/promptwheel` + `CodeWheel-AI/promptwheel`).

**v0 - the gate (runnable):**
- Before/after metric measurement in isolated, throwaway git worktrees (never touches your working tree).
- Config-driven metrics: `cmd` + `extract` (`number`/`lines`/`exit`/`{regex}`) + `direction` (`up`/`down`/`pass`) + `guard`.
- Regression guards: a trusted regression fails the gate (exit 1) - CI-friendly.
- **Noise-aware trust model** (`--repeat N`): median + observed noise band; a delta inside the band is `inconclusive` and never fails a guard. Confidence: `high`/`medium`/`low`/`unverified`.
- Human and `--json` output.

See `docs/VISION.md` for the why, `docs/ROADMAP.md` for what's next, `docs/ARCHITECTURE.md` for how it works.
