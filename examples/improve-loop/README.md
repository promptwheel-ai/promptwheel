# improve-loop: the loop's one keeper

Run an attempt. Ask the gate. Keep the change, or put it back.

```bash
promptwheel improve --attempt "<command that changes the repo>"
node examples/improve-loop/improve.mjs --attempt "<command that changes the repo>"   # the same thing, run directly
```

`promptwheel improve` runs this file, which ships in the package. It is the one keeper: on 2026-11-21 there
were three (this step, a copy of it in the framework's treegate, and a command inside the engine), and the owner
chose one, outside the engine. It asks the engine as a separate process.

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
| `--target <metric>` | the metric the loop is raising. Default `score`. Through `promptwheel improve`, a contract with no `score` gets its only measure, or its only one that is not a tripwire; one that leaves a choice is refused before the attempt runs. |
| `--cheaper <metric>` | also keep a change that holds the target (or moves it inside its noise band) and lowers this metric. |
| `--floor` | hold every kept change against the best target value so far, not only against its parent. |
| `--label <name>` | a name for the attempt in the record. Default: the attempt command. |
| `--repeat N` | handed to the gate: N readings a side. |
| `--base-cache <dir>` | handed to the gate: measure the base once. The folder must sit outside the repo. |
| `--may-change <patterns>` | the only paths an attempt may touch, with commas between: `src/**, prompts/*.md`. Anything else and the try is put back whole, before the gate is asked. |
| `--turns N` | judge over a number of turns (below). |
| `--patience P` | with `--turns`: end the run after P turns with no new best, once there is one. Default 3. |
| `--json` | print the record line as JSON instead of the one-line summary. |

A flag it does not know is an error. A mistyped `--floor` should not quietly turn the floor off.

## Exit codes

| code | meaning |
|---|---|
| 0 | kept: one new commit |
| 1 | put back: a guard got worse, the change is under the floor, it changed a file it may not, or it changed the contract |
| 2 | put back: gamed. The win came from the test, the grader or the config |
| 3 | put back: nothing improved, the gate could not tell, or the change was too wide to read |
| 64 | could not run, or the attempt could not. Nothing was kept |

**An attempt that could not run is not a try.** If your attempt command ends with 64, or the shell could not
run or find it (126, 127) and no file changed, the step puts back whatever is there, writes no line to the
record and exits 64. So a broken command stops a `while` loop and does not fill the record with "nothing".
An attempt that fails any other way and changed no file is a try, on record as `nothing`. A wrapper script
around an agent should end with 64 when the agent could not start at all: no sign-in, a usage limit, no network.

**A change too wide to read is a try.** The step reads up to 256 MB at once from git and from the gate
(`IMPROVE_READ_MAX` sets it, in bytes). Node's own limit of 1 MB was too little for a change of some 10,000 files,
and such a try used to end with 64 and no line. A change wider than the step's room is put back and on record as
`nothing`, with the reason, and the step exits 3.

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

## Over a number of turns

One attempt judged alone is put back unless it improved by itself, so a change that needs a level step first can
never be kept. With `--turns N`:

- each turn goes on from where the last one left the tree;
- after every turn the whole change so far is judged against the commit the run started from, so a test edited at
  one turn makes no win at a later one;
- the next turn is told the reading, in a file whose path is in `PW_FEEDBACK` (`PW_TURN` and `PW_TURNS` say where the
  run is);
- a turn that left the tree as the last one did is not judged again;
- the best turn is kept, as one commit, after it is measured once more. If no turn won, the tree is put back.

The run ends early when a turn that ended by itself changed nothing, when the target can go no further, or after
`--patience` turns with no new best. Ctrl-C puts the tree back, and keeps a best turn that had passed its check.
A turn whose attempt could not run ends the run too, as a run ends: a best turn is kept once it wins again when
measured once more. At the first turn nothing was tried, and no line is written.
Every turn is a line in the record, and the run ends with a line of its own.

## Behind the wall

```
node improve.mjs --attempt 'node wall.mjs --with node_modules --minutes 10 -- "sh my-agent.sh"'
```

The attempt runs in a new folder. That folder holds your tracked files and a git repo of its own. Your `.git` is
not there. When the attempt ends:

- what it changed, added or deleted comes back as plain changes for the step to judge;
- files that git ignores do not come back;
- every process it left running in its group is ended.

`--with` copies a folder git does not track, so the attempt has its own copy to use: an installed dependency it
edits is only its copy. `--minutes` ends an attempt that runs too long (35,000 at most: the timer cannot count
further). `--no-record` keeps the loop's record from the attempt.

The wall is a copy. It is not a sandbox: see "What it is not".

## A run under a plan

Write the plan, commit it, then start the run.

```json
{
  "attempt": "sh tools/propose.sh",
  "tries": 20,
  "mayChange": ["src/**"],
  "target": "score",
  "stopAfterFlat": 5,
  "best": 70,
  "wall": { "with": ["node_modules"], "minutes": 10 },
  "heldOut": "sh /elsewhere/heldout.sh"
}
```

```
git add improve.plan.json && git commit -m "the plan"
promptwheel improve --plan improve.plan.json
promptwheel improve --report
```

- The plan is read once, from the commit you were on. A try cannot change the rules of its own run.
- A plan must say what may change. The list may not let a try edit the plan.
- The wall, the floor and the base cache are on unless the plan turns them off.
- `heldOut` is a command that prints one number. It runs at the start and at the end only. No try is shown it, and
  it never decides a keep. If the end number is lost, the next start measures it.
- `best` is the best value the target can read, like 70 for 70 tasks. A gain is kept only when it is more than the
  gate's band for the target, so when what is left up to the best value is no more than the band, no try can be
  kept, and the run stops and says "no room left". The band is the one the gate held the try to (the contract's,
  else the spread it measured over its repeats), as the step writes it into the record. `best` cannot be used with
  `cheaper`.
- `arms` are named variants of one plan. One arm runs in one clone.
- Stop a run with Ctrl-C. The try in hand is put back. Start it again and it goes on from there.
- A run does not use turns yet.

Each try is one call of the step, so every rule above holds for it. The run keeps an account of its own beside the
step's record, in `.git/improve/runs.jsonl`.

## The report

`promptwheel improve --report` lists every try with its result, the kept rate, where the target started and where it
is now, the held-out number at both ends, and how often the gate was asked. Then it checks that the step's record,
the kept changes and the run's own account agree. If a line was deleted, it says "whole: no" and exits 1.

## The contract is yours

A change the gate would keep is put back when it touched `promptwheel.config.json`, a file inside the repo that it
extends, or a file its `evaluatorPaths` name, as they stood when the step started (result `contract`, exit 1). A
change the gate already sends back keeps the gate's result.

## A run that is killed

A run killed outright cannot put anything back. It leaves `.git/improve/running.json`, and the next run names the
commit it started from, with the line that puts the tree back, before it does anything.

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

Git's own files are held the same way. Git does not track them, an attempt can write them, and
the step and the gate both run git:

- the repo's git config, its hooks folder and its `info` folder (attributes, exclude)
- your global git config, and a global attributes or ignore file
- every ref but the branch the step is on: tags, other branches, replace refs

So a hook, a filter, a replace ref or an fsmonitor command that an attempt sets is gone before the
change is judged. After the attempt, the step's git calls and the gate's run no hook at all,
whatever folder the hooks are in. A branch the attempt made and left the repo on is not removed:
the step stops, and the branch is there for you to look at.

This needs git 2.31 or newer. An older git ignores the setting that turns hooks off for the
step's own git calls, and says nothing, so the step refuses to run on one.

One thing to know: if you change your own global git config while an attempt is running, the
step reads that as the attempt's doing and puts it back. The line names the file.

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
  An attempt that edits `node_modules` can move the score, and nothing here will see it. A process
  it leaves running can edit the copy the gate measures in, which sits in the temp folder, and a
  change that moved no number is then kept as a win. To hold those, run the attempt where it cannot
  write them and cannot leave a process behind: a container, or another user.
  The wall holds some of this: behind it, an installed dependency is only the attempt's copy, and a
  process left in its group is ended. It is a copy, still not a sandbox. An attempt can find your real
  repo by its full path and write files there that git ignores, and it can start a process that leaves
  its group. Both got through the wall when tried. A container handed the copy and nothing else stopped
  every attempt on the list:
  `node wall.mjs -- 'docker run --rm --network none -u $(id -u):$(id -g) -v "$PWD":"$PWD" -w "$PWD" node:22-bookworm sh my-agent.sh'`.
  And reading is not stopped: a held-out set is held out only where the attempt cannot reach it.
- **Not a judge of what a rule would still prevent.** `--cheaper` keeps a change that holds the score
  and lowers a cost. A safety rule that a second rule still covers can be deleted that way, and no
  score shows it. Freeze what protects with a mandate in the contract, and the gate sends such a
  change back.
- **Not part of the engine.** PromptWheel is the check. The step, the wall, the run and the report are
  one loop built on the check, and they ship in its package, beside it. Copy them and change them.
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

It came back as an example, not a command, so the engine stays small. The same day the engine grew a
keeper of its own, and the framework's treegate made a copy of this one. The owner chose one keeper: this
file. What the other two had and this one lacked (turns, the contract rule, the mark of a killed run, the
list of what may change, a count of gate asks) is here now, and `promptwheel improve` runs it. Its tests are in
`test/improve-loop.test.mjs`, and they run with `npm test`. One test in the main suite fails, and says why,
if this folder or those tests go missing.

**Its home is this package, and its path is kept.** (The owner's decision, 2026-11-22.) It ships with the gate
whose report it reads, it is tested with that gate, and `promptwheel improve` runs it with nothing else
installed. It does not move into treegate: the engine's own command would then hang on treegate while treegate
hangs on the engine for its gate, and the keeper and the gate could drift apart. Tools built on the keeper run
this file from where it sits, beside the engine they use as their gate (`bin/promptwheel.mjs` and
`examples/improve-loop/improve.mjs` in one package). So do not move or rename it without telling them first.

**The wall, the run and the report moved in on 2026-11-22.** (The owner's word: "yes make it promptwheel's
loop".) The framework session had built them around this step in a folder of its own. They now sit beside it, and
the piece has no name of its own. Their tests are `test/improve-loop-step.test.mjs`, `-wall` and `-run`, and the
code broken on purpose one small way at a time, to see that a test notices, is `test/improve-loop-breaks.py`.

Ask the owner before removing any of it.
