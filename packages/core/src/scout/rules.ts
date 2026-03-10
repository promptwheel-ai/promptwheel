/**
 * Custom Rules — team-specific finding patterns.
 *
 * Rules live in `.promptwheel/rules/` as YAML files. Each rule defines
 * a pattern the LLM should check for during scanning. Rules are semantic
 * (not regex) — the LLM interprets the description and examples.
 *
 * This gives teams a way to encode institutional knowledge that persists
 * across scans and team members.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CustomRule {
  /** Unique rule ID (e.g., "no-raw-sql", "auth-before-db"). */
  id: string;
  /** Short rule title. */
  title: string;
  /** What the rule checks for — injected into the scout prompt. */
  description: string;
  /** Severity to assign when this rule is violated. */
  severity: 'blocking' | 'degrading' | 'polish' | 'speculative';
  /** Category to assign to findings from this rule. */
  category?: string;
  /** Glob pattern restricting which files this rule applies to. */
  files?: string;
  /** Examples of violations and correct code. */
  examples?: {
    bad?: string;
    good?: string;
  };
  /** Whether this rule is active (default: true). */
  enabled?: boolean;
}

export interface RuleSet {
  /** Loaded rules. */
  rules: CustomRule[];
  /** Errors encountered loading rules. */
  errors: string[];
}

// ---------------------------------------------------------------------------
// YAML parser (minimal, no dependency)
// ---------------------------------------------------------------------------

/**
 * Parse a simple YAML rule file. Supports flat key:value, multiline with |,
 * and nested examples.bad/examples.good.
 */
function parseRuleYaml(content: string, filePath: string): CustomRule | null {
  const lines = content.split('\n');
  const result: Record<string, unknown> = {};
  let currentKey = '';
  let multilineBuffer: string[] = [];
  let inMultiline = false;
  let multilineIndent = 0;

  const flushMultiline = () => {
    if (inMultiline && currentKey) {
      result[currentKey] = multilineBuffer.join('\n').trimEnd();
      multilineBuffer = [];
      inMultiline = false;
    }
  };

  for (const line of lines) {
    // Blank lines in multiline blocks are preserved
    if (inMultiline) {
      const trimmed = line.trimStart();
      const indent = line.length - trimmed.length;
      if (indent >= multilineIndent && trimmed.length > 0) {
        multilineBuffer.push(line.slice(multilineIndent));
        continue;
      } else if (trimmed.length === 0) {
        multilineBuffer.push('');
        continue;
      } else {
        flushMultiline();
        // Fall through to process this line normally
      }
    }

    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    // Handle nested keys (examples.bad, examples.good)
    const nestedMatch = trimmed.match(/^(\w+)\.(\w+):\s*(.*)/);
    if (nestedMatch) {
      const [, parent, child, value] = nestedMatch;
      const parentKey = parent as string;
      const childKey = child as string;
      if (!result[parentKey] || typeof result[parentKey] !== 'object') {
        result[parentKey] = {};
      }
      const rawValue = value.trim();
      if (rawValue === '|') {
        currentKey = `${parentKey}.${childKey}`;
        inMultiline = true;
        multilineIndent = (line.length - trimmed.length) + 2;
        continue;
      }
      (result[parentKey] as Record<string, string>)[childKey] = unquote(rawValue);
      continue;
    }

    // Handle top-level key: value
    const match = trimmed.match(/^(\w+):\s*(.*)/);
    if (match) {
      const [, key, value] = match;
      const rawValue = value.trim();
      if (rawValue === '|') {
        currentKey = key;
        inMultiline = true;
        multilineIndent = (line.length - trimmed.length) + 2;
        continue;
      }
      result[key] = unquote(rawValue);
    }
  }

  flushMultiline();

  // Validate required fields
  if (!result.id || !result.title || !result.description) {
    return null;
  }

  const validSeverities = ['blocking', 'degrading', 'polish', 'speculative'];
  const severity = String(result.severity ?? 'degrading').toLowerCase();

  const rule: CustomRule = {
    id: String(result.id),
    title: String(result.title),
    description: String(result.description),
    severity: validSeverities.includes(severity) ? severity as CustomRule['severity'] : 'degrading',
    enabled: result.enabled !== undefined ? String(result.enabled) !== 'false' : true,
  };
  if (result.category) rule.category = String(result.category);
  if (result.files) rule.files = String(result.files);
  if (result.examples && typeof result.examples === 'object') {
    rule.examples = result.examples as CustomRule['examples'];
  }
  return rule;
}

function unquote(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

const RULES_DIR = 'rules';

export function rulesDir(promptwheelDir: string): string {
  return path.join(promptwheelDir, RULES_DIR);
}

/** Load all rules from `.promptwheel/rules/`. */
export function loadRules(promptwheelDir: string): RuleSet {
  const dir = rulesDir(promptwheelDir);
  const rules: CustomRule[] = [];
  const errors: string[] = [];

  if (!fs.existsSync(dir)) {
    return { rules, errors };
  }

  let files: string[];
  try {
    files = fs.readdirSync(dir).filter(f => f.endsWith('.yaml') || f.endsWith('.yml'));
  } catch (err) {
    return { rules, errors: [`Failed to read rules directory: ${err}`] };
  }

  for (const file of files.sort()) {
    const filePath = path.join(dir, file);
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const rule = parseRuleYaml(content, filePath);
      if (rule) {
        if (rule.enabled !== false) {
          rules.push(rule);
        }
      } else {
        errors.push(`${file}: missing required fields (id, title, description)`);
      }
    } catch (err) {
      errors.push(`${file}: ${err instanceof Error ? err.message : err}`);
    }
  }

  return { rules, errors };
}

/** Save a rule to `.promptwheel/rules/{id}.yaml`. */
export function saveRule(promptwheelDir: string, rule: CustomRule): string {
  const dir = rulesDir(promptwheelDir);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const lines: string[] = [
    `id: ${rule.id}`,
    `title: "${rule.title}"`,
    `severity: ${rule.severity}`,
  ];

  if (rule.category) {
    lines.push(`category: ${rule.category}`);
  }
  if (rule.files) {
    lines.push(`files: "${rule.files}"`);
  }

  lines.push(`description: |`);
  for (const line of rule.description.split('\n')) {
    lines.push(`  ${line}`);
  }

  if (rule.examples) {
    if (rule.examples.bad) {
      lines.push(`examples.bad: "${rule.examples.bad}"`);
    }
    if (rule.examples.good) {
      lines.push(`examples.good: "${rule.examples.good}"`);
    }
  }

  if (rule.enabled === false) {
    lines.push('enabled: false');
  }

  const filePath = path.join(dir, `${rule.id}.yaml`);
  fs.writeFileSync(filePath, lines.join('\n') + '\n');
  return filePath;
}

// ---------------------------------------------------------------------------
// Prompt injection
// ---------------------------------------------------------------------------

/** Build a prompt section from custom rules for injection into the scout prompt. */
export function buildRulesPromptSection(rules: CustomRule[]): string {
  if (rules.length === 0) return '';

  const lines: string[] = [
    '\n## Custom Rules (team-defined)',
    '',
    'The following rules encode team-specific patterns. Findings that match these rules should use the specified severity and category.',
    '',
  ];

  for (const rule of rules) {
    lines.push(`### ${rule.id}: ${rule.title}`);
    lines.push(`Severity: ${rule.severity}`);
    if (rule.category) lines.push(`Category: ${rule.category}`);
    if (rule.files) lines.push(`Applies to: ${rule.files}`);
    lines.push('');
    lines.push(rule.description);

    if (rule.examples) {
      if (rule.examples.bad) {
        lines.push(`Bad: \`${rule.examples.bad}\``);
      }
      if (rule.examples.good) {
        lines.push(`Good: \`${rule.examples.good}\``);
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}
