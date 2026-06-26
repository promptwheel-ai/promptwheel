# Architecture (v0)

The whole engine is `bin/promptwheel.mjs` (~200 LOC, Node ESM, zero deps). It is intentionally a single file.

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
   verdict = any guard failed ? "fail" : "pass"   →   print (human | --json)   →   exit (0 | 1)
```

The working tree is **never** touched — every read happens in a temp worktree that is removed afterward.

## Config schema — `promptwheel.config.json`

```jsonc
{
  "repeat": 1,                 // default sample count (overridden by --repeat)
  "linkNodeModules": true,     // symlink repo node_modules into worktrees (fast; default true)
  "metrics": [
    {
      "name": "lint_errors",
      "cmd":  "npx eslint . | grep -c error",  // any shell command, run inside the worktree
      "extract": "number",     // number | lines | exit | { "regex": "coverage: (\\d+)" }
      "direction": "down",     // up (higher better) | down (lower better) | pass (boolean 0/1)
      "guard": true,           // true = a trusted regression FAILS the gate; false = informational
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
| `repeat == 1` (noise unknown) | `unverified` | regression still fails (conservative) — run `--repeat` to de-flake |
| `repeat > 1`, `noise == 0` | `high` | normal |
| `repeat > 1`, delta clears noise | `medium` | normal |
| `repeat > 1`, delta inside noise | `low` | **never fails** — status is `inconclusive` |

So `--repeat` is how you trade time for trust: it earns a real confidence label and stops flaky metrics from failing guards.

## Verdict schema (`--json`)

```jsonc
{
  "base": "a1b2c3d", "head": "e4f5g6h", "repeat": 5, "verdict": "pass",
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

Exit code: `0` = pass, `1` = fail (a guarded metric had a trusted regression), `2` = config/usage error. This is the JSON that later becomes the persisted reward stream (Roadmap Phase 2).

## Design constraints
- **Zero runtime dependencies, no build.** Node 18+, ESM, runs straight from source.
- **Never mutate the working tree.** Throwaway worktrees only.
- **Deterministic-friendly, noise-honest.** Prefer cheap deterministic metrics; for noisy ones, demand `--repeat`.
