/**
 * Build execution prompts for solo ticket runs
 */

import type { tickets } from '@blockspool/core/repos';

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

  if (ticket.verificationCommands.length > 0) {
    parts.push('## Verification');
    parts.push('After making changes, verify with:');
    for (const cmd of ticket.verificationCommands) {
      parts.push(`- \`${cmd}\``);
    }
    parts.push('');
  }

  parts.push('## Instructions');
  parts.push('1. Analyze the codebase to understand the context');
  parts.push('2. Implement the required changes');
  parts.push('3. Ensure all verification commands pass');
  parts.push('4. Keep changes minimal and focused');

  return parts.join('\n');
}
