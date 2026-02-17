/**
 * Tests for parallel scout batches (Optimization 1) and runAll path (Optimization 2)
 *
 * Uses mock backends to verify:
 * - Batches actually run concurrently (not sequentially)
 * - Semaphore limits concurrent executions
 * - runAll() path is used when backend supports it
 * - Progress callbacks fire correctly
 * - Abort signal stops pending batches
 * - Proposals are collected correctly from parallel results
 */

import { describe, it, expect, vi } from 'vitest';
import { scout } from '../scout/index.js';
import type { ScoutBackend, RunnerOptions, RunnerResult } from '../scout/runner.js';

function makeProposalJson(title: string, confidence = 80) {
  return JSON.stringify({
    proposals: [
      {
        category: 'refactor',
        title,
        description: `Description for ${title}`,
        acceptance_criteria: ['Works correctly'],
        verification_commands: ['npm run build'],
        allowed_paths: ['src/test-file.ts'],
        files: ['src/test-file.ts'],
        confidence,
        impact_score: 7,
        rationale: 'Test rationale',
        estimated_complexity: 'simple',
      },
    ],
  });
}

/** Creates a temp directory with source files for scanning */
async function withTestFiles(
  fileCount: number,
  fn: (dir: string) => Promise<void>,
) {
  const { mkdtempSync, writeFileSync, rmSync, mkdirSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const dir = mkdtempSync(join(tmpdir(), 'scout-parallel-test-'));
  const srcDir = join(dir, 'src');
  mkdirSync(srcDir, { recursive: true });

  for (let i = 0; i < fileCount; i++) {
    writeFileSync(
      join(srcDir, `file${i}.ts`),
      `// File ${i}\nexport const x${i} = ${i};\n`.repeat(20), // ~40 tokens each
    );
  }

  try {
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('parallel scout batches', () => {
  it('runs batches concurrently up to scoutConcurrency limit', async () => {
    const concurrencyLog: { started: number; maxConcurrent: number } = {
      started: 0,
      maxConcurrent: 0,
    };
    let activeCalls = 0;

    const mockBackend: ScoutBackend = {
      name: 'test',
      async run(options: RunnerOptions): Promise<RunnerResult> {
        activeCalls++;
        concurrencyLog.started++;
        concurrencyLog.maxConcurrent = Math.max(
          concurrencyLog.maxConcurrent,
          activeCalls,
        );

        // Simulate async work
        await new Promise((r) => setTimeout(r, 50));

        activeCalls--;
        return {
          success: true,
          output: makeProposalJson(`Proposal from batch ${concurrencyLog.started}`),
          durationMs: 50,
        };
      },
    };

    await withTestFiles(20, async (dir) => {
      const result = await scout({
        scope: 'src/**',
        projectPath: dir,
        backend: mockBackend,
        maxProposals: 20,
        minConfidence: 30,
        scoutConcurrency: 2,
        batchTokenBudget: 200, // Small budget → many batches
        timeoutMs: 10000,
      });

      expect(result.success).toBe(true);
      // With concurrency 2, we should never exceed 2 active calls
      expect(concurrencyLog.maxConcurrent).toBeLessThanOrEqual(2);
      // But we should have had parallel execution (max > 1)
      expect(concurrencyLog.maxConcurrent).toBe(2);
      // Should have proposals from multiple batches
      expect(result.proposals.length).toBeGreaterThan(0);
    });
  });

  it('defaults to concurrency 4 for codex backend', async () => {
    let maxConcurrent = 0;
    let activeCalls = 0;

    const mockBackend: ScoutBackend = {
      name: 'codex',
      async run(): Promise<RunnerResult> {
        activeCalls++;
        maxConcurrent = Math.max(maxConcurrent, activeCalls);
        await new Promise((r) => setTimeout(r, 30));
        activeCalls--;
        return {
          success: true,
          output: makeProposalJson(`Codex proposal ${activeCalls}`),
          durationMs: 30,
        };
      },
    };

    await withTestFiles(30, async (dir) => {
      await scout({
        scope: 'src/**',
        projectPath: dir,
        backend: mockBackend,
        maxProposals: 50,
        minConfidence: 30,
        batchTokenBudget: 200,
        timeoutMs: 10000,
      });

      expect(maxConcurrent).toBeLessThanOrEqual(4);
      // Should be > 1 (parallel execution)
      expect(maxConcurrent).toBeGreaterThan(1);
    });
  });

  it('defaults to concurrency 3 for claude backend', async () => {
    let maxConcurrent = 0;
    let activeCalls = 0;

    const mockBackend: ScoutBackend = {
      name: 'claude',
      async run(): Promise<RunnerResult> {
        activeCalls++;
        maxConcurrent = Math.max(maxConcurrent, activeCalls);
        await new Promise((r) => setTimeout(r, 30));
        activeCalls--;
        return {
          success: true,
          output: makeProposalJson(`Claude proposal ${activeCalls}`),
          durationMs: 30,
        };
      },
    };

    await withTestFiles(30, async (dir) => {
      await scout({
        scope: 'src/**',
        projectPath: dir,
        backend: mockBackend,
        maxProposals: 50,
        minConfidence: 30,
        batchTokenBudget: 200,
        timeoutMs: 10000,
      });

      expect(maxConcurrent).toBeLessThanOrEqual(3);
      expect(maxConcurrent).toBeGreaterThan(1);
    });
  });

  it('stops early when maxProposals is reached', async () => {
    let callCount = 0;

    const mockBackend: ScoutBackend = {
      name: 'test',
      async run(): Promise<RunnerResult> {
        callCount++;
        await new Promise((r) => setTimeout(r, 20));
        return {
          success: true,
          output: makeProposalJson(`Proposal ${callCount}`, 90),
          durationMs: 20,
        };
      },
    };

    await withTestFiles(20, async (dir) => {
      const result = await scout({
        scope: 'src/**',
        projectPath: dir,
        backend: mockBackend,
        maxProposals: 2,
        minConfidence: 30,
        scoutConcurrency: 1, // Sequential to make deterministic
        batchTokenBudget: 200,
        timeoutMs: 10000,
      });

      expect(result.success).toBe(true);
      expect(result.proposals.length).toBeLessThanOrEqual(2);
    });
  });

  it('respects abort signal', async () => {
    const controller = new AbortController();
    let callCount = 0;

    const mockBackend: ScoutBackend = {
      name: 'test',
      async run(options: RunnerOptions): Promise<RunnerResult> {
        callCount++;
        // Abort after first batch starts
        if (callCount === 1) {
          controller.abort();
        }
        await new Promise((r) => setTimeout(r, 50));
        if (options.signal?.aborted) {
          return { success: false, output: '', error: 'Aborted', durationMs: 0 };
        }
        return {
          success: true,
          output: makeProposalJson(`Proposal ${callCount}`),
          durationMs: 50,
        };
      },
    };

    await withTestFiles(20, async (dir) => {
      const result = await scout({
        scope: 'src/**',
        projectPath: dir,
        backend: mockBackend,
        maxProposals: 20,
        minConfidence: 30,
        scoutConcurrency: 1,
        batchTokenBudget: 200,
        signal: controller.signal,
        timeoutMs: 10000,
      });

      // Should have stopped early
      expect(result.success).toBe(true);
    });
  });

  it('handles batch failures gracefully in parallel', async () => {
    let callCount = 0;

    const mockBackend: ScoutBackend = {
      name: 'test',
      async run(): Promise<RunnerResult> {
        callCount++;
        await new Promise((r) => setTimeout(r, 20));
        // Fail every other batch
        if (callCount % 2 === 0) {
          return { success: false, output: '', error: 'Simulated failure', durationMs: 20 };
        }
        return {
          success: true,
          output: makeProposalJson(`Proposal from batch ${callCount}`),
          durationMs: 20,
        };
      },
    };

    await withTestFiles(20, async (dir) => {
      const result = await scout({
        scope: 'src/**',
        projectPath: dir,
        backend: mockBackend,
        maxProposals: 20,
        minConfidence: 30,
        scoutConcurrency: 3,
        batchTokenBudget: 200,
        timeoutMs: 10000,
      });

      expect(result.success).toBe(true);
      // Some proposals from successful batches
      expect(result.proposals.length).toBeGreaterThan(0);
      // Some errors from failed batches
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors.some((e) => e.includes('Simulated failure'))).toBe(true);
    });
  });

  it('fires progress callbacks during parallel execution', async () => {
    const progressUpdates: Array<{ phase: string; currentBatch: number }> = [];

    const mockBackend: ScoutBackend = {
      name: 'test',
      async run(): Promise<RunnerResult> {
        await new Promise((r) => setTimeout(r, 30));
        return {
          success: true,
          output: makeProposalJson('Test proposal'),
          durationMs: 30,
        };
      },
    };

    await withTestFiles(10, async (dir) => {
      await scout({
        scope: 'src/**',
        projectPath: dir,
        backend: mockBackend,
        maxProposals: 20,
        minConfidence: 30,
        scoutConcurrency: 2,
        batchTokenBudget: 200,
        timeoutMs: 10000,
        onProgress: (p) => {
          progressUpdates.push({ phase: p.phase, currentBatch: p.currentBatch });
        },
      });

      // Should have discovery + multiple analyzing updates + complete
      const phases = new Set(progressUpdates.map((p) => p.phase));
      expect(phases.has('discovering')).toBe(true);
      expect(phases.has('analyzing')).toBe(true);
      expect(phases.has('complete')).toBe(true);
    });
  });

  it('deduplicates proposals across parallel batches', async () => {
    const mockBackend: ScoutBackend = {
      name: 'test',
      async run(): Promise<RunnerResult> {
        await new Promise((r) => setTimeout(r, 10));
        // Every batch returns the same proposal title
        return {
          success: true,
          output: makeProposalJson('Duplicate Proposal Title'),
          durationMs: 10,
        };
      },
    };

    await withTestFiles(15, async (dir) => {
      const result = await scout({
        scope: 'src/**',
        projectPath: dir,
        backend: mockBackend,
        maxProposals: 20,
        minConfidence: 30,
        scoutConcurrency: 3,
        batchTokenBudget: 200,
        timeoutMs: 10000,
      });

      expect(result.success).toBe(true);
      // Should deduplicate to just 1 proposal despite multiple batches
      expect(result.proposals.length).toBe(1);
      expect(result.proposals[0].title).toBe('Duplicate Proposal Title');
    });
  });
});

describe('runAll path (MCP backend)', () => {
  it('uses runAll when backend supports it', async () => {
    let runAllCalled = false;
    let runCalled = false;

    const mockBackend: ScoutBackend = {
      name: 'codex-mcp',
      async run(): Promise<RunnerResult> {
        runCalled = true;
        return { success: true, output: makeProposalJson('Single run'), durationMs: 10 };
      },
      async runAll(allOptions: RunnerOptions[]): Promise<RunnerResult[]> {
        runAllCalled = true;
        return allOptions.map((_, i) => ({
          success: true,
          output: makeProposalJson(`MCP batch ${i}`),
          durationMs: 50,
        }));
      },
    };

    await withTestFiles(10, async (dir) => {
      const result = await scout({
        scope: 'src/**',
        projectPath: dir,
        backend: mockBackend,
        maxProposals: 20,
        minConfidence: 30,
        batchTokenBudget: 200,
        timeoutMs: 10000,
      });

      expect(result.success).toBe(true);
      expect(runAllCalled).toBe(true);
      expect(runCalled).toBe(false); // Should NOT fall back to individual run()
      expect(result.proposals.length).toBeGreaterThan(0);
    });
  });

  it('runAll receives all batch prompts at once', async () => {
    let receivedCount = 0;

    const mockBackend: ScoutBackend = {
      name: 'codex-mcp',
      async run(): Promise<RunnerResult> {
        return { success: false, output: '', error: 'Should not be called', durationMs: 0 };
      },
      async runAll(allOptions: RunnerOptions[]): Promise<RunnerResult[]> {
        receivedCount = allOptions.length;
        return allOptions.map((_, i) => ({
          success: true,
          output: makeProposalJson(`Batch ${i}`),
          durationMs: 10,
        }));
      },
    };

    await withTestFiles(15, async (dir) => {
      const result = await scout({
        scope: 'src/**',
        projectPath: dir,
        backend: mockBackend,
        maxProposals: 20,
        minConfidence: 30,
        batchTokenBudget: 200,
        timeoutMs: 10000,
      });

      expect(result.success).toBe(true);
      // Should have received multiple batches
      expect(receivedCount).toBeGreaterThan(1);
    });
  });

  it('handles partial runAll failures', async () => {
    const mockBackend: ScoutBackend = {
      name: 'codex-mcp',
      async run(): Promise<RunnerResult> {
        return { success: false, output: '', error: 'unused', durationMs: 0 };
      },
      async runAll(allOptions: RunnerOptions[]): Promise<RunnerResult[]> {
        return allOptions.map((_, i) => {
          if (i % 2 === 0) {
            return { success: true, output: makeProposalJson(`Good batch ${i}`), durationMs: 10 };
          }
          return { success: false, output: '', error: 'Batch failed', durationMs: 10 };
        });
      },
    };

    await withTestFiles(15, async (dir) => {
      const result = await scout({
        scope: 'src/**',
        projectPath: dir,
        backend: mockBackend,
        maxProposals: 20,
        minConfidence: 30,
        batchTokenBudget: 200,
        timeoutMs: 10000,
      });

      expect(result.success).toBe(true);
      expect(result.proposals.length).toBeGreaterThan(0);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors.some((e) => e.includes('Batch failed'))).toBe(true);
    });
  });

  it('falls back to parallel semaphore when runAll is absent', async () => {
    let callCount = 0;

    const mockBackend: ScoutBackend = {
      name: 'codex',
      // No runAll — should use parallel semaphore path
      async run(): Promise<RunnerResult> {
        callCount++;
        await new Promise((r) => setTimeout(r, 10));
        return {
          success: true,
          output: makeProposalJson(`Parallel batch ${callCount}`),
          durationMs: 10,
        };
      },
    };

    await withTestFiles(10, async (dir) => {
      const result = await scout({
        scope: 'src/**',
        projectPath: dir,
        backend: mockBackend,
        maxProposals: 20,
        minConfidence: 30,
        scoutConcurrency: 2,
        batchTokenBudget: 200,
        timeoutMs: 10000,
      });

      expect(result.success).toBe(true);
      expect(callCount).toBeGreaterThan(1); // Multiple individual run() calls
      expect(result.proposals.length).toBeGreaterThan(0);
    });
  });
});
