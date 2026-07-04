# Gate your stack — copy a config

PromptWheel works on any change in any language. It **never parses your code** — it splits the git diff into *source* vs *test / config / grader / golden*, applies only the source slice onto a clean worktree, and re-runs **your** gate command. So pick your stack, drop a `promptwheel.config.json`, and `npx promptwheel run` catches reward-hacking by default.

> `npx promptwheel init` autodetects **pytest / go test / cargo test / npm test** and writes a starter for you. Below are the copy-paste references + what `--detect-gaming` catches in each. Plain `init` already writes the suppression / skipped-test / assertion tripwire guards by default; `--preset antihack` is just the explicit spelling of that default.

## Node / JS — tests
```json
{ "metrics": [{ "name": "tests", "cmd": "npm test --silent", "extract": "exit", "direction": "pass", "guard": true }] }
```
Catches a green suite bought by **deleting / skipping / weakening an assertion, mocking a module, or editing a fixture**.

## Python / pytest
```json
{ "metrics": [{ "name": "tests", "cmd": "pytest -q", "extract": "exit", "direction": "pass", "guard": true }] }
```
Catches **`@pytest.mark.skip` / `@pytest.mark.xfail` on a failing test, an edited `conftest.py`, or a `sys.exit(0)` harness-exit** — the source-only re-run reverts the test/conftest edit and the failure comes straight back. *(Real pytest scenario in [`../bench/RESULTS.md`](../bench/RESULTS.md), "Applications" table.)*

## TypeScript — type-check
```json
{ "metrics": [{ "name": "type_errors", "cmd": "tsc --noEmit 2>&1 | grep -c 'error TS'", "extract": "number", "direction": "down", "guard": true }] }
```
Catches a green `tsc` bought with a **near-empty `tsconfig`** (config reverted → the errors return) or scattered **`@ts-ignore` / `@ts-nocheck`** (the `antihack` suppression tripwire).

## Coverage
```json
{ "metrics": [{ "name": "coverage", "cmd": "<your coverage % command>", "extract": { "regex": "All files[^0-9]*([0-9.]+)" }, "direction": "up", "guard": true, "gamingCheck": false }] }
```
Coverage gains legitimately live in *tests*, so mark it **`gamingCheck: false`** (otherwise honest test-adds get flagged — see the `H3` row in the benchmark). The source-only re-run shines on **source-driven** metrics; for coverage, what it *can* catch deterministically is a **lowered coverage threshold in a config file**. Vacuous-test inflation needs mutation testing — out of scope, honestly.

## Bundle size
```json
{ "metrics": [{ "name": "bundle_kb", "cmd": "du -sk dist | cut -f1", "extract": "number", "direction": "down", "guard": false }] }
```
A smaller bundle that came from **relaxing the size config** rather than the source evaporates on the re-run.

## LLM eval (pass-rate + $/run) — the flagship
See **[`reliability-sprint/`](reliability-sprint/)** — gates `eval_pass_rate` (up) and `cost_per_run_usd` (down). Catches a higher pass-rate bought by **deleting hard eval cases, editing the golden answers, or mocking the scorer** — all caught in [`../bench/RESULTS.md`](../bench/RESULTS.md).

---
**One mechanism, every stack:** revert the test/config/grader/golden edits, re-run *your* gate, see if the win survives. `--detect-gaming` is on by default in `run` and `improve`; `--no-detect-gaming` for the bare gate.
