/**
 * QA baseline capture — extracted from solo-ticket.ts.
 * Captures pre-existing QA pass/fail state before agent execution.
 */

import * as path from 'node:path';
import { execFile } from 'node:child_process';
import type { SoloConfig } from './solo-config.js';
import { normalizeQaConfig } from './solo-utils.js';
import { recordBaselineResult } from './qa-stats.js';

export interface BaselineResult {
  passed: boolean;
  output?: string; // stderr/stdout from failed commands
}

/** Convert full baseline results to simple pass/fail map */
export function baselineToPassFail(baseline: Map<string, BaselineResult>): Map<string, boolean> {
  const result = new Map<string, boolean>();
  for (const [name, r] of baseline) {
    result.set(name, r.passed);
  }
  return result;
}

/**
 * Run QA commands to capture baseline pass/fail state.
 * Returns a map of command name → result (passed + error output).
 * Lightweight — no DB records, no artifacts, just exit codes.
 * Async to avoid blocking the event loop during long QA runs.
 */
export async function captureQaBaseline(
  cwd: string,
  config: SoloConfig,
  onProgress?: (msg: string) => void,
  projectRoot?: string,
): Promise<Map<string, BaselineResult>> {
  const baseline = new Map<string, BaselineResult>();
  const qaConfig = normalizeQaConfig(config);

  for (const cmd of qaConfig.commands) {
    onProgress?.(`  baseline: running ${cmd.name}...`);
    const cmdCwd = cmd.cwd && cmd.cwd !== '.'
      ? path.resolve(cwd, cmd.cwd)
      : cwd;

    try {
      await new Promise<void>((resolve, reject) => {
        execFile('sh', ['-c', cmd.cmd], {
          cwd: cmdCwd,
          timeout: cmd.timeoutMs ?? 120_000,
          maxBuffer: 10 * 1024 * 1024,
        }, (err) => err ? reject(err) : resolve());
      });
      baseline.set(cmd.name, { passed: true });
      onProgress?.(`  baseline: ${cmd.name} ✓`);
      if (projectRoot) recordBaselineResult(projectRoot, cmd.name, true);
    } catch (err) {
      // Capture error output for the fix prompt
      let output = '';
      if (err && typeof err === 'object' && 'stderr' in err) {
        output = String((err as { stderr?: unknown }).stderr || '');
      }
      if (!output && err && typeof err === 'object' && 'stdout' in err) {
        output = String((err as { stdout?: unknown }).stdout || '');
      }
      if (!output && err instanceof Error) {
        output = err.message;
      }
      // Truncate to avoid huge prompts
      if (output.length > 2000) {
        output = output.slice(-2000) + '\n... (truncated)';
      }
      baseline.set(cmd.name, { passed: false, output });
      onProgress?.(`  baseline: ${cmd.name} ✗ (pre-existing failure)`);
      if (projectRoot) recordBaselineResult(projectRoot, cmd.name, false);
    }
  }

  return baseline;
}
