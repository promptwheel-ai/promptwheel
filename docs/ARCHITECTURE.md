# Architecture (v0)

The whole engine is `bin/promptwheel.mjs` (about 1,500 lines, Node ESM, zero deps). It is intentionally a single file - importable (pure helpers are exported for unit tests) that runs the CLI only when invoked directly.

## Flow

```
config (promptwheel.config.json)
        │
   resolve base ref (default: merge-base HEAD origin/main)  and  head ref (default: HEAD)
        │
   for each ref:  git worktree add --detach (throwaway)  ──►  run each metric ×repeat  ──►  remove worktree
        │
   per metric:  median(before-samples), median(after-samples),  noise = max(spread(before), spread(after)), or the band the metric declares
        │
   evaluate → { delta, status, confidence, ok }
        │
   verdict = guard failed ? "fail" : gamed ? "gamed" : inert guard ? "inconclusive" : "pass"   →   print (human | --json | --markdown)   →   exit (0|1|2|3)
```

The working tree is **never** touched - every read happens in a temp worktree that is removed afterward.

## Commands

| command | what it does |
|---|---|
| `run [--base R] [--head R] [--repeat N] [--json\|--markdown]` | gate a change between two refs |
| `run --detect-gaming` / `--no-detect-gaming` | antihack is **on by default**: re-prove each win from source edits alone (verdict `gamed`, exit 2); `--no-detect-gaming` for the bare gate. `--markdown` emits a PR-comment table |
| `run --working` | gate **uncommitted** changes incl. newly added files (temp-index `write-tree`/`commit-tree` snapshot; real index + tree untouched) |
| `run --no-record` | check without adding a row to the record |
| `improve --attempt "<cmd>" [--target <measure>] [--label "<name>"] [--json]` | a door onto the loop's one keeper, `examples/improve-loop/improve.mjs` (shipped in the package): run any agent or script, check what it changed, keep it as one commit only if the target improved, else put the tree back. Exit 0 kept, 1 a guard got worse (or the floor, the list of what may change, or the contract), 2 gamed, 3 nothing improved, 64 could not run. `--goal` is another name for `--target`; with neither, the target is `score`, or the contract's only measure, or its only one that is not a tripwire, and a contract that leaves a choice, or cannot be read, is refused before the attempt runs (64). Its other flags are the step's: `--cheaper`, `--floor`, `--repeat`, `--base-cache`, `--may-change`. See [LEARNING.md](LEARNING.md) |
| `improve --attempt "<cmd>" --turns N [--patience P]` | judge over a number of turns: each turn goes on from the last, the whole change so far is checked against the commit the run started from, the reading is handed to the next turn (`PW_FEEDBACK`, `PW_TURN`, `PW_TURNS`), and the best turn is kept as one commit after a second look |
| `insights` / `playbook` / `suggest` `[--json]` | views over the engine's record of checked runs and the loop's record of tries: how each measure responds, what has paid here and what the loop threw away (in its own words), where to spend the next attempt |
| `backfill [-n N \| --since <ref>]` | fill the record from past commits, marked `backfill` |
| `run --base-cache <dir>` | keep the base's measurement in `<dir>` (a folder outside the repo) and reuse it for the same tree measured the same way, so a loop asks a slow or paid scorer about the base once. Only a clean measurement is kept, and the report says when the base was not measured in this run (`baseMeasured`) |
| `calibrate [--metric M] [--runs N] [--repeat N] [--json]` | measure the noise band a metric needs: run it N times (20) at `HEAD` and print the band for the repeat count, to declare on the metric as `noise`. Writes nothing |
| `init [--preset <name> \| --list] [--no-agent-block]` | write a starter config (detect stack; presets `antihack`/`no-ai-tells`/`supply-chain`) and an agent-orienting block in `AGENTS.md` |
| `lock` | write `promptwheel.lock.json`, the shape of the repo, held by the `supply-chain` preset |
| `pr-allow` | read a PR's comments as JSON on stdin and print the newest `sawbuck-allow:` reason from someone with write access (the Action's approval step). With `--author <login>` the account that opened the PR is left out, unless the contract at `--base <ref>` holds `"allowFromAuthor": true` |
| `pr-comment` | what the Action does with its one comment on a pull request: prints `none`, `create` or `update:<id>`, writes the comment and adds the whole report to the job summary. A plain pass says nothing; an earlier comment is edited in place |

### detect-gaming (antihack)
`run` re-proves every *win* from the agent's source edits **alone**. A change that moved no test, grader or config has nothing to set aside: the tree the re-run would build is the head tree, so the head measurement stands and nothing is run a second time (`gate.goalposts` is then empty). Otherwise: After the normal gate, it partitions the head diff into **production source** vs. **`{test, config, grader, golden}`** files, rebuilds a clean worktree at the base with **only the source slice** applied, and re-runs the gate. If a guarded win does **not** survive that source-only re-run - because it passed by editing/skipping a test, mocking the grader, editing a golden, relaxing config, or touching zero source files - the verdict is **`GAMED`** (exit 2). Metrics with `gamingCheck: false` are exempt from the re-run (test-side tripwires whose gains legitimately live in test files; the `antihack` preset sets this). A change is judged by the gate that was in force before it: `gamingCheck: false` set on a metric that had the re-run on, a lower `gamingThreshold`, and an edited `setup`, `env` or `linkDirs` all apply from the next change, and a change that adds the first config is compared with the zero-config gate (the detected test command). Deterministic, zero-LLM: a diff partition plus a re-run, so every flag is reproducible with a human-readable reason. The 50%-of-gain-survives threshold is the default and is tunable. See `DETECTION-LAYERS.md` for scope and `../bench/RESULTS.md` for measured recall.

## Config schema - `promptwheel.config.json`

```jsonc
{
  "extends": "./promptwheel.base.json",  // optional: inherit guards from a shared base (path or array)
  "repeat": 1,                 // default sample count (overridden by --repeat)
  "linkDirs": ["node_modules"], // dirs symlinked from the repo into each measuring worktree (deps that live outside git, e.g. node_modules / .venv / target); with nothing set, the root node_modules and each workspace's own are linked, and links back into the repo are pointed at the worktree. Back-compat: linkNodeModules:false links nothing.
  "env": { "PYTHONPATH": "{wt}/src:{wt}" }, // optional env vars for metric commands; {wt} substitutes to the worktree path
  "setup": "npm run build",    // optional per-ref build/install run after any source patch (best-effort; a failed setup leaves the metric inert → inconclusive)
  "metrics": [
    {
      "name": "lint_errors",
      "cmd":  "npx eslint . | grep -c error",  // any shell command, run inside the worktree
      "extract": "number",     // number | lines | exit | { "regex": "coverage: (\\d+)" }
      "direction": "down",     // up (higher better) | down (lower better) | pass (boolean 0/1)
      "guard": true,           // true = a trusted regression FAILS the gate; false = informational
      "gamingCheck": true,     // (default true) include this metric in the source-only re-run; false exempts test-side tripwires whose gains legitimately live in test files (the antihack preset sets this on its tripwires)
      "timeoutSec": 300
    }
  ]
}
```

### `extract` modes
| mode | reduces command output to |
|---|---|
| `number` (default) | the last number found in stdout |
| `lines` | count of non-empty stdout lines |
| `exit` | `1` if the command exited 0, else `0` |
| `{regex}` | first capture group of the regex over stdout |

## Trust / noise model (the credibility core)

A number that jitters between runs is worthless as a signal, so a delta is only believed if it clears the **observed noise band**.

- With `--repeat N`, each metric is sampled N times per ref; the **value** is the median, the **noise** is `max(spread(before), spread(after))` where `spread = max − min`.
- `withinNoise = repeat>1 && |delta| ≤ noise`.
- A metric may **declare** its band: `"noise": <number>`, in the metric's own units. Then `noise` is that number whatever the repeat count, `withinNoise = |delta| ≤ noise`, and the observed spread is reported beside it as `spread`. This is for a number that does not hold still by nature (a model-graded score, a timing): there the observed spread widens with every repeat added, so more repeats hid a real gain, and with one run a side there was no band at all. `calibrate` measures the band: the gap that two medians of `repeat` runs stay inside 95 times in 100 when nothing changed, drawn from N runs at one commit with a fixed seed.
- The declared band in force is the one the contract had **before** the change. A change cannot widen it to hide a fall or narrow it to turn a wobble into a win; a band a change adds counts from the next change on.

| condition | confidence | guard behavior |
|---|---|---|
| `extract` is `exit`/`lines` (deterministic) | `high` | normal |
| `repeat == 1` (noise unknown) | `unverified` | regression still fails (conservative) - run `--repeat` to de-flake |
| `repeat > 1`, `noise == 0` | `high` | normal |
| `repeat > 1`, delta clears noise | `medium` | normal |
| `repeat > 1`, delta inside noise | `low` | **never fails** - status is `inconclusive` |
| `noise` declared, delta clears it | `medium` (`high` when the declared band is 0) | normal, at any `repeat` |
| `noise` declared, delta inside it | `low` | **never fails** - status is `inconclusive`, at any `repeat` |

So `--repeat` is how you trade time for trust: it earns a real confidence label and stops flaky metrics from failing guards.

## Verdict schema (`--json`)

```jsonc
{
  "base": "a1b2c3d", "head": "e4f5g6h", "repeat": 5, "mode": "refs",
  "verdict": "pass",             // pass | fail | gamed | inconclusive  (gamed detection is on by default, --no-detect-gaming turns it off; inconclusive = an inert guard measured nothing - exit 3)
  "metrics": [
    { "name": "lint_errors", "direction": "down", "guard": true,
      "before": 12, "after": 7, "delta": -5,
      "status": "improved",        // improved | regressed | unchanged | inconclusive | unmeasurable
      "ok": true,                  // for guards: did it avoid a trusted regression?
      "confidence": "high",        // high | medium | low | unverified | none
      "noise": 0 }
  ]
}
```

Exit code: `0` = pass · `1` = fail (a guarded metric had a trusted regression, or a mandate was violated) · `2` = **`GAMED`** (a win that didn't survive the source-only re-run, or a weakened gate) · `3` = **inconclusive** (an inert guard measured nothing) · `64` = a usage or config error (`EX_USAGE`: a malformed config, a missing `extends` target, an unknown command, preset or flag, a flag with a missing or unusable value such as `--repeat abc`). 64 is deliberately outside the verdict range so a broken config can never be read as a verdict. A run writes nothing to the repo.

## Testing

`npm test` (= `node --test`) runs `test/promptwheel.test.mjs` - **dep-free tests**: unit coverage of `extract`, `median`/`spread`, the `evaluate` noise/confidence logic, `renderMarkdown`, the source/non-source classifier and `judgeGaming` (imported directly), plus integration tests that spawn the real CLI or call `check()` against throwaway git repos (run pass/fail, `--working` + tree-untouched, gaming detection, evaluatorPaths, mandates, gate integrity and fingerprints, the allow trailer, zero-config, `init` presets, exit 64 on a broken config, `--version`/`--help`). No test dependencies.

`npm test` also runs `test/improve-loop.test.mjs`: the tests of the loop step in `examples/improve-loop`. Each builds a small repo and runs the real step against the real engine. One test in the main file fails, and says why, if the loop or its tests go missing.

## Design constraints
- **Zero runtime dependencies, no build.** Node 18+, ESM, runs straight from source.
- **Never mutate the working tree.** Throwaway worktrees only.
- **Deterministic-friendly, noise-honest.** Prefer cheap deterministic metrics; for noisy ones, demand `--repeat`.
- **Importable + tested.** Pure helpers exported; CLI guarded behind a direct-invocation check.
- **The loop is not in the engine.** `examples/improve-loop/improve.mjs` is the one keeper: a keep-or-put-back step that shells `run --json`, shipped in the package and run by `improve`. The engine had a keeper of its own until 0.8.0 removed it as unused; on 2026-11-21 the loop came back, briefly as three keepers, and the owner chose one, outside the engine. The engine's surface stays the check. The floor against the best score so far lives in the loop too: the gate compares two commits and keeps no history.
