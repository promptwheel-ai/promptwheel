# Formulas

Formulas are repeatable recipes that tell the scout what to look for. They control categories, scope, and the scout prompt.

---

## Built-in Formulas

```bash
blockspool --formula security-audit   # Focus on vulnerabilities
blockspool --formula test-coverage     # Add missing tests
blockspool --formula type-safety       # Improve TypeScript types
blockspool --formula cleanup           # Dead code, unused imports
blockspool --formula docs              # Documentation improvements
blockspool --formula docs-audit        # Find stale/inaccurate docs
blockspool --deep                      # Architectural review (shortcut for --formula deep)
```

| Formula | Categories | What it does |
|---------|------------|--------------|
| `security-audit` | security | SQL injection, XSS, auth issues, secrets |
| `test-coverage` | test | Missing tests, low coverage areas |
| `type-safety` | types | Loose types, missing annotations, `any` usage |
| `cleanup` | cleanup | Dead code, unused imports, unreachable paths |
| `docs` | docs | Missing or outdated documentation |
| `docs-audit` | docs | Cross-references docs against codebase for accuracy |
| `deep` | all | Principal-engineer-level architectural review |

---

## docs-audit

The `docs-audit` formula cross-references your markdown files (README, CONTRIBUTING, docs/) against the actual codebase to find stale, inaccurate, or outdated documentation.

**Automatic docs-audit:** BlockSpool automatically runs a docs-audit every 3 cycles, tracked across sessions in `.blockspool/run-state.json`. Whether you run one cycle at a time or in wheel mode, the counter persists — so your 1st, 2nd runs are normal, and the 3rd triggers a docs check.

```bash
# Change the interval (default: 3)
blockspool --docs-audit-interval 5

# Disable automatic docs-audit entirely
blockspool --no-docs-audit

# Run a one-off docs-audit manually
blockspool --formula docs-audit
```

---

## Guidelines Context Injection

BlockSpool automatically loads your project guidelines and injects them into every scout and execution prompt, so agents follow your conventions. For Claude runs it searches for `CLAUDE.md`; for Codex runs it searches for `AGENTS.md`. If the preferred file isn't found, it falls back to the other. If neither exists, a baseline is auto-generated from your `package.json` (disable with `"autoCreateGuidelines": false`). The file is re-read periodically during long runs (default: every 10 cycles) to pick up edits. The full file content is injected without truncation.

| Backend | Primary | Fallback |
|---------|---------|----------|
| Claude | `CLAUDE.md` | `AGENTS.md` |
| Codex | `AGENTS.md` | `CLAUDE.md` |

### CLAUDE.md Protection

All scout runs read `CLAUDE.md` and `.claude/` for project context but **never propose changes** to them. To opt in to CLAUDE.md edits:

```bash
blockspool --include-claude-md
```

To override the exclusion list for docs-audit specifically, create a custom formula:

```yaml
# .blockspool/formulas/docs-audit.yml  (overrides built-in)
description: Docs audit with custom exclusions
categories: [docs]
min_confidence: 70
exclude: [CLAUDE.md, .claude/**, INTERNAL.md, docs/private/**]
prompt: |
  Cross-reference documentation files against the actual codebase
  to find inaccuracies. Only fix what is wrong or outdated.
```

---

## Custom Formulas

Custom formulas live in `.blockspool/formulas/` and override built-ins with the same name:

```yaml
# .blockspool/formulas/my-formula.yml
description: Focus on error handling
categories: [refactor]
exclude: [vendor/**, generated/**]
prompt: |
  Look for error handling improvements:
  - Missing try/catch blocks
  - Silent error swallowing
  - Unhandled promise rejections
```

Run with:

```bash
blockspool --formula my-formula
```

---

## Formula Fields Reference

| Field | Type | Description |
|-------|------|-------------|
| `description` | string | What the formula does |
| `categories` | array | Proposal types: `security`, `test`, `types`, `refactor`, `perf`, `docs`, `cleanup` |
| `scope` | string | Directory to scan (default: `src`) |
| `min_confidence` | number | Confidence hint for scout (low values trigger planning preamble during execution) |
| `max_prs` | number | Max PRs to create |
| `exclude` | array | Glob patterns to skip (e.g., `CLAUDE.md`, `vendor/**`) |
| `prompt` | string | Instructions for the scout |
| `tags` | array | Organizational tags |
