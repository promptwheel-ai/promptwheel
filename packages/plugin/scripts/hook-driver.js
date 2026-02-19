#!/usr/bin/env node

/**
 * PromptWheel hook driver — handles Stop and PreToolUse hooks.
 *
 * Stop hook:
 *   Reads `.promptwheel/loop-state.json` to check if a session is active.
 *   If active, blocks exit so Claude Code continues the advance loop.
 *   The actual advance() call happens via MCP tool call in the main
 *   conversation — the stop hook just prevents premature exit.
 *
 * PreToolUse hook:
 *   Checks scope policy before file writes. Reads cached policy from
 *   `.promptwheel/scope-policy.json` and validates the target file path.
 *
 * Usage:
 *   node scripts/hook-driver.js stop
 *   node scripts/hook-driver.js PreToolUse  (reads stdin)
 */

import { readFileSync, existsSync, unlinkSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';

/**
 * Simple glob matching (no external dependencies).
 * Supports: *, **, ?, {a,b}, [abc]
 */
function simpleMatch(pattern, str) {
  // Convert glob pattern to regex
  let i = 0;
  let regex = '^';
  const len = pattern.length;

  while (i < len) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        // ** matches any number of path segments
        if (pattern[i + 2] === '/') {
          regex += '(?:.*/)?';
          i += 3;
        } else {
          regex += '.*';
          i += 2;
        }
      } else {
        // * matches anything except /
        regex += '[^/]*';
        i++;
      }
    } else if (c === '?') {
      regex += '[^/]';
      i++;
    } else if (c === '{') {
      const close = pattern.indexOf('}', i);
      if (close !== -1) {
        const alternatives = pattern.slice(i + 1, close).split(',');
        regex += '(?:' + alternatives.map(a => a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')';
        i = close + 1;
      } else {
        regex += '\\{';
        i++;
      }
    } else if (c === '[') {
      const close = pattern.indexOf(']', i);
      if (close !== -1) {
        regex += pattern.slice(i, close + 1);
        i = close + 1;
      } else {
        regex += '\\[';
        i++;
      }
    } else {
      regex += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      i++;
    }
  }
  regex += '$';

  try {
    return new RegExp(regex).test(str);
  } catch (err) {
    process.stderr.write(`[promptwheel] simpleMatch: bad regex for pattern "${pattern}": ${err}\n`);
    return false;
  }
}

const hookType = process.argv[2]; // "stop" or "PreToolUse"

// ---------------------------------------------------------------------------
// Stop hook — loop driver
// ---------------------------------------------------------------------------

if (hookType === 'stop') {
  try {
    const loopStatePath = join(process.cwd(), '.promptwheel', 'loop-state.json');

    if (!existsSync(loopStatePath)) {
      // No active session — allow Claude to stop normally
      process.exit(0);
    }

    const loopState = JSON.parse(readFileSync(loopStatePath, 'utf8'));

    // Check if the session reached a terminal state
    const terminalPhases = new Set([
      'DONE', 'BLOCKED_NEEDS_HUMAN', 'FAILED_BUDGET',
      'FAILED_VALIDATION', 'FAILED_SPINDLE',
    ]);

    if (!loopState.phase || terminalPhases.has(loopState.phase)) {
      // Session is done — clean up and allow exit
      try { unlinkSync(loopStatePath); } catch { /* ignore */ }
      process.exit(0);
    }

    // Session is still active — block exit and instruct Claude to continue
    process.stdout.write(JSON.stringify({
      decision: 'block',
      reason: [
        'PromptWheel session is still active.',
        `Current phase: ${loopState.phase}`,
        `Run ID: ${loopState.run_id}`,
        '',
        'Call `promptwheel_advance` to get your next action.',
        'Do NOT stop until advance returns `next_action: "STOP"`.',
      ].join('\n'),
    }));
  } catch {
    // Error reading state — allow exit to avoid trapping Claude
    process.exit(0);
  }
  process.exit(0);
}

// ---------------------------------------------------------------------------
// PreToolUse hook — scope enforcement
// ---------------------------------------------------------------------------

if (hookType === 'PreToolUse') {
  let input = '';
  try {
    input = readFileSync(0, 'utf8');
  } catch {
    // No stdin — allow by default
    process.exit(0);
  }

  try {
    const data = JSON.parse(input);
    const toolName = data.tool_name;
    const toolInput = data.tool_input ?? {};

    // Only check write operations
    const writeTools = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'];
    if (!writeTools.includes(toolName)) {
      process.exit(0);
    }

    // Find file path from tool input
    const filePath = toolInput.file_path ?? toolInput.path ?? null;
    if (!filePath) {
      process.exit(0);
    }

    // Resolve scope policy: check for per-ticket policy first (parallel mode),
    // then fall back to single scope-policy.json (sequential mode).
    const cwd = process.cwd();
    let policyPath;

    // Check if we're in a worktree: .promptwheel/worktrees/{ticket_id}
    const worktreeMatch = cwd.match(/\.promptwheel\/worktrees\/([^/]+)/);
    if (worktreeMatch) {
      const ticketId = worktreeMatch[1];
      const perTicketPath = join(cwd.split('.promptwheel/worktrees')[0], '.promptwheel', 'scope-policies', `${ticketId}.json`);
      if (existsSync(perTicketPath)) {
        policyPath = perTicketPath;
      }
    }

    if (!policyPath) {
      policyPath = join(cwd, '.promptwheel', 'scope-policy.json');
    }

    if (!existsSync(policyPath)) {
      // No policy cached — allow
      process.exit(0);
    }

    const policy = JSON.parse(readFileSync(policyPath, 'utf8'));

    // Check denied paths
    for (const deniedGlob of (policy.denied_paths ?? [])) {
      if (simpleMatch(deniedGlob, filePath)) {
        deny(`File ${filePath} matches denied path: ${deniedGlob}`);
      }
    }

    // Check denied patterns
    for (const patternStr of (policy.denied_patterns ?? [])) {
      try {
        const pattern = new RegExp(patternStr);
        if (pattern.test(filePath)) {
          deny(`File ${filePath} matches denied pattern: ${patternStr}`);
        }
      } catch (err) {
        // Bad regex in deny pattern — fail closed (deny the write)
        process.stderr.write(`[promptwheel] bad denied_pattern regex "${patternStr}": ${err}\n`);
        deny(`File ${filePath} blocked: invalid denied_pattern regex "${patternStr}"`);
      }
    }

    // Check allowed paths (empty = everything allowed)
    const allowedPaths = policy.allowed_paths ?? [];
    if (allowedPaths.length > 0) {
      const isAllowed = allowedPaths.some(glob => simpleMatch(glob, filePath));
      if (!isAllowed) {
        deny(`File ${filePath} is outside allowed paths: ${allowedPaths.join(', ')}`);
      }
    }

    // All checks passed
    process.exit(0);
  } catch (err) {
    // Parse/validation error — fail closed to prevent unauthorized writes
    process.stderr.write(`[promptwheel] PreToolUse scope check error: ${err}\n`);
    deny(`PromptWheel scope validation error: ${err}. Fix or remove .promptwheel/scope-policy.json`);
  }
}

// Unknown hook type — allow
process.exit(0);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function deny(reason) {
  process.stdout.write(JSON.stringify({
    decision: 'deny',
    reason,
  }));
  process.exit(0);
}
