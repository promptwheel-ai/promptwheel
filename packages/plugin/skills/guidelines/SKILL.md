---
name: guidelines
description: Audit, restructure, or generate CLAUDE.md/AGENTS.md project guidelines
argument-hint: "<audit|restructure|init>"
---

Manage your project's CLAUDE.md or AGENTS.md guidelines file. Subcommand is the first word of `$ARGUMENTS`.

## Subcommands

### `audit` (default if no subcommand)

Analyze the current guidelines file and report quality metrics.

1. Read `CLAUDE.md` (falls back to `AGENTS.md`)
2. If neither exists, tell the user and suggest running `init`
3. Read `package.json` for project context
4. Report:

```
## Guidelines Audit

**File:** CLAUDE.md (N lines, ~N tokens)

### Sections
| Section | Lines | Type |
|---------|-------|------|
| Project Root | 3 | guardrail |
| ... | ... | ... |

### Assessment
- Actionable content: N% (guardrails, commands, conventions)
- Reference content: N% (architecture, glossary)
- Non-actionable content: N% (rationale, legal, speculation)

### Staleness
- References to files/dirs that don't exist: [list]
- References to tools/commands that don't exist: [list]

### Missing Sections
- [ ] Conventions (coding standards, patterns)
- [ ] Commands (dev workflow)
- [ ] File structure
- ...

### Recommendations
- [Specific suggestions to improve the file]
```

### `restructure`

Read the existing guidelines and produce a cleaned-up version.

1. Read `CLAUDE.md` (falls back to `AGENTS.md`)
2. If neither exists, tell the user and suggest `init` instead
3. Read `package.json` for project metadata
4. Analyze each section against these categories:
   - **Keep as-is:** Critical guardrails (repo boundaries, git protection, deployment safety)
   - **Keep as-is:** Operational references (version bump tables, release workflows, key commands)
   - **Keep, trim if bloated:** Architecture overview (one diagram + one paragraph max)
   - **Keep or generate:** Conventions (coding standards, test patterns, lint rules)
   - **Keep if concise:** Glossary of project-specific terms
   - **Flag for removal:** Legal analysis, TOS rationale, compliance arguments
   - **Flag for removal:** Speculative/future sections ("if we ever need...")
   - **Flag for removal:** Educational explainers (sandbox diagrams, "what is X?" sections)
   - **Flag for removal:** Stale content (file trees that don't match, tools that don't exist)
5. Present the restructured version to the user wrapped in a code block
6. Ask for confirmation before writing
7. If the user approves, write the updated file
8. If removed content is substantial (>50 lines), suggest relocating it to a `docs/` file

### `init`

Generate a new guidelines file from codebase analysis.

1. Confirm no `CLAUDE.md` or `AGENTS.md` exists (if one does, suggest `restructure` instead)
2. Read `package.json` for project name, scripts, dependencies
3. Scan for common config files (tsconfig.json, .eslintrc, vitest.config, pytest.ini, Cargo.toml, etc.)
4. Detect language, test runner, linter, framework
5. Generate a CLAUDE.md with these sections:
   - **Project overview** (1-2 sentences from package.json description)
   - **Key commands** (extracted from package.json scripts or detected build system)
   - **Conventions** (inferred from config files and dependencies)
   - **File structure** (top-level directories with one-line descriptions)
6. Write the file and tell the user to review and customize it

## Notes

- This skill does NOT call any MCP tools — it works entirely with file reads and writes
- The restructure subcommand always asks for confirmation before writing
- Token estimate uses `lines * 4` as a rough approximation
