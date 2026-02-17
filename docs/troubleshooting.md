# Troubleshooting Guide

Common issues and solutions when using PromptWheel.

## Installation Issues

### `npm install` fails with permission errors

**Problem:**
```
EACCES: permission denied
```

**Solution:**
Use a Node version manager or fix npm permissions:

```bash
# Option 1: Use nvm (recommended)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash
nvm install 20
nvm use 20
npm install -g @promptwheel/cli

# Option 2: Fix npm permissions
mkdir ~/.npm-global
npm config set prefix '~/.npm-global'
export PATH=~/.npm-global/bin:$PATH
npm install -g @promptwheel/cli
```

### `promptwheel: command not found`

**Problem:** CLI not in PATH after installation.

**Solution:**
```bash
# Check where npm installs global packages
npm config get prefix

# Add to PATH (add to ~/.bashrc or ~/.zshrc)
export PATH="$(npm config get prefix)/bin:$PATH"

# Reload shell
source ~/.bashrc  # or ~/.zshrc
```

## Doctor Failures

### `Claude CLI not found`

**Problem:**
```
✗ Claude CLI not installed
```

**Solution:**
1. Install Claude CLI from [claude.ai/code](https://claude.ai/code)
2. Authenticate: `claude login`
3. Verify: `claude --version`

### `Claude CLI not authenticated`

**Problem:**
```
✗ Claude CLI not authenticated
```

**Solution:**
```bash
claude login
```

Follow the prompts to authenticate with your Anthropic account.

### `GitHub CLI not authenticated`

**Problem:**
```
⚠ GitHub CLI not authenticated (PR creation won't work)
```

**Solution:**
```bash
gh auth login
```

This is optional - you can still use PromptWheel without PR creation.

## Initialization Issues

### `Project already initialized`

**Problem:**
```
Error: .promptwheel/config.json already exists
```

**Solution:**
```bash
# Re-initialize with force
promptwheel solo init --force
```

### `Could not detect project type`

**Problem:** No `package.json` found.

**Solution:**
1. Run from project root directory
2. Or create minimal `package.json`:
   ```bash
   npm init -y
   ```

## Scout Issues

### `No proposals found`

**Problem:** Scout completes but finds nothing.

**Possible causes:**
1. Small codebase with no issues
2. Exclude patterns too broad
3. Categories too narrow

**Solution:**
```bash
# Check what's being excluded
cat .promptwheel/config.json

# Scout specific directory
promptwheel solo scout src/

# Scout all categories
promptwheel solo scout . --categories all
```

### Scout is very slow

**Problem:** Scanning takes too long.

**Solution:**
1. Exclude large directories:
   ```json
   {
     "scout": {
       "exclude": ["node_modules", "dist", ".git", "coverage", "*.min.js"]
     }
   }
   ```
2. Target specific directories:
   ```bash
   promptwheel solo scout src/
   ```

## Execution Issues

### `Ticket blocked after execution`

**Problem:**
```
Ticket tkt_abc123 blocked: QA failed
```

**Causes:**
- Tests failing
- Lint errors
- Type errors
- Build errors

**Solution:**
1. Check QA output:
   ```bash
   promptwheel solo status --all
   ```
2. Run QA manually:
   ```bash
   promptwheel solo qa
   ```
3. Fix issues and retry:
   ```bash
   promptwheel solo retry tkt_abc123
   ```

### `Claude CLI timeout`

**Problem:**
```
Error: Execution timeout after 300000ms
```

**Solution:**
Increase timeout in config:
```json
{
  "execution": {
    "timeout": 600000
  }
}
```

### `Max iterations exceeded`

**Problem:**
```
Error: Max iterations (5) exceeded
```

**Solution:**
The ticket may be too complex. Either:

1. Increase iterations:
   ```json
   {
     "execution": {
       "maxIterations": 10
     }
   }
   ```

2. Break down the ticket manually

### `Branch already exists`

**Problem:**
```
Error: Branch promptwheel/tkt_abc123 already exists
```

**Solution:**
```bash
# Delete the branch
git branch -D promptwheel/tkt_abc123

# Or use custom branch name
promptwheel solo run tkt_abc123 --branch fix/my-branch
```

## Database Issues

### `SQLite database locked`

**Problem:**
```
Error: SQLITE_BUSY: database is locked
```

**Causes:**
- Another PromptWheel process running
- Database file permissions

**Solution:**
```bash
# Check for running processes
ps aux | grep promptwheel

# Kill stale processes
pkill -f promptwheel

# Check permissions
ls -la .promptwheel/
```

### `PostgreSQL connection failed`

**Problem:**
```
Error: Connection refused to localhost:5432
```

**Solution:**
1. Check PostgreSQL is running:
   ```bash
   pg_isready
   ```
2. Verify connection string:
   ```bash
   echo $DATABASE_URL
   psql $DATABASE_URL -c "SELECT 1"
   ```
3. Check firewall/network settings

## PR Creation Issues

### `PR creation failed: Not authenticated`

**Problem:**
```
Error: gh: not authenticated
```

**Solution:**
```bash
gh auth login
gh auth status
```

### `PR creation failed: No upstream`

**Problem:**
```
Error: No upstream branch configured
```

**Solution:**
```bash
# Push branch first
git push -u origin HEAD

# Then create PR
promptwheel solo run tkt_abc123 --pr
```

## Performance Issues

### High memory usage

**Problem:** PromptWheel using too much RAM.

**Solution:**
1. Use SQLite instead of Postgres for local dev
2. Limit proposal count:
   ```json
   {
     "scout": {
       "maxProposals": 10
     }
   }
   ```

### Slow TUI updates

**Problem:** TUI dashboard is laggy.

**Solution:**
- Reduce polling frequency (default is 2s)
- Use `promptwheel solo status` for one-time checks

## Getting Help

If you're still stuck:

1. Check existing issues: [GitHub Issues](https://github.com/promptwheel-ai/promptwheel/issues)
2. Create a new issue with:
   - PromptWheel version (`promptwheel --version`)
   - Node.js version (`node --version`)
   - Operating system
   - Full error message
   - Steps to reproduce

3. Include debug output:
   ```bash
   PROMPTWHEEL_LOG_LEVEL=debug promptwheel solo <command>
   ```
