import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import {
  getBlockspoolDir,
  getDbPath,
  formatProgress,
  displayProposal,
  DEFAULT_AUTO_CONFIG,
} from '../lib/solo-config.js';
import type { ScoutProgress } from '@blockspool/core/services';
import type { TicketProposal } from '@blockspool/core/scout';

// ---------------------------------------------------------------------------
// getBlockspoolDir
// ---------------------------------------------------------------------------
describe('getBlockspoolDir', () => {
  const originalEnv = process.env;

  afterEach(() => {
    process.env = originalEnv;
  });

  it('returns path.join(repoRoot, ".blockspool") when repoRoot is provided', () => {
    const result = getBlockspoolDir('/my/repo');
    expect(result).toBe(path.join('/my/repo', '.blockspool'));
  });

  it('uses HOME env var when repoRoot is omitted', () => {
    process.env = { ...originalEnv, HOME: '/home/testuser', USERPROFILE: undefined };
    const result = getBlockspoolDir();
    expect(result).toBe(path.join('/home/testuser', '.blockspool'));
  });

  it('uses USERPROFILE when HOME is not set', () => {
    process.env = { ...originalEnv, HOME: undefined as unknown as string, USERPROFILE: '/Users/win' };
    // Delete HOME so it's truly absent
    delete process.env.HOME;
    const result = getBlockspoolDir();
    expect(result).toBe(path.join('/Users/win', '.blockspool'));
  });

  it('falls back to "." when neither HOME nor USERPROFILE is set', () => {
    process.env = { ...originalEnv };
    delete process.env.HOME;
    delete process.env.USERPROFILE;
    const result = getBlockspoolDir();
    expect(result).toBe(path.join('.', '.blockspool'));
  });

  it('handles trailing slash in repoRoot', () => {
    const result = getBlockspoolDir('/my/repo/');
    expect(result).toBe(path.join('/my/repo/', '.blockspool'));
  });
});

// ---------------------------------------------------------------------------
// getDbPath
// ---------------------------------------------------------------------------
describe('getDbPath', () => {
  it('returns a path ending in state.sqlite', () => {
    const result = getDbPath('/repo');
    expect(result).toMatch(/state\.sqlite$/);
  });

  it('uses getBlockspoolDir internally', () => {
    const result = getDbPath('/repo');
    expect(result).toBe(path.join('/repo', '.blockspool', 'state.sqlite'));
  });

  it('works without repoRoot argument', () => {
    const result = getDbPath();
    expect(result).toMatch(/\.blockspool[/\\]state\.sqlite$/);
  });
});

// ---------------------------------------------------------------------------
// formatProgress
// ---------------------------------------------------------------------------
describe('formatProgress', () => {
  it('init phase returns initialization message', () => {
    const result = formatProgress({
      phase: 'init',
      message: 'Initializing...',
      filesScanned: 0,
      totalFiles: 0,
      proposalsFound: 0,
    } as ScoutProgress);
    expect(result).toContain('Initializing');
  });

  it('init phase uses default message when none provided', () => {
    const result = formatProgress({
      phase: 'init',
      filesScanned: 0,
      totalFiles: 0,
      proposalsFound: 0,
    } as ScoutProgress);
    expect(result).toContain('Initializing');
  });

  it('scanning phase returns scanning message', () => {
    const result = formatProgress({
      phase: 'scanning',
      message: 'Scanning files...',
      filesScanned: 0,
      totalFiles: 10,
      proposalsFound: 0,
    } as ScoutProgress);
    expect(result).toContain('Scanning');
  });

  it('scanning phase uses default message when none provided', () => {
    const result = formatProgress({
      phase: 'scanning',
      filesScanned: 0,
      totalFiles: 10,
      proposalsFound: 0,
    } as ScoutProgress);
    expect(result).toContain('Scanning');
  });

  it('analyzing phase includes file count and proposal count', () => {
    const result = formatProgress({
      phase: 'analyzing',
      filesScanned: 5,
      totalFiles: 20,
      proposalsFound: 3,
    } as ScoutProgress);
    expect(result).toContain('5');
    expect(result).toContain('20');
    expect(result).toContain('3');
    expect(result).toContain('Analyzing');
  });

  it('storing phase returns storing message', () => {
    const result = formatProgress({
      phase: 'storing',
      message: 'Storing results...',
      filesScanned: 20,
      totalFiles: 20,
      proposalsFound: 5,
    } as ScoutProgress);
    expect(result).toContain('Storing');
  });

  it('storing phase uses default message when none provided', () => {
    const result = formatProgress({
      phase: 'storing',
      filesScanned: 20,
      totalFiles: 20,
      proposalsFound: 5,
    } as ScoutProgress);
    expect(result).toContain('Storing');
  });

  it('complete phase includes proposals and tickets created', () => {
    const result = formatProgress({
      phase: 'complete',
      filesScanned: 20,
      totalFiles: 20,
      proposalsFound: 5,
      ticketsCreated: 3,
    } as ScoutProgress);
    expect(result).toContain('5');
    expect(result).toContain('3');
    expect(result).toContain('Complete');
  });

  it('unknown phase returns empty string', () => {
    const result = formatProgress({
      phase: 'unknown-phase' as never,
      filesScanned: 0,
      totalFiles: 0,
      proposalsFound: 0,
    } as ScoutProgress);
    expect(result).toBe('');
  });

  it('returns a non-empty string for all known phases', () => {
    const phases = ['init', 'scanning', 'analyzing', 'storing', 'complete'] as const;
    for (const phase of phases) {
      const result = formatProgress({
        phase,
        filesScanned: 1,
        totalFiles: 2,
        proposalsFound: 1,
        ticketsCreated: 1,
      } as ScoutProgress);
      expect(result.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// displayProposal
// ---------------------------------------------------------------------------
describe('displayProposal', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  function makeProposal(overrides: Partial<TicketProposal> = {}): TicketProposal {
    return {
      id: 'test-1',
      title: 'Fix unused imports',
      description: 'Remove unused imports from utility files.',
      category: 'refactor',
      estimated_complexity: 'simple',
      confidence: 85,
      impact_score: 7,
      files: ['src/utils/helpers.ts'],
      acceptance_criteria: ['No unused imports remain'],
      verification_commands: ['npm run build'],
      allowed_paths: ['src/utils/helpers.ts'],
      ...overrides,
    } as TicketProposal;
  }

  it('calls console.log with proposal details', () => {
    displayProposal(makeProposal(), 0);
    expect(logSpy).toHaveBeenCalled();
    const allOutput = logSpy.mock.calls.map(c => String(c[0] ?? '')).join('\n');
    expect(allOutput).toContain('Fix unused imports');
  });

  it('shows index+1 in output', () => {
    displayProposal(makeProposal(), 4);
    const allOutput = logSpy.mock.calls.map(c => String(c[0] ?? '')).join('\n');
    expect(allOutput).toContain('5.');
  });

  it('shows title', () => {
    displayProposal(makeProposal({ title: 'My Title' }), 0);
    const allOutput = logSpy.mock.calls.map(c => String(c[0] ?? '')).join('\n');
    expect(allOutput).toContain('My Title');
  });

  it('shows category', () => {
    displayProposal(makeProposal({ category: 'perf' }), 0);
    const allOutput = logSpy.mock.calls.map(c => String(c[0] ?? '')).join('\n');
    expect(allOutput).toContain('perf');
  });

  it('shows complexity', () => {
    displayProposal(makeProposal({ estimated_complexity: 'moderate' }), 0);
    const allOutput = logSpy.mock.calls.map(c => String(c[0] ?? '')).join('\n');
    expect(allOutput).toContain('moderate');
  });

  it('shows confidence', () => {
    displayProposal(makeProposal({ confidence: 92 }), 0);
    const allOutput = logSpy.mock.calls.map(c => String(c[0] ?? '')).join('\n');
    expect(allOutput).toContain('92');
  });

  it('truncates long descriptions at 100 chars', () => {
    const longDesc = 'A'.repeat(150);
    displayProposal(makeProposal({ description: longDesc }), 0);
    const allOutput = logSpy.mock.calls.map(c => String(c[0] ?? '')).join('\n');
    // Should contain truncation indicator
    expect(allOutput).toContain('...');
    // Should not contain the full 150-char string raw
    expect(allOutput).not.toContain('A'.repeat(150));
  });

  it('does not add ellipsis for short descriptions', () => {
    displayProposal(makeProposal({ description: 'Short desc' }), 0);
    const allOutput = logSpy.mock.calls.map(c => String(c[0] ?? '')).join('\n');
    expect(allOutput).toContain('Short desc');
    // The output line containing the description should not end with ...
    const descLine = logSpy.mock.calls.find(c => String(c[0] ?? '').includes('Short desc'));
    expect(String(descLine?.[0] ?? '')).not.toContain('...');
  });

  it('shows file count with "+N more" for >3 files', () => {
    displayProposal(
      makeProposal({
        files: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'],
      }),
      0,
    );
    const allOutput = logSpy.mock.calls.map(c => String(c[0] ?? '')).join('\n');
    expect(allOutput).toContain('+2 more');
  });

  it('does not show "+N more" for exactly 3 files', () => {
    displayProposal(
      makeProposal({ files: ['a.ts', 'b.ts', 'c.ts'] }),
      0,
    );
    const allOutput = logSpy.mock.calls.map(c => String(c[0] ?? '')).join('\n');
    expect(allOutput).not.toContain('more');
  });

  it('shows impact score when present', () => {
    displayProposal(makeProposal({ impact_score: 9 }), 0);
    const allOutput = logSpy.mock.calls.map(c => String(c[0] ?? '')).join('\n');
    expect(allOutput).toContain('impact');
    expect(allOutput).toContain('9');
  });

  it('omits impact string when impact_score is null', () => {
    displayProposal(makeProposal({ impact_score: null }), 0);
    const allOutput = logSpy.mock.calls.map(c => String(c[0] ?? '')).join('\n');
    expect(allOutput).not.toContain('impact');
  });
});

// ---------------------------------------------------------------------------
// DEFAULT_AUTO_CONFIG
// ---------------------------------------------------------------------------
describe('DEFAULT_AUTO_CONFIG', () => {
  it('has allowCategories as an array', () => {
    expect(Array.isArray(DEFAULT_AUTO_CONFIG.allowCategories)).toBe(true);
  });

  it('includes refactor in allowCategories', () => {
    expect(DEFAULT_AUTO_CONFIG.allowCategories).toContain('refactor');
  });

  it('includes test in allowCategories', () => {
    expect(DEFAULT_AUTO_CONFIG.allowCategories).toContain('test');
  });

  it('has blockCategories containing security', () => {
    expect(DEFAULT_AUTO_CONFIG.blockCategories).toContain('security');
  });

  it('has minConfidence of 70', () => {
    expect(DEFAULT_AUTO_CONFIG.minConfidence).toBe(70);
  });

  it('has maxPrs of 3', () => {
    expect(DEFAULT_AUTO_CONFIG.maxPrs).toBe(3);
  });

  it('has draftPrs set to true', () => {
    expect(DEFAULT_AUTO_CONFIG.draftPrs).toBe(true);
  });

  it('has maxFilesPerTicket of 10', () => {
    expect(DEFAULT_AUTO_CONFIG.maxFilesPerTicket).toBe(10);
  });

  it('has maxLinesPerTicket of 300', () => {
    expect(DEFAULT_AUTO_CONFIG.maxLinesPerTicket).toBe(300);
  });

  it('has defaultScope of "src"', () => {
    expect(DEFAULT_AUTO_CONFIG.defaultScope).toBe('src');
  });
});
