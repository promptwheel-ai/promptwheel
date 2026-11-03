# PromptWheel security guard-pack

Gate your AI coding loop on **security invariants**, not just tests. When an agent
writes backend code, "tests pass" says nothing about whether it shipped a CORS
wildcard, a client-controlled payment amount, or a hardcoded secret. This pack
adds a `security_findings` metric that must not climb - and because it's a
PromptWheel metric, the win has to survive `--detect-gaming`: an agent can't
lower the count by editing the pattern file or a config, only by fixing the code.

## Use it

The pack ships inside the `promptwheel` package, not in your repo, so install it with the
preset:

```bash
promptwheel init --preset security            # or --preset security-antihack, which adds the tripwires
```

`init` copies the pack into `.promptwheel/packs/security/` and writes a `security_findings`
metric that runs it from there. Commit the pack with the config: the gate measures in clean
git worktrees, so a pack that is not in git is absent at both refs and the metric reads
`unmeasurable` (init warns when `.promptwheel/` is gitignored; change that rule to
`.promptwheel/*` plus `!.promptwheel/packs/`, since git cannot re-include a file under an
ignored directory). Then gate as usual:

```bash
promptwheel run --working          # fails if security_findings increased
```

`pack.json` is the same metric as a config fragment for `extends`
(`{ "extends": ["packs/security/pack.json"] }`); its command is relative to a repo that
holds the pack at `packs/security/`, such as a vendored copy or this repository.

A finding-count that drops because you fixed the code is a `PASS`; a "fix" that
only survives with test/config/pattern edits reverted is `GAMED`.

## What it checks (v0.1 - 8 high-precision invariants)

Decanted from [securitychecks](https://securitychecks.ai)' "recommended" tier - 
the regex-portable subset, chosen for near-zero false positives:

| Invariant | Severity |
| --- | --- |
| CORS wildcard origin | P0 |
| CORS origin reflection | P0 |
| Insecure session cookie (`secure:false`) | P0 |
| Payment amount from client input | P0 |
| Hardcoded secret in a sensitive variable | P0 |
| NPM token committed in `.npmrc` | P0 |
| Template autoescape disabled (XSS) | P0 |
| S3 presigned upload without content validation | P2 |

Each pattern ships with its own false-positive guards (the `exclude` regexes).

## Scope, honestly

This is the **regex-portable** slice. The other ~75 recommended invariants
(auth-enforcement, authz-revocation, tenant-isolation, dataflow-tainted sinks)
need an AST + dataflow engine and are a possible follow-up, not part of this
pack. The point of v0.1 is the architecture: security invariants are
now a first-class, un-gameable PromptWheel metric. Zero dependencies; the scanner
is one file (`scan.mjs`).
