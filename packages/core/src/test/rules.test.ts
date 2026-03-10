import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  loadRules,
  saveRule,
  buildRulesPromptSection,
  rulesDir,
  type CustomRule,
} from '../scout/rules.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-rules-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeRule(id: string, content: string): void {
  const dir = rulesDir(tmpDir);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.yaml`), content);
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

describe('loadRules', () => {
  it('returns empty when no rules directory', () => {
    const { rules, errors } = loadRules(tmpDir);
    expect(rules).toHaveLength(0);
    expect(errors).toHaveLength(0);
  });

  it('loads a simple rule', () => {
    writeRule('no-console', `
id: no-console
title: "No console.log in production"
severity: degrading
category: cleanup
files: "src/**/*.ts"
description: |
  Remove console.log statements from production code.
  Use the logger utility instead.
examples.bad: "console.log('debug:', data)"
examples.good: "logger.debug('debug:', data)"
`);

    const { rules, errors } = loadRules(tmpDir);
    expect(errors).toHaveLength(0);
    expect(rules).toHaveLength(1);
    expect(rules[0].id).toBe('no-console');
    expect(rules[0].title).toBe('No console.log in production');
    expect(rules[0].severity).toBe('degrading');
    expect(rules[0].category).toBe('cleanup');
    expect(rules[0].files).toBe('src/**/*.ts');
    expect(rules[0].description).toContain('Remove console.log');
    expect(rules[0].description).toContain('Use the logger');
    expect(rules[0].examples?.bad).toBe("console.log('debug:', data)");
    expect(rules[0].examples?.good).toBe("logger.debug('debug:', data)");
  });

  it('loads multiple rules sorted by filename', () => {
    writeRule('b-rule', 'id: b-rule\ntitle: B\ndescription: B rule');
    writeRule('a-rule', 'id: a-rule\ntitle: A\ndescription: A rule');

    const { rules } = loadRules(tmpDir);
    expect(rules).toHaveLength(2);
    expect(rules[0].id).toBe('a-rule');
    expect(rules[1].id).toBe('b-rule');
  });

  it('skips disabled rules', () => {
    writeRule('disabled', 'id: disabled\ntitle: Off\ndescription: desc\nenabled: false');
    writeRule('active', 'id: active\ntitle: On\ndescription: desc');

    const { rules } = loadRules(tmpDir);
    expect(rules).toHaveLength(1);
    expect(rules[0].id).toBe('active');
  });

  it('reports error for invalid rule (missing fields)', () => {
    writeRule('bad', 'id: bad\ntitle: Bad');  // missing description

    const { rules, errors } = loadRules(tmpDir);
    expect(rules).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('missing required fields');
  });

  it('defaults severity to degrading', () => {
    writeRule('no-sev', 'id: no-sev\ntitle: No Severity\ndescription: desc');

    const { rules } = loadRules(tmpDir);
    expect(rules[0].severity).toBe('degrading');
  });

  it('normalizes invalid severity to degrading', () => {
    writeRule('bad-sev', 'id: bad-sev\ntitle: Bad Sev\ndescription: desc\nseverity: critical');

    const { rules } = loadRules(tmpDir);
    expect(rules[0].severity).toBe('degrading');
  });

  it('handles .yml extension', () => {
    const dir = rulesDir(tmpDir);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'test.yml'), 'id: test\ntitle: Test\ndescription: desc');

    const { rules } = loadRules(tmpDir);
    expect(rules).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// saveRule
// ---------------------------------------------------------------------------

describe('saveRule', () => {
  it('saves and loads a rule', () => {
    const rule: CustomRule = {
      id: 'auth-check',
      title: 'Ensure auth before DB access',
      description: 'All database queries must be preceded by auth verification.',
      severity: 'blocking',
      category: 'security',
      files: 'src/api/**/*.ts',
      examples: {
        bad: 'db.query(sql)',
        good: 'await verifyAuth(req); db.query(sql)',
      },
    };

    const filePath = saveRule(tmpDir, rule);
    expect(fs.existsSync(filePath)).toBe(true);

    const { rules } = loadRules(tmpDir);
    expect(rules).toHaveLength(1);
    expect(rules[0].id).toBe('auth-check');
    expect(rules[0].title).toBe('Ensure auth before DB access');
    expect(rules[0].severity).toBe('blocking');
    expect(rules[0].category).toBe('security');
  });

  it('creates rules directory if missing', () => {
    const nested = path.join(tmpDir, 'sub', 'dir');
    saveRule(nested, {
      id: 'test',
      title: 'Test',
      description: 'desc',
      severity: 'polish',
    });
    expect(fs.existsSync(path.join(rulesDir(nested), 'test.yaml'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildRulesPromptSection
// ---------------------------------------------------------------------------

describe('buildRulesPromptSection', () => {
  it('returns empty string for no rules', () => {
    expect(buildRulesPromptSection([])).toBe('');
  });

  it('builds prompt section with rules', () => {
    const rules: CustomRule[] = [
      {
        id: 'no-raw-sql',
        title: 'No raw SQL',
        description: 'Use query builder instead.',
        severity: 'blocking',
        category: 'security',
        files: 'src/**/*.ts',
        examples: { bad: 'db.query(sql)', good: 'db.queryBuilder()' },
      },
      {
        id: 'no-console',
        title: 'No console.log',
        description: 'Use logger.',
        severity: 'degrading',
      },
    ];

    const section = buildRulesPromptSection(rules);
    expect(section).toContain('Custom Rules (team-defined)');
    expect(section).toContain('no-raw-sql: No raw SQL');
    expect(section).toContain('Severity: blocking');
    expect(section).toContain('Category: security');
    expect(section).toContain('Applies to: src/**/*.ts');
    expect(section).toContain('Use query builder');
    expect(section).toContain('Bad: `db.query(sql)`');
    expect(section).toContain('Good: `db.queryBuilder()`');
    expect(section).toContain('no-console: No console.log');
  });
});
