# Getting Started with BlockSpool

This guide will help you set up BlockSpool and run your first automated code improvement.

## Prerequisites

Before installing BlockSpool, ensure you have:

| Requirement | Version | Purpose | Installation |
|-------------|---------|---------|--------------|
| Node.js | 18+ | Runtime | [nodejs.org](https://nodejs.org/) |
| Git | 2.x | Version control | [git-scm.com](https://git-scm.com/) |
| Claude CLI | Latest | Execute improvements | [claude.ai/code](https://claude.ai/code) |
| GitHub CLI | Optional | Create PRs | [cli.github.com](https://cli.github.com/) |

## Installation

```bash
npm install -g @blockspool/cli
```

Verify the installation:

```bash
blockspool --version
```

## Quick Start

### 1. Check Your Environment

Navigate to your project and run the doctor command:

```bash
cd your-project
blockspool solo doctor
```

This checks all prerequisites and shows any issues.

### 2. Initialize BlockSpool

```bash
blockspool solo init
```

This creates `.blockspool/config.json` with:
- Auto-detected QA commands from your `package.json`
- SQLite database for local state
- Default scout configuration

### 3. Scout for Improvements

```bash
blockspool solo scout .
```

BlockSpool scans your codebase and identifies:
- Security vulnerabilities
- Performance optimizations
- Missing tests
- Code quality improvements
- Refactoring opportunities

### 4. Review Proposals

```bash
blockspool solo status
```

You'll see a list of proposals. Each proposal includes:
- Title and description
- Affected files
- Estimated complexity
- Category (security, performance, tests, etc.)

### 5. Approve Proposals

Convert proposals to tickets:

```bash
# Approve specific proposals
blockspool solo approve 1,3,5

# Approve a range
blockspool solo approve 1-5

# Approve all
blockspool solo approve all
```

### 6. Execute a Ticket

```bash
# Execute without PR
blockspool solo run tkt_abc123

# Execute and create PR
blockspool solo run tkt_abc123 --pr
```

BlockSpool will:
1. Create a new branch
2. Run Claude CLI to implement the fix
3. Run your QA commands to verify
4. Create a PR if `--pr` is specified

## Understanding the Workflow

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         BLOCKSPOOL WORKFLOW                              │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│   ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐          │
│   │  SCOUT   │───▶│ PROPOSE  │───▶│ APPROVE  │───▶│ EXECUTE  │          │
│   │          │    │          │    │          │    │          │          │
│   │ Scan     │    │ Review   │    │ Convert  │    │ Claude   │          │
│   │ codebase │    │ findings │    │ to       │    │ implements│          │
│   │          │    │          │    │ tickets  │    │ fix      │          │
│   └──────────┘    └──────────┘    └──────────┘    └────┬─────┘          │
│                                                        │                 │
│                                                        ▼                 │
│                                                   ┌──────────┐          │
│                                                   │    QA    │          │
│                                                   │          │          │
│                                                   │ typecheck│          │
│                                                   │ lint     │          │
│                                                   │ test     │          │
│                                                   └────┬─────┘          │
│                                                        │                 │
│                                    ┌───────────────────┴───────────┐    │
│                                    │                               │    │
│                                    ▼                               ▼    │
│                              ┌──────────┐                   ┌──────────┐│
│                              │  PASS    │                   │  FAIL    ││
│                              │          │                   │          ││
│                              │ Create   │                   │ Retry or ││
│                              │ PR       │                   │ escalate ││
│                              └──────────┘                   └──────────┘│
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

## Ticket States

| State | Description |
|-------|-------------|
| `pending` | Approved, waiting to be worked on |
| `in_progress` | Currently being executed |
| `done` | Successfully completed |
| `blocked` | Failed QA, needs attention |
| `cancelled` | Manually cancelled |

## Next Steps

- [CLI Reference](./cli-reference.md) - Full command documentation
- [Configuration](./configuration.md) - Customize BlockSpool
- [Troubleshooting](./troubleshooting.md) - Common issues and solutions

## Auto Mode

For hands-off operation, use auto:

```bash
# Run in wheel mode, fixing issues as they're found
blockspool --wheel

# Just fix CI failures
blockspool solo auto ci
```

## Interactive TUI

For a visual dashboard:

```bash
blockspool solo tui
```

This shows:
- Active tickets and their status
- Recent completions
- QA results
- Real-time progress
