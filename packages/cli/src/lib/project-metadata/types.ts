/**
 * Project metadata types
 */

export interface ProjectMetadata {
  /** Primary language(s) detected */
  languages: string[];
  /** Package manager (npm, yarn, pnpm, bun, pip, poetry, cargo, go, mix, bundle, maven, gradle) */
  package_manager: string | null;
  /** Test runner and CLI syntax */
  test_runner: TestRunnerInfo | null;
  /** App framework (next, remix, express, django, flask, rails, phoenix, spring, etc.) */
  framework: string | null;
  /** Linter (eslint, biome, ruff, clippy, golangci-lint, rubocop, etc.) */
  linter: string | null;
  /** Type checker if separate from compiler (tsc, mypy, pyright, etc.) */
  type_checker: string | null;
  /** Monorepo tool (turborepo, nx, lerna, cargo workspaces, etc.) */
  monorepo_tool: string | null;
  /** Raw detection signals for debugging */
  signals: string[];
}

export interface TestRunnerInfo {
  name: string;       // vitest, jest, mocha, pytest, cargo-test, go-test, rspec, minitest, junit, exunit
  run_command: string; // e.g. "npm test", "pytest", "cargo test", "go test ./..."
  filter_syntax: string; // e.g. "npm test -- path/to/file", "pytest path/to/file", "cargo test test_name"
}

/** Context passed to each language detector */
export interface DetectorContext {
  projectRoot: string;
  exists: (f: string) => boolean;
  readJson: (f: string) => Record<string, unknown> | null;
  readText: (f: string) => string | null;
  existsGlob: (pattern: string) => boolean;
}

/** A language detector mutates the metadata in place */
export type LanguageDetector = (ctx: DetectorContext, meta: ProjectMetadata) => void;
