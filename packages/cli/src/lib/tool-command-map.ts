/**
 * Static maps from detected tool names → runnable CLI commands.
 *
 * Used by detectQaCommands() to generate QA commands for non-Node projects
 * based on project metadata detection.
 */

/** Linter name → command to run */
export const LINTER_COMMANDS: Record<string, string> = {
  eslint: 'npx eslint .',
  biome: 'npx biome check .',
  ruff: 'ruff check .',
  flake8: 'flake8 .',
  clippy: 'cargo clippy -- -D warnings',
  'golangci-lint': 'golangci-lint run',
  rubocop: 'bundle exec rubocop',
  credo: 'mix credo --strict',
};

/** Type checker name → command to run */
export const TYPE_CHECKER_COMMANDS: Record<string, string> = {
  tsc: 'npx tsc --noEmit',
  mypy: 'mypy .',
  pyright: 'pyright',
};
