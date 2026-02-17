# Authentication & Backends

BlockSpool supports multiple AI backends. Choose the one that fits your workflow.

## Five Ways to Run

| Route | Auth | Best for |
|-------|------|----------|
| **Plugin** (`/blockspool:run`) | Claude Code subscription | Interactive use, no API key setup |
| **CLI + Claude** (`blockspool`) | `ANTHROPIC_API_KEY` | CI, cron jobs, long runs |
| **CLI + Codex** (`blockspool --codex`) | `codex login` or `OPENAI_API_KEY` | No Anthropic key, Codex-native teams |
| **CLI + Kimi** (`blockspool --kimi`) | `kimi /login` or `MOONSHOT_API_KEY` | Kimi-native teams |
| **CLI + Local** (`blockspool --local`) | None (local server) | Ollama, vLLM, SGLang, LM Studio |

The CLI defaults to Claude Opus (`opus`). You can also use `sonnet` or `haiku` for cost-effective runs.

---

## Claude (default)

Set `ANTHROPIC_API_KEY` in your environment:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
blockspool --hours 8 --batch-size 30
```

Or use the **plugin** inside Claude Code — no API key needed, it uses your subscription directly.

---

## Codex

### Authentication

Two auth methods:

- **`codex login`** — OAuth via ChatGPT subscription. No env var needed.
- **`OPENAI_API_KEY`** — API key in your environment. Required for some models.

```bash
# OAuth (opens browser)
codex login

# Run with Codex
blockspool --codex --hours 8 --batch-size 30
```

### Model availability

BlockSpool uses the official `codex exec` CLI. Not all models are available with `codex login` (ChatGPT subscription):

| Model | `codex login` | `OPENAI_API_KEY` |
|-------|:---:|:---:|
| `gpt-5.3-codex` (default) | Yes | Yes |
| `gpt-5.2-codex` | Yes | Yes |
| `gpt-5.1-codex-max` | Yes | Yes |
| `gpt-5.2-codex-high` | No | Yes |
| `gpt-5.2-codex-xhigh` | No | Yes |
| `gpt-5.1-codex-mini` | No | Yes |
| `gpt-5.2` / `-high` / `-xhigh` | No | Yes |

These restrictions are enforced by OpenAI's Codex CLI, not BlockSpool. If your saved model becomes incompatible (e.g., you switch from API key to `codex login`), BlockSpool will prompt you to re-select.

### Changing your saved model

```bash
blockspool --codex --codex-model <name>
```

### Can third-party tools bypass these restrictions?

Some third-party tools intercept Codex OAuth tokens to access restricted models. **This likely violates OpenAI's Terms of Service** — users have reported account bans for similar approaches with other providers. BlockSpool only uses the official `codex exec` CLI and respects its model restrictions.

---

## Kimi

### Authentication

Two auth methods:

- **`kimi /login`** — OAuth, opens browser (one-time).
- **`MOONSHOT_API_KEY`** — API key in your environment.

```bash
# Login via OAuth (one-time, opens browser)
kimi   # then type /login inside the session

# Run with Kimi
blockspool --kimi --kimi-model kimi-k2.5

# Or use an API key instead
export MOONSHOT_API_KEY=...
blockspool --kimi
```

---

## Local Models (Ollama, vLLM, SGLang, LM Studio)

Run with any OpenAI-compatible local server. No API key needed — runs entirely on your machine.

The local backend uses an **agentic tool-use loop** — the LLM gets `read_file`, `write_file`, and `run_command` tools and iterates until done.

```bash
# Start Ollama (or any OpenAI-compatible server)
ollama serve

# Run with a local model
blockspool --local --local-model qwen2.5-coder

# Custom server URL (default: http://localhost:11434/v1)
blockspool --local --local-model deepseek-coder-v2 --local-url http://localhost:8080/v1

# Limit agentic loop iterations (default: 20)
blockspool --local --local-model qwen2.5-coder --local-max-iterations 10
```

Quality depends on the model — larger coding models (Qwen 2.5 Coder 32B, DeepSeek Coder V2) work best.

---

## Hybrid Mode

Use Codex for scouting (cheap, high-volume) and Claude for execution (higher quality):

```bash
blockspool --scout-backend codex
```

Requires both `codex login` and `ANTHROPIC_API_KEY`.

---

## Changing the Default Model

For Claude runs, you can switch between models:

```bash
blockspool --model sonnet    # Use Sonnet (faster, cheaper)
blockspool --model haiku     # Use Haiku (fastest, cheapest)
blockspool --model opus      # Use Opus (default, highest quality)
```

For Codex runs:

```bash
blockspool --codex --codex-model gpt-5.2-codex
```

For local runs:

```bash
blockspool --local --local-model <model-name>
```
