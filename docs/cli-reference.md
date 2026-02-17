# CLI Reference

Complete reference for all PromptWheel CLI commands.

## Global Options

```bash
promptwheel [options] <command>
```

| Option | Description |
|--------|-------------|
| `--version` | Show version number |
| `--help` | Show help |

## Commands

### `promptwheel solo doctor`

Check system prerequisites and configuration.

```bash
promptwheel solo doctor
```

**Checks:**
- Node.js version (18+)
- Git installation
- Claude CLI installation and authentication
- GitHub CLI (optional)
- Project configuration

**Output:**
```
PromptWheel Doctor
─────────────────
✓ Node.js 20.10.0
✓ Git 2.43.0
✓ Claude CLI authenticated
✓ GitHub CLI authenticated
✓ Project initialized

All checks passed!
```

---

### `promptwheel solo init`

Initialize PromptWheel in the current directory.

```bash
promptwheel solo init [options]
```

**Options:**

| Option | Description | Default |
|--------|-------------|---------|
| `--force` | Overwrite existing config | `false` |

**What it does:**
1. Creates `.promptwheel/` directory
2. Creates `config.json` with auto-detected settings
3. Initializes SQLite database (or connects to Postgres if `DATABASE_URL` is set)

**Auto-detection:**
- Reads `package.json` for available scripts
- Configures QA commands (typecheck, lint, test)
- Detects project type (Node, Python, etc.)

---

### `promptwheel solo scout`

Scan codebase for improvement opportunities.

```bash
promptwheel solo scout [path] [options]
```

**Arguments:**

| Argument | Description | Default |
|----------|-------------|---------|
| `path` | Directory or file to scan | `.` (current directory) |

**Options:**

| Option | Description | Default |
|--------|-------------|---------|
| `--categories` | Filter by category | All |
| `--max` | Maximum proposals | 20 |

**Categories:**
- `security` - Security vulnerabilities
- `performance` - Performance optimizations
- `tests` - Missing or incomplete tests
- `refactor` - Code quality improvements
- `docs` - Documentation gaps

**Example:**
```bash
# Scan entire project
promptwheel solo scout .

# Scan specific directory
promptwheel solo scout src/api

# Only security issues
promptwheel solo scout . --categories security

# Limit results
promptwheel solo scout . --max 10
```

---

### `promptwheel solo status`

Show current state of tickets and proposals.

```bash
promptwheel solo status [options]
```

**Options:**

| Option | Description | Default |
|--------|-------------|---------|
| `--all` | Show all tickets (including done) | `false` |
| `--json` | Output as JSON | `false` |

**Output:**
```
PromptWheel Status
─────────────────

Proposals (3 pending):
  1. [security] Fix SQL injection in user query
  2. [tests] Add tests for auth middleware
  3. [refactor] Extract duplicate validation logic

Tickets:
  tkt_abc123 [in_progress] Fix XSS vulnerability
  tkt_def456 [pending] Add input validation

Recent:
  tkt_ghi789 [done] Update dependencies
```

---

### `promptwheel solo approve`

Convert proposals to actionable tickets.

```bash
promptwheel solo approve <selection>
```

**Arguments:**

| Argument | Description | Example |
|----------|-------------|---------|
| `selection` | Proposals to approve | `1`, `1,3,5`, `1-5`, `all` |

**Examples:**
```bash
# Approve single proposal
promptwheel solo approve 1

# Approve multiple
promptwheel solo approve 1,3,5

# Approve range
promptwheel solo approve 1-5

# Approve all
promptwheel solo approve all
```

---

### `promptwheel solo run`

Execute a ticket.

```bash
promptwheel solo run <ticketId> [options]
```

**Arguments:**

| Argument | Description |
|----------|-------------|
| `ticketId` | The ticket ID (e.g., `tkt_abc123`) |

**Options:**

| Option | Description | Default |
|--------|-------------|---------|
| `--pr` | Create pull request after success | `false` |
| `--branch` | Custom branch name | Auto-generated |
| `--dry-run` | Show what would happen | `false` |

**Process:**
1. Creates branch `promptwheel/<ticket-id>`
2. Runs Claude CLI with ticket context
3. Runs QA commands
4. If QA passes and `--pr`: creates PR
5. Updates ticket status

**Examples:**
```bash
# Execute ticket
promptwheel solo run tkt_abc123

# Execute and create PR
promptwheel solo run tkt_abc123 --pr

# Custom branch
promptwheel solo run tkt_abc123 --branch fix/sql-injection
```

---

### `promptwheel solo retry`

Retry a blocked ticket.

```bash
promptwheel solo retry <ticketId>
```

Resets ticket status from `blocked` to `pending` so it can be run again.

---

### `promptwheel solo qa`

Manually run QA commands.

```bash
promptwheel solo qa [options]
```

**Options:**

| Option | Description |
|--------|-------------|
| `--command` | Run specific command only |

Runs all configured QA commands (typecheck, lint, test) and reports results.

---

### `promptwheel solo auto`

Run in auto mode (planning by default, `--wheel` for continuous).

```bash
promptwheel solo auto [mode]
```

**Modes:**

| Mode | Description |
|------|-------------|
| (none) | Continuously scout and execute |
| `ci` | Only fix CI failures |

**Auto loop:**
1. Scout for improvements
2. Auto-approve based on criteria
3. Execute tickets
4. Create PRs
5. Wait and repeat

**Exit:** Press `Ctrl+C` to stop.

---

### `promptwheel solo tui`

Launch interactive terminal UI.

```bash
promptwheel solo tui
```

**Features:**
- Live ticket status
- QA results
- Progress visualization
- Keyboard navigation

**Keybindings:**
| Key | Action |
|-----|--------|
| `q` | Quit |
| `r` | Refresh |
| `↑/↓` | Navigate |
| `Enter` | Select |

---

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `DATABASE_URL` | Postgres connection string | SQLite |
| `PROMPTWHEEL_LOG_LEVEL` | Log verbosity | `info` |
| `PROMPTWHEEL_CONFIG` | Config file path | `.promptwheel/config.json` |

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | General error |
| 2 | Invalid arguments |
| 3 | Configuration error |
| 4 | QA failure |
