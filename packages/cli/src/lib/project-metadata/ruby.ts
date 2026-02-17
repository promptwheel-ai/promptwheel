/**
 * Ruby detector
 */

import type { DetectorContext, ProjectMetadata } from './types.js';

export function detectRuby(ctx: DetectorContext, meta: ProjectMetadata): void {
  if (!ctx.exists('Gemfile')) return;

  if (!meta.languages.includes('Ruby')) meta.languages.push('Ruby');
  meta.package_manager = meta.package_manager ?? 'bundler';

  const gemfile = ctx.readText('Gemfile') ?? '';

  if (!meta.test_runner) {
    if (gemfile.includes('rspec') || ctx.exists('.rspec')) {
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
    if (gemfile.includes('rails') || ctx.exists('config/routes.rb')) { meta.framework = 'Rails'; }
    else if (gemfile.includes('sinatra')) { meta.framework = 'Sinatra'; }
  }

  meta.linter = meta.linter ?? (gemfile.includes('rubocop') ? 'rubocop' : null);
  meta.signals.push('Gemfile detected');
}
