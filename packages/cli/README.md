# PromptWheel CLI

Zero-config continuous improvement tool. Works locally with any git repository.

## Quick Start (5 minutes)

```bash
# Install globally
npm install -g @promptwheel/cli

# Navigate to any git repo
cd your-project

# Check prerequisites
promptwheel solo doctor

# Initialize (auto-detects QA commands from package.json)
promptwheel solo init

# Scan for improvement opportunities
promptwheel solo scout .

# Approve proposals (e.g., 1-3)
promptwheel solo approve 1-3

# Execute a ticket with Claude
promptwheel solo run tkt_abc123

# Or execute and create a PR
promptwheel solo run tkt_abc123 --pr
```

## Prerequisites

Run `promptwheel solo doctor` to check all prerequisites:

| Requirement | Purpose | Install |
|-------------|---------|---------|
| Node.js 18+ | Runtime | [nodejs.org](https://nodejs.org/) |
| Git | Version control | [git-scm.com](https://git-scm.com/) |
| Claude CLI | Execute tickets | [claude.ai/code](https://claude.ai/code) |
| GitHub CLI | Create PRs (optional) | [cli.github.com](https://cli.github.com/) |

## Commands

### `solo init`
Initialize PromptWheel in your repository. Creates `.promptwheel/` directory with:
- `config.json` - Configuration (auto-detects QA commands)
- `state.sqlite` - Local database

### `solo scout [path]`
Scan codebase for improvement opportunities:
- Code quality issues
- Security vulnerabilities
- Performance optimizations
- Test coverage gaps

### `solo approve <selection>`
Convert proposals to tickets. Examples:
- `promptwheel solo approve 1` - Approve proposal #1
- `promptwheel solo approve 1-3` - Approve proposals 1, 2, and 3
- `promptwheel solo approve all` - Approve all proposals

### `solo run <ticketId>`
Execute a ticket using Claude Code CLI:
- Creates a branch for changes
- Runs QA commands (if configured)
- Commits changes
- `--pr` flag creates a GitHub PR

### `solo status`
Show current state:
- Active tickets
- Recent runs
- QA results

### `solo doctor`
Check prerequisites and environment health:
- Git installation
- Claude CLI installation and auth
- GitHub CLI installation and auth
- Node.js version
- SQLite native module
- Directory permissions

### `solo nudge [text...]`
Steer a running auto session with live hints:
- `promptwheel solo nudge "focus on auth"` — Add a hint
- `promptwheel solo nudge --list` — Show pending hints
- `promptwheel solo nudge --clear` — Clear all hints

Hints are consumed in the next scout cycle. In continuous mode, you can also type hints directly into stdin.

### `solo qa`
Run QA commands manually:
- Uses commands from `.promptwheel/config.json`
- Records results in database

## Configuration

Configuration lives in `.promptwheel/config.json`:

```json
{
  "version": 1,
  "qa": {
    "commands": [
      { "name": "typecheck", "cmd": "npm run typecheck" },
      { "name": "lint", "cmd": "npm run lint" },
      { "name": "test", "cmd": "npm test" }
    ],
    "retry": {
      "enabled": true,
      "maxAttempts": 3
    }
  },
  "spindle": {
    "enabled": true,
    "maxStallIterations": 5,
    "tokenBudgetAbort": 140000
  }
}
```

### QA Commands
Auto-detected from `package.json` during `solo init`:
- `typecheck` / `type-check` - TypeScript checking
- `lint` - Linting
- `test` - Testing
- `build` - Build verification

### Project Guidelines Context

PromptWheel automatically loads your project guidelines and injects them into every scout and execution prompt so agents respect your conventions.

**File selection by backend:**

| Backend | Primary | Fallback |
|---------|---------|----------|
| Claude | `CLAUDE.md` | `AGENTS.md` |
| Codex | `AGENTS.md` | `CLAUDE.md` |

**Behavior:**

- **Auto-create:** If no guidelines file exists, a baseline is generated from your `package.json` (project name, TypeScript detection, test/lint/build commands, monorepo detection)
- **Truncation:** Content longer than 4000 characters is truncated with a `[truncated]` marker
- **Refresh:** During long runs, re-reads every N cycles (default 10, configurable)
- **Format:** Wrapped in `<project-guidelines>` XML tags in the prompt

Configure in `.promptwheel/config.json`:

```json
{
  "auto": {
    "guidelinesRefreshCycles": 10,
    "autoCreateGuidelines": true,
    "guidelinesPath": null
  }
}
```

| Setting | Default | Description |
|---------|---------|-------------|
| `guidelinesRefreshCycles` | `10` | Re-read every N cycles (0 = disabled, still loaded once at start) |
| `autoCreateGuidelines` | `true` | Auto-create baseline file from `package.json` if none exists |
| `guidelinesPath` | `null` | Custom path relative to repo root (e.g. `"docs/CONVENTIONS.md"`). Set to `false` to disable guidelines entirely. `null` = default search. |

### Spindle Loop Detection
Prevents runaway agent execution:
- **Oscillation**: Detects add→remove→add patterns
- **Stalling**: Stops after N iterations without changes
- **Repetition**: Catches repeated output patterns
- **Token Budget**: Enforces context limits

## Push Safety

PromptWheel records your `origin` remote URL when you run `solo init`.
Every push and PR creation validates the current origin still matches.
SSH and HTTPS URLs for the same repo are treated as equivalent.

If your origin changes (e.g., you switch from HTTPS to SSH), re-initialize:

    promptwheel solo init --force

Or edit `.promptwheel/config.json` directly:

    { "allowedRemote": "git@github.com:you/your-repo.git" }

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | General failure |
| 2 | Spindle abort (agent loop detected) |
| 130 | Cancelled (Ctrl+C) |

## Artifacts

Run artifacts are stored in `.promptwheel/artifacts/`:
- `runs/` - Run summaries
- `executions/` - Agent output logs
- `diffs/` - Git diff snapshots
- `violations/` - Scope violation details
- `spindle/` - Spindle abort diagnostics

View artifacts with:
```bash
promptwheel solo artifacts
promptwheel solo artifacts --type runs
```

## License

Apache-2.0
