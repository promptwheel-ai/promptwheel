# The wheel: the record, the loop, and what may be said about them

Status: **built, and its claim is still closed.** The code below runs and is tested. No page of ours says the loop
gets better with use, because that has not been shown. This file says what would show it.

## What there is

| | what it does |
|---|---|
| the record | every checked run adds one short row: the verdict, each measure before and after, and the top folders the change landed in. It is in the repo's git folder (`promptwheel/outcomes.jsonl` under `git rev-parse --git-common-dir`), so it is never in the working tree, never in a commit, and one record serves every worktree of the repo. Nothing a person typed is in a row. A label is there only when `--label` gave one. `run --no-record` adds no row |
| `improve --attempt "<cmd>"` | the loop's one step. Run any agent or script, check what it changed, and keep it as one commit only if a measure improved. If a guard got worse, if the win came from a change to the tests, or if nothing improved, the tree is put back as it was. A count that only guards (tests, assertions) going up is not a win. Commits the attempt made itself are folded back and checked as one change |
| `insights` | how each measure has responded, straight from the record |
| `playbook` | what has paid here: for each measure, and each measure in each folder, how often a change helped when it moved. A row counts half as much every 20 runs. A line is shown only past 3 weighted runs in which the key moved. Then the list of what the loop tried and threw away, newest first, each with the measured reason |
| `suggest` | where to spend the next attempt: a lever that has paid, or what was tried least (UCB). When the last 3 attempts kept nothing, it names the least tried arm first. It offers no measure that is gone from the contract, and no count that only guards |
| `backfill` | fills the record from past commits, each checked against its parent with the measures as they are now. Rows are marked `backfill`, and a commit's type (fix, feat, ...) becomes its label |

The record is read as a hint and never changes a verdict. Anything that can write to the repo can write to it.

## What may be said, and what may not

**May be said:** the loop keeps a change only if it measured better, and puts the tree back if not. That is the
check, run on an attempt. It is tested.

**May not be said, until it is shown:** that the loop gets better with use, that the playbook makes later attempts
better, or that the list of what was thrown away keeps an attempt from being tried twice.

The test is `bench/compounding-ab.mjs`. Two arms take turns on one repo with one agent. One arm is handed a fresh
playbook before each attempt and the other is not. The check judges every attempt. The claim opens only if the
playbook arm keeps more, by 15 points or more over 20 attempts or more, and again on a second repo. A run that
shows no gap is written down the same way.

What is known so far points both ways:
- A controlled test of notes across runs (March 2026) found they saved tokens and did not make the code better.
- In sessions, a change a person had undone came back in the next session 27 of 27 times with nothing shown, and
  0 of 27 with the undo and the person's reason at the prompt. A line that only stated the fact did not carry it
  (22 of 27 came back). A line that said to stop and ask did (1 of 27). So a bare list of rejects is not known to
  be enough. The reason is what carried. (Sawbuck's benches, 2026-11-10 and 2026-11-17.)
- Google's RRSI paper (arXiv 2609.24972) measured a loop of this shape on agent harnesses. Without brakes it
  gained on its own tasks (89.4 to 92.8), gained almost nothing on unseen ones (39.7 to 40.3), and used 2.4 times
  the tokens. With brakes it gained less on its own tasks (90.5) and more on unseen ones (43.6).

## The parts, beside RRSI's

RRSI searches over an agent's harness with the tasks held fixed. This loop searches over a repo's files with the
agent held fixed. The parts line up, and where they do not, it is said.

| RRSI | here |
|---|---|
| a candidate: a bundle of edits, each with a hypothesis | one attempt: whatever the command changed, with a label if the driver gives one |
| score on the task set, several trials | the contract's measures, each run `repeat` times, the middle value taken |
| a noise band from re-running the unchanged base | the spread of the repeats. A move inside it is not a move |
| the floor: no worse than the best so far, less the noise | a guard may not get worse than the base, and the base is the last kept commit |
| the cost rule: a gain must pay for what it costs | `budget` on a guard, since 0.8.14 |
| the leak critic, a model that reads the diff for task-specific edits | no model. A win is run again from the source edits alone, and a protected path fails the check. It asks a narrower thing: did the gain come from changing the measure? |
| the edit log: every edit tried, with what it did and whether it was kept | the record, and the playbook's list of what was thrown away |
| the exploration slot when the search stalls (3 rounds) | `suggest`: the least tried arm, named first after 3 attempts with nothing kept |
| the edit budget that shrinks over the rounds | not here. The size of an attempt is the agent's |
| the pruner, which removes parts that stopped paying | not here. A line in the playbook fades unless it is earned again. Nothing is removed from the repo |
| a held-out set the search never sees | not here, and it is the largest gap. A loop that improves the repo's own tests can fit those tests. The source-only re-run stops the cheapest way and no other |

## History

Built in June and July 2026 (`improve`, the record, `insights`, then `playbook`, `suggest`, `backfill` and the
compounding test). Removed in November 2026 for a smaller surface before launch: the views in 0.7.5 and the loop
and the record in 0.8.0. Neither cut followed a measurement, and the compounding test had never been run on real
use. When the record was cut it held 224 rows across six repos, and none of them was an attempt of the loop: the
loop itself had not been given real work. Put back in November 2026, with the changes named at the top of the
engine's section "The wheel".
