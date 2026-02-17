/**
 * Go detector
 */

import type { DetectorContext, ProjectMetadata } from './types.js';

export function detectGo(ctx: DetectorContext, meta: ProjectMetadata): void {
  if (!ctx.exists('go.mod')) return;

  if (!meta.languages.includes('Go')) meta.languages.push('Go');
  meta.package_manager = meta.package_manager ?? 'go';

  if (!meta.test_runner) {
    meta.test_runner = {
      name: 'go-test',
      run_command: 'go test ./...',
      filter_syntax: 'go test ./... -run <TestName>',
    };
  }

  meta.linter = meta.linter ?? (ctx.exists('.golangci.yml') || ctx.exists('.golangci.yaml') ? 'golangci-lint' : null);
  meta.signals.push('go.mod detected');

  const gomod = ctx.readText('go.mod');
  if (gomod?.includes('github.com/gin-gonic/gin')) { meta.framework = meta.framework ?? 'Gin'; }
  else if (gomod?.includes('github.com/labstack/echo')) { meta.framework = meta.framework ?? 'Echo'; }
  else if (gomod?.includes('github.com/gofiber/fiber')) { meta.framework = meta.framework ?? 'Fiber'; }
}
