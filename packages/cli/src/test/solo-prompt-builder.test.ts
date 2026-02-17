import { describe, it, expect } from 'vitest';
import { buildTicketPrompt } from '../lib/solo-prompt-builder.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface MockTicket {
  title: string;
  description: string | null;
  allowedPaths: string[];
  forbiddenPaths: string[];
}

function makeTicket(overrides: Partial<MockTicket> = {}): MockTicket {
  return {
    title: 'Fix the bug',
    description: 'Something is broken',
    allowedPaths: [],
    forbiddenPaths: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// buildTicketPrompt
// ---------------------------------------------------------------------------

describe('buildTicketPrompt', () => {
  // ---------------------------------------------------------------------------
  // Basic output
  // ---------------------------------------------------------------------------

  it('includes the ticket title in a Task heading', () => {
    const result = buildTicketPrompt(makeTicket() as any);
    expect(result).toContain('# Task: Fix the bug');
  });

  it('includes the ticket description', () => {
    const result = buildTicketPrompt(makeTicket({ description: 'Detailed info here' }) as any);
    expect(result).toContain('Detailed info here');
  });

  it('handles null description gracefully', () => {
    const result = buildTicketPrompt(makeTicket({ description: null }) as any);
    expect(result).toContain('# Task: Fix the bug');
    // Should not throw or include "null" literal
    expect(result).not.toContain('null');
  });

  it('always includes Verification and Instructions sections', () => {
    const result = buildTicketPrompt(makeTicket() as any);
    expect(result).toContain('## Verification');
    expect(result).toContain('## Instructions');
    expect(result).toContain('do NOT run test suites yourself');
  });

  // ---------------------------------------------------------------------------
  // Complexity preamble — confidence trigger
  // ---------------------------------------------------------------------------

  it('adds complexity preamble when confidence < 50', () => {
    const result = buildTicketPrompt(makeTicket() as any, undefined, undefined, undefined, { confidence: 30 });
    expect(result).toContain('## Approach — This is a complex change');
    expect(result).toContain('confidence: 30%');
  });

  it('does not add complexity preamble when confidence >= 50', () => {
    const result = buildTicketPrompt(makeTicket() as any, undefined, undefined, undefined, { confidence: 50 });
    expect(result).not.toContain('## Approach — This is a complex change');
  });

  it('does not add complexity preamble when confidence is exactly 50', () => {
    const result = buildTicketPrompt(makeTicket() as any, undefined, undefined, undefined, { confidence: 50 });
    expect(result).not.toContain('complex change');
  });

  // ---------------------------------------------------------------------------
  // Complexity preamble — complexity string trigger
  // ---------------------------------------------------------------------------

  it('adds complexity preamble for "moderate" complexity', () => {
    const result = buildTicketPrompt(makeTicket() as any, undefined, undefined, undefined, { complexity: 'moderate' });
    expect(result).toContain('## Approach — This is a complex change');
  });

  it('adds complexity preamble for "complex" complexity', () => {
    const result = buildTicketPrompt(makeTicket() as any, undefined, undefined, undefined, { complexity: 'complex' });
    expect(result).toContain('## Approach — This is a complex change');
  });

  it('does not add complexity preamble for "simple" complexity', () => {
    const result = buildTicketPrompt(makeTicket() as any, undefined, undefined, undefined, { complexity: 'simple' });
    expect(result).not.toContain('## Approach — This is a complex change');
  });

  it('shows "?" for confidence in preamble when confidence is undefined', () => {
    const result = buildTicketPrompt(makeTicket() as any, undefined, undefined, undefined, { complexity: 'moderate' });
    expect(result).toContain('confidence: ?%');
  });

  // ---------------------------------------------------------------------------
  // Context injection
  // ---------------------------------------------------------------------------

  it('includes guidelines context when provided', () => {
    const result = buildTicketPrompt(makeTicket() as any, '## Project Guidelines\nUse strict mode');
    expect(result).toContain('## Project Guidelines');
    expect(result).toContain('Use strict mode');
  });

  it('includes learnings context when provided', () => {
    const result = buildTicketPrompt(makeTicket() as any, undefined, '## Learnings\nAvoid X pattern');
    expect(result).toContain('## Learnings');
    expect(result).toContain('Avoid X pattern');
  });

  it('includes metadata context when provided', () => {
    const result = buildTicketPrompt(makeTicket() as any, undefined, undefined, '## Metadata\nTypeScript project');
    expect(result).toContain('## Metadata');
    expect(result).toContain('TypeScript project');
  });

  it('orders context: guidelines before metadata before learnings before task', () => {
    const result = buildTicketPrompt(
      makeTicket() as any,
      'GUIDELINES_BLOCK',
      'LEARNINGS_BLOCK',
      'METADATA_BLOCK',
    );
    const guidelinesIdx = result.indexOf('GUIDELINES_BLOCK');
    const metadataIdx = result.indexOf('METADATA_BLOCK');
    const learningsIdx = result.indexOf('LEARNINGS_BLOCK');
    const taskIdx = result.indexOf('# Task:');

    expect(guidelinesIdx).toBeLessThan(metadataIdx);
    expect(metadataIdx).toBeLessThan(learningsIdx);
    expect(learningsIdx).toBeLessThan(taskIdx);
  });

  it('omits guidelines section when not provided', () => {
    const result = buildTicketPrompt(makeTicket() as any);
    // No extra blank sections before Task
    const lines = result.split('\n');
    const taskLine = lines.findIndex(l => l.startsWith('# Task:'));
    // Task should be near the top when no context is provided
    expect(taskLine).toBeLessThan(5);
  });

  // ---------------------------------------------------------------------------
  // Allowed paths
  // ---------------------------------------------------------------------------

  it('includes Allowed Paths section when paths are provided', () => {
    const ticket = makeTicket({ allowedPaths: ['src/lib/foo.ts', 'src/lib/bar.ts'] });
    const result = buildTicketPrompt(ticket as any);
    expect(result).toContain('## Allowed Paths');
    expect(result).toContain('- src/lib/foo.ts');
    expect(result).toContain('- src/lib/bar.ts');
  });

  it('omits Allowed Paths section when paths array is empty', () => {
    const ticket = makeTicket({ allowedPaths: [] });
    const result = buildTicketPrompt(ticket as any);
    expect(result).not.toContain('## Allowed Paths');
  });

  // ---------------------------------------------------------------------------
  // Forbidden paths
  // ---------------------------------------------------------------------------

  it('includes Forbidden Paths section when paths are provided', () => {
    const ticket = makeTicket({ forbiddenPaths: ['node_modules/**', '.env'] });
    const result = buildTicketPrompt(ticket as any);
    expect(result).toContain('## Forbidden Paths');
    expect(result).toContain('- node_modules/**');
    expect(result).toContain('- .env');
  });

  it('omits Forbidden Paths section when paths array is empty', () => {
    const ticket = makeTicket({ forbiddenPaths: [] });
    const result = buildTicketPrompt(ticket as any);
    expect(result).not.toContain('## Forbidden Paths');
  });

  // ---------------------------------------------------------------------------
  // Combined scenario
  // ---------------------------------------------------------------------------

  it('produces correct full output with all options', () => {
    const ticket = makeTicket({
      title: 'Refactor auth module',
      description: 'Extract shared logic',
      allowedPaths: ['src/auth/**'],
      forbiddenPaths: ['src/auth/secrets.ts'],
    });
    const result = buildTicketPrompt(
      ticket as any,
      'GUIDELINES',
      'LEARNINGS',
      'METADATA',
      { confidence: 40, complexity: 'complex' },
    );

    // Preamble present (confidence < 50)
    expect(result).toContain('## Approach — This is a complex change');
    expect(result).toContain('confidence: 40%');

    // All context blocks present
    expect(result).toContain('GUIDELINES');
    expect(result).toContain('METADATA');
    expect(result).toContain('LEARNINGS');

    // Task content
    expect(result).toContain('# Task: Refactor auth module');
    expect(result).toContain('Extract shared logic');

    // Path sections
    expect(result).toContain('## Allowed Paths');
    expect(result).toContain('- src/auth/**');
    expect(result).toContain('## Forbidden Paths');
    expect(result).toContain('- src/auth/secrets.ts');

    // Standard sections
    expect(result).toContain('## Verification');
    expect(result).toContain('## Instructions');
  });

  // ---------------------------------------------------------------------------
  // No opts
  // ---------------------------------------------------------------------------

  it('works without opts parameter', () => {
    const result = buildTicketPrompt(makeTicket() as any);
    expect(result).not.toContain('## Approach');
    expect(result).toContain('# Task: Fix the bug');
  });

  it('works with empty opts', () => {
    const result = buildTicketPrompt(makeTicket() as any, undefined, undefined, undefined, {});
    expect(result).not.toContain('## Approach');
  });

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------

  it('handles empty string description', () => {
    const result = buildTicketPrompt(makeTicket({ description: '' }) as any);
    expect(result).toContain('# Task: Fix the bug');
  });

  it('handles multiple allowed and forbidden paths', () => {
    const ticket = makeTicket({
      allowedPaths: ['a.ts', 'b.ts', 'c.ts'],
      forbiddenPaths: ['x.ts', 'y.ts'],
    });
    const result = buildTicketPrompt(ticket as any);
    expect(result).toContain('- a.ts');
    expect(result).toContain('- b.ts');
    expect(result).toContain('- c.ts');
    expect(result).toContain('- x.ts');
    expect(result).toContain('- y.ts');
  });
});
