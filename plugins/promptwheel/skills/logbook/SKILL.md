---
name: logbook
description: Turn a repo's git history into memory an agent can use. Writes LOGBOOK.md (hotspots, do-not-retry reverts, suppression ledger, fragile areas), events.jsonl, JOURNEY.md; `audit` shows what is still suppressed today and its fight log. INVOKE WHEN: starting work in an unfamiliar repo; before proposing a refactor or any large change (check do-not-retry first); when something keeps breaking or a test seems flaky (fragile areas / fight log); when asked "has this been tried", "why is this like this", or "what happened here"; when deciding whether green tests can be trusted (assertion-weakening ledger). Structure maps show WHERE code is; the logbook shows WHAT HAPPENED. The logbook records; the referee (promptwheel gate) judges.
---

# Logbook

```bash
npx @promptwheel/logbook              # analyze current repo → 3 files
npx @promptwheel/logbook journey      # the story, in color (writes nothing)
npx @promptwheel/logbook --json       # events to stdout (writes nothing)
```

Never touches source or git history; writes only its own brief files. `-n N` caps commits; `--since/--until` for era scoping.

After running: read "$(git rev-parse --show-toplevel)/LOGBOOK.md" and relay "What a fresh session should know"
plus the 2-3 most notable findings. TRIAGE, don't parrot: the logbook is a
recall layer — you are the precision layer. Cross-reference findings against
the current task, and verify any lead you act on with `git show <sha>` before
asserting what happened. Findings are leads, not verdicts — a suppression
event means "a human should look here," not misconduct. If the repo is
shallow, offer `git fetch --unshallow` first.

## Investigation mode (when the user asks to dig into findings)

For each Notable event or flagged lead worth pursuing: `git show <sha>` the
commit, read the actual diff, and classify it — real weakening / sanctioned
maintenance / classifier artifact — with one line of evidence each. Check
whether flagged suppressions are STILL in the current tree (grep HEAD for
the skip/ignore near the flagged location). Present the triage as YOUR
judgment layered on the deterministic record — never edit the logbook files
to match your conclusions; the record and the reading stay separate.

PERSIST what you learn (lazy enrichment): when an investigation establishes
WHY something happened — a revert's failure mode, a suppression's cause —
save it so the next session gets it free instead of re-investigating:

```bash
npx @promptwheel/logbook annotate SHA "one specific sentence" --by MODEL
```

Annotations are sha-keyed, attributed, dated, and merged into LOGBOOK.md as
"why (inferred)" lines on future runs. Judgments, not records: only annotate
causes you verified in the actual diffs, and treat old annotations as aged
testimony — the fact never changes, but its force can (a "reverted because
webpack4 broke" constraint stops binding once webpack4 is dead).

## Querying the full record (events.jsonl)

The digest truncates with "…and N more — full record in events.jsonl". When
completeness matters (ALL reverts touching a file, every weakening event),
query the record — never read it whole (it can exceed the context window):

```bash
# every revert touching a file
npx -y @promptwheel/logbook query --file lib/response.js --revert
# all assertion-weakening events (3+ net) since a date
npx -y @promptwheel/logbook query --weaken 3 --since 2024-01-01
# all suppression events, era-scoped
npx -y @promptwheel/logbook query --suppress --since 2024-01-01
```

Digest for breadth, queries for depth. Measured: digest alone found 4/12
qualifying commits on a real task; digest + two jq queries found 12/12 for
~400 extra tokens.
