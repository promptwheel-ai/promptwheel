# PromptWheel supply-chain guard-pack

The step every npm supply-chain attack needs inside a target repo is a supply-chain edit: a
lifecycle script, a new dependency, a lockfile entry that resolves somewhere other than the
registry, a workflow or publish config. Those are paths and counts, and paths and counts are what
the gate checks deterministically. This pack holds the counts; the preset that installs it also
writes the mandates that freeze the paths.

```bash
promptwheel init --preset supply-chain
```

`init` copies the pack into `.promptwheel/packs/supply-chain/`, writes seven guarded metrics that run
it from there, and writes the mandates below. Commit the pack with the config: the gate measures in
clean git worktrees, so a pack that is not in git is absent at both refs and the metrics read
`unmeasurable` (init warns when `.promptwheel/` is gitignored).

## The seven counts

- **lifecycle_scripts**: install-time script entries (`preinstall`, `install`, `postinstall`,
  `prepare`, `prepublish`, `prepublishOnly`, `postpack`) across every `package.json` in the repo.
- **dependency_entries**: dependency entries across every `package.json` (`dependencies`,
  `devDependencies`, `optionalDependencies`, `peerDependencies`).
- **lock_nonregistry_sources**: lockfile entries (`package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`)
  resolved from somewhere other than the npm registry (git, ssh, http, a tarball on another host,
  `file:`) plus registry entries that carry no integrity hash. Workspace links inside the repo do not
  count. A private registry mirror makes this baseline large, not failing.
- **unpinned_execution**: code run from a reference that can move. A GitHub Action not pinned to a full commit SHA (a local `./action` does not count), `npx`, `bunx` or `dlx` with no exact version, `npm install -g` with no exact version, and a remote script piped into a shell. Read from workflows, `action.yml`, package.json scripts, `scripts/*.sh` and Dockerfiles. In package.json scripts, a tool the manifest declares does not count: the lockfile already pins it.
- **install_policy_gaps**: 0, 1 or 2. Are install scripts disabled, and is a release-age cooldown set (`ignore-scripts=true` and `min-release-age` in `.npmrc`, or the pnpm or yarn equivalents)? The cooldown is enforced by the package manager, not by this pack: a registry lookup here would make the verdict depend on the clock.
- **lock_drift**: structural items the tree has that `promptwheel.lock.json` does not. `promptwheel lock` reads the repo once and writes its shape: dependencies, install scripts, workflows, modules, import edges between modules, routes, public entry points, and the network hosts the source names. It also records each script's body, native binaries, and what a module can do (network, process spawning, eval), so a new capability shows even when the host is built at runtime. Ordinary edits never touch it. A new route is reported but not held by default; add `--routes` to hold it. On 1,403 commits across eight repositories this guard would have stopped 5.1%, about one in 20. JS and TS only for edges, routes, hosts and capabilities today.
- **pins_changed**: a fingerprint of the resolved dependency tree, compared base to head, because a new version under an old name is how a worm arrives. It covers every package, version, source and integrity, not the file's bytes, so a release of your own project does not count. Any change needs a reason. Nothing is stored, so the lock does not change across updates and an approved update does not blind the next check. On the same commits this stopped 8.7%, all real dependency changes; use the CI path below for those.

**Dependency updates in CI.** Give the reason from a step the agent cannot reach. Workflows are a frozen path, so an agent cannot edit this:

```yaml
- uses: promptwheel-ai/promptwheel@<full commit sha>
  with:
    allow: ${{ github.event.pull_request.user.login == 'dependabot[bot]' && 'dependabot update, reviewed in this PR' || '' }}
```

Check the PR author, not `github.actor`, which is whoever last triggered the run. Everything else still fails without a person's reason.

**What this does not catch.** A new destination reached through a module that already uses the network, when the address is assembled at runtime, reads as nothing new. The lock holds structure; it cannot follow a value.

A reason clears these guards only through the `--allow` flag, never through a commit trailer: an agent can write a trailer, so a guard meant to stop a compromised agent cannot be cleared by one. The lock file itself is a mandate that a person's `--allow` can clear, so an agent cannot launder a change by updating the lock in the same diff.

Each is a count, not a finding. The gate holds the number: a change that makes it rise fails,
whatever else the change did right. The count does not have to be zero.

## When the rise is the job

Sometimes adding a dependency is exactly what was asked. Say so, and the gate records it:

```bash
promptwheel run --working --allow "needed for the CSV export (papaparse)"
```

or a `Promptwheel-Allow: <reason>` trailer on the commit. The seven metrics carry `allowable: true`,
which means a declared reason clears their guarded regression for that one run, with the reason
written into `report.allowed` and the outcome record. Nothing is loosened in the config, and a rise
without a reason still fails. That is the point: every added package, script, or non-registry
source leaves an audit line a reviewer can read.

`gamingCheck` is `false` on all seven because these numbers legitimately live in config files
(`package.json`, lockfiles), which the source-only re-run reverts; re-proving them from source would
flag every honest dependency bump.

## The mandates the preset writes

A mandate is a path the agent must not touch in a change; the gate fails before any metric is read,
and a mandate deleted or narrowed in the same change that violates it stays in force.

| mandate | paths | why |
| --- | --- | --- |
| workflows-frozen | `.github/workflows/**` | workflows run with the repository's secrets |
| registry-config-frozen | `.npmrc`, `.yarnrc`, `.yarnrc.yml` | where packages come from and where tokens go |
| build-images-frozen | `Dockerfile*`, `docker-compose*` | what runs at build and deploy time |
| publish-scripts-frozen | `scripts/release*`, `scripts/publish*` | the publish path is how a compromise spreads |
| codeowners-frozen | `CODEOWNERS` | review ownership is set by people |
| hooks-frozen | `.claude/settings.json`, `.claude/settings.local.json`, `.sawbuck/**` | the hooks that enforce the contract are wired by a person |

The contract itself (`promptwheel.config.json`, `sawbuck.config.json`) is protected as an
`evaluatorPaths` entry rather than a mandate: a change that edits it alongside a win is `GAMED` by
declaration unless the change carries a declared reason, while a change that only edits the
contract (a person retiring a rule) still passes. A mandate there would make the contract
un-editable through the gate.

A person who needs to change a frozen path does it in a separate change that only touches that
path, reviewed as such.

## What this is not

- **Not a dependency firewall.** It does nothing about installing a package that is already
  compromised on the registry. Use a registry policy, a cooldown on new versions, and
  `--ignore-scripts` for that.
- **Not an injection detector.** It does not decide whether an instruction came from you or from
  content the agent read. Whatever steered the agent, a supply-chain edit it was steered into fails
  here, deterministically.
- **Not a scanner.** No matchers, no findings, no false positives to triage: a path, a count, or a
  hash.

Pair it with the `security` preset for the eight code-level invariants, and with the GitHub Action so
the gate runs where the agent cannot switch it off.
