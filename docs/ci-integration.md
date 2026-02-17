# CI Integration

Run PromptWheel on a schedule to continuously improve your codebase without manual intervention.

---

## GitHub Actions

### Basic Nightly Run

```yaml
# .github/workflows/promptwheel.yml
name: PromptWheel

on:
  schedule:
    - cron: '0 3 * * 1-5'  # Weeknights at 3am UTC
  workflow_dispatch:         # Manual trigger

permissions:
  contents: write
  pull-requests: write

jobs:
  promptwheel:
    runs-on: ubuntu-latest
    timeout-minutes: 150

    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0  # Full history for worktrees

      - uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Install dependencies
        run: npm ci

      - name: Install PromptWheel
        run: npm install -g @promptwheel/cli

      - name: Initialize PromptWheel
        run: promptwheel init

      - name: Run PromptWheel
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: promptwheel --hours 2 --pr --safe --yes --no-tui
```

### Key flags for CI

| Flag | Purpose |
|------|---------|
| `--hours 2` | Time budget (prevents runaway costs) |
| `--pr` | Create PRs instead of direct commits |
| `--safe` | Conservative categories only (no tests, no risky changes) |
| `--yes` | Skip interactive prompts |
| `--no-tui` | Disable terminal UI (no TTY in CI) |
| `--batch-size 10` | Group 10 tickets into one milestone PR |
| `--scope src` | Limit to specific directory |
| `--formula security-audit` | Focus on a specific formula |

### Milestone PRs (Recommended for CI)

Individual PRs per ticket create review noise. Use milestone mode to batch tickets:

```yaml
      - name: Run PromptWheel
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: promptwheel --hours 2 --batch-size 10 --pr --safe --yes --no-tui
```

This creates one PR with up to 10 improvements instead of 10 separate PRs.

### Weekly Deep Review

Run an architectural review on a slower schedule:

```yaml
on:
  schedule:
    - cron: '0 6 * * 0'  # Sundays at 6am UTC

# ...same steps, but:
      - name: Run PromptWheel (deep)
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: promptwheel --hours 1 --deep --pr --yes --no-tui
```

### PR Permissions

The built-in `GITHUB_TOKEN` is sufficient for creating PRs in the same repository. If you need cross-repo PRs or additional permissions, create a [fine-grained personal access token](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens) with `contents: write` and `pull-requests: write` scopes, then store it as a repository secret.

---

## GitLab CI

```yaml
# .gitlab-ci.yml
promptwheel:
  image: node:20
  rules:
    - if: $CI_PIPELINE_SOURCE == "schedule"
  variables:
    ANTHROPIC_API_KEY: $ANTHROPIC_API_KEY
  before_script:
    - npm install -g @promptwheel/cli
    - npm ci
    - promptwheel init
    - git config user.name "PromptWheel"
    - git config user.email "promptwheel@noreply"
    - git remote set-url origin "https://oauth2:${CI_JOB_TOKEN}@${CI_SERVER_HOST}/${CI_PROJECT_PATH}.git"
  script:
    - promptwheel --hours 2 --pr --safe --yes --no-tui
```

Create a [pipeline schedule](https://docs.gitlab.com/ee/ci/pipelines/schedules.html) for nightly or weekly runs. Add `ANTHROPIC_API_KEY` as a CI/CD variable (masked).

---

## Generic CI

Any CI system that can run Node.js and Git works. The requirements:

### Environment Variables

| Variable | Required | Purpose |
|----------|----------|---------|
| `ANTHROPIC_API_KEY` | Yes (Claude) | API authentication |
| `OPENAI_API_KEY` | Yes (Codex) | API authentication (alternative to Claude) |
| `GITHUB_TOKEN` | For PRs | PR creation via `gh` CLI |

### Git Setup

PromptWheel creates branches and worktrees. The CI runner needs:

- Full git history (`git clone --depth=0` or `fetch-depth: 0`)
- Push access to the repository (for branches and PRs)
- `user.name` and `user.email` configured

### Minimum Script

```bash
#!/bin/bash
set -e

npm install -g @promptwheel/cli
npm ci
promptwheel init
promptwheel --hours 2 --pr --safe --yes --no-tui
```

---

## Best Practices

### Run on a Schedule, Not on Every Push

PromptWheel scouts and rewrites code. Running it on every push wastes API credits and creates merge conflicts with in-flight work. Use cron schedules:

- **Nightly** for active projects
- **Weekly** for stable/maintenance projects
- **Manual trigger** for on-demand runs

### Preview First with `--dry-run`

Before enabling automated runs, test locally:

```bash
promptwheel --dry-run --safe
```

This shows what PromptWheel would propose without making changes.

### Use `--safe` for Conservative Changes

The `--safe` flag restricts to low-risk categories (refactor, docs, types, perf). It excludes security fixes, cleanup, and tests, which are more likely to need human judgment.

Remove `--safe` once you trust PromptWheel's output on your codebase.

### Scope to Specific Directories

Avoid scanning generated code, vendored dependencies, or large test fixtures:

```bash
promptwheel --scope src --hours 2 --pr --yes --no-tui
```

Or use config:

```json
{
  "auto": {
    "defaultScope": "src"
  }
}
```

### Set Time Budgets

Always use `--hours` in CI. Without it, PromptWheel runs a single cycle and exits (which is fine), but `--wheel` without `--hours` would run forever.

```bash
# Single cycle (quick, exits when done)
promptwheel --pr --safe --yes --no-tui

# Timed run (2 hours, multiple cycles)
promptwheel --hours 2 --pr --safe --yes --no-tui

# Wheel mode with budget (runs until time expires)
promptwheel --wheel --hours 2 --pr --safe --yes --no-tui
```

### Set Minimum Impact Score

Filter out low-value proposals to reduce noise:

```bash
promptwheel --min-impact-score 5 --hours 2 --pr --yes --no-tui
```

---

## Codex Backend in CI

Use the `--codex` flag with an `OPENAI_API_KEY`:

```yaml
      - name: Run PromptWheel (Codex)
        env:
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: promptwheel --codex --codex-model gpt-5.3-codex --hours 2 --pr --safe --yes --no-tui
```

In CI, always pass `--codex-model` explicitly. Without it, PromptWheel opens an interactive model picker that will hang in a non-TTY environment.

The `codex login` OAuth flow is not available in CI — use `OPENAI_API_KEY` instead.

---

## Local LLM in CI

Use `--local` with a self-hosted model server (Ollama, vLLM, SGLang, LM Studio). This avoids API costs entirely but requires a GPU runner.

```yaml
# Self-hosted runner with GPU
promptwheel-local:
  runs-on: self-hosted
  steps:
    - uses: actions/checkout@v4
      with:
        fetch-depth: 0

    - name: Start Ollama
      run: ollama serve &

    - name: Pull model
      run: ollama pull qwen2.5-coder:32b

    - name: Run PromptWheel
      env:
        GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
      run: |
        npm install -g @promptwheel/cli
        promptwheel init
        promptwheel --local --local-model qwen2.5-coder:32b --hours 2 --pr --safe --yes --no-tui
```

For a remote model server:

```bash
promptwheel --local --local-model deepseek-coder-v2 --local-url http://gpu-server:8080/v1 --hours 2 --pr --yes --no-tui
```

Local models have no sandbox. Worktree isolation and QA gating provide the safety layer.

---

## Monitoring

### Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success (at least one ticket completed or nothing to do) |
| 1 | Error (auth failure, config issue, all tickets blocked) |

### Artifacts

PromptWheel stores run logs in `.promptwheel/runs/`. Save them as CI artifacts for debugging:

```yaml
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: promptwheel-logs
          path: .promptwheel/runs/
          retention-days: 7
```

### Notifications

Combine with Slack/email notifications on workflow failure:

```yaml
      - name: Notify on failure
        if: failure()
        run: |
          curl -X POST "$SLACK_WEBHOOK" \
            -H 'Content-Type: application/json' \
            -d '{"text":"PromptWheel run failed. Check: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}"}'
```
