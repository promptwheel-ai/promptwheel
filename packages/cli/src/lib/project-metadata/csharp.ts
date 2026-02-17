/**
 * C# / .NET detector
 */

import type { DetectorContext, ProjectMetadata } from './types.js';

export function detectCsharp(ctx: DetectorContext, meta: ProjectMetadata): void {
  if (!ctx.exists('*.sln') && !ctx.exists('*.csproj') && !ctx.existsGlob('*.csproj')) return;

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
