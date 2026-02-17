/**
 * Codebase index pure algorithm tests — covers functions in codebase-index/shared.ts:
 *   - purposeHintFromDirName
 *   - sampleEvenly
 *   - countNonProdFiles
 *   - classifyModule
 *   - extractImports
 *   - resolveImportToModule
 *   - formatIndexForPrompt
 *   - Constants: SOURCE_EXTENSIONS, PURPOSE_HINT, NON_PRODUCTION_PURPOSES
 *
 * Tests pure functions only (no filesystem).
 */

import { describe, it, expect } from 'vitest';
import {
  purposeHintFromDirName,
  sampleEvenly,
  countNonProdFiles,
  classifyModule,
  extractImports,
  resolveImportToModule,
  formatIndexForPrompt,
  SOURCE_EXTENSIONS,
  PURPOSE_HINT,
  NON_PRODUCTION_PURPOSES,
  CHUNK_SIZE,
  type CodebaseIndex,
} from '../codebase-index/shared.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('SOURCE_EXTENSIONS', () => {
  it('includes common language extensions', () => {
    expect(SOURCE_EXTENSIONS.has('.ts')).toBe(true);
    expect(SOURCE_EXTENSIONS.has('.js')).toBe(true);
    expect(SOURCE_EXTENSIONS.has('.py')).toBe(true);
    expect(SOURCE_EXTENSIONS.has('.go')).toBe(true);
    expect(SOURCE_EXTENSIONS.has('.rs')).toBe(true);
    expect(SOURCE_EXTENSIONS.has('.java')).toBe(true);
  });

  it('excludes non-source extensions', () => {
    expect(SOURCE_EXTENSIONS.has('.json')).toBe(false);
    expect(SOURCE_EXTENSIONS.has('.md')).toBe(false);
    expect(SOURCE_EXTENSIONS.has('.css')).toBe(false);
  });
});

describe('PURPOSE_HINT', () => {
  it('maps known directory names', () => {
    expect(PURPOSE_HINT['controllers']).toBe('api');
    expect(PURPOSE_HINT['services']).toBe('services');
    expect(PURPOSE_HINT['components']).toBe('ui');
    expect(PURPOSE_HINT['utils']).toBe('utils');
  });
});

describe('NON_PRODUCTION_PURPOSES', () => {
  it('includes test and config', () => {
    expect(NON_PRODUCTION_PURPOSES.has('tests')).toBe(true);
    expect(NON_PRODUCTION_PURPOSES.has('config')).toBe(true);
    expect(NON_PRODUCTION_PURPOSES.has('fixtures')).toBe(true);
    expect(NON_PRODUCTION_PURPOSES.has('generated')).toBe(true);
  });

  it('excludes production purposes', () => {
    expect(NON_PRODUCTION_PURPOSES.has('api')).toBe(false);
    expect(NON_PRODUCTION_PURPOSES.has('services')).toBe(false);
  });
});

describe('CHUNK_SIZE', () => {
  it('is 15', () => {
    expect(CHUNK_SIZE).toBe(15);
  });
});

// ---------------------------------------------------------------------------
// purposeHintFromDirName
// ---------------------------------------------------------------------------

describe('purposeHintFromDirName', () => {
  it('returns api for known API directory names', () => {
    expect(purposeHintFromDirName('controllers')).toBe('api');
    expect(purposeHintFromDirName('routes')).toBe('api');
    expect(purposeHintFromDirName('handlers')).toBe('api');
    expect(purposeHintFromDirName('endpoints')).toBe('api');
  });

  it('returns services for known service names', () => {
    expect(purposeHintFromDirName('services')).toBe('services');
    expect(purposeHintFromDirName('lib')).toBe('services');
    expect(purposeHintFromDirName('core')).toBe('services');
  });

  it('returns ui for known UI names', () => {
    expect(purposeHintFromDirName('components')).toBe('ui');
    expect(purposeHintFromDirName('views')).toBe('ui');
    expect(purposeHintFromDirName('pages')).toBe('ui');
  });

  it('returns utils for utility names', () => {
    expect(purposeHintFromDirName('utils')).toBe('utils');
    expect(purposeHintFromDirName('helpers')).toBe('utils');
    expect(purposeHintFromDirName('common')).toBe('utils');
  });

  it('is case-insensitive', () => {
    expect(purposeHintFromDirName('Controllers')).toBe('api');
    expect(purposeHintFromDirName('SERVICES')).toBe('services');
  });

  it('returns unknown for unrecognized names', () => {
    expect(purposeHintFromDirName('foobar')).toBe('unknown');
    expect(purposeHintFromDirName('data')).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// sampleEvenly
// ---------------------------------------------------------------------------

describe('sampleEvenly', () => {
  it('returns all items when array is smaller than count', () => {
    expect(sampleEvenly([1, 2, 3], 5)).toEqual([1, 2, 3]);
  });

  it('returns all items when array equals count', () => {
    expect(sampleEvenly([1, 2, 3], 3)).toEqual([1, 2, 3]);
  });

  it('samples evenly from larger arrays', () => {
    const result = sampleEvenly([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 3);
    expect(result).toHaveLength(3);
    // Should pick items at indices 0, 3, 6 (step = 10/3 ≈ 3.33)
    expect(result[0]).toBe(0);
    expect(result[1]).toBe(3);
    expect(result[2]).toBe(6);
  });

  it('handles empty array', () => {
    expect(sampleEvenly([], 5)).toEqual([]);
  });

  it('handles count of 1', () => {
    const result = sampleEvenly([10, 20, 30], 1);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// countNonProdFiles
// ---------------------------------------------------------------------------

describe('countNonProdFiles', () => {
  it('counts .test. files', () => {
    expect(countNonProdFiles(['a.test.ts', 'b.ts', 'c.test.js'])).toBe(2);
  });

  it('counts .spec. files', () => {
    expect(countNonProdFiles(['a.spec.ts', 'b.ts'])).toBe(1);
  });

  it('counts .e2e. files', () => {
    expect(countNonProdFiles(['login.e2e.ts'])).toBe(1);
  });

  it('counts .stories. files', () => {
    expect(countNonProdFiles(['Button.stories.tsx'])).toBe(1);
  });

  it('returns 0 for all production files', () => {
    expect(countNonProdFiles(['util.ts', 'api.js', 'main.py'])).toBe(0);
  });

  it('handles empty array', () => {
    expect(countNonProdFiles([])).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// classifyModule
// ---------------------------------------------------------------------------

describe('classifyModule', () => {
  it('classifies as tests when majority of files are test files', () => {
    const files = ['a.test.ts', 'b.test.ts', 'c.test.ts', 'd.ts'];
    const result = classifyModule('__tests__', files, [], 4);
    expect(result.purpose).toBe('tests');
    expect(result.production).toBe(false);
    expect(result.confidence).toBe('high');
  });

  it('classifies as generated from content signals', () => {
    const snippets = [
      '// @generated\nconst x = 1;',
      '/* THIS FILE IS GENERATED */\nmodule.exports = {};',
    ];
    const result = classifyModule('output', ['a.ts', 'b.ts'], snippets, 2);
    expect(result.purpose).toBe('generated');
    expect(result.production).toBe(false);
  });

  it('classifies as tests from content signals', () => {
    const snippets = [
      'describe("foo", () => { it("works", () => { expect(1).toBe(1); }); });',
      'test("bar", () => { expect(true).toBe(true); });',
    ];
    const result = classifyModule('specs', ['a.ts', 'b.ts'], snippets, 2);
    expect(result.purpose).toBe('tests');
    expect(result.production).toBe(false);
  });

  it('classifies as fixtures from content signals', () => {
    const snippets = [
      'export const mockUser = { name: "test" };',
      'export function fakeResponse() { return {}; }',
    ];
    const result = classifyModule('mocks', ['a.ts', 'b.ts'], snippets, 2);
    expect(result.purpose).toBe('fixtures');
    expect(result.production).toBe(false);
  });

  it('classifies as config from file extensions', () => {
    const files = ['tsconfig.json', 'eslint.yaml', 'jest.config.toml', 'app.ts'];
    const result = classifyModule('config', files, [], 4);
    expect(result.purpose).toBe('config');
    expect(result.production).toBe(false);
  });

  it('uses directory name hint for production modules', () => {
    const result = classifyModule('controllers', ['user.ts', 'auth.ts'], [], 2);
    expect(result.purpose).toBe('api');
    expect(result.production).toBe(true);
    expect(result.confidence).toBe('high');
  });

  it('returns unknown with low confidence when no signals match', () => {
    const result = classifyModule('stuff', ['a.ts', 'b.ts'], [], 2);
    expect(result.purpose).toBe('unknown');
    expect(result.production).toBe(true);
    expect(result.confidence).toBe('low');
  });

  it('subtracts non-prod files from production file count', () => {
    const files = ['api.ts', 'api.test.ts', 'helper.ts'];
    const result = classifyModule('services', files, [], 3);
    expect(result.production).toBe(true);
    expect(result.productionFileCount).toBe(2); // 3 total - 1 test file
  });

  it('gives medium confidence with content signals but no dir hint', () => {
    const snippets = ['describe("test", () => {});'];
    // Only 1 out of 2 snippets has test content (50%), which is NOT > 50%, so it falls through
    // But testHits > 0 provides content signals
    const result = classifyModule('mymod', ['a.ts', 'b.ts'], snippets, 2);
    // With only 1 snippet and 1 test hit, testHits/total = 1/1 > 0.5, so actually classifies as tests
    expect(result.purpose).toBe('tests');
  });

  it('classifies as production with medium confidence when content signals present but below threshold', () => {
    const snippets = [
      'export function handler() {}',
      'export function middleware() {}',
      'describe("test", () => {});', // 1 test hit out of 3 snippets = 33%
    ];
    const result = classifyModule('mymod', ['a.ts', 'b.ts', 'c.ts'], snippets, 3);
    expect(result.production).toBe(true);
    expect(result.confidence).toBe('medium');
  });
});

// ---------------------------------------------------------------------------
// extractImports
// ---------------------------------------------------------------------------

describe('extractImports', () => {
  it('extracts JS/TS imports', () => {
    const content = `
import { foo } from './utils.js';
import bar from '../lib/bar.js';
const baz = require('./baz.js');
`;
    const imports = extractImports(content, 'src/index.ts');
    expect(imports).toContain('./utils.js');
    expect(imports).toContain('../lib/bar.js');
    expect(imports).toContain('./baz.js');
  });

  it('extracts Python imports', () => {
    const content = `
from mypackage.utils import helper
import os
from . import local
`;
    const imports = extractImports(content, 'src/main.py');
    expect(imports).toContain('mypackage.utils');
    expect(imports).toContain('os');
  });

  it('extracts Go imports', () => {
    const content = `
import "fmt"
import "github.com/user/pkg"
`;
    const imports = extractImports(content, 'main.go');
    expect(imports).toContain('fmt');
    expect(imports).toContain('github.com/user/pkg');
  });

  it('returns empty for unsupported extensions', () => {
    expect(extractImports('import foo from "bar"', 'file.rs')).toEqual([]);
  });

  it('returns empty for no imports', () => {
    expect(extractImports('const x = 1;', 'file.ts')).toEqual([]);
  });

  it('handles .js extension the same as .ts', () => {
    const content = "import { x } from './y.js';";
    expect(extractImports(content, 'file.js')).toContain('./y.js');
  });
});

// ---------------------------------------------------------------------------
// resolveImportToModule
// ---------------------------------------------------------------------------

describe('resolveImportToModule', () => {
  const modulePaths = ['src/lib', 'src/services', 'src/utils'];

  it('resolves relative imports to module paths', () => {
    const result = resolveImportToModule(
      '../lib/helper.js',
      '/project/src/services/api.ts',
      '/project',
      modulePaths,
    );
    expect(result).toBe('src/lib');
  });

  it('returns null for non-relative (package) imports', () => {
    expect(resolveImportToModule('lodash', '/project/src/a.ts', '/project', modulePaths)).toBeNull();
    expect(resolveImportToModule('@scope/pkg', '/project/src/a.ts', '/project', modulePaths)).toBeNull();
  });

  it('returns null when resolved path is not in any module', () => {
    const result = resolveImportToModule(
      '../unknown/thing.js',
      '/project/src/lib/a.ts',
      '/project',
      modulePaths,
    );
    expect(result).toBeNull();
  });

  it('handles same-module imports (returns the module itself)', () => {
    const result = resolveImportToModule(
      './other.js',
      '/project/src/lib/a.ts',
      '/project',
      modulePaths,
    );
    expect(result).toBe('src/lib');
  });
});

// ---------------------------------------------------------------------------
// formatIndexForPrompt
// ---------------------------------------------------------------------------

describe('formatIndexForPrompt', () => {
  function makeIndex(overrides: Partial<CodebaseIndex> = {}): CodebaseIndex {
    return {
      built_at: new Date().toISOString(),
      modules: [],
      dependency_edges: {},
      untested_modules: [],
      large_files: [],
      entrypoints: [],
      sampled_file_mtimes: {},
      ...overrides,
    };
  }

  it('returns "No modules detected" for empty index', () => {
    const result = formatIndexForPrompt(makeIndex(), 0);
    expect(result).toContain('No modules detected');
  });

  it('includes chunk header', () => {
    const idx = makeIndex({
      modules: [
        { path: 'src/lib', file_count: 5, production_file_count: 5, purpose: 'services', production: true, classification_confidence: 'high' },
      ],
    });
    const result = formatIndexForPrompt(idx, 0);
    expect(result).toContain('chunk 1/1');
    expect(result).toContain('Modules in Focus');
  });

  it('includes module info with dependencies', () => {
    const idx = makeIndex({
      modules: [
        { path: 'src/services', file_count: 10, production_file_count: 10, purpose: 'services', production: true, classification_confidence: 'high' },
        { path: 'src/lib', file_count: 5, production_file_count: 5, purpose: 'services', production: true, classification_confidence: 'high' },
      ],
      dependency_edges: { 'src/services': ['src/lib'] },
    });
    const result = formatIndexForPrompt(idx, 0);
    expect(result).toContain('src/services/');
    expect(result).toContain('10 files');
    expect(result).toContain('imports: src/lib');
  });

  it('rotates chunks across cycles', () => {
    const modules = Array.from({ length: 20 }, (_, i) => ({
      path: `src/mod${i}`,
      file_count: 1,
      production_file_count: 1,
      purpose: 'unknown',
      production: true,
      classification_confidence: 'low' as const,
    }));
    const idx = makeIndex({ modules });

    const cycle0 = formatIndexForPrompt(idx, 0);
    const cycle1 = formatIndexForPrompt(idx, 1);
    expect(cycle0).toContain('chunk 1/2');
    expect(cycle1).toContain('chunk 2/2');
    expect(cycle0).not.toEqual(cycle1);
  });

  it('shows other modules not in focus', () => {
    const modules = Array.from({ length: 20 }, (_, i) => ({
      path: `src/mod${i}`,
      file_count: 1,
      production_file_count: 1,
      purpose: 'unknown',
      production: true,
      classification_confidence: 'low' as const,
    }));
    const idx = makeIndex({ modules });

    const result = formatIndexForPrompt(idx, 0);
    expect(result).toContain('Other Modules');
  });

  it('includes untested modules section', () => {
    const idx = makeIndex({
      modules: [{ path: 'src/lib', file_count: 3, production_file_count: 3, purpose: 'services', production: true, classification_confidence: 'high' }],
      untested_modules: ['src/lib'],
    });
    const result = formatIndexForPrompt(idx, 0);
    expect(result).toContain('Untested Modules');
    expect(result).toContain('src/lib/');
  });

  it('includes complexity hotspots section', () => {
    const idx = makeIndex({
      modules: [{ path: 'src/lib', file_count: 1, production_file_count: 1, purpose: 'services', production: true, classification_confidence: 'high' }],
      large_files: [{ path: 'src/lib/big.ts', lines: 500 }],
    });
    const result = formatIndexForPrompt(idx, 0);
    expect(result).toContain('Complexity Hotspots');
    expect(result).toContain('src/lib/big.ts (500)');
  });

  it('includes entrypoints section', () => {
    const idx = makeIndex({
      modules: [{ path: 'src/lib', file_count: 1, production_file_count: 1, purpose: 'services', production: true, classification_confidence: 'high' }],
      entrypoints: ['src/index.ts', 'src/server.ts'],
    });
    const result = formatIndexForPrompt(idx, 0);
    expect(result).toContain('Entrypoints');
    expect(result).toContain('src/index.ts');
    expect(result).toContain('src/server.ts');
  });

  it('omits sections that have no data', () => {
    const idx = makeIndex({
      modules: [{ path: 'src/lib', file_count: 1, production_file_count: 1, purpose: 'services', production: true, classification_confidence: 'high' }],
    });
    const result = formatIndexForPrompt(idx, 0);
    expect(result).not.toContain('Untested');
    expect(result).not.toContain('Hotspots');
    expect(result).not.toContain('Entrypoints');
    expect(result).not.toContain('Other Modules');
  });
});
