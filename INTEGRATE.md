# Integrating PromptWheel

PromptWheel is the reference implementation of the **Verified-Outcome Contract**: a
deterministic, zero-LLM check that proves a change moved a real metric and that the agent
earned the win in the source, not by editing the test, config, or grader. This page is the
integration surface. There are four ways in, from loosest coupling to tightest.

The protocol itself (exit codes, the verdict JSON, the integrity boundary) is specified in
[CONTRACT.md](https://github.com/sawbuck-ai/sawbuck/blob/master/CONTRACT.md). The sections
below say `Section N` where that document says `N`.

---

## 1. Conform to the Contract (no code from here)

The strongest guarantee and the loosest coupling: emit or consume the two artifacts the
Contract defines, and any harness interoperates with any other, in any language, without
importing this package.

- **Section 1, exit codes.** `0` pass, `1` fail (a guarded metric regressed beyond noise, or
  a mandate was violated), `2` gamed (a win that did not survive a source-only re-run), `3`
  inconclusive (a guard measured nothing, or a win whose source-only re-run could not be applied,
  so a pass cannot be certified). An agent reads the
  code as a per-turn reward it cannot inflate; a merge gate reads the same code as a wall it
  cannot self-clear. A usage or config error (a malformed config, a missing `extends` target,
  a bad flag) exits `64` (`EX_USAGE`), which is not a verdict: a CI step must never read a
  typo as `GAMED`.
- **Section 2, the verdict JSON.** The object below, reproducible from `(base, head, config)`
  alone.

```json
{
  "base": "a1b2c3d",
  "head": "e4f5g6h",
  "mode": "refs",
  "repeat": 3,
  "verdict": "gamed",
  "metrics": [
    {
      "name": "tests_pass",
      "direction": "pass",
      "guard": true,
      "before": 0,
      "after": 1,
      "delta": 1,
      "status": "improved",
      "ok": true,
      "confidence": "high",
      "noise": 0,
      "gamed": true,
      "sourceOnly": null,
      "retained": 0.0,
      "gamingReason": "the \"win\" changed zero production-source files, only test/config/grader/golden"
    }
  ]
}
```

Fixed vocabularies (use exactly these):

- `verdict` is one of `pass | fail | gamed | inconclusive`
- `metric.status` is one of `improved | regressed | unchanged | inconclusive | unmeasurable`
- `direction` is one of `up | down | pass` (the direction that counts as better; `pass` is a 0/1 gate)

`noise` is the measured jitter band, a single number, across the top-level `repeat` runs; a
delta inside it is `inconclusive`, never a regression. `retained` is the fraction of a
metric's gain that survived the source-only re-run (Section 3). `confidence`
(`none | unverified | low | medium | high`, `none` for an unmeasurable metric) and `sourceOnly` are informational fields this
implementation adds; a minimal conforming report may omit them. `gate` (optional) records a
truncated SHA-256 fingerprint of the gate definition (metrics, guards, `evaluatorPaths`,
`gamingThreshold`, `mandates`, `setup`, `env`, linked dirs; each metric with its `cmd` and how it
is read) at base and head, sets `gate.changed: true` when they differ, and lists in
`gate.weakened` any guard the change removed, disabled, or measured another way
(`change: guard-edited`, such as `cmd: "true"`; `change: measurement-edited`, a new `setup`, `env`
or `linkDirs`) to hide a regression; a non-empty `gate.weakened` forces `gamed`, so an agent
cannot pass by disabling the guard it is judged by. A change that adds the first config is
compared with the zero-config gate (the detected test command). `allowed` (optional) is `{ reason, cleared }` when a declared
reason turned a would-be `gamed`, `fail` or `inconclusive` into `pass`: `cleared` names each metric,
`gate`, or `mandate:<name>` it cleared, and each cleared metric carries `allowed: true` and keeps its
`gamingReason`, so a consumer can say what was allowed and why it would have failed.

Self-check your implementation against this schema with `conformsToContract` (see part 4 below).

---

## 2. Shell the CLI and parse `--json`

Language-agnostic, process-isolated, the common path for CI and for harnesses not written in
Node. Run the gate, read the exit code (Section 1), parse stdout (Section 2).

```bash
promptwheel run --base "$BASE" --head "$HEAD" --json
echo $?   # 0 pass | 1 fail | 2 gamed | 3 inconclusive | 64 usage/config error (not a verdict)
```

```bash
promptwheel run --working --json        # gate uncommitted changes (incl. newly added files)
promptwheel run --no-detect-gaming       # the bare gate, without the Section 3 re-proof
```

Gaming detection (Section 3) is **on by default**. Nothing touches your working tree: every
measurement runs in a throwaway git worktree.

---

## 3. Import the library (in process)

Zero dependencies, no build step, the whole engine is one file. `check()` runs the gate in
process and returns the Section 2 object. It never prints and never calls `process.exit`; on a
precondition failure it throws an `Error` named `ConfigError` with `exitCode` 64. Types ship in the package
(`bin/promptwheel.d.ts`, hand-written, no build step): `import type { Report, CheckOptions, Config } from 'promptwheel'`
works in TypeScript, and editors complete the options and the report in plain JavaScript.

```js
import { check, verdictExitCode, conformsToContract, VERDICTS, CONTRACT_VERSION } from 'promptwheel';

const report = check({ base: 'HEAD~1', head: 'HEAD' });   // discovers the repo from cwd
if (report.verdict === 'gamed') {
  const m = report.metrics.find((x) => x.gamed);
  throw new Error(`gamed: ${m.name} (${m.gamingReason})`);
}
process.exit(verdictExitCode(report.verdict));             // exit exactly as the CLI would
```

### `check(options) -> report`

Returns the Section 2 verdict object (identical to `run --json`). Reproducible from
`(base, head, config)` alone.

| option | type | default | meaning |
| --- | --- | --- | --- |
| `repo` | string | from `process.cwd()` | repo path |
| `base` | string | merge-base vs `origin/main`..., else `HEAD~1` | base ref |
| `head` | string | `HEAD` | head ref |
| `working` | boolean | `false` | gate uncommitted changes instead of `base..head` |
| `config` | object | load `promptwheel.config.json`, or auto-detect | a resolved config `{ metrics: [...], ... }`, supplied in process |
| `auto` | boolean | `true` | with no config file and no `config` option, gate the auto-detected test command (zero-config); `false` throws instead |
| `repeat` | number | `config.repeat ?? 1` | measurement repeats for the noise band |
| `detectGaming` | boolean | `true` | run the Section 3 source-only re-proof |
| `allow` | string | none | a declared override reason (the same as `--allow` / a `Promptwheel-Allow:` trailer): a would-be `gamed`, or an `unprovable` win (its source-only re-run could not be applied), reads `pass` with the reason recorded in `report.allowed` |

Preconditions throw (they do not exit the host): not inside a git repository; `auto: false`
with no `promptwheel.config.json` and no `config` option; a `config` with no non-empty
`metrics` array. With neither a file nor `config`, the default is zero-config: the detected
test command is gated (an inert command reads `inconclusive`, never a fake pass). Supplying
`config` needs no file on disk:

```js
const report = check({
  repo: '/path/to/repo', base: 'HEAD~1', head: 'HEAD',
  config: { linkNodeModules: false, metrics: [
    { name: 'tests_pass', cmd: 'npm test', extract: 'exit', direction: 'pass', guard: true },
  ] },
});
```

### `verdictExitCode(verdict) -> 0 | 1 | 2 | 3`

The one Section 1 mapping the CLI uses too. Map verdicts this way and your process exits
exactly as `promptwheel run` does.

### `conformsToContract(report) -> { ok, errors }`

Structurally validate any verdict object against Section 2 (shapes, the fixed vocabularies,
and the honest-verdict rules: a `pass` cannot hide a failing guard or a gamed win, a `gamed`
verdict must point at a gamed metric). Zero dependency, so a third-party implementation can
self-check the artifact it emits. `errors` is a list of human-readable problems, empty when
`ok` is `true`.

### Other exports

`CONTRACT_VERSION` (the protocol revision this build implements), and the frozen vocab
arrays `VERDICTS`, `METRIC_STATUSES`, `DIRECTIONS`, so a consumer validates against the source
of truth instead of hardcoding the strings.

---

## 4. Self-check with `conformsToContract`

Prove your own check, loop, or CI step speaks the Contract.

```js
import { conformsToContract, verdictExitCode } from 'promptwheel';

const { ok, errors } = conformsToContract(JSON.parse(reportJson));   // Section 2
const exitMatches = exitCode === verdictExitCode(report.verdict);    // Section 1
```

`ok` is `true` when the report conforms; otherwise `errors` lists every problem. This is how a
third-party implementation earns the right to say "Verified-Outcome Contract compatible."

---

## Related

PromptWheel is the check: it verifies what holds now. The history side is served by
[`@promptwheel/logbook`](https://www.npmjs.com/package/@promptwheel/logbook), a separate
zero-dependency package that turns a repo's git history into agent-readable memory
(hotspots, reverts, suppressions), shelled the same way (`logbook query --json`). Both are
deterministic and model-blind: no LLM call, no network, no build step. A harness that
orchestrates models should consume them across a process boundary (shell the CLI, parse
`--json`) rather than importing their internals, so a skeptic can always re-run the check and
get the same verdict.
