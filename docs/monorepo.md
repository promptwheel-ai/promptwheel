# Monorepo Guide

PromptWheel works with monorepos out of the box. It auto-detects `packages/`, `apps/`, and similar workspace directories during scouting. Scoping narrows it down so each session focuses on the code that matters.

---

## Scoping to a Single Package

Use `--scope` to restrict scouting and execution to one package:

```bash
promptwheel --scope "packages/api/**"
promptwheel --scope "apps/web/**" --hours 4
```

In the plugin:

```
/promptwheel:run scope=packages/api/**
```

Without `--scope`, the scout scans the entire repo. This works fine, but large monorepos benefit from narrowing the scope so cycles stay fast and proposals stay relevant.

---

## Configuration

Place `.promptwheel/config.json` at the repo root. Use `defaultScope` to set a persistent scope so you don't have to pass `--scope` every time:

```json
{
  "auto": {
    "defaultScope": "packages/api",
    "minImpactScore": 4
  }
}
```

The CLI flag `--scope` overrides `defaultScope` for a single run.

---

## Cross-Package Changes

Tickets are sandboxed to their `allowed_paths`, but scope expansion automatically widens access when a change needs related files:

- **Sibling files** in the same directory (e.g., `types.ts` next to `handler.ts`)
- **Test files** alongside source (`.test.ts`, `.spec.ts`, `_test.go`, etc.)
- **Index/module files** (`index.ts`, `__init__.py`, `mod.rs`)
- **Root config files** (`tsconfig.json`, `package.json`, `Cargo.toml`, etc.)
- **Cross-directory within the same top-level package** (e.g., `packages/core/src/` can reach `packages/core/types/`)

If a ticket scoped to `packages/api/` needs to update a shared type in `packages/core/`, the scope expander detects that both live under `packages/` and adds the file automatically. This keeps tickets focused while allowing necessary cross-package edits.

---

## Workspace Types

PromptWheel does not depend on any workspace tool. All of these work:

| Tool | Workspace config |
|------|-----------------|
| npm workspaces | `package.json` `"workspaces"` |
| pnpm | `pnpm-workspace.yaml` |
| Yarn | `package.json` `"workspaces"` |
| Lerna | `lerna.json` |
| Turborepo | `turbo.json` |
| Nx | `nx.json` |

PromptWheel reads the filesystem directly. It does not invoke `pnpm`, `yarn`, or any workspace tool during scouting or execution.

---

## Tips

- **Start focused, expand later.** Run `--scope packages/core/**` first. Once you're confident in the results, widen to `--scope "packages/**"` or drop the scope entirely.

- **Use formulas for targeted passes.** Combine scope with a formula to run a specific kind of improvement across one package:

  ```bash
  promptwheel --scope "packages/auth/**" --formula security-audit
  promptwheel --scope "packages/api/**" --formula type-safety
  ```

- **Milestone mode for large repos.** Long runs across many packages produce many PRs. Use `--batch-size` to group related changes into fewer, larger PRs:

  ```bash
  promptwheel --scope "packages/**" --hours 8 --batch-size 20
  ```

- **QA commands run at the repo root.** Make sure `npm test` and `npm run lint` work from the root. If your monorepo requires per-package commands, configure them in `.promptwheel/config.json` under `qa.commands` (see [Configuration](configuration.md)).

- **One session, one scope.** Separate sessions per package produce better proposals because the scout can focus its context budget.
