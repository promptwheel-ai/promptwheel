/**
 * Project Metadata — framework-agnostic detection of tooling, test runners,
 * package managers, and languages.
 *
 * Scans config files at the project root to build a structured summary
 * that gets injected into scout prompts so the LLM knows which CLI
 * flags and conventions to use.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export function detectProjectMetadata(projectRoot: string): ProjectMetadata {
  const meta: ProjectMetadata = {
    languages: [],
    package_manager: null,
    test_runner: null,
    framework: null,
    linter: null,
    type_checker: null,
    monorepo_tool: null,
    signals: [],
  };

  const exists = (f: string) => fs.existsSync(path.join(projectRoot, f));
  const readJson = (f: string): Record<string, unknown> | null => {
    try {
      return JSON.parse(fs.readFileSync(path.join(projectRoot, f), 'utf8'));
    } catch { return null; }
  };
  const readText = (f: string): string | null => {
    try {
      return fs.readFileSync(path.join(projectRoot, f), 'utf8');
    } catch { return null; }
  };

  // -----------------------------------------------------------------------
  // Node / JavaScript / TypeScript
  // -----------------------------------------------------------------------
  if (exists('package.json')) {
    const pkg = readJson('package.json') as Record<string, unknown> | null;
    if (pkg) {
      const devDeps = (pkg.devDependencies ?? {}) as Record<string, string>;
      const deps = (pkg.dependencies ?? {}) as Record<string, string>;
      const scripts = (pkg.scripts ?? {}) as Record<string, string>;
      const allDeps = { ...deps, ...devDeps };

      // Language
      if (allDeps['typescript'] || exists('tsconfig.json')) {
        meta.languages.push('TypeScript');
        meta.type_checker = 'tsc';
        meta.signals.push('tsconfig.json or typescript dep');
      } else {
        meta.languages.push('JavaScript');
      }

      // Package manager
      if (exists('bun.lockb') || exists('bun.lock')) {
        meta.package_manager = 'bun';
      } else if (exists('pnpm-lock.yaml')) {
        meta.package_manager = 'pnpm';
      } else if (exists('yarn.lock')) {
        meta.package_manager = 'yarn';
      } else {
        meta.package_manager = 'npm';
      }

      // Test runner
      if (allDeps['vitest'] || exists('vitest.config.ts') || exists('vitest.config.js') || exists('vitest.config.mts')) {
        const runCmd = scripts['test'] ? `${meta.package_manager} test` : 'npx vitest run';
        meta.test_runner = {
          name: 'vitest',
          run_command: runCmd,
          filter_syntax: `${runCmd} -- <file-or-pattern>`,
        };
        meta.signals.push('vitest detected');
      } else if (allDeps['jest'] || exists('jest.config.js') || exists('jest.config.ts') || exists('jest.config.mjs')) {
        const runCmd = scripts['test'] ? `${meta.package_manager} test` : 'npx jest';
        meta.test_runner = {
          name: 'jest',
          run_command: runCmd,
          filter_syntax: `${runCmd} -- --testPathPattern=<pattern>`,
        };
        meta.signals.push('jest detected');
      } else if (allDeps['mocha']) {
        meta.test_runner = {
          name: 'mocha',
          run_command: scripts['test'] ? `${meta.package_manager} test` : 'npx mocha',
          filter_syntax: `npx mocha --grep <pattern>`,
        };
        meta.signals.push('mocha detected');
      } else if (allDeps['ava']) {
        meta.test_runner = {
          name: 'ava',
          run_command: scripts['test'] ? `${meta.package_manager} test` : 'npx ava',
          filter_syntax: `npx ava --match '<pattern>'`,
        };
        meta.signals.push('ava detected');
      } else if (scripts['test']) {
        // Has a test script but can't identify runner — use generic
        meta.test_runner = {
          name: 'unknown',
          run_command: `${meta.package_manager} test`,
          filter_syntax: `${meta.package_manager} test`,
        };
        meta.signals.push('test script exists but runner unknown');
      }

      // Framework
      if (allDeps['next']) { meta.framework = 'Next.js'; meta.signals.push('next dep'); }
      else if (allDeps['@remix-run/node'] || allDeps['@remix-run/react']) { meta.framework = 'Remix'; }
      else if (allDeps['nuxt']) { meta.framework = 'Nuxt'; }
      else if (allDeps['svelte'] || allDeps['@sveltejs/kit']) { meta.framework = 'SvelteKit'; }
      else if (allDeps['astro']) { meta.framework = 'Astro'; }
      else if (allDeps['express']) { meta.framework = 'Express'; }
      else if (allDeps['fastify']) { meta.framework = 'Fastify'; }
      else if (allDeps['hono']) { meta.framework = 'Hono'; }
      else if (allDeps['react']) { meta.framework = 'React'; }
      else if (allDeps['vue']) { meta.framework = 'Vue'; }
      else if (allDeps['angular'] || allDeps['@angular/core']) { meta.framework = 'Angular'; }

      // Linter
      if (allDeps['@biomejs/biome'] || exists('biome.json') || exists('biome.jsonc')) {
        meta.linter = 'biome';
      } else if (allDeps['eslint'] || exists('.eslintrc.js') || exists('.eslintrc.json') || exists('eslint.config.js') || exists('eslint.config.mjs')) {
        meta.linter = 'eslint';
      }

      // Monorepo
      if (allDeps['turbo'] || exists('turbo.json')) { meta.monorepo_tool = 'turborepo'; }
      else if (allDeps['nx'] || exists('nx.json')) { meta.monorepo_tool = 'nx'; }
      else if (allDeps['lerna'] || exists('lerna.json')) { meta.monorepo_tool = 'lerna'; }
      else if (pkg.workspaces) { meta.monorepo_tool = 'workspaces'; }
    }
  }

  // -----------------------------------------------------------------------
  // Python
  // -----------------------------------------------------------------------
  if (exists('pyproject.toml') || exists('setup.py') || exists('requirements.txt') || exists('Pipfile')) {
    if (!meta.languages.includes('Python')) meta.languages.push('Python');

    const pyproject = readText('pyproject.toml');

    // Package manager
    if (exists('poetry.lock') || pyproject?.includes('[tool.poetry]')) {
      meta.package_manager = meta.package_manager ?? 'poetry';
    } else if (exists('Pipfile.lock') || exists('Pipfile')) {
      meta.package_manager = meta.package_manager ?? 'pipenv';
    } else if (exists('uv.lock') || pyproject?.includes('[tool.uv]')) {
      meta.package_manager = meta.package_manager ?? 'uv';
    } else {
      meta.package_manager = meta.package_manager ?? 'pip';
    }

    // Test runner
    if (!meta.test_runner) {
      if (pyproject?.includes('[tool.pytest]') || exists('pytest.ini') || exists('conftest.py')) {
        meta.test_runner = {
          name: 'pytest',
          run_command: 'pytest',
          filter_syntax: 'pytest <path> -k <pattern>',
        };
        meta.signals.push('pytest detected');
      } else if (exists('tox.ini')) {
        meta.test_runner = {
          name: 'tox',
          run_command: 'tox',
          filter_syntax: 'tox -- <path>',
        };
      } else {
        // Default python test
        meta.test_runner = {
          name: 'pytest',
          run_command: 'pytest',
          filter_syntax: 'pytest <path> -k <pattern>',
        };
      }
    }

    // Framework
    if (!meta.framework) {
      const allText = (pyproject ?? '') + (readText('requirements.txt') ?? '');
      if (allText.includes('django') || allText.includes('Django')) { meta.framework = 'Django'; }
      else if (allText.includes('flask') || allText.includes('Flask')) { meta.framework = 'Flask'; }
      else if (allText.includes('fastapi') || allText.includes('FastAPI')) { meta.framework = 'FastAPI'; }
    }

    // Linter / type checker
    if (!meta.linter) {
      if (pyproject?.includes('[tool.ruff]') || exists('ruff.toml')) { meta.linter = 'ruff'; }
      else if (pyproject?.includes('[tool.flake8]') || exists('.flake8')) { meta.linter = 'flake8'; }
    }
    if (!meta.type_checker) {
      if (pyproject?.includes('[tool.mypy]') || exists('mypy.ini') || exists('.mypy.ini')) { meta.type_checker = 'mypy'; }
      else if (pyproject?.includes('[tool.pyright]') || exists('pyrightconfig.json')) { meta.type_checker = 'pyright'; }
    }
  }

  // -----------------------------------------------------------------------
  // Rust
  // -----------------------------------------------------------------------
  if (exists('Cargo.toml')) {
    if (!meta.languages.includes('Rust')) meta.languages.push('Rust');
    meta.package_manager = meta.package_manager ?? 'cargo';

    if (!meta.test_runner) {
      meta.test_runner = {
        name: 'cargo-test',
        run_command: 'cargo test',
        filter_syntax: 'cargo test <test_name>',
      };
    }

    meta.linter = meta.linter ?? 'clippy';
    meta.signals.push('Cargo.toml detected');

    const cargo = readText('Cargo.toml');
    if (cargo?.includes('[workspace]')) { meta.monorepo_tool = meta.monorepo_tool ?? 'cargo-workspaces'; }
    if (cargo?.includes('actix') || cargo?.includes('actix-web')) { meta.framework = meta.framework ?? 'Actix'; }
    else if (cargo?.includes('axum')) { meta.framework = meta.framework ?? 'Axum'; }
    else if (cargo?.includes('rocket')) { meta.framework = meta.framework ?? 'Rocket'; }
  }

  // -----------------------------------------------------------------------
  // Go
  // -----------------------------------------------------------------------
  if (exists('go.mod')) {
    if (!meta.languages.includes('Go')) meta.languages.push('Go');
    meta.package_manager = meta.package_manager ?? 'go';

    if (!meta.test_runner) {
      meta.test_runner = {
        name: 'go-test',
        run_command: 'go test ./...',
        filter_syntax: 'go test ./... -run <TestName>',
      };
    }

    meta.linter = meta.linter ?? (exists('.golangci.yml') || exists('.golangci.yaml') ? 'golangci-lint' : null);
    meta.signals.push('go.mod detected');

    const gomod = readText('go.mod');
    if (gomod?.includes('github.com/gin-gonic/gin')) { meta.framework = meta.framework ?? 'Gin'; }
    else if (gomod?.includes('github.com/labstack/echo')) { meta.framework = meta.framework ?? 'Echo'; }
    else if (gomod?.includes('github.com/gofiber/fiber')) { meta.framework = meta.framework ?? 'Fiber'; }
  }

  // -----------------------------------------------------------------------
  // Ruby
  // -----------------------------------------------------------------------
  if (exists('Gemfile')) {
    if (!meta.languages.includes('Ruby')) meta.languages.push('Ruby');
    meta.package_manager = meta.package_manager ?? 'bundler';

    const gemfile = readText('Gemfile') ?? '';

    if (!meta.test_runner) {
      if (gemfile.includes('rspec') || exists('.rspec')) {
        meta.test_runner = {
          name: 'rspec',
          run_command: 'bundle exec rspec',
          filter_syntax: 'bundle exec rspec <path>',
        };
      } else {
        meta.test_runner = {
          name: 'minitest',
          run_command: 'bundle exec rake test',
          filter_syntax: 'bundle exec ruby -Itest <path>',
        };
      }
    }

    if (!meta.framework) {
      if (gemfile.includes('rails') || exists('config/routes.rb')) { meta.framework = 'Rails'; }
      else if (gemfile.includes('sinatra')) { meta.framework = 'Sinatra'; }
    }

    meta.linter = meta.linter ?? (gemfile.includes('rubocop') ? 'rubocop' : null);
    meta.signals.push('Gemfile detected');
  }

  // -----------------------------------------------------------------------
  // Elixir
  // -----------------------------------------------------------------------
  if (exists('mix.exs')) {
    if (!meta.languages.includes('Elixir')) meta.languages.push('Elixir');
    meta.package_manager = meta.package_manager ?? 'mix';

    if (!meta.test_runner) {
      meta.test_runner = {
        name: 'exunit',
        run_command: 'mix test',
        filter_syntax: 'mix test <path>:<line>',
      };
    }

    const mixfile = readText('mix.exs') ?? '';
    if (mixfile.includes(':phoenix')) { meta.framework = meta.framework ?? 'Phoenix'; }
    meta.signals.push('mix.exs detected');
  }

  // -----------------------------------------------------------------------
  // Java / Kotlin
  // -----------------------------------------------------------------------
  if (exists('pom.xml')) {
    if (!meta.languages.includes('Java')) meta.languages.push('Java');
    meta.package_manager = meta.package_manager ?? 'maven';
    if (!meta.test_runner) {
      meta.test_runner = {
        name: 'junit',
        run_command: 'mvn test',
        filter_syntax: 'mvn test -Dtest=<ClassName>#<methodName>',
      };
    }
    const pom = readText('pom.xml') ?? '';
    if (pom.includes('spring-boot')) { meta.framework = meta.framework ?? 'Spring Boot'; }
    meta.signals.push('pom.xml detected');
  } else if (exists('build.gradle') || exists('build.gradle.kts')) {
    // Check for .kt files to determine if Kotlin project (build script format isn't reliable)
    const hasKotlinFiles = hasFileWithExtension(path.join(projectRoot, 'src'), '.kt');
    const lang = hasKotlinFiles ? 'Kotlin' : 'Java';
    if (!meta.languages.includes(lang)) meta.languages.push(lang);
    meta.package_manager = meta.package_manager ?? 'gradle';
    if (!meta.test_runner) {
      meta.test_runner = {
        name: 'junit',
        run_command: './gradlew test',
        filter_syntax: './gradlew test --tests <ClassName>',
      };
    }
    meta.signals.push('build.gradle detected');
  }

  // -----------------------------------------------------------------------
  // C# / .NET
  // -----------------------------------------------------------------------
  if (exists('*.sln') || exists('*.csproj') || existsGlob(projectRoot, '*.csproj')) {
    if (!meta.languages.includes('C#')) meta.languages.push('C#');
    meta.package_manager = meta.package_manager ?? 'dotnet';
    if (!meta.test_runner) {
      meta.test_runner = {
        name: 'dotnet-test',
        run_command: 'dotnet test',
        filter_syntax: 'dotnet test --filter <FullyQualifiedName>',
      };
    }
    meta.signals.push('.NET project detected');
  }

  // -----------------------------------------------------------------------
  // PHP
  // -----------------------------------------------------------------------
  if (exists('composer.json')) {
    if (!meta.languages.includes('PHP')) meta.languages.push('PHP');
    meta.package_manager = meta.package_manager ?? 'composer';
    if (!meta.test_runner) {
      if (exists('phpunit.xml') || exists('phpunit.xml.dist')) {
        meta.test_runner = {
          name: 'phpunit',
          run_command: './vendor/bin/phpunit',
          filter_syntax: './vendor/bin/phpunit --filter <pattern>',
        };
      }
    }
    const composer = readJson('composer.json') as Record<string, unknown> | null;
    const require_ = (composer?.require ?? {}) as Record<string, string>;
    if (require_['laravel/framework']) { meta.framework = meta.framework ?? 'Laravel'; }
    else if (require_['symfony/framework-bundle']) { meta.framework = meta.framework ?? 'Symfony'; }
    meta.signals.push('composer.json detected');
  }

  // -----------------------------------------------------------------------
  // Swift
  // -----------------------------------------------------------------------
  if (exists('Package.swift')) {
    if (!meta.languages.includes('Swift')) meta.languages.push('Swift');
    meta.package_manager = meta.package_manager ?? 'swift-pm';
    if (!meta.test_runner) {
      meta.test_runner = {
        name: 'swift-test',
        run_command: 'swift test',
        filter_syntax: 'swift test --filter <TestTarget>.<TestCase>',
      };
    }
    meta.signals.push('Package.swift detected');
  }

  // -----------------------------------------------------------------------
  // Dart / Flutter
  // -----------------------------------------------------------------------
  if (exists('pubspec.yaml')) {
    if (!meta.languages.includes('Dart')) meta.languages.push('Dart');
    meta.package_manager = meta.package_manager ?? 'pub';

    if (!meta.test_runner) {
      meta.test_runner = {
        name: 'dart-test',
        run_command: exists('.flutter-plugins') || exists('android') ? 'flutter test' : 'dart test',
        filter_syntax: exists('.flutter-plugins') || exists('android') ? 'flutter test <path>' : 'dart test <path>',
      };
    }

    if (exists('.flutter-plugins') || exists('android') || exists('ios')) {
      meta.framework = meta.framework ?? 'Flutter';
    }

    meta.linter = meta.linter ?? (exists('analysis_options.yaml') ? 'dart-analyzer' : null);
    meta.signals.push('pubspec.yaml detected');
  }

  // -----------------------------------------------------------------------
  // Scala
  // -----------------------------------------------------------------------
  if (exists('build.sbt')) {
    if (!meta.languages.includes('Scala')) meta.languages.push('Scala');
    meta.package_manager = meta.package_manager ?? 'sbt';

    if (!meta.test_runner) {
      meta.test_runner = {
        name: 'sbt-test',
        run_command: 'sbt test',
        filter_syntax: 'sbt "testOnly <ClassName>"',
      };
    }

    meta.signals.push('build.sbt detected');
  }

  // -----------------------------------------------------------------------
  // Haskell
  // -----------------------------------------------------------------------
  if (exists('stack.yaml') || exists('cabal.project') || existsGlob(projectRoot, '*.cabal')) {
    if (!meta.languages.includes('Haskell')) meta.languages.push('Haskell');
    meta.package_manager = meta.package_manager ?? (exists('stack.yaml') ? 'stack' : 'cabal');

    if (!meta.test_runner) {
      meta.test_runner = exists('stack.yaml')
        ? { name: 'stack-test', run_command: 'stack test', filter_syntax: 'stack test --test-arguments "<pattern>"' }
        : { name: 'cabal-test', run_command: 'cabal test', filter_syntax: 'cabal test --test-option="<pattern>"' };
    }

    meta.signals.push(exists('stack.yaml') ? 'stack.yaml detected' : 'cabal project detected');
  }

  // -----------------------------------------------------------------------
  // Zig
  // -----------------------------------------------------------------------
  if (exists('build.zig')) {
    if (!meta.languages.includes('Zig')) meta.languages.push('Zig');

    if (!meta.test_runner) {
      meta.test_runner = {
        name: 'zig-test',
        run_command: 'zig build test',
        filter_syntax: 'zig build test',
      };
    }

    meta.signals.push('build.zig detected');
  }

  // -----------------------------------------------------------------------
  // C / C++ (CMake or Makefile)
  // -----------------------------------------------------------------------
  if (exists('CMakeLists.txt')) {
    const hasCpp = hasFileWithExtension(projectRoot, '.cpp') || hasFileWithExtension(projectRoot, '.hpp');
    const lang = hasCpp ? 'C++' : 'C';
    if (!meta.languages.includes(lang)) meta.languages.push(lang);
    meta.package_manager = meta.package_manager ?? 'cmake';

    if (!meta.test_runner) {
      meta.test_runner = {
        name: 'ctest',
        run_command: 'cmake --build build && ctest --test-dir build',
        filter_syntax: 'ctest --test-dir build -R <pattern>',
      };
    }

    meta.signals.push('CMakeLists.txt detected');
  }

  // Final fallback: if no language or test runner was detected, check for
  // common test patterns that work across ecosystems
  if (meta.languages.length === 0) {
    // Check for Makefile (common in C/C++, polyglot projects)
    if (exists('Makefile') || exists('makefile') || exists('GNUmakefile')) {
      meta.signals.push('Makefile detected — unknown language');
      if (!meta.test_runner) {
        meta.test_runner = {
          name: 'make',
          run_command: 'make test',
          filter_syntax: 'make test',
        };
      }
    }
  }

  return meta;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Check if any file with the given extension exists in dir (non-recursive, checks top-level + src/) */
function hasFileWithExtension(dir: string, ext: string): boolean {
  try {
    const entries = fs.readdirSync(dir);
    if (entries.some(e => e.endsWith(ext))) return true;
    // Also check src/ subdirectory
    const srcDir = path.join(dir, 'src');
    try {
      return fs.readdirSync(srcDir).some(e => e.endsWith(ext));
    } catch { return false; }
  } catch {
    return false;
  }
}

/** @deprecated Use hasFileWithExtension instead */
function existsGlob(dir: string, pattern: string): boolean {
  const ext = pattern.replace('*', '');
  return hasFileWithExtension(dir, ext);
}

// ---------------------------------------------------------------------------
// Format for prompt injection
// ---------------------------------------------------------------------------

export function formatMetadataForPrompt(meta: ProjectMetadata): string {
  const lines: string[] = ['## Project Tooling'];

  if (meta.languages.length > 0) {
    lines.push(`**Language(s):** ${meta.languages.join(', ')}`);
  }
  if (meta.framework) {
    lines.push(`**Framework:** ${meta.framework}`);
  }
  if (meta.package_manager) {
    lines.push(`**Package manager:** ${meta.package_manager}`);
  }
  if (meta.test_runner) {
    lines.push(`**Test runner:** ${meta.test_runner.name}`);
    lines.push(`**Run tests:** \`${meta.test_runner.run_command}\``);
    lines.push(`**Filter tests:** \`${meta.test_runner.filter_syntax}\``);
    lines.push('');
    lines.push(`**IMPORTANT:** Use ${meta.test_runner.name} CLI syntax for all \`verification_commands\`. Do NOT guess — use the exact syntax above.`);
  }
  if (meta.linter) {
    lines.push(`**Linter:** ${meta.linter}`);
  }
  if (meta.type_checker) {
    lines.push(`**Type checker:** ${meta.type_checker}`);
  }
  if (meta.monorepo_tool) {
    lines.push(`**Monorepo:** ${meta.monorepo_tool}`);
  }

  return lines.join('\n');
}
