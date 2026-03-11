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
import { join } from 'node:path';

/**
 * Glob matching compatible with minimatch({ dot: true }) behavior.
 * No external dependencies — the plugin runs standalone.
 *
 * Supports: *, **, ?, {a,b}, [abc], dotfiles
 * Mirrors the patterns used by scope-policy.ts (ALWAYS_DENIED, allowed_paths).
 */
function globMatch(pattern, str) {
  // Normalize: directory-style paths get /** appended (matches normalizeAllowedGlob in scope-policy.ts)
  if (pattern.endsWith('/')) pattern += '**';

  // Convert glob pattern to regex
  let i = 0;
  let regex = '^';
  const len = pattern.length;

  while (i < len) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') {
          // **/ matches zero or more path segments
          regex += '(?:.+/)?';
          i += 3;
        } else if (i === 0 || pattern[i - 1] === '/') {
          // ** at start or after / matches everything (including nested paths)
          regex += '.*';
          i += 2;
        } else {
          // Bare ** not at segment boundary — treat as two single *
          regex += '[^/]*[^/]*';
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
        regex += '(?:' + alternatives.map(escapeRegex).join('|') + ')';
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
      regex += escapeRegex(c);
      i++;
    }
  }
  regex += '$';

  try {
    return new RegExp(regex).test(str);
  } catch {
    // Bad pattern — fail closed (deny the match)
    return false;
  }
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

    // PID liveness check — if the session's process is dead, this is a stale file
    if (typeof loopState.pid === 'number') {
      let alive = false;
      try { process.kill(loopState.pid, 0); alive = true; } catch { /* ESRCH = dead */ }
      if (!alive) {
        try { unlinkSync(loopStatePath); } catch { /* ignore */ }
        process.exit(0);
      }
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

    // Check Bash tool for dangerous command patterns
    if (toolName === 'Bash') {
      const command = toolInput.command ?? '';
      const blocked = checkCommandBlocklist(command);
      if (blocked) {
        deny(`Blocked dangerous command: ${blocked}`);
      }
      process.exit(0);
    }

    // Only check write operations for scope enforcement
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
      if (globMatch(deniedGlob, filePath)) {
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
      const isAllowed = allowedPaths.some(glob => globMatch(glob, filePath));
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

const COMMAND_BLOCKLIST = [
  { pattern: /\brm\s+(-\w*r\w*f\w*|-\w*f\w*r\w*)\s+\/(\s|$)/, reason: 'Recursive force-delete from root' },
  { pattern: /\brm\s+(-\w*r\w*f\w*|-\w*f\w*r\w*)\s+~\//, reason: 'Recursive force-delete from home directory' },
  { pattern: /\bgit\s+push\s+.*--force\b/, reason: 'Force push can destroy remote history' },
  { pattern: /\bgit\s+push\s+-f\b/, reason: 'Force push can destroy remote history' },
  { pattern: /\bgit\s+reset\s+--hard\b/, reason: 'Hard reset discards uncommitted work' },
  { pattern: /\bgit\s+clean\s+(-\w*f\w*d|-\w*d\w*f)\b/, reason: 'git clean -fd deletes untracked files' },
  { pattern: /\bDROP\s+(TABLE|DATABASE)\b/i, reason: 'SQL DROP is destructive and irreversible' },
  { pattern: /\bchmod\s+777\b/, reason: 'chmod 777 is a security risk' },
  { pattern: /\bcurl\b.*\|\s*(ba)?sh\b/, reason: 'Piping curl to shell is a security risk' },
  { pattern: /\bwget\b.*\|\s*(ba)?sh\b/, reason: 'Piping wget to shell is a security risk' },
  { pattern: /\bmkfs\b/, reason: 'mkfs formats filesystems' },
  { pattern: /\bdd\s+.*\bof=\/dev\//, reason: 'dd to device can destroy data' },
  { pattern: />\s*\/dev\/sd[a-z]/, reason: 'Redirecting to block device can destroy data' },
  { pattern: /:\(\)\s*\{.*:\|:.*\}/, reason: 'Fork bomb' },
];

function checkCommandBlocklist(command) {
  for (const entry of COMMAND_BLOCKLIST) {
    if (entry.pattern.test(command)) {
      return entry.reason;
    }
  }
  return null;
}

function deny(reason) {
  process.stdout.write(JSON.stringify({
    decision: 'deny',
    reason,
  }));
  process.exit(0);
}
