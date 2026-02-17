/**
 * PHP detector
 */

import type { DetectorContext, ProjectMetadata } from './types.js';

export function detectPhp(ctx: DetectorContext, meta: ProjectMetadata): void {
  if (!ctx.exists('composer.json')) return;

  if (!meta.languages.includes('PHP')) meta.languages.push('PHP');
  meta.package_manager = meta.package_manager ?? 'composer';
  if (!meta.test_runner) {
    if (ctx.exists('phpunit.xml') || ctx.exists('phpunit.xml.dist')) {
      meta.test_runner = {
        name: 'phpunit',
        run_command: './vendor/bin/phpunit',
        filter_syntax: './vendor/bin/phpunit --filter <pattern>',
      };
    }
  }
  const composer = ctx.readJson('composer.json');
  const require_ = ((composer?.require ?? {}) as Record<string, string>);
  if (require_['laravel/framework']) { meta.framework = meta.framework ?? 'Laravel'; }
  else if (require_['symfony/framework-bundle']) { meta.framework = meta.framework ?? 'Symfony'; }
  meta.signals.push('composer.json detected');
}
