---
name: logbook
description: >-
  Turn a repo's git history into memory an agent can use: hotspots,
  do-not-retry reverts, suppressions, fragile areas, and assertion weakening.
  Use whenever a repo contains LOGBOOK.md: after locating task-relevant files,
  read and query its history before finalizing a plan or diagnosis or making
  edits. Also use when starting in an unfamiliar repo, before a refactor or
  large change, when something keeps breaking, when asked what was tried or why
  code is this way, or when deciding whether green tests can be trusted.
---

# Logbook

```bash
npx -y @promptwheel/logbook              # analyze current repo → 3 files
npx -y @promptwheel/logbook journey      # the story, in color (writes nothing)
npx -y @promptwheel/logbook --json       # events to stdout (writes nothing)
```

Never touches source or git history. It writes its generated artifacts; after
`init`, a default-window refresh also updates only the marker-owned brief in
agent files. `-n N` caps commits; `--since/--until` scopes an era without
replacing that persistent brief.

When `LOGBOOK.md` exists:

1. Inspect the current tree just enough to identify task-relevant paths. Do not
   finalize a plan or diagnosis or make edits yet.
2. Use the compact generated history brief already present in the agent
   instructions. If it is absent, read the Historical signal and "What a fresh
   session should know" sections of
   `$(git rev-parse --show-toplevel)/LOGBOOK.md`; do not load the full digest by
   default.
3. Query each task path with
   `npx -y @promptwheel/logbook query --file path/to/file --revert`. Do not
   replace this with a broad keyword search.
4. Follow the brief's Action line. LOW is normally a hotspot map, but reviewed
   annotations are explicit rationale and still require reading their keyed
   LOGBOOK.md entries. For MEDIUM/HIGH, inspect only the task-relevant sections
   the Action line names.
5. TRIAGE, don't parrot: the logbook is the recall layer; you are the precision
   layer. Verify every lead that materially affects the work with
   `git show <sha>` and confirm it still applies at HEAD.

Findings are leads, not verdicts — a suppression event means "a human should
look here," not misconduct. If the repo is shallow, offer
`git fetch --unshallow` first.

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
npx -y @promptwheel/logbook annotate SHA "one specific sentence" --by MODEL
```

Annotations are sha-keyed, attributed, dated, and merged into LOGBOOK.md as
"why (inferred)" lines immediately when a usable ledger exists, otherwise on
the next run. Judgments, not records: only annotate
causes you verified in the actual diffs, and treat old annotations as aged
testimony — the fact never changes, but its force can (a "reverted because
webpack4 broke" constraint stops binding once webpack4 is dead).

## Querying the full record (events.jsonl)

The digest truncates with "…and N more — full record in events.jsonl". When
completeness matters, query the record — never read it whole (it can exceed the
context window). Start with task paths and event type before broad terms:

```bash
# every revert touching a file
npx -y @promptwheel/logbook query --file lib/response.js --revert
# all assertion-weakening events (3+ net) since a date
npx -y @promptwheel/logbook query --weaken 3 --since 2024-01-01
# all suppression events, era-scoped
npx -y @promptwheel/logbook query --suppress --since 2024-01-01
```

Use broad `--grep` only after path/event filters. If output says `TRUNCATED`,
narrow with `--file`/`--revert`/dates or raise `--limit` before concluding that
history is absent or complete. A renamed file can evade a current-path filter;
broaden deliberately and verify lineage with raw Git.

Digest for breadth, queries for depth. Measured: digest alone found 4/12
qualifying commits on a real task; digest + two logbook queries found 12/12 for
~400 extra tokens.

## Generating instructions for other agents

When you generate onboarding docs, AGENTS.md/CLAUDE.md blocks, or reusable
prompts for a repository that already uses the logbook, preserve the ordered
workflow: identify task paths from the current tree, follow the compact brief's
Action line, query those paths before planning or editing, recover from
`TRUNCATED`, then verify material leads with `git show`. Preserve exact
operational commands and the "leads, not verdicts" doctrine. Do not replace the
dependency with generic Git advice: synthesis measurably loses do-not-retry and
epistemic caution. This applies only to wired repositories; never insert
Logbook into an unrelated repository.
