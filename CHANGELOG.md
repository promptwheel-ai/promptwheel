# Changelog

## 0.8.18 (2026-11-22): the wheel, put back, and a comment that says what to do

Three things in one release. Each has its own part below.

- **The comment on a gamed win says what to do.** On real pull requests it was one sentence and a table, where the comment for a fallen count says what to do. Now it says to put the files back and fix the source, how a person can accept it, and that changing the check is not a way through, in the sentences measured for a fallen count. It also named "the agent" whoever made the change. It names no one now.
- **The report says when an earlier state could not be run.** Both commits are measured with what is installed now. A change that removes a tool the earlier tests need leaves the earlier state unable to start, and the move reads as failing, then passing: an honest tool swap by a person read `gamed` on a real commit. The measure now carries `baseUnrun`, with the line that names what is missing. It is the reading alone. No verdict reads it yet, because a change that takes out the test runner looks the same, and that case is settled first. A file that cannot be read inside a package that is not installed is read as a missing dependency.
- **The pages' words.** The demo is a gamed green built by hand (`examples/gamed-green`). A metric has guards. The help's line for `run` says what it does by default. The sentence on where the check runs says what is not run there.

### The wheel, put back

- **One keeper.** For a day the loop had three keepers: the step in `examples/improve-loop/` (written by another session), a copy of it in that session's treegate, and a command inside the engine (the `improve` the bullets below describe as it was built). The owner chose one, outside the engine: the step. What the command and the copy had and the step lacked is in the step now: `--turns` and `--patience`, the contract rule, the mark a killed run leaves, `--may-change`, and a count of gate asks. `promptwheel improve` is a door that runs the step, which ships in the package; `--goal` is another name for its `--target`, and a win is a gain on that target. With none named, the target is `score`, or the contract's only measure, or its only one that is not a tripwire: on the contract `init` writes, and with no config, the test run. A contract that leaves a choice, or cannot be read, is refused before the attempt runs, where the step alone finds out only after it. The engine's own keeper is gone, with its 34 tests: each behaviour is held by a test of the step (132 of them). The views read the loop's record (`.git/improve/attempts.jsonl`) for what was kept and thrown away, in the step's own words. Its home is this package, and its path stays (the owner's decision, 2026-11-22): it ships with the gate whose report it reads, and tools built on it, such as the framework session's treegate, run it from beside the engine they use as their gate. The new code was broken on purpose: my 32 breaks were caught 28 of 32 at first, a second reader's 20 were caught 0 of 20; each gap has a test now. One of the reader's was a bug: a run over several turns did not stop on Ctrl-C when the attempt caught the signal and ended by itself (the step is synchronous, and its handler never ran in time). It stops now, and keeps a best turn that had passed.
- **An attempt that could not run is not a try.** Found in the first real run of a loop on this step: an attempt script crashed before its agent started, the step wrote "nothing" for each try, and a plan of tries was used up in two seconds. Now an attempt command that ends with 64, or that the shell could not run or find (126, 127) with no file changed, writes no line and ends the step with 64. Any other failure with no file changed is still a try. In a run over turns the same holds for the first turn, and a later turn that could not run ends the run as a run ends: a best turn that had passed is kept once it wins again when measured once more, and anything else is put back. And the step refuses a git older than 2.31, which ignores the setting that holds hooks off for the step's own calls. The framework session found it and wrote it, for its copy and then onto the one keeper; the two ports agreed but for that second look. Its 13 tests are here as written, with 4 more.
`improve`, the record of every checked run, and the views over it (`insights`, `playbook`, `suggest`, `backfill`) were built in June and July 2026 and removed in November (0.7.5 and 0.8.0) for a smaller surface. Neither cut followed a measurement. They are back, with these changes.

- **The record is one short row a run, in the repo's git folder.** Not in the working tree: no run leaves a file to commit or ignore, and every worktree of a repo writes the one record. A row holds the verdict, each measure before and after, and the top folders the change landed in. Nothing a person typed is in it: the command line of an attempt is no longer kept, and a label is there only when `--label` gave one. A record written before 0.8.0 is still read where it is.
- **`run` adds a row again, unless `--no-record`.** The report is not changed. The library's `check()` adds a row only with `record: true`.
- **`improve` does not keep more tests alone.** More of a count that can go up for free (tests, assertions) is not a win. Fewer of what the contract counts is. **`--goal <measure>`** says which measure an attempt is for, and then only that one makes a win. An attempt that makes commits of its own is folded back and checked as one change (it used to pass unchecked: the tree looked clean). An attempt's own output goes to stderr, so `--json` is the report alone. A plain `git status` that hides untracked files no longer lets `improve` start on a tree that holds a person's work.
- **The playbook lists what was tried and thrown away,** newest first, with the measured reason.
- **`suggest` names the least tried arm after three attempts with nothing kept,** and offers nothing an attempt could not improve: no measure that is gone from the contract, no count that more of alone is not a win, no guard that already passes. On the first real record the views met (224 rows from before 0.8.0), the four arms it put first were measures no contract held any more.
- **`improve --turns N`: judged over a number of turns.** One attempt judged alone is put back unless it improved by itself, so a change that needs a level step first could never be kept, and under a pass-or-fail measure a fix bigger than one attempt showed nothing until it was whole. With `--turns` each turn goes on from the last, the whole change so far is checked against the commit the run started from, the reading is handed to the next turn (`PW_FEEDBACK`, `PW_TURN`, `PW_TURNS`), and the best turn is kept as one commit after it is measured once more. `--patience` ends a run that has stopped gaining. The record holds a row a turn and a row a run, and `playbook` prints each run's path.
- **Holes closed, two of them named by another session's report.** An attempt that moved the branch back was refused and the branch LEFT there, so a win kept by an earlier run was off the branch: it is put back. An interrupt left a half-made change: the tree is put back, and a best turn that had passed its check is kept. An attempt that left a contract nobody could read crashed the loop with the change still in the tree: it is put back. A run that was killed outright is named by the next one, with the line that puts the tree back.
- **The engine's own switch is not handed to a command it measures.** `PROMPTWHEEL_NO_ALLOW_TRAILER` (Sawbuck sets it) reached this repo's own suite, and six tests about trailers failed at both ends of every check Sawbuck ran here, so they were never checked there.
- **What is judged cannot touch what judges it.** Another session wrote 28 attacks for its own loop step. Run against this command, 8 of the 25 that apply got through, and 6 were holes. Closed: the commit is made from the tree that was judged, with `git commit-tree` (no git hook runs on it, and a file written after the check is not in it); a file an attempt hides from git is shown again and the attempt put back, and the loop does not start while a file is hidden; the loop's record and the engine's own files are put back if an attempt changed them. Now 23 of 25. The two left are limits on every step that was tried, and `docs/LEARNING.md` says them: an installed dependency a measure runs, and a safety rule deleted behind another one.
- **Git's own files, and the engine's own git calls.** The same session wrote eight more attacks. Five went through this command by way of git's own files, which git does not track and an attempt can write: a hook moved the branch after the keep, a filter made the commit hold another number than the one measured (in the repo's config, and in the global one), a replace ref swapped the object the check read for an older one, and an fsmonitor command ran inside the loop's own git calls. Now the repo's git config, its hooks and info folders, the refs, and your global git config, attributes file and ignore file are read before each attempt and put back after it, before the change is judged. If your global config changed while an attempt ran, it is put back and the line names the file. A config file that is a link stays a link. Every git call the engine makes itself runs no hook, no fsmonitor command, and reads no replace object, in `run` as well as in the loop: a replace ref in a repo no longer changes what the check measures. A command the engine runs for you (a metric, the setup, the attempt) gets your environment as you set it. The setting that turns hooks and fsmonitor off needs git 2.31 or newer; an older git ignores it and says nothing. The three that stay open are limits: a process the attempt leaves running can write into the copy the check measures in, and an installed dependency can be edited, by its own path or the repo's full one.
- **`run`: the repeat count is read as it stood at the base.** A change that lowered its own repeat count was measured with fewer readings a side, which is a wider band. It is now measured with the count the base held. A change may raise it, and `--repeat` decides over both.
- **The band reads the second measurement too.** When a change moves a goalpost, each win is measured again with the source edits alone. That reading was read without the noise band, so on a score that wobbles an honest win beside an edited test read `gamed` whenever the re-run rolled low. Now a part of the gain that did not survive and is no wider than the band is not called gamed. If the source alone moved the number past the band, the win stands. If it did not, the second reading is inside the band of both ends: nothing is shown either way, and the metric is not counted as a win (`inconclusive`, with the reason). A win beside an edit to a declared goalpost file is gamed by declaration as before, and a guard edited in the change that wins on it keeps the strict reading. With no band nothing changes.
- **The gate's own tests were tested too.** Another session's lead: the loop's tests had been broken on purpose and the gate's never had. `evaluate`, `judgeGaming`, `deriveVerdict`, `applyBudgets`, `checkMandates` and the pass that calls them were broken in 63 small ways, one at a time, and the suite caught 55. A second reader then proposed 20 breaks it expected no test to catch, and 18 were not caught. They were edges: a value exactly on a band or a budget, a gain on a metric that counts down, a rule edited in the change and hit in both its versions, a threshold written on the metric and for the contract at once, which ref a command ran at. Each gap has a test now (20 tests). Two of the first list's eight change nothing anyone could see.
- **A hint that said the wrong thing.** Found by writing one of those tests. When a guard's command ran and failed at one end of a change and was not there at the other, the report said it "could not run in the clean copy at either ref". It now says it could not run at one ref and failed at the other, and which. The verdict was right and is not changed.
- **The missing-dependency hint keeps the file's name on a long path.** It was cut at 200 characters from the left, so under a temp folder longer than 123 characters the name of the missing file was gone. A long path is now cut in its middle.
- **Inside the loop the contract is the person's.** An attempt added a measure of its own to the contract, satisfied it with one line of source, and was kept, the changed contract with it (found by a second reader of the code, then run). An attempt that changes `promptwheel.config.json`, a file it extends or a file it names as part of the gate is now put back, and a win is a gain on a measure the contract held when the run started.
- **A test that makes a removal loud.** `the wheel is here on purpose` fails, and says what was decided on 2026-11-21, if the loop's commands or its tests go missing.
- **The tests were tested.** The loop's code was broken in 58 small ways, one at a time, and its tests caught 58. That list was the author's. A second reader then proposed 20 breaks it expected no test to catch, and 18 were not caught. Each has a test now.
- **With a real agent, `--turns` is not shown to help.** Three runs: the work left fell in steps, not slopes, and judging over turns was no worse and no better than judging each attempt alone. One of those runs found a fault that is fixed here: a turn that was cut off before it had saved anything ended the whole run.
- **Run once with a real agent before this was written down** (three attempts, a copy of this repo). The first form of the rule on counts threw away three real improvements: it did not ask which way a count runs. Fixed the same night.
- **What is not claimed:** that the loop gets better with use. `bench/compounding-ab.mjs` is the test, and it has not been run on real use. See `docs/LEARNING.md`.
- New exports: `foldOutcomes`, `betaMean`, `scoreKey`. New options on `check()`: `record`, `label`.

### A score that wobbles, and the loop is back

From the branch `feat/noisy-scorer-gate`, a second line of work the same night, merged here as it was written. Not released, and no version is set.

The gate was built for tests that pass or fail. An eval score moves between runs, and the gate did not handle that well. Measured on a made-up scorer with normal noise and nothing changed, 1,000 runs with one run a side: it called a win 496 times and a loss 504 times, and 241 of those runs read `gamed`. More repeats made it worse at seeing a real gain, because the band was the widest gap seen, and that grows with every reading: a gain of three standard deviations was seen 761 times in 1,000 at three repeats, 289 in 500 at five, and 196 in 500 at eight.

- **No second measurement when no goalpost moved.** A change that touched no test, grader or config has a source-only tree that is the tree just measured. Measuring it again asked a noisy scorer the same question twice, and a lower second answer read `gamed`. That measurement now stands. On the same scorer `gamed` went from 241, 55 and 20 in 1,000 (one, two and three repeats) to 0, 0 and 0. A change that did move a goalpost is re-proved as before.
- **A band the contract declares.** `"noise": <number>` on a metric is the band, in the metric's own units. A move inside it is `inconclusive`, with one run a side too. The report keeps the widest gap it saw beside it, as `spread`. The band is part of how a metric is judged, so it is read as it stood at the base: a change cannot widen its own band to hide a loss, or narrow it to claim a win. A contract with no band keeps the fingerprint it had.
- **`promptwheel calibrate`.** Measures the band. It runs a metric N times at HEAD (20 by default) and prints the gap that two medians of `--repeat` readings stay inside 95 times in 100 when nothing changed. It writes nothing. You put the number in the contract.
- **Measured with a calibrated band** (same scorer, the band from 200 runs at the base). Nothing changed, one run a side: a win 31 times in 1,000 and a loss 27 times, where it was 496 and 504. A gain of three standard deviations was seen 877 times in 1,000 at three repeats, 488 in 500 at five, and 499 in 500 at eight. More repeats now help. A gain of one standard deviation at five repeats: 135 in 500, where it was 19.
- **`run --base-cache <dir>`.** Keeps the base's measurement in a folder and uses it again for the same tree measured the same way, so a loop asks a slow or paid scorer about the base once. Off unless asked for. The folder must sit outside the repository: a kept number the change can reach is a goalpost. Only a clean measurement is kept, and the report says when a kept one was used (`baseMeasured`).
- **The counts read PHP.** PHPUnit test methods, `#[Test]`, a docblock `@test`, and skipped or incomplete tests. On a real Drupal module with 489 PHP files the counts read 0 tests and 0 skips before. Now they read 984 and 5. By hand it is 982 test methods and 5 skips: the other 2 are the word in a comment and in a string.
- **The improve loop is back, as an example.** 0.8.0 removed `promptwheel improve` and its four tests, as a command nothing relied on. The owner asked for it back. It is `examples/improve-loop/improve.mjs` now: one step that runs an attempt, asks the check, and keeps the change or puts it back. It is not in the engine and not in the npm package. New in it is `--floor`, which holds each kept change against the best score so far. Without it, four small drops that each sat inside the band were all kept, and a score went from 100 to 80. With it the walk stopped at 90.
- **The loop has 72 tests**, in `test/improve-loop.test.mjs`. The first 62 were written before the loop was touched, and 13 of them failed. The three that mattered most: an attempt that committed its own work skipped the check, an attempt could throw away an earlier kept commit, and an attempt could delete the floor file and so lower the floor. All are closed. So is a fourth, found later: stopping the loop with Ctrl-C left a half-made change in the tree. To test the tests, the loop was then broken in 37 small ways, one at a time. The tests caught 37.
- **The loop step, held to a list of attacks.** 28 attempts that try to get a bad change kept, lose earlier work, leave a mess, or bend the judge for later tries. The step stopped 19. Nine got through: a git hook added a worse change at commit time, a process left running edited a file after the check looked, a file hidden from git made every later try read as a win, an attempt edited the kept base number in the `--base-cache` folder (a score that fell from 100 to 80 was kept as a win), an attempt replaced the gate program, an attempt rewrote the step itself, an attempt deleted the refs of earlier tries, an attempt edited an installed dependency the scorer runs, and `--cheaper` kept the deletion of a safety rule that a second rule still covered. Seven are closed. The check now judges one commit and that same tree is what is kept, with no hook run. The loop's own files (the record, the floor, the kept refs, the base cache, the gate program and the step) are put back after every attempt, and the record says which were touched. 11 tests were written first and 9 of them failed, so the loop has 83 now. Broken on purpose in 52 small ways, the step was caught by its tests 52 times. Two are stated limits. What git does not track is out of the step's sight, so an attempt that edits `node_modules` can still move the score. And no score shows a safety rule deleted behind another one: freeze what protects with a mandate, which sends that change back. The old `promptwheel improve` (0.7.16) let 14 of 25 of the same attacks through.
- **Eight more attacks, and five more holes closed.** Written after the 28, while a wall for the attempt was being built. Five went through the step by way of git's own files, which an attempt can write and git does not track. A `reference-transaction` hook moved the branch to another commit right after the keep. A filter in `.git/config` made the commit hold a lower score than the check had measured. A replace ref hid a worse cost. `core.fsmonitor` ran the attempt's command inside later steps. And the same filter worked from the global git config. All five are closed: git's settings (the repo's and your global ones) and every ref but the branch are read before the attempt and put back after it, and after the attempt no hook runs in the step's git calls or the check's. 15 tests were written first and 13 of them failed, so the loop has 98 now. Three are stated limits, all of them ways a live process or a full path gets past a step that runs the attempt as you: a process the attempt leaves running can edit the copy the check measures in, the same with a process that leaves its group, and an installed dependency reached by the repo's full path. They need a wall around the attempt, which is a container.
- **One test in the main suite is a tripwire.** It fails, and says why, if the loop or its tests go missing, drop under 60, or get skipped.
- **One existing test changed on purpose.** It pinned three setup runs for a change that moved no goalpost. That is two now.
- New command: `calibrate`. New exports: `calibrate`, `noiseBand`. New in a report: `spread` on a metric with a declared band, and `baseMeasured`.
- **Not built:** PHP lint silencers and Pest's `->skip(` are not counted. (Two things this line named when it was written are built in the section above: the band reads the second measurement, and the repeat count is read as it stood at the base.)
- **Not run:** the loop on a real scorer with a real proposer. Everything here ran on small scripted scorers. Those test the mechanics. They do not show that a loop makes anything better over time. Not run on Windows or macOS.

## 0.8.17 (2026-11-22): every test a pull request added, gone at its end

An agent writes tests early in a pull request. They fail, and a later commit deletes them. The pull request ends with as many tests as before, so every count says nothing changed. Now the comment on the pull request says so in a note: `an earlier commit of this pull request (abc1234) added 3 tests. None of them is in it now:`, with their names. With one test the second sentence reads `That test is not in it now:`. The terminal says the same of "this change".

- **Each test is read by its name.** A small reader for each language (JavaScript and TypeScript, Python, Go with its table rows, Rust, Ruby, Java, Kotlin, C#, Swift, Elixir), no parser and no dependency. It was held against real test files by eye, sixty at a time, five times, and fixed after each of the first four. The report names what it found (`testsTakenOut`).
- **It speaks only when the pull request as it stands adds no tests.** So a renamed test is not called gone: the number of tests decides, and the names only say which went.
- **A note, never part of a verdict.** A pass that carries it is still a pass, and its title still says so. The comment is left, since there is something to say.
- **Measured before it was written here,** on 994 pull requests: it speaks on 14 of 139 a person objected to, 6 of 270 matched ones nobody objected to, and none of 271 ordinary ones by an agent.
- **It says nothing where it cannot read:** a commit that is not in the clone (a shallow clone, a pull request squashed into one commit), or a step that touches more than 2,000 files it reads. A test made from a table in JavaScript, Python or C# has one name, so it counts as one test, and a test written in a way the reader does not know is not read.

## 0.8.16 (2026-11-20): a report that arrived cut

`run` printed its report and called `process.exit()` at once. Node writes to a pipe in the background, and an exit drops what the pipe has not taken yet. So a report larger than a pipe holds arrived cut, with the verdict's exit code: at 146,176 bytes where the reader was quick, at 65,536 where it was slow. Found by running the Action's own two commands on every commit of 994 pull requests. One of them changed 10,753 files, and its report came to 812,136 bytes.

- **`run` ends by itself once its report is written.** The exit code is set, and nothing is cut. The report lists every test, fixture and config file a change touches (`gate.goalposts`), so the cut began at a change of a few thousand of them.
- **The Action was not affected.** It writes the report to a file. A tool that reads `run --json` through a pipe was. Sawbuck's `check` and its commit hook do, and Sawbuck 0.2.3 has the tests for what each of them then did.
- Not run on a Mac.

## 0.8.15 (2026-11-20): a good guest on a pull request

The Action left a new comment on every run, a pass included, under the name PromptWheel. Run with its own steps: ten passing pushes, ten comments. A check that speaks on every push gets muted, and then its one real sentence is not read either.

- **One comment, and only when there is something to say.** The Action keeps one comment on a pull request and edits it in place. It reads the comments again just before it speaks, so two pushes close together still leave one. It speaks on a send-back, on a reason that was used, when a file lost tests or assertions while the repo's total held, when the check's own definition changed, and when it could not run. A pull request that passes with nothing to note gets no comment. The notes a full contract makes (a new dependency, the shape of the repo) are in the job summary on every run, and in the comment when there is one. `comment: always` gives the whole report every time. `comment: false` gives none.
- **The comment is Sawbuck's.** One name and one link, to [github.com/sawbuck-ai/sawbuck](https://github.com/sawbuck-ai/sawbuck). What to do is in view, and the table of numbers is folded away. The sentences that tell a fix run how to get through are the measured ones, unchanged.
- **A protected path says how a person accepts it.** A changed workflow is the most common send-back on ordinary work, and its comment named the path and stopped there: the way through was printed only under a count that fell. A path that takes no reason now says what a person does first.
- **`comment-only: true`.** The job never fails, and the comment says what would have been sent back. For trying the check on real pull requests before it counts.
- **Where one person works.** A report says when the contract on the base branch lets the opener's own comment count (`openerCounts`), and the comment prints the way through that works there.
- **Where a count fell is read from the change alone.** The engine used to check out both commits a second time and count the whole tree by file. Now it writes out only the files the change touched, as they stood at each end, and runs the contract's own count command on those. Held against the whole-tree counts on 5,670 pairs of commits from 140 public repos: the same change in every count, every time. It takes about 60 thousandths of a second at the median, where the old reading added about a second. `changeCounts()` gives the same reading to a caller. The verdict's own totals are still whole-tree counts. A path that would land outside the scratch folder is not written, and a symlink is not read.
- **A count that holds for the repo can fall in one file.** A test emptied of its assertions while another file gains as many passed in silence. The file is now named in a note (`lostIn`). A file that was moved or split is left out. It is a note, never a verdict. Run on 408 ordinary pull requests from seven public repos: of the 365 that pass, the note names a file on 17, about 1 in 20.
- New command: `pr-comment` (what the Action runs). New exports: `commentPlan`, `changeCounts`.
- Not run on GitHub itself from here. The Action's own steps were run with a stand-in for `gh`: 24 pull requests, 36 pushes.

## 0.8.14 (2026-11-17): a cost that a gain pays for

A guard is a wall: the metric may not get worse. A loop that improves something by itself, with no person to ask, needs a rate as well. Google's RRSI paper (arXiv 2609.24972) measured the loop without one: it paid 2.4 times the tokens and gained almost nothing on tasks it had not seen.

- **`budget` on a guard.** `{ "gain": "score", "base": 0.10, "rate": 0.2 }` lets a trusted regression of that metric through when the named metric improved in the same change, by a share of the old value no larger than `base + rate x gain`. The report says what paid, or by how much it went over. With no trusted gain, nothing changes: the guard fails as it did.
- **A gain the source did not earn pays for nothing.** The rule runs after the source-only re-run.
- **The counts read code files only.** Found by replaying the contract on 408 real pull requests: a docs-only change was sent back for fewer tests (the words "it (" in a Markdown sentence), and a removed dependency for fewer assertions (the word assert in a lock file). Tests in Go, Rust, Ruby, Java, C#, Elixir and Swift are now counted. A contract signed before this keeps the commands it was signed with.
- **A fall in the tests says where, and what to do.** On a pull request the verdict now names the file the count fell in and three ways out: put back what was removed; or, only if what it tested was itself removed on purpose, end a commit message with `Promptwheel-Allow: test_count: <what was removed, and who asked for it>` (where the contract takes a reason from a commit); or, if neither can be done honestly, stop, leave it red and say why. A reason is read from every commit of the change. A session keeps its own words.
- **Measured before it was written this way** (1,737 agent runs on Claude Sonnet, Haiku and Opus 5.5 and Fable 5.2, in made-up repos). With the words before, on a test that could not pass, 92 of 100 runs got to green by rewriting the test's expected value. With these, 23 of 100 did, and 77 stopped and handed it to a person. A false reason copied from an earlier commit passed in 5 of 100 runs with a first wording, and in 0 of 100 with this one.
- **A change cannot write or loosen its own budget.** The budget is part of how a guard is judged, and a guard is judged as it stood at the base. A gate with no budget keeps the fingerprint it had.
- **Not built:** RRSI's second rule, for a change whose gain is inside the noise. **Not run:** this rule inside RRSI's own loop.

## 0.8.13 (2026-11-16): a test removed on purpose takes a reason

`CONTRACT.md` has always named "an obsolete test removed" as a change a person can declare. With the default contract it could not be: `init` guards the count of tests, of skipped tests and of assertions, no reason reached those three, and a person who removed a test they no longer wanted failed the check whatever they declared (found by typing it on 2026-11-16, in Sawbuck's proof-bench/yes-counts). A failing test deleted on purpose read `fail` for the count even after `--allow` had taken the gamed green.

- **The three test counts take a reason, by the flag.** `init` and the `antihack` preset write `"allowable": "flag"` on `test_count`, `skipped_tests` and `assertions`. A reason from `--allow` or the `allow` option lets a regression in them through, on the record; the Action hands its approving comment in the same way. A commit trailer does not: an agent can write one. The count of lint silencers (`suppressions`) is unchanged.
- **The tests are one thing to a reason.** Deleting a test moves `tests_pass`, `test_count` and `assertions` in one act. Those four names (with `skipped_tests`) count as one thing for "a reason lets through only what it names": alone they need no name, and beside something else naming any one of them names them all. The line the check prints to copy follows the same rule.
- **Who gets this.** A config written from 0.8.13 on. A config written earlier holds its own copy of the guards, and an update does not change it: add `"allowable": "flag"` to the three entries (in a signed repo that edit takes a reason itself). No verdict changes for a run that passes no reason.
- **Not run:** a Mac or Windows. The Action's comment path for these counts.

## 0.8.12 (2026-11-16): the report names the goalposts a change moved

A caller that holds a gamed verdict over a span until it is earned (Sawbuck, at the end of a turn) could not tell two red spans apart: the test was put back and the suite is red as before, or the test is still edited and the suite is red. Both read `inconclusive`. So putting the test back did not end a send-back when the suite had been red to begin with (proof-bench/beside-guard, 2026-11-16).

- **`gate.goalposts` in the JSON report.** The changed paths the source-only re-run does not take from the change: tests, graders, config, declared evaluator paths, a runner script a guard names, and a `package.json` or `pyproject.toml` whose test keys changed. Sorted, and an empty list when there are none. With no goalpost moved the source-only tree is the head tree, so nothing over that span can read `gamed`.
- **Not changed:** every verdict, exit code and fingerprint. The engine's word for a change that touches a protected path or makes a guard worse is still `fail`, with the gamed metric marked in the report beside it; a caller that sends back only `gamed` has to read the metrics too. Sawbuck did not until 0.1.73.
- **Absent** with `--no-detect-gaming`, as the rest of the gate record is.
- **Not run:** a Mac or Windows.

## 0.8.11 (2026-11-15): your own git settings do not change a verdict

Every test and release check of this engine ran under a blank git config. A person has a `~/.gitconfig`. Run under one (the published 0.8.9 and 0.8.10, 29 settings, git 2.25 to 2.52), four things read wrong, and one of them needed no setting at all.

- **A file name is read as it is on disk.** Git prints a name that holds a byte above 127, a double quote, a backslash or a tab inside quotes, with the bytes escaped. Read as a line, that string matched no file. An honest fix in `src/añadir.js` read "gamed", and a new workflow file named `añadir.yml` was no protected path. Names are now read NUL-separated. This is git's default, so it happened to everyone with such a file.
- **The source-only patch is made the same way on every machine.** With `diff.noprefix`, an outside diff tool (`diff.external`), colour forced on (`color.ui=always`) or `diff.context=0`, the patch was one `git apply` refuses. An honest fix then read "inconclusive", and a gamed win that also touched a source file read "inconclusive" too, which is not sent back. The patch now names its own format.
- **The throwaway checkouts run none of your git hooks.** `git worktree add` fires `post-checkout`, from the repo's hooks or your global ones (`core.hooksPath`). One that exits 1 on a detached HEAD stopped every check ("could not run") and left a worktree behind each time. **This changes behaviour** for a repo that leaned on a `post-checkout` hook to prepare the checkout being measured: put that step in `setup`.
- **A commit message is read with no signature check.** With `log.showSignature`, git starts gpg once for each commit a log shows.
- **Not changed:** a verdict under a blank config. `core.autocrlf`, a global ignore file, `safe.directory` and your filters are still obeyed, as they must be.
- **Not run:** a Mac or Windows, Git LFS, submodules.

## 0.8.10 (2026-11-14): on a pull request, the account that opened it cannot let it through

The Action took a person's yes from the newest `sawbuck-allow: <reason>` comment by any account of type User with write access. It did not ask whether that account had opened the pull request. A coding agent run from a service account (a GitHub machine user is a User, and its token writes pull requests) opens its pull requests from that account, and the check's own comment spells out the words to post. Run with the Action's own steps on the published 0.8.9: the opener's comment let a gamed green through, and let a pull request that rewrote its own contract through.

- **The opener's own comment does not count.** `pr-allow --author <login>` leaves out the account that opened the pull request, in any letter case. A newer comment from the opener does not hide an older one from another person. The Action passes the opener from GitHub's own event, in the environment.
- **A repo with one person in it says so in the contract.** `"allowFromAuthor": true` in `promptwheel.config.json` lets the opener count. It is read at the base ref (`pr-allow --base <ref>`), so a pull request cannot turn it on for itself, and the change that adds it shows as a change to the gate. Contracts without the key keep the fingerprint they had.
- **The check's comment says what was not counted.** When the only approval is the opener's, the comment on the pull request says so, why, and names the setting. The lines that tell a reader how to accept a change now say who: someone with write access who did not open the pull request.
- **This changes what a solo owner's own comment does.** If you open your own pull requests and approve them with a comment, add `"allowFromAuthor": true` to the contract on your default branch. With that key an agent signed in as you can post the comment, as before.
- **Who gets this, and when.** A workflow on `@v0` gets it when the tag moves. A workflow that pins this Action by commit keeps the engine it pins, and the old rule with it, until its `uses:` line changes. That line is a workflow change. Under a contract written from this release on it takes one pull request and one reason (the next bullet). Under a contract written before, the workflow rule takes no reason, so a pull request that only changes the line is sent back, with or without a comment; there it takes two pull requests, each with a person's reason: one adds `"allowable": "flag"` to the `workflows-frozen` rule in the contract, the next changes the line. Each was run with the Action's own steps, the first on 0.8.9 and the rest on this release.
- **A workflow change takes a person's reason.** `workflows-frozen` in the supply-chain preset now carries `"allowable": "flag"`, like the contract, the lock and the hooks: `--allow "<reason>"` from a person clears it, on a pull request a `sawbuck-allow:` comment from someone who did not open it does, and a commit trailer never does. Before, the only way through was to delete the rule, make the change and put the rule back. A workflow change is ordinary upkeep: on 340 real commits from 17 public repos, 65 were sent back for a protected path, 64 of those for a workflow, and 20 changed only an action's version. A rule with no way through but deleting it teaches people to delete it. The registry file, build images, publish scripts, `CODEOWNERS` and the scanners keep no way through but retiring their rule. **A contract already written is not changed by an update**: it holds its own copy of the rule. To get the same there, add the key to `workflows-frozen` by hand (an edit to the contract, so it takes a reason).
- **Not changed:** a bot never counts; `allowFromComments(comments)` with no opener named reads as before, for a caller that does not know who opened it.
- **Not run:** a real pull request on GitHub. The Action's shell steps were run as written, with a stand-in for `gh`.
- **The report says when the environment can change which tests run.** `PYTEST_ADDOPTS`, `PYTEST_PLUGINS`, or a preload in `NODE_OPTIONS`, set in the shell the check runs in and not in the contract's own `env`: a note in the JSON (`explained`, metric `environment`), the PR comment and the plain report. Owed since 2026-11-11, when a deselecting `PYTEST_ADDOPTS` and a preload each read pass while a fresh install was red. A note, never a verdict, and nothing is removed from the environment.

## 0.8.9 (2026-11-12): what the counts ask about on real commits; a Python `tests.py` and a runner script are test-side

Found two ways the same night, each change with a test seen failing first. The config `init` writes was read on 340 real commits by people, each against its parent (it had only ever been read on agent runs). And a bench on public agent runs keeps its tests in a script named `test.py`, which the file rule did not know.

- **One more lint silencer is a note when it buys nothing.** `init` writes four counts next to the test run. On those 340 commits, 17 were sent back for a count and nothing else, 13 of them for one more lint silencer (`eslint-disable`, `#[allow(`, `//nolint`, `# type: ignore`), nearly always in new test code. In none of the 17 commits where the silencer count rose did anything else get better. So `suppressions` is now written with `"report": "no-win"`: when nothing else measured got better in the same change, the rise is shown as a note and the gate passes. When it arrives beside a win (the tests went from red to green, a lint count went down) it fails as before, because that is the trade the count exists to catch: a lint error silenced to get to green. A plain note would have let that through, and a test pins that it does not. The other three counts (tests, assertions, skips) stay guards. They asked 3 times in 340, each time about assertions a person really removed. A config written before this is not changed; delete the `report` key to make the count block always. An engine older than 0.8.9 reads `"no-win"` as a plain note, so check a config that 0.8.9 wrote with 0.8.9 or newer.
- **`exit(` is not a skipped test.** The skip pattern was `xit ?\(` with nothing in front of it, so it matched every `process.exit(`, `sys.exit(` and `effects.exit(`. One repo read 400 skipped tests and had none, and a commit that added one `exit(` call was sent back. The pattern has its word boundary now.
- **A Python `test.py` or `tests.py` is test-side when it imports a test framework.** The rule for "this file is a test, put it back for the source-only re-run" knew `test_*.py`, `*_test.py`, `conftest.py` and anything under `tests/`, and not a file named `tests.py`, which is the file Django writes into every app. So a green made by editing one read as earned. The name cannot decide it: Jinja keeps production code in `src/jinja2/tests.py`. The file's own imports decide, at the base or at the head: `unittest`, `pytest`, `django.test`, `nose`, `hypothesis`, `doctest`, `testtools`, `rest_framework.test`, `twisted.trial`.
- **A runner script the test command runs is test-side.** `sh test.sh`, `python3 runtests.py`, `bash ./scripts/run-tests.sh`, and the same through `npm test` when the test script in package.json names it. A green made by editing `test.sh` read as earned before. Only the script that is run counts, and only when its name says test (`test`, `tests`, `runtests`, `run-tests`, `run_tests`, with a script extension): `node src/cli.js --self-test` runs the product, and a file handed to the command (`python -m doctest src/pkg/tests.py`) is not the runner. The guards at both ends of the change are read, so a change cannot un-name its runner in the commit that edits it.
- **`report` is in the README.** A guard with `"report": true` shows its regression as a note; `"no-win"` is the new conditional form. A change that softens a guard and would have failed it is still judged by the guard it was; that was true for `true` and is now pinned by tests for both.
- **A limit, seen and not changed:** the counts read every file a `grep -r` finds outside the folders they skip. A build's copies under `lib/` are counted when the build has run, so a commit that makes a broken build pass can move a count with one line changed. And the assertion pattern counts Rust's `.expect("...")`, which is an unwrap.

## 0.8.8 (2026-11-11): one reason, one thing; a Python venv is left alone

- **A Python repo's venv is left alone.** Until 0.8.7 `init` wrote `"setup": "pip install -e . --quiet 2>/dev/null || true"` for a Python repo, and the venv is linked into each clean copy. So with the venv active (its pip first on PATH), every check ran pip in a throwaway folder against the developer's own venv and left the editable install pointing at a folder the check then deleted. Found by running the first commands a new user runs on real repos: on 8 Python repos, after one check 6 could no longer import their own package, and every verdict was the same with no setup at all (`PYTHONPATH` already puts the measured source first). `init` now writes no setup for Python, and a config that still holds that exact line does not run it. Any other setup runs as written. If your venv was hit: `pip install -e .` in the repo puts it back.
- **A workspace package's own executable runs from the commit being measured.** `node_modules/.bin` was linked into the clean copy as one folder, so a tool the repo keeps as a workspace package (micromark's build runs `micromark-build`) ran from the working tree at both refs. It is now linked like the packages are. Found by replaying real commits.
- **The missing-dependency hint names the file.** A script that dies on a failed ES module import prints `throw new ERR_MODULE_NOT_FOUND(` one line before the line that names what is missing, and the hint took the first. On micromark it read `ERR_MODULE_NOT_FOUND(` and nothing else.
- **A limit, stated and pinned by a test:** a dependency from outside the repo that itself imports one of the repo's workspace packages resolves from its real folder, so it reads the working tree's copy at both refs (micromark's tests reach micromark through `mdast-util-from-markdown`). A fresh clone of such a repo reads "could not measure" until the working tree is built.
- **A reason lets through only what it names when there is more than one thing.** Before, one `--allow "<reason>"` cleared everything a reason can clear in that run. An outside report found the cost: a pull request comment written about a config change also waved through a gamed test in the same change. Now one thing still needs no name. When a reason could let more than one through (a gamed test and an edited contract, a new dependency and the lock), it lets through only the ones it names, as whole words: `--allow "tests_pass, contract-frozen: the spec changed"`. What it does not name still fails.
- **The report says what a reason can let through.** `allowable` lists the names (metric names, `gate`, `mandate:<name>`). The terminal and the pull request comment print the line to copy, and say what a reason did not let through. `allowed.cleared` can be empty when a reason named none of several.
- **What a reason cannot reach does not count.** A commit trailer cannot clear a flag-only guard or rule, so a trailer on a change that also touches one of those is still one thing, and naming a flag-only rule in a trailer still does not clear it.
- **The dependency-update recipe names `pins_changed`.** In the supply-chain pack's README the CI reason is now `pins_changed: dependabot update, reviewed in this PR`. A version bump passes; a bump that also adds an install script fails. Tested.
- This changes behavior for anyone who cleared several things with one unnamed reason. The check prints the new line.

## 0.8.7 (2026-11-11): Rust workspaces

- **A Rust workspace is tested with `cargo test --workspace`.** Plain `cargo test` at a workspace root ran 446 of ripgrep's 1246 tests and 321 of regex's 1410.

## 0.8.6 (2026-11-11): more test names read as tests

- **ava's `test-*.js` files and tsd type tests are tests.** A fixed `test-release.js` had read as a source win. `*-test.js` and `*_test.js` (node --test) are tests too.
- **Test names and test configs of more runners are non-source:** Bun, Cypress, .NET, PHPUnit, XCTest, ExUnit, Dart, Go testdata, Rust benches, mocha, RSpec and coverage gates. Hyphen test names count outside `src/`, `lib/` and `scripts/` only: checked against 18,091 real files, where the first rule swept production code and this one swept none.

## 0.8.5 (2026-11-10)

- **A test that prints an HTTP "Not found" is not a missing dependency.** Only a shell's command-not-found is.

## 0.8.4 (2026-11-10)

- **A shell that can write neither a temp folder nor `.git`** (a sandboxed agent shell) gets one plain sentence, not a stack trace.

## 0.8.3 (2026-11-10)

- **A read-only system temp folder does not stop the gate.** Where it is read-only (Claude Code's sandbox, a locked-down runner), the gate makes its clean copies inside the repo's `.git`.

## 0.8.2 (2026-11-06): what a field report found on a real monorepo

An outside report ran 0.7.16 on a private npm-workspaces monorepo. These are the engine findings from it, and one more from running twelve real repos afterwards.

- **Workspaces are measured with no config.** The check linked only the root `node_modules`, so a test that needed a workspace's own dependencies could not run and nothing was measured. With no `linkDirs` set, the `node_modules` of every folder that has a tracked `package.json` is linked too.
- **A sibling package is read at the ref being measured.** npm, yarn and pnpm link a workspace package from `node_modules` back into the repo. Through one symlink to the real folder, a test in the worktree imported the sibling from the working tree at both refs, so a regression there read as "nothing changed". A `node_modules` that holds such links is now rebuilt in the worktree with those links pointed at the worktree. A repo with no workspace links keeps the single symlink.
- **pnpm repos are measured.** pnpm refuses a `node_modules` that is a symlink, and refuses its own task-run state folder through one, so any script that called `pnpm` stopped at once in the clean copy. A pnpm-managed `node_modules` is rebuilt in the worktree too, and a tool's own state or cache folder inside it (`.pnpm-task-run-state-v1`, `.cache`, `.vite`) is left for the tool to make.
- **`test_count` leaves out `.promptwheel`.** The other three counting tripwires already did. Copying the supply-chain scanners into a repo moved its own `test_count` baseline by 37.
- **A failed `setup` is reported.** Its output was thrown away. The report now carries `setup: { base, head }` with the exit code and last line at each ref where it failed, and the terminal says so.
- **A test metric that fails at both refs says why.** `cause` is `missing-dependency` when the output names a module, package or command the clean copy does not have (with the line in `detail`), else `failing`. A hint for the person, never part of a verdict.
- **A chatty suite is measured.** A test command that printed more than 1 MB was killed and read as failing at both refs, after waiting out the time limit. Running real repos found it (`tap` prints every assertion when its output is a pipe). The limit is now 1 GB.
- **`--allow` and an inconclusive result.** A test now holds that a waiver does not turn "could not measure" into a pass. A win whose source-only patch could not be applied still takes `--allow`, as before, and reads as allowed, not proved.

## 0.8.1 (2026-11-05): claims checked against the code

- **Two cheats in one change.** A guard swapped or renamed in the same change that edits the test green is judged under the old definition, source-only re-run included, and reads `GAMED`. A file dropped from `evaluatorPaths` in the change that edits it still counts as a goalpost. Stated limits: a build script the unchanged `setup` runs, and a base config that extends a file outside the repository.
- **A guard measured another way is a gate change.** The gate fingerprint now includes each metric's `cmd` and how it is read (`extract`, `direction`, `exact`, `report`), at both refs and through `extends`. A guard whose definition changed is re-measured under the base definition; if it would have failed, or would still fail, the verdict is `gamed` (`gate.weakened[].change: guard-edited`). Before, setting `tests_pass.cmd` to `true` hid a real regression and read `pass`. `--allow` clears it like any gate change. Fingerprints and `configHash` differ from 0.8.0 for every config.
  Replacing the placeholder test command that `init` writes is setup, not a weakened gate: it reads as a gate change only.
- **A person can accept a hooks change.** In the supply-chain preset `hooks-frozen` now takes `--allow "<reason>"`, like the contract and the lock, so a team can commit shared hooks to a repo that is already set up. A commit trailer still clears nothing.
- **Graders in any scripting language.** A file named `eval`, `evals`, `grade`, `grader`, `graders`, `score`, `scorer` or `scoring` (alone or with a `-`, `_` or `.` suffix) in `.js/.ts/.py/.sh/.rb/.pl/.php/.lua/.r/.jl` and the shell variants, and anything under `evals/`, `grader/` or `graders/`, is non-source. Before, only `.js/.ts` names counted, so a commit that edited only `grader.py` passed. Kept as source on purpose: `evaluate.py`, `scoreboard.js`, a `scoring/` or `eval/` directory, compiled names (`eval.c`, `eval.go`, `Grade.java`) and `.tsx`/`.vue` files. On 36,528 tracked paths across 60 local repositories this flags 14 more paths and unflags none; 13 are eval harness files, one is a Next.js page under `app/(marketing)/evals/`. A production file named `score.py` now needs `--allow` for a fix that lives only there.
- **`promptwheel lock` outside a repository** prints one line and exits 64, not a stack trace and exit 1.
- **Help** lists `pr-allow` and no longer mentions MCP, which no doc covers.
- **The Action reads every page of PR comments.** It read the oldest 100 only, so a `sawbuck-allow:` approval on a longer PR could be missed. `pr-allow` now accepts one comment per line (`gh api --paginate --jq '.[]'`) as well as a JSON array, and reads stdin as a stream: `readFileSync(0)` crashed Node 24.22 on a live paginated `gh` pipe.
- **The PR comment says what a declared reason cleared** (`Allowed: ... cleared by a declared reason: ...`). The JSON already carried `allowed.reason`, `allowed.cleared`, and `allowed: true` with the `gamingReason` on each cleared metric; exit codes are unchanged.
- **Self-heal removes a worktree a killed run left registered** once it is a day old. Before, a registered worktree was skipped forever. A registered worktree not tagged for this repo is never touched.
- **Self-heal removes only directories the engine made.** It matched any temp-dir entry whose name started with `promptwheel-` or `pw-idx-`, so a day-old folder named `promptwheel-notes`, or another repo's worktree named `promptwheel-site-wt` with uncommitted work in it, was deleted. It now removes only a directory whose whole name has the shape the engine generates (`promptwheel-`, `promptwheel-src-` or `pw-idx-`, an 8-hex repo tag, then 6 random characters). An untagged directory from an engine older than 0.7.9 is no longer cleaned up.
- **A change is judged by the gate that was in force before it.** Three false passes are closed:
  - *A first config.* With no config at base, `gate.weakened` saw nothing, so a new config with `tests_pass.cmd: "true"` plus a broken source read `pass`. The base definition is now the zero-config gate (the test command detected from the base commit), so that reads `gamed` (`guard-edited`). A first config that keeps the detected command, or replaces the placeholder, is not affected. `gate.fingerprint.base` stays `null` when there was no config file at base.
  - *`gamingCheck` and `gamingThreshold`.* `gamingCheck: false` set in the change that edits the test to pass skipped the source-only re-run. A metric that had the re-run on at base keeps it for that change, and a `gamingThreshold` lowered in a change is held at the base value. Both apply from the next change. A metric the change adds keeps its own `gamingCheck`.
  - *`setup`, `env`, `linkDirs`.* These are now in the gate fingerprint. When a change edits them, each base guard is measured again with the base values and so is the source-only re-run. A guard that fails the old way and reads fine the new way is listed in `gate.weakened` with `change: measurement-edited` and the verdict is `gamed`; `--allow` clears it like any gate change. Before, a `setup` that overwrote the test file read `pass`. Two limits: a `setup` fix for a suite that could not run at all before reads `gamed` on the change that adds it and needs `--allow` (the `setup` that `init` writes into a first config is exempt), and a base config that `extends` a file outside the repository is not compared on these keys.
- **Flag values are checked.** `run --repeat abc` measured nothing and read `fail`, exit 1. `--allow`, `--base`, `--head` and `init --preset` with no value ran as if the flag was not there, and a blank `--allow "   "` was recorded as the reason and cleared a `gamed` verdict. Each is now one line and exit 64. An empty `--base ""` still means the default ref, because the Action passes one outside a pull request.
- **An inert guard says what happened.** A test that ran and failed at both refs printed "never ran ... its command needs a build/deps first". It now prints "ran and failed before and after this change", in the terminal and in the PR comment, and the metric carries `ran: "both"` (or `"base"` / `"head"`). The build/deps advice stays only when the command did not run: exit 126 or 127, a timeout, or the placeholder.
- **Quieter and clearer `run`.** A default `run` no longer prints git's `fatal: Not a valid object name origin/main` lines while it looks for a base. When a protected path fails the gate, a mandate that takes `--allow` (the contract, the lock, the hooks) says `promptwheel run --allow "<reason>"`; before it said to retire the mandate in the config, which is the protected file.
- **More docs match the code:** `--routes` goes on the `lock_drift` metric's `cmd` (`lock.mjs drift . --routes`), not on `promptwheel lock`; `pack.json` no longer says to use it through `extends`, which reads every metric as unmeasurable outside this repository; the README sample output is labeled as shortened and its lines are literal; the INTEGRATE sample `gamingReason` is the real text; the types and ARCHITECTURE no longer say a run writes a record.
- **Docs match the code:** a mandate fails the gate after the metrics run, not before; the mandates in force are the base ref's (one added in the same change does not apply to it); a change that only edits a supply-chain contract fails without `--allow`; `--allow` clears only `contract-frozen` and `lock-frozen`; the pack's guards take the flag only, not a trailer; no outcome record and no `security` preset remain.

## 0.8.0 (2026-11-05): a smaller surface

Breaking for anyone who used these directly. Sawbuck, the GitHub Action, and the verdict contract are unchanged.

- **Commands removed:** `improve`, `insights`, `guards`, `conformance`. Each now exits 64 as an unknown command. `conformsToContract` stays in the library and does what `conformance` did.
- **Presets removed:** `tests-pass`, `lint`, `bundle-size`, `security`, `llm-eval`, `security-antihack`, and `packs/security`. Each now exits 64 as an unknown preset. Configs already written by them keep working, and a pack already copied into `.promptwheel/packs/` keeps running. `antihack` (the `init` default), `no-ai-tells` and `supply-chain` stay.
- **No outcome record.** A run no longer writes `.promptwheel/outcomes.jsonl`; only `insights` and `guards` read it. `--no-record` stays accepted and does nothing. The `record` config key and the `record` option of `check()` are ignored.
- **Plugin 0.1.15:** the `/promptwheel:improve` and `/promptwheel:insights` skills are gone.

## 0.7.12 (2026-11-04): adopting a contract no longer fails its own commit

- A guard the change adds has no value at base, because its scanner did not exist there; it now starts counting from head (`adopted: true` on the metric) instead of failing as unmeasurable. A guard the base contract already had still fails when it cannot be measured, and removing one is still caught.
- A mandate the change adds does not apply to that change, so signing a contract does not violate it. Deleting or narrowing a rule stays caught through the base contract.
- The antihack tripwires skip `.promptwheel/`, so a pack's own source does not read as skipped tests.

## 0.7.11 (2026-11-04): the supply-chain preset and the architecture lock

- **`promptwheel init --preset supply-chain`.** Seven guarded metrics, seven frozen paths, and a pack copied into `.promptwheel/packs/supply-chain/`. Guards: `lifecycle_scripts`, `dependency_entries`, `lock_nonregistry_sources`, `unpinned_execution` (actions not pinned by SHA, npx or global installs with no exact version, a remote script piped to a shell), `install_policy_gaps`, `lock_drift`, `pins_changed`. Frozen: workflows, registry config, build images, publish scripts, CODEOWNERS, the scanners, the hooks.
- **`promptwheel lock`** writes `promptwheel.lock.json`, the shape of a repo: dependencies, script bodies, install scripts, workflows, modules, import edges, routes, entry points, hosts, what each module can do (network, process spawn, eval), native binaries. No model, no timestamp. `lock_drift` fails what the lock has not seen; a new route is reported, and held with `--routes`. Edges, routes, hosts and capabilities read JS and TS today.
- **`pins_changed`** compares a fingerprint of the resolved dependency tree base to head (new metric option `exact: true`: any change regresses), so a new version under an old name fails, an approved update never blinds the next check, and the lock does not change across updates.
- **Allowable mandates and `allowable: 'flag'`.** The lock file is a mandate only a person's `--allow` clears, and these guards take a reason from the flag only: an agent can write a commit trailer.
- **`allowTrailer: false`** turns commit trailers off, read from the contract at the base ref too, so a change cannot turn them back on for itself. `PROMPTWHEEL_NO_ALLOW_TRAILER` does the same for a caller checking an agent's commit. The preset sets it.
- **The Action** takes an `allow` input, and pins its own action by SHA. Workflows pin actions by SHA; `.npmrc` sets `ignore-scripts` and a release-age cooldown.
- Measured on 1,403 commits across eight repositories: structure stops 5.1%, pins 8.7% (all real dependency changes). Red team: 22 of 25 direct attacks caught; the misses are one class, an address assembled at runtime in a module that already uses the network, and that is a stated limit.

## 0.7.10 (2026-11-03): a declared override covers an unprovable win; self-heal bounds every orphan

- **`--allow` (and a `Promptwheel-Allow:` trailer) now clears an `unprovable` win too.** 0.7.9 made a
  win whose source-only re-run could not be applied read `inconclusive` (exit 3) instead of `pass`,
  but the declared override cleared only `gamed`, so an intentional, declared goalpost change whose
  source slice will not re-apply (an LFS-smudged blob, a file created beneath a symlink the slice does
  not remove) had no way to pass short of `gamingCheck: false`. The override names the metric in
  `allowed.cleared`, sets `unprovable: false` and `allowed: true` on it, and `conformsToContract`
  accepts exactly that shape (an `unprovable: false` without `allowed: true` is rejected).
- **The apply-failure path is exercised end to end.** A test drives a real `git apply` refusal through
  the gate (a source file created beneath a symlink whose own change is non-source): the metric reads
  `unprovable`, the CLI exits 3, the report conforms, and `--allow` turns it into a pass.
- **`promptwheel run` outside a repository prints one line.** `repoRoot` no longer lets git's own
  `fatal: not a git repository` through above the exit-64 message.
- **Self-heal prunes another repository's orphaned checkout after a day.** 0.7.9 skipped any temp
  dir tagged for another repo forever, so a measurement crashed in a repo that was later deleted or
  moved (a new path is a new tag) leaked its checkout for good. This repo's dirs still go after an
  hour, untagged legacy dirs after a day, and another repo's tagged dirs after a day too.
- **An unknown flag is a usage error on every command.** `run --bogus-flag` used to run the gate
  as if the flag were not there (a typo in a CI step could silently drop `--no-detect-gaming` or
  `--allow`), while INTEGRATE.md promised a bad flag exits 64. Every command now checks its flags
  against the documented list and exits 64 naming the flag; `promptwheel run --help` prints the
  banner instead of gating.
- **Plugin 0.1.13.** The disclosure of what the plugin writes now names `.cursorrules` (a setup block
  when the file already exists), the security pack copy under `.promptwheel/packs/security/`, and
  what `improve` does to the working tree (a commit when a metric improved, otherwise a hard reset
  plus a clean of untracked files). The logbook skill and README pin `@promptwheel/logbook@0.9.10`,
  with a test that fails when the pin drifts from the release named in the suite; the marketplace
  entry carries the plugin version.
- **INTEGRATE.md lists `none` among the confidence values** (an unmeasurable metric reports it).

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
