/**
 * Tests for CLI project-metadata module
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { detectProjectMetadata, formatMetadataForPrompt } from '../lib/project-metadata.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

function mkfile(relPath: string, content = ''): void {
  const full = path.join(tmpDir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'project-metadata-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// detectProjectMetadata
// ---------------------------------------------------------------------------

describe('detectProjectMetadata', () => {
  it('returns empty metadata for empty project', () => {
    const meta = detectProjectMetadata(tmpDir);
    expect(meta.languages).toEqual([]);
    expect(meta.package_manager).toBeNull();
    expect(meta.test_runner).toBeNull();
    expect(meta.framework).toBeNull();
    expect(meta.linter).toBeNull();
  });

  it('detects TypeScript with npm', () => {
    mkfile('package.json', JSON.stringify({
      devDependencies: { typescript: '^5.0.0' },
    }));
    const meta = detectProjectMetadata(tmpDir);
    expect(meta.languages).toContain('TypeScript');
    expect(meta.package_manager).toBe('npm');
    expect(meta.type_checker).toBe('tsc');
  });

  it('detects pnpm from lockfile', () => {
    mkfile('package.json', JSON.stringify({}));
    mkfile('pnpm-lock.yaml', '');
    const meta = detectProjectMetadata(tmpDir);
    expect(meta.package_manager).toBe('pnpm');
  });

  it('detects yarn from lockfile', () => {
    mkfile('package.json', JSON.stringify({}));
    mkfile('yarn.lock', '');
    const meta = detectProjectMetadata(tmpDir);
    expect(meta.package_manager).toBe('yarn');
  });

  it('detects bun from lockfile', () => {
    mkfile('package.json', JSON.stringify({}));
    mkfile('bun.lockb', '');
    const meta = detectProjectMetadata(tmpDir);
    expect(meta.package_manager).toBe('bun');
  });

  it('detects vitest test runner', () => {
    mkfile('package.json', JSON.stringify({
      devDependencies: { vitest: '^1.0.0' },
      scripts: { test: 'vitest run' },
    }));
    const meta = detectProjectMetadata(tmpDir);
    expect(meta.test_runner?.name).toBe('vitest');
    expect(meta.test_runner?.run_command).toBe('npm test');
  });

  it('detects jest test runner', () => {
    mkfile('package.json', JSON.stringify({
      devDependencies: { jest: '^29.0.0' },
      scripts: { test: 'jest' },
    }));
    const meta = detectProjectMetadata(tmpDir);
    expect(meta.test_runner?.name).toBe('jest');
  });

  it('detects Next.js framework', () => {
    mkfile('package.json', JSON.stringify({
      dependencies: { next: '^14.0.0', react: '^18.0.0' },
    }));
    const meta = detectProjectMetadata(tmpDir);
    expect(meta.framework).toBe('Next.js');
  });

  it('detects Express framework', () => {
    mkfile('package.json', JSON.stringify({
      dependencies: { express: '^4.0.0' },
    }));
    const meta = detectProjectMetadata(tmpDir);
    expect(meta.framework).toBe('Express');
  });

  it('detects eslint linter', () => {
    mkfile('package.json', JSON.stringify({
      devDependencies: { eslint: '^8.0.0' },
    }));
    const meta = detectProjectMetadata(tmpDir);
    expect(meta.linter).toBe('eslint');
  });

  it('detects biome linter', () => {
    mkfile('package.json', JSON.stringify({
      devDependencies: { '@biomejs/biome': '^1.0.0' },
    }));
    const meta = detectProjectMetadata(tmpDir);
    expect(meta.linter).toBe('biome');
  });

  it('detects turborepo monorepo', () => {
    mkfile('package.json', JSON.stringify({}));
    mkfile('turbo.json', '{}');
    const meta = detectProjectMetadata(tmpDir);
    expect(meta.monorepo_tool).toBe('turborepo');
  });

  // Python
  it('detects Python with pytest', () => {
    mkfile('pyproject.toml', '[tool.pytest]\n');
    const meta = detectProjectMetadata(tmpDir);
    expect(meta.languages).toContain('Python');
    expect(meta.test_runner?.name).toBe('pytest');
    expect(meta.test_runner?.run_command).toBe('pytest');
  });

  it('detects Django framework', () => {
    mkfile('requirements.txt', 'Django==4.2\n');
    const meta = detectProjectMetadata(tmpDir);
    expect(meta.languages).toContain('Python');
    expect(meta.framework).toBe('Django');
  });

  it('detects ruff linter', () => {
    mkfile('pyproject.toml', '[tool.ruff]\nline-length = 100\n');
    const meta = detectProjectMetadata(tmpDir);
    expect(meta.linter).toBe('ruff');
  });

  // Rust
  it('detects Rust with cargo', () => {
    mkfile('Cargo.toml', '[package]\nname = "myapp"\n');
    const meta = detectProjectMetadata(tmpDir);
    expect(meta.languages).toContain('Rust');
    expect(meta.package_manager).toBe('cargo');
    expect(meta.test_runner?.name).toBe('cargo-test');
    expect(meta.linter).toBe('clippy');
  });

  // Go
  it('detects Go', () => {
    mkfile('go.mod', 'module example.com/app\n\ngo 1.21\n');
    const meta = detectProjectMetadata(tmpDir);
    expect(meta.languages).toContain('Go');
    expect(meta.test_runner?.name).toBe('go-test');
    expect(meta.test_runner?.run_command).toBe('go test ./...');
  });

  // Ruby
  it('detects Ruby with rspec', () => {
    mkfile('Gemfile', "gem 'rspec'\n");
    mkfile('.rspec', '--format documentation\n');
    const meta = detectProjectMetadata(tmpDir);
    expect(meta.languages).toContain('Ruby');
    expect(meta.test_runner?.name).toBe('rspec');
  });

  it('detects Rails framework', () => {
    mkfile('Gemfile', "gem 'rails'\n");
    const meta = detectProjectMetadata(tmpDir);
    expect(meta.framework).toBe('Rails');
  });

  // Elixir
  it('detects Elixir with Phoenix', () => {
    mkfile('mix.exs', 'defmodule MyApp do\n  :phoenix\nend\n');
    const meta = detectProjectMetadata(tmpDir);
    expect(meta.languages).toContain('Elixir');
    expect(meta.test_runner?.name).toBe('exunit');
    expect(meta.framework).toBe('Phoenix');
  });

  // Java
  it('detects Java with Maven', () => {
    mkfile('pom.xml', '<project><spring-boot></spring-boot></project>');
    const meta = detectProjectMetadata(tmpDir);
    expect(meta.languages).toContain('Java');
    expect(meta.package_manager).toBe('maven');
    expect(meta.test_runner?.name).toBe('junit');
    expect(meta.framework).toBe('Spring Boot');
  });

  // PHP
  it('detects PHP with Laravel', () => {
    mkfile('composer.json', JSON.stringify({
      require: { 'laravel/framework': '^10.0' },
    }));
    mkfile('phpunit.xml', '<phpunit/>');
    const meta = detectProjectMetadata(tmpDir);
    expect(meta.languages).toContain('PHP');
    expect(meta.test_runner?.name).toBe('phpunit');
    expect(meta.framework).toBe('Laravel');
  });

  // Swift
  it('detects Swift', () => {
    mkfile('Package.swift', '// swift-tools-version: 5.9\n');
    const meta = detectProjectMetadata(tmpDir);
    expect(meta.languages).toContain('Swift');
    expect(meta.test_runner?.name).toBe('swift-test');
  });

  // Multi-language
  it('detects multiple languages', () => {
    mkfile('package.json', JSON.stringify({ devDependencies: { typescript: '^5' } }));
    mkfile('pyproject.toml', '[project]\n');
    const meta = detectProjectMetadata(tmpDir);
    expect(meta.languages).toContain('TypeScript');
    expect(meta.languages).toContain('Python');
  });
});

// ---------------------------------------------------------------------------
// formatMetadataForPrompt
// ---------------------------------------------------------------------------

describe('formatMetadataForPrompt', () => {
  it('returns minimal output for empty metadata', () => {
    const meta = detectProjectMetadata(tmpDir);
    const result = formatMetadataForPrompt(meta);
    expect(result).toContain('Project Tooling');
    expect(result).not.toContain('Language');
  });

  it('includes all detected fields', () => {
    mkfile('package.json', JSON.stringify({
      dependencies: { next: '^14', react: '^18' },
      devDependencies: { typescript: '^5', vitest: '^1', eslint: '^8' },
      scripts: { test: 'vitest run' },
    }));
    mkfile('turbo.json', '{}');

    const meta = detectProjectMetadata(tmpDir);
    const result = formatMetadataForPrompt(meta);

    expect(result).toContain('TypeScript');
    expect(result).toContain('Next.js');
    expect(result).toContain('vitest');
    expect(result).toContain('eslint');
    expect(result).toContain('tsc');
    expect(result).toContain('turborepo');
    expect(result).toContain('IMPORTANT');
  });

  it('includes run and filter syntax for test runner', () => {
    mkfile('package.json', JSON.stringify({
      devDependencies: { vitest: '^1' },
      scripts: { test: 'vitest run' },
    }));

    const meta = detectProjectMetadata(tmpDir);
    const result = formatMetadataForPrompt(meta);

    expect(result).toContain('Run tests');
    expect(result).toContain('Filter tests');
    expect(result).toContain('npm test');
  });
});

// ---------------------------------------------------------------------------
// Integration with buildTicketPrompt
// ---------------------------------------------------------------------------

describe('integration with buildTicketPrompt', () => {
  it('buildTicketPrompt accepts metadataContext parameter', async () => {
    const { buildTicketPrompt } = await import('../lib/solo-ticket.js');

    const ticket = {
      id: 'test-1',
      title: 'Test ticket',
      description: 'A test',
      allowedPaths: ['src/'],
      forbiddenPaths: [],
      acceptanceCriteria: ['It works'],
      verificationCommands: ['npm test'],
      estimatedComplexity: 'simple' as const,
      projectId: 'proj-1',
      status: 'ready' as const,
      createdAt: new Date(),
      updatedAt: new Date(),
      metadata: {},
    };

    const prompt = buildTicketPrompt(ticket, undefined, undefined, '## Project Tooling\n**Language(s):** TypeScript');
    expect(prompt).toContain('Project Tooling');
    expect(prompt).toContain('TypeScript');
  });
});
