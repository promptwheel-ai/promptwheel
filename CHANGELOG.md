# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.5.30] - 2026-02-02

### Changed
- **Confidence is now an execution hint, not a filter** — low-confidence proposals are no longer discarded. Instead, confidence and complexity are passed forward to the execution layer.
- **Planning preamble for complex changes** — when confidence < 50% or complexity is moderate/complex, a planning preamble is prepended to the execution prompt instructing the agent to read context, identify side effects, plan, and implement incrementally.
- Removed `--min-confidence` CLI flag and `minConfidence` config default (field kept for backwards compatibility with existing config files).
- Impact score filter remains as the quality gate for proposals.
- **Filter breakdown in rejection messages** — when all proposals are rejected, shows per-filter counts (e.g., "No proposals approved (5 out of scope, 2 blocked by category)") instead of the opaque "No proposals passed trust filter".

## [0.3.3] - 2026-01-31

### Added
- **Project guidelines context** — automatically loads CLAUDE.md (Claude runs) or AGENTS.md (Codex runs) into every scout and execution prompt
- Auto-creates baseline guidelines from `package.json` when no file exists
- Configurable custom guidelines path, auto-create toggle, and refresh interval (`guidelinesRefreshCycles`)
- `@blockspool/mcp` — MCP server package for plugin-based orchestration
- Configurable retention, auto-prune, periodic pull, and `prune` command
- Deferred out-of-scope proposals with automatic retry when scope matches
- Landing page: project guidelines feature card, FAQ entry, comparison matrix row

### Changed
- Favicon replaced with BlockSpool logo (Next.js `icon.tsx` route)
- Navbar logo size increased

## [0.1.0] - 2025-01-26

### Added
- Initial open source release
- `@blockspool/core` - Core business logic and database adapter interface
- `@blockspool/cli` - Command-line interface with solo mode
- `@blockspool/sqlite` - Zero-config SQLite adapter for local development
- Solo mode commands: `init`, `scout`, `run`, `pr`, `auto`, `status`, `doctor`
- TUI dashboard for monitoring long-running sessions
- Built-in starter pack with CI fix automation

### Security
- All packages published with npm provenance

[Unreleased]: https://github.com/blockspool/blockspool/compare/v0.3.3...HEAD
[0.3.3]: https://github.com/blockspool/blockspool/compare/v0.2.0...v0.3.3
[0.1.0]: https://github.com/blockspool/blockspool/releases/tag/v0.2.0
