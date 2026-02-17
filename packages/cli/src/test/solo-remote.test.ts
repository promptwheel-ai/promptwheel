import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { normalizeRemoteUrl, assertPushSafe } from '../lib/solo-remote.js';

// Mock child_process
vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));

describe('normalizeRemoteUrl', () => {
  it('normalizes SSH URL', () => {
    const url = 'git@github.com:org/repo.git';
    expect(normalizeRemoteUrl(url)).toBe('github.com/org/repo');
  });

  it('normalizes HTTPS URL', () => {
    const url = 'https://github.com/org/repo.git';
    expect(normalizeRemoteUrl(url)).toBe('github.com/org/repo');
  });

  it('normalizes HTTP URL', () => {
    const url = 'http://github.com/org/repo.git';
    expect(normalizeRemoteUrl(url)).toBe('github.com/org/repo');
  });

  it('strips trailing .git', () => {
    expect(normalizeRemoteUrl('git@github.com:org/repo.git')).toBe('github.com/org/repo');
    expect(normalizeRemoteUrl('https://github.com/org/repo.git')).toBe('github.com/org/repo');
  });

  it('strips trailing slash', () => {
    expect(normalizeRemoteUrl('https://github.com/org/repo/')).toBe('github.com/org/repo');
    expect(normalizeRemoteUrl('github.com/org/repo/')).toBe('github.com/org/repo');
  });

  it('converts to lowercase', () => {
    expect(normalizeRemoteUrl('git@GitHub.com:Org/Repo.git')).toBe('github.com/org/repo');
    expect(normalizeRemoteUrl('https://GitHub.com/Org/Repo.git')).toBe('github.com/org/repo');
  });

  it('handles SSH URL without .git extension', () => {
    const url = 'git@github.com:org/repo';
    expect(normalizeRemoteUrl(url)).toBe('github.com/org/repo');
  });

  it('handles HTTPS URL without .git extension', () => {
    const url = 'https://github.com/org/repo';
    expect(normalizeRemoteUrl(url)).toBe('github.com/org/repo');
  });

  it('handles GitLab SSH URL', () => {
    const url = 'git@gitlab.com:group/project.git';
    expect(normalizeRemoteUrl(url)).toBe('gitlab.com/group/project');
  });

  it('handles GitLab HTTPS URL', () => {
    const url = 'https://gitlab.com/group/project.git';
    expect(normalizeRemoteUrl(url)).toBe('gitlab.com/group/project');
  });

  it('handles Bitbucket SSH URL', () => {
    const url = 'git@bitbucket.org:team/repo.git';
    expect(normalizeRemoteUrl(url)).toBe('bitbucket.org/team/repo');
  });

  it('handles custom port in HTTPS URL', () => {
    const url = 'https://example.com:8080/org/repo.git';
    expect(normalizeRemoteUrl(url)).toBe('example.com:8080/org/repo');
  });

  it('handles nested repository paths', () => {
    const url = 'https://github.com/org/team/repo.git';
    expect(normalizeRemoteUrl(url)).toBe('github.com/org/team/repo');
  });

  it('trims whitespace', () => {
    expect(normalizeRemoteUrl('  git@github.com:org/repo.git  ')).toBe('github.com/org/repo');
    expect(normalizeRemoteUrl('  https://github.com/org/repo.git  ')).toBe('github.com/org/repo');
  });

  it('handles URLs with multiple trailing slashes', () => {
    expect(normalizeRemoteUrl('https://github.com/org/repo///')).toBe('github.com/org/repo');
  });

  it('handles SSH URLs with different user names', () => {
    expect(normalizeRemoteUrl('custom@github.com:org/repo.git')).toBe('github.com/org/repo');
    expect(normalizeRemoteUrl('deploy@gitlab.com:org/repo.git')).toBe('gitlab.com/org/repo');
  });
});

describe('assertPushSafe', () => {
  let execSyncMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const childProcess = await import('node:child_process');
    execSyncMock = vi.mocked(childProcess.execSync);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('succeeds when current remote matches allowed remote', async () => {
    execSyncMock.mockReturnValue('git@github.com:org/repo.git\n' as any);

    await expect(
      assertPushSafe('/repo', 'git@github.com:org/repo.git')
    ).resolves.toBeUndefined();
  });

  it('succeeds when remotes match after normalization (SSH vs HTTPS)', async () => {
    execSyncMock.mockReturnValue('https://github.com/org/repo.git\n' as any);

    await expect(
      assertPushSafe('/repo', 'git@github.com:org/repo.git')
    ).resolves.toBeUndefined();
  });

  it('succeeds when remotes match after normalization (case insensitive)', async () => {
    execSyncMock.mockReturnValue('git@GitHub.com:Org/Repo.git\n' as any);

    await expect(
      assertPushSafe('/repo', 'git@github.com:org/repo.git')
    ).resolves.toBeUndefined();
  });

  it('throws when current remote does not match allowed remote', async () => {
    execSyncMock.mockReturnValue('git@github.com:different/repo.git\n' as any);

    await expect(
      assertPushSafe('/repo', 'git@github.com:org/repo.git')
    ).rejects.toThrow('Push blocked');
  });

  it('throws with detailed error message on mismatch', async () => {
    execSyncMock.mockReturnValue('git@github.com:different/repo.git\n' as any);

    await expect(
      assertPushSafe('/repo', 'git@github.com:org/repo.git')
    ).rejects.toThrow(/different\/repo/);

    await expect(
      assertPushSafe('/repo', 'git@github.com:org/repo.git')
    ).rejects.toThrow(/org\/repo/);
  });

  it('warns but proceeds when allowedRemote is undefined', async () => {
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(
      assertPushSafe('/repo', undefined)
    ).resolves.toBeUndefined();

    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining('No allowedRemote configured')
    );

    consoleWarnSpy.mockRestore();
  });

  it('passes cwd to execSync', async () => {
    execSyncMock.mockReturnValue('git@github.com:org/repo.git\n' as any);

    await assertPushSafe('/custom/repo/path', 'git@github.com:org/repo.git');

    expect(execSyncMock).toHaveBeenCalledWith(
      'git remote get-url origin',
      expect.objectContaining({ cwd: '/custom/repo/path' })
    );
  });

  it('uses utf-8 encoding for execSync', async () => {
    execSyncMock.mockReturnValue('git@github.com:org/repo.git\n' as any);

    await assertPushSafe('/repo', 'git@github.com:org/repo.git');

    expect(execSyncMock).toHaveBeenCalledWith(
      'git remote get-url origin',
      expect.objectContaining({ encoding: 'utf-8' })
    );
  });

  it('trims whitespace from execSync output', async () => {
    execSyncMock.mockReturnValue('  git@github.com:org/repo.git  \n' as any);

    await expect(
      assertPushSafe('/repo', 'git@github.com:org/repo.git')
    ).resolves.toBeUndefined();
  });

  it('throws when git command fails', async () => {
    execSyncMock.mockImplementation(() => {
      throw new Error('fatal: not a git repository');
    });

    await expect(
      assertPushSafe('/repo', 'git@github.com:org/repo.git')
    ).rejects.toThrow();
  });
});
