# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.6.0] - 2026-02-16

### Added

- **Language-agnostic mode** — Full support for Python, Rust, Go, Java, Ruby, Elixir, C#, Swift, Dart/Flutter, Scala, Haskell, Zig, and C/C++ projects
- **Dry-run mode** (`--dry-run`) — Scout-only execution, no tickets created or code modified
- **Session-level QA commands** (`qa_commands`) — Always run specified commands after every ticket
- **Per-ticket spindle detection** — Loop detection isolated per ticket instead of global
- **QA classification system** — Smarter parsing of QA results with pass/fail/error distinction
- **Timeout watchdog** — Detects and terminates agents stalled for 50+ steps
- **Skip adversarial review** (`skip_review: true`) — Bypass two-Claude review pattern for faster iteration
- **Marketplace skills** — All 12 plugin skills discoverable in Claude Code marketplace

### Changed

- **Codebase index** — Import extraction for 12+ languages, binary file detection, deeper walking (3 levels), module limit raised to 80
- **Project metadata detection** — New: Dart/Flutter, Scala, Haskell, Zig, C/C++ (CMake). Fixed Gradle/Kotlin
- **Polyglot tool auto-approve** — Test runner patterns for pytest, cargo test, go test, mvn test, mix test, dotnet test, phpunit, swift test, make test
- **Scope enforcement** — Removed overly broad `*.lock` deny rule. Added polyglot related-file recognition
- **Excluded directories** — Added `__pycache__`, `.venv`, `target`, `.gradle`, `_build`, `deps`, `.bundle`
- **Session robustness** — PID-based lock file, dirty git warning, auto `.gitignore` management

### Fixed

- Adversarial review in MCP mode — review prompt now includes `promptwheel_ingest_event` instructions
- Fallback parsing when LLM sends review results through `SCOUT_OUTPUT` instead of `PROPOSALS_REVIEWED`
- `USER_OVERRIDE` to support `skip_review` mid-session
- Directory-style `allowed_paths` normalization in scope validation
- Binary file detection in codebase index — was skipping all small files due to zero-padded buffer

## [0.5.30] - 2026-02-02

### Changed
- **Confidence is now an execution hint, not a filter** — low-confidence proposals are no longer discarded. Instead, confidence and complexity are passed forward to the execution layer.
- **Planning preamble for complex changes** — when confidence < 50% or complexity is moderate/complex, a planning preamble is prepended to the execution prompt instructing the agent to read context, identify side effects, plan, and implement incrementally.
- Removed `--min-confidence` CLI flag and `minConfidence` config default (field kept for backwards compatibility with existing config files).
- Impact score filter remains as the quality gate for proposals.
- **Filter breakdown in rejection messages** — when all proposals are rejected, shows per-filter counts (e.g., "No proposals approved (5 out of scope, 2 blocked by category)") instead of the opaque "No proposals passed trust filter".
- **Removed test proposal paranoia layers** — deleted `looksLikeTestProposal()` reclassification from CLI and MCP, removed "CATEGORY HONESTY" section from scout prompt. Category allow/block list is sufficient — if a test sneaks through labeled as "refactor" it either works or fails QA. Reduces complexity from 5 test-suppression layers to 2 (category gate + maxTestRatio).

## [0.3.3] - 2026-01-31

### Added
- **Project guidelines context** — automatically loads CLAUDE.md (Claude runs) or AGENTS.md (Codex runs) into every scout and execution prompt
- Auto-creates baseline guidelines from `package.json` when no file exists
- Configurable custom guidelines path, auto-create toggle, and refresh interval (`guidelinesRefreshCycles`)
- `@promptwheel/mcp` — MCP server package for plugin-based orchestration
- Configurable retention, auto-prune, periodic pull, and `prune` command
- Deferred out-of-scope proposals with automatic retry when scope matches
- Landing page: project guidelines feature card, FAQ entry, comparison matrix row

### Changed
- Favicon replaced with PromptWheel logo (Next.js `icon.tsx` route)
- Navbar logo size increased

## [0.1.0] - 2025-01-26

### Added
- Initial open source release
- `@promptwheel/core` - Core business logic and database adapter interface
- `@promptwheel/cli` - Command-line interface with solo mode
- `@promptwheel/sqlite` - Zero-config SQLite adapter for local development
- Solo mode commands: `init`, `scout`, `run`, `pr`, `auto`, `status`, `doctor`
- TUI dashboard for monitoring long-running sessions
- Built-in starter pack with CI fix automation

### Security
- All packages published with npm provenance

[Unreleased]: https://github.com/promptwheel-ai/promptwheel/compare/v0.3.3...HEAD
[0.3.3]: https://github.com/promptwheel-ai/promptwheel/compare/v0.2.0...v0.3.3
[0.1.0]: https://github.com/promptwheel-ai/promptwheel/releases/tag/v0.2.0
