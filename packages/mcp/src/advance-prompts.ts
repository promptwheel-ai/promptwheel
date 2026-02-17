import { getRegistry } from './tool-registry.js';
import type { AdvanceConstraints } from './types.js';
import type { Formula } from './formulas.js';
import type { CodebaseIndex } from './codebase-index.js';

export function buildScoutEscalation(
  retryCount: number,
  explorationLog: string[],
  scoutedDirs: string[],
  codebaseIndex: CodebaseIndex | null,
): string {
  const parts = [
    '## Previous Attempts Found Nothing — Fresh Approach Required',
    '',
  ];

  if (explorationLog.length > 0) {
    parts.push('### What Was Already Tried');
    for (const entry of explorationLog) {
      parts.push(entry);
    }
    parts.push('');
  }

  // Suggest unexplored modules from codebase index
  const exploredSet = new Set(scoutedDirs.map(d => d.replace(/\/$/, '')));
  const unexplored: string[] = [];
  if (codebaseIndex) {
    for (const mod of codebaseIndex.modules) {
      if (!exploredSet.has(mod.path) && !exploredSet.has(mod.path + '/')) {
        unexplored.push(mod.path);
      }
    }
  }

  parts.push('### What to Do Differently');
  parts.push('');
  parts.push('Knowing everything from the attempts above, take a completely different angle:');
  parts.push('- Do NOT re-read the directories listed above.');
  if (unexplored.length > 0) {
    parts.push(`- Try unexplored areas: ${unexplored.slice(0, 8).map(d => `\`${d}\``).join(', ')}`);
  }
  parts.push('- Switch categories: if you looked for bugs, look for tests. If tests, try security.');
  parts.push('- Read at least 15 NEW source files.');
  parts.push('- If genuinely nothing to improve, explain your analysis across all attempts.');

  return parts.join('\n');
}

export function buildScoutPrompt(
  scope: string,
  categories: string[],
  minConfidence: number,
  maxProposals: number,
  dedupContext: string[],
  formula: Formula | null,
  hints: string[],
  eco: boolean,
  minImpactScore: number = 3,
  scoutedDirs: string[] = [],
  excludeDirs: string[] = [],
  coverageContext?: { scannedSectors: number; totalSectors: number; percent: number; sectorPercent?: number; sectorSummary?: string },
): string {
  const parts = [
    '# Scout Phase',
    '',
    'Identify improvements by reading source code. Return proposals in a `<proposals>` XML block containing a JSON array.',
    '',
    ...(!eco ? ['**IMPORTANT:** Do not use the Task or Explore tools. Read files directly using Read, Glob, and Grep. Do not delegate to subagents.', ''] : []),
    '## How to Scout',
    '',
    'STEP 1 — Discover: Use Glob to list all files in scope. Group them by directory or module (e.g. `src/auth/`, `src/api/`, `lib/utils/`). Identify entry points, core logic, and test directories.',
    '',
    'STEP 2 — Pick a Partition: Choose one or two directories/modules to analyze deeply this cycle. Do NOT try to skim everything — go deep on a focused slice. On future cycles, different partitions will be explored.',
    '',
    'STEP 3 — Read & Analyze: Use Read to open 10-15 source files within your chosen partition(s). Read related files together (e.g. a module and its tests, a handler and its helpers). For each file, look for:',
    '  - Bugs, incorrect logic, off-by-one errors',
    '  - Missing error handling or edge cases',
    '  - Missing or inadequate tests for the code you read',
    '  - Security issues (injection, auth bypass, secrets in code)',
    '  - Performance problems (N+1 queries, unnecessary re-renders, blocking I/O)',
    '  - Dead code, unreachable branches',
    '  - Meaningful refactoring opportunities (not cosmetic)',
    '',
    'STEP 4 — Propose: Only after reading source files, write proposals with specific file paths and line-level detail.',
    '',
    'DO NOT run lint or typecheck commands as a substitute for reading code.',
    'DO NOT propose changes unless you have READ the files you are proposing to change.',
    '',
    `**Scope:** \`${scope}\``,
    `**Categories:** ${categories.join(', ')}`,
    `**Min confidence:** ${minConfidence}`,
    `**Min impact score:** ${minImpactScore} (proposals below this will be rejected)`,
    `**Max proposals:** ${maxProposals}`,
    '',
    '**DO NOT propose changes to these files** (read-only context): CLAUDE.md, .claude/**',
    ...(excludeDirs.length > 0 ? [
      `**Skip these directories when scouting** (build artifacts, vendor, generated): ${excludeDirs.map(d => `\`${d}\``).join(', ')}`,
    ] : []),
    '',
    ...(coverageContext ? [
      `## Coverage Context`,
      '',
      `Overall codebase coverage: ${coverageContext.scannedSectors}/${coverageContext.totalSectors} sectors scanned (${coverageContext.sectorPercent ?? coverageContext.percent}% of sectors, ${coverageContext.percent}% of files).`,
      ...(coverageContext.percent < 50 ? ['Many sectors remain unscanned. Focus on high-impact issues rather than minor cleanups.'] : []),
      ...(coverageContext.sectorSummary ? ['', coverageContext.sectorSummary] : []),
      '',
    ] : []),
    '## Quality Bar',
    '',
    '- Proposals must have **real user or developer impact** — not just lint cleanup or style nits.',
    '- Do NOT propose fixes for lint warnings, unused variables, or cosmetic issues unless they cause actual bugs or test failures.',
    '- If project guidelines are provided above, **respect them**. Do NOT propose changes the guidelines explicitly discourage (e.g., "avoid over-engineering", "don\'t change code you didn\'t touch").',
    '- Focus on: bugs, security issues, performance problems, correctness, and meaningful refactors.',
    '',
    '## Category Rules',
    '',
    '- Any proposal that creates new test files (e.g. .test.ts, .spec.ts, test_*.py, *_test.go, *Test.java) or adds test coverage MUST use category "test" — NEVER label test-writing as "fix", "refactor", or any other category.',
    '- If "test" is not in the categories list above, do NOT propose writing new tests. Focus on the allowed categories only.',
    '- If "test" IS allowed, you may generate test proposals freely.',
    '',
  ];

  if (scoutedDirs.length > 0) {
    parts.push('## Already Explored (prefer unexplored directories)');
    parts.push('');
    parts.push('These directories were analyzed in previous scout cycles. Prefer exploring different areas first:');
    for (const dir of scoutedDirs) {
      parts.push(`- \`${dir}\``);
    }
    parts.push('');
  }

  if (dedupContext.length > 0) {
    parts.push('**Already completed (do not duplicate):**');
    for (const title of dedupContext) {
      parts.push(`- ${title}`);
    }
    parts.push('');
  }

  if (formula) {
    parts.push(`**Formula:** ${formula.name} — ${formula.description}`);
    if (formula.prompt) {
      parts.push('');
      parts.push('**Formula instructions:**');
      parts.push(formula.prompt);
    }
    if (formula.risk_tolerance) {
      parts.push(`**Risk tolerance:** ${formula.risk_tolerance}`);
    }
    parts.push('');
  }

  if (hints.length > 0) {
    parts.push('**Hints from user:**');
    for (const hint of hints) {
      parts.push(`- ${hint}`);
    }
    parts.push('');
  }

  parts.push(
    '## Required Fields',
    '',
    'Each proposal in the JSON array MUST include ALL of these fields:',
    '- `category` (string): one of the categories listed above',
    '- `title` (string): concise, unique title',
    '- `description` (string): what needs to change and why',
    '- `acceptance_criteria` (string[]): how to verify the change is correct',
    '- `verification_commands` (string[]): commands to run (use the project\'s detected test runner — see Project Tooling above)',
    '- `allowed_paths` (string[]): file paths/globs this change may touch',
    '- `files` (string[]): specific files to modify',
    '- `confidence` (number 0-100): how confident you are this is correct',
    '- `impact_score` (number 1-10): how much this matters',
    '- `risk` (string): "low", "medium", or "high"',
    '- `touched_files_estimate` (number): expected number of files changed',
    '- `rollback_note` (string): how to revert if something goes wrong',
    '',
    '## Scoring',
    '',
    'Proposals are ranked by `impact_score × confidence`. Prefer low-risk proposals.',
    '',
    '## Output',
    '',
    'Wrap the JSON array in a `<proposals>` XML block:',
    '```',
    '<proposals>',
    '[{ ... }, { ... }]',
    '</proposals>',
    '```',
    '',
    'Then call `promptwheel_ingest_event` with type `SCOUT_OUTPUT` and payload:',
    '`{ "proposals": [...], "explored_dirs": ["src/auth/", "src/api/"] }`',
    '',
    'The `explored_dirs` field should list the top-level directories you analyzed (e.g. `src/services/`, `lib/utils/`). This is used to rotate to unexplored areas in future cycles.',
  );

  if (coverageContext) {
    parts.push('');
    parts.push('If this sector appears misclassified (e.g., labeled as production but contains only tests/config/generated code, or vice versa), include in the SCOUT_OUTPUT payload:');
    parts.push('`"sector_reclassification": { "production": true/false, "confidence": "medium"|"high" }`');
  }

  return parts.join('\n');
}

export function buildPlanPrompt(ticket: { title: string; description: string | null; allowedPaths: string[]; verificationCommands: string[]; category?: string | null }): string {
  const constraintNote = getRegistry().getConstraintNote({ phase: 'EXECUTE', category: ticket.category ?? null });
  const toolRestrictionLines = constraintNote
    ? ['', '## Tool Restrictions', '', constraintNote, '']
    : [''];

  return [
    '# Commit Plan Required',
    '',
    `**Ticket:** ${ticket.title}`,
    '',
    ticket.description ?? '',
    '',
    'Before making changes, output a `<commit-plan>` XML block with:',
    '```json',
    '{',
    `  "ticket_id": "<ticket-id>",`,
    '  "files_to_touch": [{"path": "...", "action": "create|modify|delete", "reason": "..."}],',
    '  "expected_tests": ["npm test -- --grep ..."],',
    '  "estimated_lines": <number>,',
    '  "risk_level": "low|medium|high"',
    '}',
    '```',
    '',
    `**Allowed paths:** ${ticket.allowedPaths.length > 0 ? ticket.allowedPaths.join(', ') : 'any'}`,
    `**Verification commands:** ${ticket.verificationCommands.join(', ') || 'none specified'}`,
    ...toolRestrictionLines,
    'Then call `promptwheel_ingest_event` with type `PLAN_SUBMITTED` and the plan as payload.',
  ].join('\n');
}

export function buildExecutePrompt(
  ticket: { title: string; description: string | null; allowedPaths: string[]; verificationCommands: string[]; category?: string | null },
  plan: unknown,
): string {
  const parts = [
    `# Execute: ${ticket.title}`,
    '',
    ticket.description ?? '',
    '',
  ];

  if (plan) {
    parts.push('## Approved Commit Plan');
    parts.push('```json');
    parts.push(JSON.stringify(plan, null, 2));
    parts.push('```');
    parts.push('');
    parts.push('Follow the plan above. Only touch the files listed.');
    parts.push('');
  }

  parts.push(
    '## Constraints',
    `- Only modify files in: ${ticket.allowedPaths.length > 0 ? ticket.allowedPaths.join(', ') : 'any'}`,
    '- Make minimal, focused changes',
    '',
  );

  const constraintNote = getRegistry().getConstraintNote({ phase: 'EXECUTE', category: ticket.category ?? null });
  if (constraintNote) {
    parts.push('## Tool Restrictions', '', constraintNote, '');
  }

  parts.push(
    '## When done',
    'Output a `<ticket-result>` block with status, changed_files, summary, lines_added, lines_removed.',
    'Then call `promptwheel_ingest_event` with type `TICKET_RESULT` and the result as payload.',
  );

  return parts.join('\n');
}

export function buildQaPrompt(ticket: { title: string; verificationCommands: string[] }): string {
  return [
    `# QA: ${ticket.title}`,
    '',
    'Run the following verification commands and report results:',
    '',
    ...ticket.verificationCommands.map(c => `\`\`\`bash\n${c}\n\`\`\``),
    '',
    'For each command, call `promptwheel_ingest_event` with type `QA_COMMAND_RESULT` and:',
    '`{ "command": "...", "success": true/false, "output": "stdout+stderr" }`',
    '',
    'After all commands, call `promptwheel_ingest_event` with type `QA_PASSED` if all pass, or `QA_FAILED` with failure details.',
  ].join('\n');
}

export function buildPlanningPreamble(ticket: { metadata?: Record<string, unknown> | null }): string {
  const meta = ticket.metadata as Record<string, unknown> | null | undefined;
  const confidence = typeof meta?.scoutConfidence === 'number' ? meta.scoutConfidence : undefined;
  const complexity = typeof meta?.estimatedComplexity === 'string' ? meta.estimatedComplexity : undefined;
  if ((confidence !== undefined && confidence < 50) || complexity === 'moderate' || complexity === 'complex') {
    return [
      '## Approach — This is a complex change',
      '',
      `The automated analysis flagged this as uncertain (confidence: ${confidence ?? '?'}%). Before writing code:`,
      '1. Read all relevant files to understand the full context',
      '2. Identify all touch points and potential side effects',
      '3. Write out your implementation plan before making changes',
      '4. Implement incrementally, verifying at each step',
      '',
    ].join('\n') + '\n';
  }
  return '';
}

/** Escape a string for use inside double-quoted shell arguments */
export function shellEscape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$').replace(/`/g, '\\`');
}

export function buildInlineTicketPrompt(
  ticket: { id: string; title: string; description: string | null; allowedPaths: string[]; verificationCommands: string[]; metadata?: Record<string, unknown> | null; category?: string | null },
  constraints: AdvanceConstraints,
  guidelinesBlock: string,
  metadataBlock: string,
  createPrs: boolean,
  draft: boolean,
  direct: boolean,
  setupCommand?: string,
  baselineFailures: string[] = [],
): string {
  const slug = ticket.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
  const branch = `promptwheel/${ticket.id}/${slug}`;
  const worktree = `.promptwheel/worktrees/${ticket.id}`;

  const verifyBlock = constraints.required_commands.length > 0
    ? constraints.required_commands.map(c => `\`\`\`bash\n${c}\n\`\`\``).join('\n')
    : 'Run the project\'s test suite to verify your changes. Use the test runner shown in **Project Tooling** above (e.g. `npm test`, `pytest`, `cargo test`, `go test ./...`). If no test runner is specified, check for a test command in the project\'s config files.';

  const planningPreamble = buildPlanningPreamble(ticket);

  // Build tool restriction block from registry
  const inlineConstraintNote = getRegistry().getConstraintNote({ phase: 'EXECUTE', category: ticket.category ?? null });
  const toolRestrictionBlock = inlineConstraintNote
    ? ['## Tool Restrictions', '', inlineConstraintNote, '']
    : [];

  // Direct mode: simpler flow, edit in place, no worktrees
  if (direct) {
    return [
      `# PromptWheel Ticket: ${ticket.title}`,
      '',
      planningPreamble,
      guidelinesBlock,
      metadataBlock,
      ticket.description ?? '',
      '',
      '## Constraints',
      '',
      `- **Allowed paths:** ${constraints.allowed_paths.length > 0 ? constraints.allowed_paths.join(', ') : 'any'}`,
      `- **Denied paths:** ${constraints.denied_paths.length > 0 ? constraints.denied_paths.join(', ') : 'none'}`,
      `- **Max files:** ${constraints.max_files || 'unlimited'}`,
      `- **Max lines:** ${constraints.max_lines || 'unlimited'}`,
      '',
      ...toolRestrictionBlock,
      '## Step 1 — Implement the change',
      '',
      '- Read the relevant files first to understand the current state.',
      '- Make minimal, focused changes that match the ticket description.',
      '- Only modify files within the allowed paths.',
      '- Follow any project guidelines provided above.',
      '',
      '## Step 2 — Verify',
      '',
      verifyBlock,
      '',
      ...(baselineFailures.length > 0 ? [
        `**Pre-existing failures (IGNORE these — they were failing before your changes):** ${baselineFailures.join(', ')}`,
        '',
        'Only fix failures that are NEW — caused by your changes. If a command was already failing, do not try to fix it.',
      ] : [
        'If tests fail due to your changes, fix the issues and re-run.',
      ]),
      '',
      '## Step 3 — Commit',
      '',
      '```bash',
      'git add -A',
      `git commit -m "${shellEscape(ticket.title)}"`,
      '```',
      '',
      '## Output',
      '',
      'When done, output a summary in this exact format:',
      '',
      '```',
      `TICKET_ID: ${ticket.id}`,
      'STATUS: success | failed',
      'PR_URL: none',
      'BRANCH: (current)',
      'SUMMARY: <one line summary of what was done>',
      '```',
      '',
      'If anything goes wrong and you cannot complete the ticket, output STATUS: failed with a reason.',
    ].join('\n');
  }

  // Worktree mode: isolated branches for parallel execution or PR workflow
  return [
    `# PromptWheel Ticket: ${ticket.title}`,
    '',
    planningPreamble,
    guidelinesBlock,
    metadataBlock,
    ticket.description ?? '',
    '',
    '## Constraints',
    '',
    `- **Allowed paths:** ${constraints.allowed_paths.length > 0 ? constraints.allowed_paths.join(', ') : 'any'}`,
    `- **Denied paths:** ${constraints.denied_paths.length > 0 ? constraints.denied_paths.join(', ') : 'none'}`,
    `- **Max files:** ${constraints.max_files || 'unlimited'}`,
    `- **Max lines:** ${constraints.max_lines || 'unlimited'}`,
    '',
    ...toolRestrictionBlock,
    '## Step 1 — Set up worktree',
    '',
    '```bash',
    `git worktree add ${worktree} -b ${branch}`,
    '```',
    '',
    `All work MUST happen inside \`${worktree}/\`. Do NOT modify files in the main working tree.`,
    '',
    ...(setupCommand ? [
      '```bash',
      `cd ${worktree}`,
      setupCommand,
      '```',
      '',
      'Wait for setup to complete before proceeding. If setup fails, try to continue anyway.',
      '',
    ] : []),
    '## Step 2 — Implement the change',
    '',
    '- Read the relevant files first to understand the current state.',
    '- Make minimal, focused changes that match the ticket description.',
    '- Only modify files within the allowed paths.',
    '- Follow any project guidelines provided above.',
    '',
    '## Step 3 — Verify',
    '',
    'Run verification commands inside the worktree:',
    '',
    '```bash',
    `cd ${worktree}`,
    '```',
    '',
    verifyBlock,
    '',
    ...(baselineFailures.length > 0 ? [
      `**Pre-existing failures (IGNORE these — they were failing before your changes):** ${baselineFailures.join(', ')}`,
      '',
      'Only fix failures that are NEW — caused by your changes. If a command was already failing, do not try to fix it.',
    ] : [
      'If tests fail due to your changes, fix the issues and re-run.',
    ]),
    '',
    '## Step 4 — Commit and push',
    '',
    '```bash',
    `cd ${worktree}`,
    'git add -A',
    `git commit -m "${shellEscape(ticket.title)}"`,
    ...(createPrs ? [`git push -u origin ${branch}`] : []),
    '```',
    '',
    ...(createPrs ? [
      '## Step 5 — Create PR',
      '',
      `Create a ${draft ? 'draft ' : ''}pull request:`,
      '',
      '```bash',
      `cd ${worktree}`,
      `gh pr create --title "${shellEscape(ticket.title)}"${draft ? ' --draft' : ''} --body "$(cat <<'PROMPTWHEEL_BODY_EOF'`,
      ticket.description?.slice(0, 500) ?? ticket.title,
      '',
      'Generated by PromptWheel',
      `PROMPTWHEEL_BODY_EOF`,
      `)"`,
      '```',
      '',
    ] : []),
    '## Output',
    '',
    'When done, output a summary in this exact format:',
    '',
    '```',
    `TICKET_ID: ${ticket.id}`,
    'STATUS: success | failed',
    `PR_URL: <url or "none">`,
    `BRANCH: ${branch}`,
    'SUMMARY: <one line summary of what was done>',
    '```',
    '',
    'If anything goes wrong and you cannot complete the ticket, output STATUS: failed with a reason.',
  ].join('\n');
}

export function buildPrPrompt(
  ticket: { title: string; description: string | null } | null,
  draftPr: boolean,
): string {
  const title = ticket?.title ?? 'PromptWheel changes';
  return [
    '# Create PR',
    '',
    `Create a ${draftPr ? 'draft ' : ''}pull request for the changes.`,
    '',
    `**Title:** ${title}`,
    ticket?.description ? `**Description:** ${ticket.description.slice(0, 200)}` : '',
    '',
    '## Dry-run first',
    '',
    '1. Stage changes: `git add <files>`',
    '2. Create commit: `git commit -m "..."`',
    '3. Verify the commit looks correct: `git diff HEAD~1 --stat`',
    '4. Push to remote: `git push -u origin <branch>`',
    `5. Create ${draftPr ? 'draft ' : ''}PR: \`gh pr create${draftPr ? ' --draft' : ''}\``,
    '',
    'Call `promptwheel_ingest_event` with type `PR_CREATED` and `{ "url": "<pr-url>", "branch": "<branch-name>" }` as payload.',
  ].join('\n');
}
