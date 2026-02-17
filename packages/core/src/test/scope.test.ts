/**
 * Scope algorithm tests — covers functions not tested by CLI's scope.test.ts:
 *   - normalizePath
 *   - detectHallucinatedPath
 *   - detectCredentialInContent
 *   - detectCredentialPattern
 *   - isPathAllowed
 *   - ALWAYS_DENIED / CREDENTIAL_PATTERNS / FILE_DENY_PATTERNS constants
 *
 * Tests pure functions only (no filesystem, no minimatch).
 */

import { describe, it, expect } from 'vitest';
import {
  normalizePath,
  detectHallucinatedPath,
  detectCredentialInContent,
  detectCredentialPattern,
  isPathAllowed,
  matchesPattern,
  ALWAYS_DENIED,
  CREDENTIAL_PATTERNS,
  FILE_DENY_PATTERNS,
} from '../scope/shared.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('ALWAYS_DENIED', () => {
  it('includes .env patterns', () => {
    expect(ALWAYS_DENIED).toContain('.env');
    expect(ALWAYS_DENIED).toContain('.env.*');
  });

  it('includes node_modules', () => {
    expect(ALWAYS_DENIED.some(p => p.includes('node_modules'))).toBe(true);
  });

  it('includes .git', () => {
    expect(ALWAYS_DENIED.some(p => p.includes('.git'))).toBe(true);
  });

  it('includes lockfiles', () => {
    expect(ALWAYS_DENIED).toContain('package-lock.json');
  });

  it('includes build output directories', () => {
    expect(ALWAYS_DENIED.some(p => p.includes('dist'))).toBe(true);
    expect(ALWAYS_DENIED.some(p => p.includes('build'))).toBe(true);
    expect(ALWAYS_DENIED.some(p => p.includes('coverage'))).toBe(true);
  });
});

describe('CREDENTIAL_PATTERNS', () => {
  // Build test strings dynamically to avoid triggering gitleaks in pre-commit
  const fake = (parts: string[]) => parts.join('');

  it('matches AWS access keys', () => {
    const awsKey = fake(['AKIA', 'IOSFODNN7EXAMPLE']);
    expect(CREDENTIAL_PATTERNS.some(p => p.test(awsKey))).toBe(true);
  });

  it('matches PEM private keys', () => {
    const pem = fake(['-----BEGIN ', 'RSA PRIVATE KEY-----']);
    expect(CREDENTIAL_PATTERNS.some(p => p.test(pem))).toBe(true);
  });

  it('matches GitHub PATs', () => {
    const ghpat = fake(['ghp_', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghij']);
    expect(CREDENTIAL_PATTERNS.some(p => p.test(ghpat))).toBe(true);
  });

  it('matches OpenAI keys', () => {
    const key = fake(['sk-proj-', 'abcdefghijklmnopqrstuvwxyz012345']);
    expect(CREDENTIAL_PATTERNS.some(p => p.test(key))).toBe(true);
  });

  it('matches hardcoded passwords', () => {
    const pwd = fake(['password = "', 'supersecret123"']);
    expect(CREDENTIAL_PATTERNS.some(p => p.test(pwd))).toBe(true);
  });

  it('matches Slack tokens', () => {
    const token = fake(['xoxb', '-123456789-abcdef']);
    expect(CREDENTIAL_PATTERNS.some(p => p.test(token))).toBe(true);
  });

  it('matches PostgreSQL connection strings', () => {
    const conn = fake(['postgres', 'ql://user:pass@localhost:5432/db']);
    expect(CREDENTIAL_PATTERNS.some(p => p.test(conn))).toBe(true);
  });

  it('matches MongoDB connection strings', () => {
    const conn = fake(['mongodb+srv', '://user:pass@cluster.example.net/db']);
    expect(CREDENTIAL_PATTERNS.some(p => p.test(conn))).toBe(true);
  });

  it('matches MySQL connection strings', () => {
    const conn = fake(['mysql', '://user:pass@localhost:3306/db']);
    expect(CREDENTIAL_PATTERNS.some(p => p.test(conn))).toBe(true);
  });

  it('matches generic secret assignments', () => {
    const secret = fake(['API_KEY', ' = "abc123def456ghi789"']);
    expect(CREDENTIAL_PATTERNS.some(p => p.test(secret))).toBe(true);
  });

  it('does not match normal code', () => {
    const normal = 'const x = 42; console.log("hello world");';
    expect(CREDENTIAL_PATTERNS.some(p => p.test(normal))).toBe(false);
  });
});

describe('FILE_DENY_PATTERNS', () => {
  it('matches .env files', () => {
    expect(FILE_DENY_PATTERNS.some(p => p.test('.env'))).toBe(true);
    expect(FILE_DENY_PATTERNS.some(p => p.test('config/.env'))).toBe(true);
  });

  it('matches .pem files', () => {
    expect(FILE_DENY_PATTERNS.some(p => p.test('server.pem'))).toBe(true);
  });

  it('matches .key files', () => {
    expect(FILE_DENY_PATTERNS.some(p => p.test('private.key'))).toBe(true);
  });

  it('matches files with "credentials" in the name', () => {
    expect(FILE_DENY_PATTERNS.some(p => p.test('credentials.json'))).toBe(true);
    expect(FILE_DENY_PATTERNS.some(p => p.test('aws-credentials'))).toBe(true);
  });

  it('matches files with "secret" in the name', () => {
    expect(FILE_DENY_PATTERNS.some(p => p.test('secret.yaml'))).toBe(true);
    expect(FILE_DENY_PATTERNS.some(p => p.test('client_secret.json'))).toBe(true);
  });

  it('does not match normal source files', () => {
    expect(FILE_DENY_PATTERNS.some(p => p.test('index.ts'))).toBe(false);
    expect(FILE_DENY_PATTERNS.some(p => p.test('package.json'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// normalizePath
// ---------------------------------------------------------------------------

describe('normalizePath', () => {
  it('converts backslashes to forward slashes', () => {
    expect(normalizePath('src\\lib\\index.ts')).toBe('src/lib/index.ts');
  });

  it('removes leading ./', () => {
    expect(normalizePath('./src/index.ts')).toBe('src/index.ts');
  });

  it('collapses multiple slashes', () => {
    expect(normalizePath('src///lib//index.ts')).toBe('src/lib/index.ts');
  });

  it('removes trailing slash', () => {
    expect(normalizePath('src/lib/')).toBe('src/lib');
  });

  it('handles all normalizations together', () => {
    expect(normalizePath('.\\src\\\\lib//index.ts/')).toBe('src/lib/index.ts');
  });

  it('handles empty string', () => {
    expect(normalizePath('')).toBe('');
  });

  it('handles single file name', () => {
    expect(normalizePath('file.ts')).toBe('file.ts');
  });
});

// ---------------------------------------------------------------------------
// detectHallucinatedPath
// ---------------------------------------------------------------------------

describe('detectHallucinatedPath', () => {
  it('detects repeated consecutive segments', () => {
    const result = detectHallucinatedPath('src/src/index.ts');
    expect(result.isHallucinated).toBe(true);
    expect(result.reason).toContain('src/src');
  });

  it('detects repeated segments deeper in path', () => {
    const result = detectHallucinatedPath('packages/core/core/shared.ts');
    expect(result.isHallucinated).toBe(true);
    expect(result.reason).toContain('core/core');
  });

  it('detects double slashes', () => {
    const result = detectHallucinatedPath('src//index.ts');
    expect(result.isHallucinated).toBe(true);
    expect(result.reason).toContain('double slashes');
  });

  it('allows normal paths', () => {
    expect(detectHallucinatedPath('src/lib/index.ts').isHallucinated).toBe(false);
    expect(detectHallucinatedPath('packages/core/src/index.ts').isHallucinated).toBe(false);
  });

  it('allows non-consecutive repeated segments', () => {
    // src appears twice but not consecutively
    expect(detectHallucinatedPath('src/lib/src-utils.ts').isHallucinated).toBe(false);
  });

  it('handles empty path', () => {
    expect(detectHallucinatedPath('').isHallucinated).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// detectCredentialInContent
// ---------------------------------------------------------------------------

describe('detectCredentialInContent', () => {
  // Build test strings dynamically to avoid triggering gitleaks in pre-commit
  const fake = (parts: string[]) => parts.join('');

  it('detects AWS access keys', () => {
    const content = fake(['const key = "', 'AKIA', 'IOSFODNN7EXAMPLE";']);
    const result = detectCredentialInContent(content);
    expect(result).not.toBeNull();
    expect(result).toContain('credential');
  });

  it('detects PEM private keys', () => {
    const content = fake(['-----BEGIN ', 'RSA PRIVATE KEY-----\nMIIEowIBAAK...']);
    expect(detectCredentialInContent(content)).not.toBeNull();
  });

  it('detects GitHub PATs', () => {
    const content = fake(['token: ghp_', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghij']);
    expect(detectCredentialInContent(content)).not.toBeNull();
  });

  it('detects hardcoded passwords', () => {
    const content = fake(['password', ' = "my-super-secret-password"']);
    expect(detectCredentialInContent(content)).not.toBeNull();
  });

  it('detects database connection strings', () => {
    const content = fake(['const db = "postgres', 'ql://admin:pass@db.host:5432/mydb"']);
    expect(detectCredentialInContent(content)).not.toBeNull();
  });

  it('detects generic secret assignments', () => {
    const content = fake(['API_KEY', ' = "a1b2c3d4e5f6g7h8i9j0"']);
    expect(detectCredentialInContent(content)).not.toBeNull();
  });

  it('returns null for clean code', () => {
    const content = `
      const x = 42;
      function hello(name: string) {
        return \`Hello, \${name}!\`;
      }
      export default hello;
    `;
    expect(detectCredentialInContent(content)).toBeNull();
  });

  it('returns null for empty content', () => {
    expect(detectCredentialInContent('')).toBeNull();
  });

  it('detects credentials in multiline content', () => {
    const content = fake([
      '// config\nconst config = {\n  host: "localhost",\n  ',
      'password: "secret123"',
      ',\n  port: 3000,\n};',
    ]);
    expect(detectCredentialInContent(content)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// detectCredentialPattern
// ---------------------------------------------------------------------------

describe('detectCredentialPattern', () => {
  it('detects .env files', () => {
    expect(detectCredentialPattern('.env')).toBe(true);
    expect(detectCredentialPattern('config/.env.local')).toBe(false); // .env.local doesn't end with .env
  });

  it('detects .pem files', () => {
    expect(detectCredentialPattern('certs/server.pem')).toBe(true);
  });

  it('detects .key files', () => {
    expect(detectCredentialPattern('ssl/private.key')).toBe(true);
  });

  it('detects credentials files', () => {
    expect(detectCredentialPattern('credentials.json')).toBe(true);
    expect(detectCredentialPattern('.aws/credentials')).toBe(true);
  });

  it('detects secret files', () => {
    expect(detectCredentialPattern('client_secret.json')).toBe(true);
    expect(detectCredentialPattern('secrets.yaml')).toBe(true);
  });

  it('returns false for normal source files', () => {
    expect(detectCredentialPattern('src/index.ts')).toBe(false);
    expect(detectCredentialPattern('package.json')).toBe(false);
    expect(detectCredentialPattern('README.md')).toBe(false);
    expect(detectCredentialPattern('src/utils/helpers.ts')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isPathAllowed
// ---------------------------------------------------------------------------

describe('isPathAllowed', () => {
  it('allows everything when allowed list is empty and not denied', () => {
    expect(isPathAllowed('src/index.ts', [], [])).toBe(true);
    expect(isPathAllowed('any/path/file.ts', [], [])).toBe(true);
  });

  it('denies paths matching denied patterns', () => {
    expect(isPathAllowed('node_modules/foo/index.js', [], ['node_modules/**'])).toBe(false);
    expect(isPathAllowed('dist/bundle.js', [], ['dist/**'])).toBe(false);
  });

  it('denied takes priority over allowed', () => {
    expect(isPathAllowed('src/secret.key', ['src/**'], ['**/*.key'])).toBe(false);
  });

  it('denies credential files even without explicit deny list', () => {
    // detectCredentialPattern is called in isPathAllowed
    expect(isPathAllowed('credentials.json', ['**'], [])).toBe(false);
    expect(isPathAllowed('server.pem', ['**'], [])).toBe(false);
    expect(isPathAllowed('.env', ['**'], [])).toBe(false);
  });

  it('allows files matching allowed patterns', () => {
    expect(isPathAllowed('src/index.ts', ['src/**'], [])).toBe(true);
    expect(isPathAllowed('src/lib/utils.ts', ['src/**'], [])).toBe(true);
  });

  it('denies files not matching any allowed pattern', () => {
    expect(isPathAllowed('lib/utils.ts', ['src/**'], [])).toBe(false);
    expect(isPathAllowed('test/foo.ts', ['src/**'], [])).toBe(false);
  });

  it('supports multiple allowed patterns', () => {
    const allowed = ['src/**', 'lib/**', 'test/**'];
    expect(isPathAllowed('src/index.ts', allowed, [])).toBe(true);
    expect(isPathAllowed('lib/utils.ts', allowed, [])).toBe(true);
    expect(isPathAllowed('test/foo.ts', allowed, [])).toBe(true);
    expect(isPathAllowed('docs/readme.md', allowed, [])).toBe(false);
  });

  it('normalizes paths before matching', () => {
    expect(isPathAllowed('./src/index.ts', ['src/**'], [])).toBe(true);
    expect(isPathAllowed('src\\lib\\index.ts', ['src/**'], [])).toBe(true);
  });
});
