/**
 * Build execution prompts for solo ticket runs
 */

import type { tickets } from '@promptwheel/core/repos';

/**
 * Build the prompt for Claude from a ticket
 */
export function buildTicketPrompt(ticket: NonNullable<Awaited<ReturnType<typeof tickets.getById>>>, guidelinesContext?: string, learningsContext?: string, metadataContext?: string, opts?: { confidence?: number; complexity?: string }): string {
  const parts: string[] = [];

  // Planning preamble for uncertain or complex changes
  const confidence = opts?.confidence;
  const complexity = opts?.complexity;
  if ((confidence !== undefined && confidence < 50) || complexity === 'moderate' || complexity === 'complex') {
    parts.push(
      '## Approach — This is a complex change',
      '',
      `The automated analysis flagged this as uncertain (confidence: ${confidence ?? '?'}%). Before writing code:`,
      '1. Read all relevant files to understand the full context',
      '2. Identify all touch points and potential side effects',
      '3. Write out your implementation plan before making changes',
      '4. Implement incrementally, verifying at each step',
      '',
    );
  }

  if (guidelinesContext) {
    parts.push(guidelinesContext, '');
  }

  if (metadataContext) {
    parts.push(metadataContext, '');
  }

  if (learningsContext) {
    parts.push(learningsContext, '');
  }

  parts.push(
    `# Task: ${ticket.title}`,
    '',
    ticket.description ?? '',
    '',
  );

  if (ticket.allowedPaths.length > 0) {
    parts.push('## Allowed Paths');
    parts.push('Only modify files in these paths:');
    for (const p of ticket.allowedPaths) {
      parts.push(`- ${p}`);
    }
    parts.push('');
  }

  if (ticket.forbiddenPaths.length > 0) {
    parts.push('## Forbidden Paths');
    parts.push('Do NOT modify files in these paths:');
    for (const p of ticket.forbiddenPaths) {
      parts.push(`- ${p}`);
    }
    parts.push('');
  }

  parts.push('## Verification');
  parts.push('QA verification is handled automatically AFTER your changes — do NOT run test suites yourself.');
  parts.push('Running tests wastes your time budget and they may have pre-existing failures unrelated to your work.');
  parts.push('Focus only on making the code changes correctly.');
  parts.push('');

  parts.push('## Instructions');
  parts.push('1. Analyze the codebase to understand the context');
  parts.push('2. Implement the required changes');
  parts.push('3. Keep changes minimal and focused');
  parts.push('4. Do NOT run test/build/lint commands — QA is automated after you finish');

  return parts.join('\n');
}
