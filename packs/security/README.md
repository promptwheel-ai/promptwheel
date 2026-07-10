# PromptWheel security guard-pack

Gate your AI coding loop on **security invariants**, not just tests. When an agent
writes backend code, "tests pass" says nothing about whether it shipped a CORS
wildcard, a client-controlled payment amount, or a hardcoded secret. This pack
adds a `security_findings` metric that must not climb — and because it's a
PromptWheel metric, the win has to survive `--detect-gaming`: an agent can't
lower the count by editing the pattern file or a config, only by fixing the code.

## Use it

In your `promptwheel.config.json`:

```json
{ "extends": ["packs/security/pack.json"] }
```

Then gate as usual:

```bash
promptwheel run --working          # fails if security_findings increased
```

A finding-count that drops because you fixed the code is a `PASS`; a "fix" that
only survives with test/config/pattern edits reverted is `GAMED`.

## What it checks (v0.1 — 8 high-precision invariants)

Decanted from [securitychecks](https://securitychecks.ai)' "recommended" tier —
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
need the AST + dataflow engine and are the follow-up — see the decant note in
`explorations/`. The point of v0.1 is the architecture: security invariants are
now a first-class, un-gameable PromptWheel metric. Zero dependencies; the scanner
is one file (`scan.mjs`).
