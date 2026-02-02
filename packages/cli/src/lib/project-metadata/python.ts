/**
 * Python detector
 */

import type { DetectorContext, ProjectMetadata } from './types.js';

export function detectPython(ctx: DetectorContext, meta: ProjectMetadata): void {
  if (!ctx.exists('pyproject.toml') && !ctx.exists('setup.py') && !ctx.exists('requirements.txt') && !ctx.exists('Pipfile')) return;

  if (!meta.languages.includes('Python')) meta.languages.push('Python');

  const pyproject = ctx.readText('pyproject.toml');

  // Package manager
  if (ctx.exists('poetry.lock') || pyproject?.includes('[tool.poetry]')) {
    meta.package_manager = meta.package_manager ?? 'poetry';
  } else if (ctx.exists('Pipfile.lock') || ctx.exists('Pipfile')) {
    meta.package_manager = meta.package_manager ?? 'pipenv';
  } else if (ctx.exists('uv.lock') || pyproject?.includes('[tool.uv]')) {
    meta.package_manager = meta.package_manager ?? 'uv';
  } else {
    meta.package_manager = meta.package_manager ?? 'pip';
  }

  // Test runner
  if (!meta.test_runner) {
    if (pyproject?.includes('[tool.pytest]') || ctx.exists('pytest.ini') || ctx.exists('conftest.py')) {
      meta.test_runner = {
        name: 'pytest',
        run_command: 'pytest',
        filter_syntax: 'pytest <path> -k <pattern>',
      };
      meta.signals.push('pytest detected');
    } else if (ctx.exists('tox.ini')) {
      meta.test_runner = {
        name: 'tox',
        run_command: 'tox',
        filter_syntax: 'tox -- <path>',
      };
    } else {
      meta.test_runner = {
        name: 'pytest',
        run_command: 'pytest',
        filter_syntax: 'pytest <path> -k <pattern>',
      };
    }
  }

  // Framework
  if (!meta.framework) {
    const allText = (pyproject ?? '') + (ctx.readText('requirements.txt') ?? '');
    if (allText.includes('django') || allText.includes('Django')) { meta.framework = 'Django'; }
    else if (allText.includes('flask') || allText.includes('Flask')) { meta.framework = 'Flask'; }
    else if (allText.includes('fastapi') || allText.includes('FastAPI')) { meta.framework = 'FastAPI'; }
  }

  // Linter / type checker
  if (!meta.linter) {
    if (pyproject?.includes('[tool.ruff]') || ctx.exists('ruff.toml')) { meta.linter = 'ruff'; }
    else if (pyproject?.includes('[tool.flake8]') || ctx.exists('.flake8')) { meta.linter = 'flake8'; }
  }
  if (!meta.type_checker) {
    if (pyproject?.includes('[tool.mypy]') || ctx.exists('mypy.ini') || ctx.exists('.mypy.ini')) { meta.type_checker = 'mypy'; }
    else if (pyproject?.includes('[tool.pyright]') || ctx.exists('pyrightconfig.json')) { meta.type_checker = 'pyright'; }
  }
}
