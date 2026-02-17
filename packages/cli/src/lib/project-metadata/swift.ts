/**
 * Swift detector
 */

import type { DetectorContext, ProjectMetadata } from './types.js';

export function detectSwift(ctx: DetectorContext, meta: ProjectMetadata): void {
  if (!ctx.exists('Package.swift')) return;

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
