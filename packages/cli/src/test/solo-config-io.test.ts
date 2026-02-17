import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

vi.mock('node:fs');
vi.mock('child_process', () => ({
  execSync: vi.fn(() => 'https://github.com/example/repo.git\n'),
}));

const mockedFs = vi.mocked(fs);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('isInitialized', () => {
  it('returns true when config.json exists', async () => {
    const { isInitialized } = await import('../lib/solo-config.js');
    mockedFs.existsSync.mockReturnValue(true);
    expect(isInitialized('/repo')).toBe(true);
    expect(mockedFs.existsSync).toHaveBeenCalledWith(
      path.join('/repo', '.promptwheel', 'config.json'),
    );
  });

  it('returns false when config.json does not exist', async () => {
    const { isInitialized } = await import('../lib/solo-config.js');
    mockedFs.existsSync.mockReturnValue(false);
    expect(isInitialized('/repo')).toBe(false);
  });
});

describe('detectQaCommands', () => {
  it('returns empty array when package.json does not exist', async () => {
    const { detectQaCommands } = await import('../lib/solo-config.js');
    mockedFs.existsSync.mockReturnValue(false);
    expect(detectQaCommands('/repo')).toEqual([]);
  });

  it('detects test script', async () => {
    const { detectQaCommands } = await import('../lib/solo-config.js');
    mockedFs.existsSync.mockImplementation((p: fs.PathLike) => String(p).endsWith('package.json'));
    mockedFs.readFileSync.mockReturnValue(
      JSON.stringify({ scripts: { test: 'vitest' } }),
    );
    const cmds = detectQaCommands('/repo');
    expect(cmds).toEqual([
      { name: 'test', cmd: 'npm run test', source: 'package.json' },
    ]);
  });

  it('detects lint script', async () => {
    const { detectQaCommands } = await import('../lib/solo-config.js');
    mockedFs.existsSync.mockImplementation((p: fs.PathLike) => String(p).endsWith('package.json'));
    mockedFs.readFileSync.mockReturnValue(
      JSON.stringify({ scripts: { lint: 'eslint .' } }),
    );
    const cmds = detectQaCommands('/repo');
    expect(cmds).toEqual([
      { name: 'lint', cmd: 'npm run lint', source: 'package.json' },
    ]);
  });

  it('detects typecheck script', async () => {
    const { detectQaCommands } = await import('../lib/solo-config.js');
    mockedFs.existsSync.mockImplementation((p: fs.PathLike) => String(p).endsWith('package.json'));
    mockedFs.readFileSync.mockReturnValue(
      JSON.stringify({ scripts: { typecheck: 'tsc --noEmit' } }),
    );
    const cmds = detectQaCommands('/repo');
    expect(cmds).toEqual([
      { name: 'typecheck', cmd: 'npm run typecheck', source: 'package.json' },
    ]);
  });

  it('detects build script', async () => {
    const { detectQaCommands } = await import('../lib/solo-config.js');
    mockedFs.existsSync.mockImplementation((p: fs.PathLike) => String(p).endsWith('package.json'));
    mockedFs.readFileSync.mockReturnValue(
      JSON.stringify({ scripts: { build: 'tsc' } }),
    );
    const cmds = detectQaCommands('/repo');
    expect(cmds).toEqual([
      { name: 'build', cmd: 'npm run build', source: 'package.json' },
    ]);
  });

  it('returns empty on JSON parse error', async () => {
    const { detectQaCommands } = await import('../lib/solo-config.js');
    mockedFs.existsSync.mockImplementation((p: fs.PathLike) => String(p).endsWith('package.json'));
    mockedFs.readFileSync.mockReturnValue('not json');
    expect(detectQaCommands('/repo')).toEqual([]);
  });

  it('sorts by priority (typecheck before test)', async () => {
    const { detectQaCommands } = await import('../lib/solo-config.js');
    mockedFs.existsSync.mockImplementation((p: fs.PathLike) => String(p).endsWith('package.json'));
    mockedFs.readFileSync.mockReturnValue(
      JSON.stringify({ scripts: { test: 'vitest', typecheck: 'tsc' } }),
    );
    const cmds = detectQaCommands('/repo');
    expect(cmds[0].name).toBe('typecheck');
    expect(cmds[1].name).toBe('test');
  });

  it('does not add duplicate scripts', async () => {
    const { detectQaCommands } = await import('../lib/solo-config.js');
    mockedFs.existsSync.mockImplementation((p: fs.PathLike) => String(p).endsWith('package.json'));
    mockedFs.readFileSync.mockReturnValue(
      JSON.stringify({ scripts: { lint: 'eslint .', 'lint:fix': 'eslint . --fix' } }),
    );
    const cmds = detectQaCommands('/repo');
    const lintCmds = cmds.filter((c) => c.cmd.includes('lint'));
    // lint and lint:fix are different script names, both should be present
    expect(lintCmds.length).toBe(2);
    const names = lintCmds.map((c) => c.cmd);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('loadConfig', () => {
  it('returns null when config does not exist', async () => {
    const { loadConfig } = await import('../lib/solo-config.js');
    mockedFs.existsSync.mockReturnValue(false);
    expect(loadConfig('/repo')).toBeNull();
  });

  it('returns parsed config when config exists', async () => {
    const { loadConfig } = await import('../lib/solo-config.js');
    const config = { version: 1, repoRoot: '/repo', createdAt: '2025-01-01', dbPath: '/repo/.promptwheel/state.sqlite' };
    // Only return true for config.json path; false for setup-detection paths
    // (package.json, pnpm-lock.yaml, etc.) so detectSetupCommand doesn't inject a setup field
    mockedFs.existsSync.mockImplementation((p: fs.PathLike) => {
      return String(p).includes('config.json');
    });
    mockedFs.readFileSync.mockReturnValue(JSON.stringify(config));
    expect(loadConfig('/repo')).toEqual(config);
  });

  it('returns SoloConfig with expected shape', async () => {
    const { loadConfig } = await import('../lib/solo-config.js');
    const config = {
      version: 1,
      repoRoot: '/repo',
      createdAt: '2025-01-01T00:00:00.000Z',
      dbPath: '/repo/.promptwheel/state.sqlite',
      qa: { commands: [{ name: 'test', cmd: 'npm run test' }] },
    };
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(JSON.stringify(config));
    const result = loadConfig('/repo');
    expect(result).toHaveProperty('version');
    expect(result).toHaveProperty('repoRoot');
    expect(result).toHaveProperty('createdAt');
    expect(result).toHaveProperty('dbPath');
    expect(result).toHaveProperty('qa');
    expect(result!.qa!.commands).toHaveLength(1);
  });
});

describe('initSolo', () => {
  it('creates .promptwheel directory', async () => {
    const { initSolo } = await import('../lib/solo-config.js');
    mockedFs.existsSync.mockImplementation((p: fs.PathLike) => {
      const s = String(p);
      // .promptwheel dir doesn't exist, package.json doesn't exist, .gitignore doesn't exist
      return false;
    });
    mockedFs.mkdirSync.mockReturnValue(undefined);
    mockedFs.writeFileSync.mockReturnValue(undefined);

    await initSolo('/repo');
    expect(mockedFs.mkdirSync).toHaveBeenCalledWith(
      path.join('/repo', '.promptwheel'),
      { recursive: true },
    );
  });

  it('writes config.json', async () => {
    const { initSolo } = await import('../lib/solo-config.js');
    mockedFs.existsSync.mockReturnValue(false);
    mockedFs.mkdirSync.mockReturnValue(undefined);
    mockedFs.writeFileSync.mockReturnValue(undefined);

    const { config } = await initSolo('/repo');
    expect(mockedFs.writeFileSync).toHaveBeenCalled();
    const writeCall = mockedFs.writeFileSync.mock.calls[0];
    expect(String(writeCall[0])).toContain('config.json');
    expect(config.version).toBe(1);
    expect(config.repoRoot).toBe('/repo');
  });

  it('detects QA commands', async () => {
    const { initSolo } = await import('../lib/solo-config.js');
    mockedFs.existsSync.mockImplementation((p: fs.PathLike) => {
      const s = String(p);
      if (s.endsWith('package.json')) return true;
      return false;
    });
    mockedFs.readFileSync.mockReturnValue(
      JSON.stringify({ scripts: { test: 'vitest', lint: 'eslint' } }),
    );
    mockedFs.mkdirSync.mockReturnValue(undefined);
    mockedFs.writeFileSync.mockReturnValue(undefined);

    const { detectedQa } = await initSolo('/repo');
    expect(detectedQa.length).toBeGreaterThan(0);
  });

  it('adds .promptwheel to .gitignore if not present', async () => {
    const { initSolo } = await import('../lib/solo-config.js');
    mockedFs.existsSync.mockImplementation((p: fs.PathLike) => {
      const s = String(p);
      if (s.endsWith('.gitignore')) return true;
      return false;
    });
    mockedFs.readFileSync.mockReturnValue('node_modules/\n');
    mockedFs.mkdirSync.mockReturnValue(undefined);
    mockedFs.writeFileSync.mockReturnValue(undefined);
    mockedFs.appendFileSync.mockReturnValue(undefined);

    await initSolo('/repo');
    expect(mockedFs.appendFileSync).toHaveBeenCalledWith(
      path.join('/repo', '.gitignore'),
      expect.stringContaining('.promptwheel'),
    );
  });

  it('does not add to .gitignore if already present', async () => {
    const { initSolo } = await import('../lib/solo-config.js');
    mockedFs.existsSync.mockImplementation((p: fs.PathLike) => {
      const s = String(p);
      if (s.endsWith('.gitignore')) return true;
      return false;
    });
    mockedFs.readFileSync.mockReturnValue('node_modules/\n.promptwheel/\n');
    mockedFs.mkdirSync.mockReturnValue(undefined);
    mockedFs.writeFileSync.mockReturnValue(undefined);

    await initSolo('/repo');
    expect(mockedFs.appendFileSync).not.toHaveBeenCalled();
  });
});
