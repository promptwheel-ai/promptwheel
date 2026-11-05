# Architecture (v0)

The whole engine is `bin/promptwheel.mjs` (~1290 LOC, Node ESM, zero deps). It is intentionally a single file - importable (pure helpers are exported for unit tests) that runs the CLI only when invoked directly.

## Flow

```
config (promptwheel.config.json)
        │
   resolve base ref (default: merge-base HEAD origin/main)  and  head ref (default: HEAD)
        │
   for each ref:  git worktree add --detach (throwaway)  ──►  run each metric ×repeat  ──►  remove worktree
        │
   per metric:  median(before-samples), median(after-samples),  noise = max(spread(before), spread(after))
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
| `run --no-record` | accepted and does nothing; no record is written |
| `init [--preset <name> \| --list] [--no-agent-block]` | write a starter config (detect stack; presets `antihack`/`no-ai-tells`/`supply-chain`) and an agent-orienting block in `AGENTS.md` |
| `lock` | write `promptwheel.lock.json`, the shape of the repo, held by the `supply-chain` preset |
| `pr-allow` | read a PR's comments as JSON on stdin and print the newest `sawbuck-allow:` reason from someone with write access (the Action's approval step) |

### detect-gaming (antihack)
`run --detect-gaming` re-proves every *win* from the agent's source edits **alone**. After the normal gate, it partitions the head diff into **production source** vs. **`{test, config, grader, golden}`** files, rebuilds a clean worktree at the base with **only the source slice** applied, and re-runs the gate. If a guarded win does **not** survive that source-only re-run - because it passed by editing/skipping a test, mocking the grader, editing a golden, relaxing config, or touching zero source files - the verdict is **`GAMED`** (exit 2). Metrics with `gamingCheck: false` are exempt from the re-run (test-side tripwires whose gains legitimately live in test files; the `antihack` preset sets this). Deterministic, zero-LLM: a diff partition plus a re-run, so every flag is reproducible with a human-readable reason. The 50%-of-gain-survives threshold is the default and is tunable. See `DETECTION-LAYERS.md` for scope and `../bench/RESULTS.md` for measured recall.

## Config schema - `promptwheel.config.json`

```jsonc
{
  "extends": "./promptwheel.base.json",  // optional: inherit guardrails from a shared base (path or array)
  "repeat": 1,                 // default sample count (overridden by --repeat)
  "linkDirs": ["node_modules"], // dirs symlinked from the repo into each measuring worktree (deps that live outside git, e.g. node_modules / .venv / target); default ["node_modules"]. Back-compat: linkNodeModules:false links nothing.
  "env": { "PYTHONPATH": "{wt}/src:{wt}" }, // optional env vars for metric commands; {wt} substitutes to the worktree path
  "setup": "npm run build",    // optional per-ref build/install run after any source patch (best-effort; a failed setup leaves the metric inert → inconclusive)
  "metrics": [
    {
      "name": "lint_errors",
      "cmd":  "npx eslint . | grep -c error",  // any shell command, run inside the worktree
      "extract": "number",     // number | lines | exit | { "regex": "coverage: (\\d+)" }
      "direction": "down",     // up (higher better) | down (lower better) | pass (boolean 0/1)
      "guard": true,           // true = a trusted regression FAILS the gate; false = informational
      "gamingCheck": true,     // (default true) include this metric in --detect-gaming's source-only re-run; false exempts test-side tripwires whose gains legitimately live in test files (the antihack preset sets this on its tripwires)
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

| condition | confidence | guard behavior |
|---|---|---|
| `extract` is `exit`/`lines` (deterministic) | `high` | normal |
| `repeat == 1` (noise unknown) | `unverified` | regression still fails (conservative) - run `--repeat` to de-flake |
| `repeat > 1`, `noise == 0` | `high` | normal |
| `repeat > 1`, delta clears noise | `medium` | normal |
| `repeat > 1`, delta inside noise | `low` | **never fails** - status is `inconclusive` |

So `--repeat` is how you trade time for trust: it earns a real confidence label and stops flaky metrics from failing guards.

## Verdict schema (`--json`)

```jsonc
{
  "base": "a1b2c3d", "head": "e4f5g6h", "repeat": 5, "mode": "refs",
  "verdict": "pass",             // pass | fail | gamed | inconclusive  (gamed only with --detect-gaming; inconclusive = an inert guard measured nothing - exit 3)
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

Exit code: `0` = pass · `1` = fail (a guarded metric had a trusted regression, or a mandate was violated) · `2` = **`GAMED`** (a win that didn't survive the source-only re-run, or a weakened gate) · `3` = **inconclusive** (an inert guard measured nothing) · `64` = a usage or config error (`EX_USAGE`: a malformed config, a missing `extends` target, an unknown command or preset). 64 is deliberately outside the verdict range so a broken config can never be read as a verdict. This JSON is the persisted reward stream (`.promptwheel/outcomes.jsonl`), appended once per gated run.

## Testing

`npm test` (= `node --test`) runs `test/promptwheel.test.mjs` - **134 dep-free tests**: unit coverage of `extract`, `median`/`spread`, the `evaluate` noise/confidence logic, `renderMarkdown`, the source/non-source classifier and `judgeGaming` (imported directly), plus integration tests that spawn the real CLI or call `check()` against throwaway git repos (run pass/fail, `--working` + tree-untouched, gaming detection, evaluatorPaths, mandates, gate integrity and fingerprints, the allow trailer, zero-config, `init` presets, exit 64 on a broken config, `--version`/`--help`). No test dependencies.

## Design constraints
- **Zero runtime dependencies, no build.** Node 18+, ESM, runs straight from source.
- **Never mutate the working tree.** Throwaway worktrees only.
- **Deterministic-friendly, noise-honest.** Prefer cheap deterministic metrics; for noisy ones, demand `--repeat`.
- **Importable + tested.** Pure helpers exported; CLI guarded behind a direct-invocation check.
