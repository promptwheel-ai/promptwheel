/**
 * Elixir detector
 */

import type { DetectorContext, ProjectMetadata } from './types.js';

export function detectElixir(ctx: DetectorContext, meta: ProjectMetadata): void {
  if (!ctx.exists('mix.exs')) return;

  if (!meta.languages.includes('Elixir')) meta.languages.push('Elixir');
  meta.package_manager = meta.package_manager ?? 'mix';

  if (!meta.test_runner) {
    meta.test_runner = {
      name: 'exunit',
      run_command: 'mix test',
      filter_syntax: 'mix test <path>:<line>',
    };
  }

  const mixfile = ctx.readText('mix.exs') ?? '';
  if (mixfile.includes(':phoenix')) { meta.framework = meta.framework ?? 'Phoenix'; }
  meta.signals.push('mix.exs detected');
}
