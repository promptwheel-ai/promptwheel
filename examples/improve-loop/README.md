# improve-loop: one step of a self-improving loop

Run an attempt. Ask the gate. Keep the change, or put it back.

```bash
node examples/improve-loop/improve.mjs --attempt "<command that changes the repo>"
```

The attempt is any command that edits files: an agent, a script, a codemod. The step runs it, asks
`promptwheel run --working --json` what moved, and reads the answer.

Run it in a loop and it stops by itself when the attempts stop winning:

```bash
while node examples/improve-loop/improve.mjs --attempt "my-agent 'make the score better'"; do :; done
```

## What it keeps

A change is kept only when the gate passes **and** the target metric improved. A pass alone is not
enough: the gate passes a change that does nothing.

| flag | what it does |
|---|---|
| `--target <metric>` | the metric the loop is raising. Default `score`. |
| `--cheaper <metric>` | also keep a change that holds the target (or moves it inside its noise band) and lowers this metric. |
| `--floor` | hold every kept change against the best target value so far, not only against its parent. |
| `--label <name>` | a name for the attempt in the record. Default: the attempt command. |
| `--repeat N` | handed to the gate: N readings a side. |
| `--base-cache <dir>` | handed to the gate: measure the base once. The folder must sit outside the repo. |
| `--json` | print the record line as JSON instead of the one-line summary. |

A flag it does not know is an error. A mistyped `--floor` should not quietly turn the floor off.

## Exit codes

| code | meaning |
|---|---|
| 0 | kept: one new commit |
| 1 | put back: a guard got worse, or the change is under the floor |
| 2 | put back: gamed. The win came from the test, the grader or the config |
| 3 | put back: nothing improved, or the gate could not tell |
| 64 | could not run. Nothing was kept |

## Why `--floor`

The gate compares two commits. It keeps no history. So a loop can lose ground one small step at a
time: each step drops the score a little, each drop sits inside the noise band, each step passes.

`./run-demo.sh` shows it. The same small trade, four times, on a score with a band of 10:

```
Without a floor:   kept, kept, kept, kept      score 100 to 80
With --floor:      kept, kept, worse, worse    score stops at 90
```

With `--floor` the step asks the gate a second time, with the best commit so far as the base. The
best commit is kept in `.git/improve/best.json`.

## The record

Every attempt, kept or not, is one line in `.git/improve/attempts.jsonl`: the label, the result,
the reason, the files, and what the gate measured. The change itself stays reachable as
`refs/improve/<n>`, so a change that was put back can still be read.

The attempt command gets the path of the record in `IMPROVE_RECORD` and the target's name in
`IMPROVE_TARGET`. A proposer can read what was already tried.

## What an attempt cannot touch

The loop's own files are read before the attempt runs and put back after it:

- the record and the floor file
- the refs of earlier tries
- the base cache folder (`--base-cache`), and anything an attempt adds to it
- the gate program, when `PROMPTWHEEL` names its file (as in `node path/to/promptwheel.mjs`)
- this step

If an attempt touched one, the line for that attempt says which (`restored`), and the printed line
says so too. If an attempt deleted earlier tries so they cannot be put back, the line lists them
(`refsLost`).

## What it will not do

- It will not run on a dirty tree. It needs a clean commit to put a change back to. An edited file
  that is hidden from git (skip-worktree, assume-unchanged) counts as dirty.
- It will not keep anything the gate did not judge. The attempt's change is made into one commit,
  the gate judges that commit, and that same tree goes on the branch. No git hook runs. A file
  edited after the gate looked is not in it.
- It will not let an attempt hide a file from git. The file is shown again and judged.
- It will not let an attempt that commits its own work skip the gate. The commits are taken back
  into the working tree and judged like any change.
- It will not let an attempt throw away earlier commits. The branch is put back, and the step stops.
- It will not remove ignored files when it puts a change back.
- It will not leave a half-made change behind when you stop it with Ctrl-C. The attempt is put back, and the
  step exits 64, so a `while` loop ends.

## What it is not

- **Not a sandbox.** The attempt runs as you, with your shell. What git does not track is out of
  sight: an installed dependency the scorer runs, a database, a process the attempt leaves running.
  An attempt that edits `node_modules` can move the score, and nothing here will see it. To hold
  those, run the attempt where it cannot write them: a container, or another user.
- **Not a judge of what a rule would still prevent.** `--cheaper` keeps a change that holds the score
  and lowers a cost. A safety rule that a second rule still covers can be deleted that way, and no
  score shows it. Freeze what protects with a mandate in the contract, and the gate sends such a
  change back.
- **Not part of the engine, and not in the npm package.** PromptWheel is the check. This is one loop
  built on the check, in about 200 lines. Copy it and change it.
- **Not proven on real work yet.** It has been run on small scripted scorers. Those test the
  mechanics. They do not show that a loop makes anything better over time.

## If you copy it into your repo

- Freeze its path with a mandate in the contract, so a change to it is sent back by the gate too:
  `"mandates": [{ "name": "step-frozen", "paths": ["tools/improve.mjs"], "reason": "the loop step is not edited by the change it judges" }]`
- Name the gate by its file in `PROMPTWHEEL`, so the step can put it back. A gate started as
  `npx promptwheel` cannot be watched.
- To improve the gate's own code with the loop, judge with a released copy kept outside the repo.
  The step puts back any edit to the gate it is judging with.

## Why it is here

The engine had this as `promptwheel improve --attempt` from 0.0.2. Version 0.8.0 removed it, with
its four tests, as a command nothing relied on. On 2026-11-21 the owner asked for it back.

It came back as an example, not a command, so the engine stays small. Its tests are in
`test/improve-loop.test.mjs`, and they run with `npm test`. One test in the main suite fails, and
says why, if this folder or those tests go missing.

Ask the owner before removing either.
