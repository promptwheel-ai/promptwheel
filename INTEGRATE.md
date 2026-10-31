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

- **Section 1, exit codes.** `0` pass, `1` fail (a guarded metric regressed beyond noise),
  `2` gamed (a win that did not survive a source-only re-run), `3` inconclusive (a guard
  measured nothing, so a pass cannot be certified). An agent reads the code as a per-turn
  reward it cannot inflate; a merge gate reads the same code as a wall it cannot self-clear.
- **Section 2, the verdict JSON.** The object below, reproducible from `(base, head, config)`
  alone.

```json
{
  "base": "a1b2c3d",
  "head": "e4f5g6h",
  "mode": "refs",
  "repeat": 3,
  "cohort": "ci",
  "verdict": "gamed",
  "subsystems": ["api", "auth"],
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
      "gamingReason": "the win changed zero production-source files, only test/config/grader/golden"
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
(`unverified | low | medium | high`) and `sourceOnly` are informational fields this
implementation adds; a minimal conforming report may omit them.

Self-check your implementation against this schema (see Section 4 below):

```bash
your-tool --json | promptwheel conformance -
```

---

## 2. Shell the CLI and parse `--json`

Language-agnostic, process-isolated, the common path for CI and for harnesses not written in
Node. Run the gate, read the exit code (Section 1), parse stdout (Section 2).

```bash
promptwheel run --base "$BASE" --head "$HEAD" --json
echo $?   # 0 pass | 1 fail | 2 gamed | 3 inconclusive
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
process and returns the Section 2 object. It never prints and never calls `process.exit`; it
throws a plain `Error` on a precondition failure.

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
| `config` | object | load `promptwheel.config.json` from the repo | a resolved config `{ metrics: [...], ... }`, supplied in process |
| `repeat` | number | `config.repeat ?? 1` | measurement repeats for the noise band |
| `detectGaming` | boolean | `true` | run the Section 3 source-only re-proof |
| `cohort` | string | `CI ? 'ci' : 'local'` | cohort tag for the record |
| `label` | string | none | change-type label |
| `record` | boolean | `false` | append the run to `.promptwheel/outcomes.jsonl` |

Preconditions throw (they do not exit the host): not inside a git repository; no
`promptwheel.config.json` and no `config` option; a `config` with no non-empty `metrics`
array. Supplying `config` needs no file on disk:

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

## 4. Self-check with `promptwheel conformance`

Prove your own check, loop, or CI step speaks the Contract.

```bash
# validate a verdict JSON (from a file or stdin) against the Section 2 schema
promptwheel conformance report.json
cat report.json | promptwheel conformance -

# run a command, then validate BOTH its --json stdout (Section 2)
# AND that its exit code matches the verdict (Section 1)
promptwheel conformance --cmd "your-tool --json"
```

Exit `0` if it conforms, `1` otherwise, listing every problem. This is how a third-party
implementation earns the right to say "Verified-Outcome Contract compatible."

---

## The memory half: @promptwheel/logbook

The check verifies what holds now; the **logbook** records what happened over the history.
It is a separate package with the same thin, model-blind, zero-dependency design, and it ships
three integration surfaces of its own:

- **CLI + JSON.** `logbook query --json`, `logbook check --diff --json`. Shell it like Section 2.
- **MCP.** `@promptwheel/logbook-mcp` (bin `logbook-mcp`) exposes the history to an agent over
  the Model Context Protocol, so a Claude Code or other MCP client reads hotspots, reverts, and
  suppression signals without shelling anything.
- **Import.** The package is importable (`@promptwheel/logbook`) and importing it never runs the
  CLI; `queryEvents`, `analyze`, `auditHead`, and `hotspots` are exported for advanced in-process
  use. The scan and cache entry points take explicit options, so the CLI and MCP are the
  first-class surfaces for most integrations. The reference harness (Sawbuck) consumes the
  logbook by shelling `logbook query --json`, not by importing it, which keeps the same process
  boundary the check engine uses.

---

## The layer boundary (why this stays thin)

The engines are deterministic and model-blind: no LLM call, no network, no runtime
dependency, no build step. A harness that orchestrates models (Sawbuck is the reference one)
consumes these engines across a process boundary, by shelling the CLI or resolving the bin,
and never imports their internals. Keep that boundary and the check stays something a
skeptic can re-run and get the same verdict, which is the entire point.
