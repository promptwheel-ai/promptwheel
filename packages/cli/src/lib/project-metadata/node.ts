/**
 * Node.js / JavaScript / TypeScript detector
 */

import type { DetectorContext, ProjectMetadata } from './types.js';

export function detectNode(ctx: DetectorContext, meta: ProjectMetadata): void {
  if (!ctx.exists('package.json')) return;

  const pkg = ctx.readJson('package.json');
  if (!pkg) return;

  const devDeps = (pkg.devDependencies ?? {}) as Record<string, string>;
  const deps = (pkg.dependencies ?? {}) as Record<string, string>;
  const scripts = (pkg.scripts ?? {}) as Record<string, string>;
  const allDeps = { ...deps, ...devDeps };

  // Language
  if (allDeps['typescript'] || ctx.exists('tsconfig.json')) {
    meta.languages.push('TypeScript');
    meta.type_checker = 'tsc';
    meta.signals.push('tsconfig.json or typescript dep');
  } else {
    meta.languages.push('JavaScript');
  }

  // Package manager
  if (ctx.exists('bun.lockb') || ctx.exists('bun.lock')) {
    meta.package_manager = 'bun';
  } else if (ctx.exists('pnpm-lock.yaml')) {
    meta.package_manager = 'pnpm';
  } else if (ctx.exists('yarn.lock')) {
    meta.package_manager = 'yarn';
  } else {
    meta.package_manager = 'npm';
  }

  // Test runner
  if (allDeps['vitest'] || ctx.exists('vitest.config.ts') || ctx.exists('vitest.config.js') || ctx.exists('vitest.config.mts')) {
    const runCmd = scripts['test'] ? `${meta.package_manager} test` : 'npx vitest run';
    meta.test_runner = {
      name: 'vitest',
      run_command: runCmd,
      filter_syntax: `${runCmd} -- <file-or-pattern>`,
    };
    meta.signals.push('vitest detected');
  } else if (allDeps['jest'] || ctx.exists('jest.config.js') || ctx.exists('jest.config.ts') || ctx.exists('jest.config.mjs')) {
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
  if (allDeps['@biomejs/biome'] || ctx.exists('biome.json') || ctx.exists('biome.jsonc')) {
    meta.linter = 'biome';
  } else if (allDeps['eslint'] || ctx.exists('.eslintrc.js') || ctx.exists('.eslintrc.json') || ctx.exists('eslint.config.js') || ctx.exists('eslint.config.mjs')) {
    meta.linter = 'eslint';
  }

  // Monorepo
  if (allDeps['turbo'] || ctx.exists('turbo.json')) { meta.monorepo_tool = 'turborepo'; }
  else if (allDeps['nx'] || ctx.exists('nx.json')) { meta.monorepo_tool = 'nx'; }
  else if (allDeps['lerna'] || ctx.exists('lerna.json')) { meta.monorepo_tool = 'lerna'; }
  else if (pkg.workspaces) { meta.monorepo_tool = 'workspaces'; }
}
