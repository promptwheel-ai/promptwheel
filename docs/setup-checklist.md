# First-Time Setup Checklist

A quick checklist to get BlockSpool running on any project.

## Prerequisites

| Check | Command | Required? |
|-------|---------|-----------|
| Node.js 18+ | `node --version` | Yes |
| Git 2.x | `git --version` | Yes |
| Claude Code CLI | `claude --version` | Yes |
| GitHub CLI | `gh --version` | For PRs only |

## Setup Steps

### 1. Install BlockSpool

**CLI (standalone):**
```bash
npm install -g @blockspool/cli
```

**Claude Code plugin:**
```bash
claude mcp add blockspool -- npx -y @blockspool/mcp
```

### 2. Navigate to Your Project

```bash
cd /path/to/your-project
```

BlockSpool works best from a **git repository root**. If not in a git repo, PR creation is disabled and direct mode is used automatically.

### 3. Initialize

```bash
blockspool init
```

This creates `.blockspool/` with a SQLite database and auto-detected project settings.

### 4. Verify Project Detection

BlockSpool auto-detects your project's language, test runner, linter, and framework. Check what it found:

```bash
blockspool solo doctor
```

If your test runner isn't detected, add a `test` script to `package.json`:
```json
{
  "scripts": {
    "test": "vitest run",
    "lint": "eslint ."
  }
}
```

For non-Node projects, BlockSpool detects: Python (pytest/unittest), Rust (cargo), Go, Java (Maven/Gradle), Ruby, PHP, Elixir, C/C++ (Make/CMake), and Makefile-based projects.

### 5. Add Project Guidelines (Recommended)

Create a `CLAUDE.md` at your project root with conventions BlockSpool should follow:

```markdown
# Project Guidelines

## Conventions
- Use TypeScript strict mode
- Tests use Vitest
- Follow existing patterns in the codebase

## Key Commands
npm test        # Run tests
npm run lint    # Lint check
```

BlockSpool injects these guidelines into every scout and execution prompt. Without them, it uses generic best practices.

### 6. Run Your First Scout

```bash
# CLI
blockspool

# Plugin
/blockspool:run
```

BlockSpool will:
1. Scan your codebase for improvements
2. Show you a roadmap of proposals
3. Ask for approval before executing

### 7. Review and Approve

The roadmap shows proposals ranked by impact. Review them, then approve what looks good. BlockSpool executes approved tickets in parallel, runs your QA commands, and creates PRs.

## Quick Checks

After setup, verify everything works:

| Check | What to look for |
|-------|-----------------|
| `.blockspool/` directory exists | Created by `init` |
| Test runner detected | Shown in session start warnings |
| CLAUDE.md exists | "Using project guidelines from CLAUDE.md" in session start |
| Git repo clean | No uncommitted changes that could conflict |

## Configuration

BlockSpool works with zero configuration, but you can tune it:

```bash
# Narrow scope to specific directories
blockspool --scope "src/**"

# Use a formula for focused scanning
blockspool --formula security-audit

# Set minimum quality bar
blockspool --min-impact-score 5

# Run for a fixed duration
blockspool --hours 4
```

See [Configuration](./configuration.md) for all options.

## Recommended First Run

For your first run, start small:

```bash
blockspool --max-proposals 3 --min-impact-score 5
```

This limits to 3 high-impact proposals so you can review the quality before scaling up.

## Next Steps

- [Getting Started](./getting-started.md) - Detailed walkthrough
- [Formulas](./formulas.md) - Focused scanning recipes
- [Configuration](./configuration.md) - All configuration options
- [Troubleshooting](./troubleshooting.md) - Common issues
