/**
 * Rust detector
 */

import type { DetectorContext, ProjectMetadata } from './types.js';

export function detectRust(ctx: DetectorContext, meta: ProjectMetadata): void {
  if (!ctx.exists('Cargo.toml')) return;

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

  const cargo = ctx.readText('Cargo.toml');
  if (cargo?.includes('[workspace]')) { meta.monorepo_tool = meta.monorepo_tool ?? 'cargo-workspaces'; }
  if (cargo?.includes('actix') || cargo?.includes('actix-web')) { meta.framework = meta.framework ?? 'Actix'; }
  else if (cargo?.includes('axum')) { meta.framework = meta.framework ?? 'Axum'; }
  else if (cargo?.includes('rocket')) { meta.framework = meta.framework ?? 'Rocket'; }
}
