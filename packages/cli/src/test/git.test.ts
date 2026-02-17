/**
 * Tests for git service implementation
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { createGitService } from '../lib/git.js';

// Mock node modules
vi.mock('node:fs');
vi.mock('node:child_process');

const mockFs = vi.mocked(fs);
const mockExecSync = vi.mocked(execSync);

describe('GitService', () => {
  const gitService = createGitService();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe('findRepoRoot', () => {
    it('returns the directory containing .git', async () => {
      // Simulate /home/user/project/.git exists
      mockFs.existsSync.mockImplementation((p) => {
        return p === '/home/user/project/.git';
      });

      const result = await gitService.findRepoRoot('/home/user/project/src/lib');

      expect(result).toBe('/home/user/project');
    });

    it('traverses up directories to find .git', async () => {
      // Simulate .git exists at /home/user/project
      mockFs.existsSync.mockImplementation((p) => {
        return p === '/home/user/project/.git';
      });

      const result = await gitService.findRepoRoot('/home/user/project/src/deep/nested/dir');

      expect(result).toBe('/home/user/project');
      // Verify it checked multiple directories
      expect(mockFs.existsSync).toHaveBeenCalled();
    });

    it('returns null when no .git directory is found', async () => {
      // No .git directory exists anywhere
      mockFs.existsSync.mockReturnValue(false);

      const result = await gitService.findRepoRoot('/home/user/not-a-repo');

      expect(result).toBeNull();
    });

    it('returns null when starting from root with no .git', async () => {
      mockFs.existsSync.mockReturnValue(false);

      const result = await gitService.findRepoRoot('/');

      expect(result).toBeNull();
    });

    it('handles relative paths by resolving them', async () => {
      const cwd = process.cwd();
      mockFs.existsSync.mockImplementation((p) => {
        return p === path.join(cwd, '.git');
      });

      const result = await gitService.findRepoRoot('.');

      expect(result).toBe(cwd);
    });

    it('returns root directly if .git is at root', async () => {
      mockFs.existsSync.mockImplementation((p) => {
        return p === '/project/.git';
      });

      const result = await gitService.findRepoRoot('/project');

      expect(result).toBe('/project');
    });
  });

  describe('getRemoteUrl', () => {
    it('returns the origin URL when available', async () => {
      mockExecSync.mockReturnValue('https://github.com/user/repo.git\n');

      const result = await gitService.getRemoteUrl('/home/user/project');

      expect(result).toBe('https://github.com/user/repo.git');
      expect(mockExecSync).toHaveBeenCalledWith('git remote get-url origin', {
        cwd: '/home/user/project',
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    });

    it('returns null when origin remote does not exist', async () => {
      mockExecSync.mockImplementation(() => {
        throw new Error('fatal: No such remote "origin"');
      });

      const result = await gitService.getRemoteUrl('/home/user/project');

      expect(result).toBeNull();
    });

    it('returns null when git command fails', async () => {
      mockExecSync.mockImplementation(() => {
        throw new Error('git command failed');
      });

      const result = await gitService.getRemoteUrl('/home/user/project');

      expect(result).toBeNull();
    });

    it('returns null when git is not available', async () => {
      mockExecSync.mockImplementation(() => {
        throw new Error('command not found: git');
      });

      const result = await gitService.getRemoteUrl('/home/user/project');

      expect(result).toBeNull();
    });

    it('returns null for empty URL response', async () => {
      mockExecSync.mockReturnValue('   \n');

      const result = await gitService.getRemoteUrl('/home/user/project');

      expect(result).toBeNull();
    });

    it('trims whitespace from URL', async () => {
      mockExecSync.mockReturnValue('  git@github.com:user/repo.git  \n');

      const result = await gitService.getRemoteUrl('/home/user/project');

      expect(result).toBe('git@github.com:user/repo.git');
    });

    it('handles SSH URLs', async () => {
      mockExecSync.mockReturnValue('git@github.com:user/repo.git\n');

      const result = await gitService.getRemoteUrl('/home/user/project');

      expect(result).toBe('git@github.com:user/repo.git');
    });
  });

  describe('getProjectId', () => {
    it('generates deterministic ID from remote URL', () => {
      const id1 = gitService.getProjectId('/home/user/project', 'https://github.com/user/repo.git');
      const id2 = gitService.getProjectId('/home/user/project', 'https://github.com/user/repo.git');

      expect(id1).toBe(id2);
      expect(id1).toMatch(/^proj_[a-z0-9]+$/);
    });

    it('uses repoRoot when remoteUrl is null', () => {
      const id1 = gitService.getProjectId('/home/user/project', null);
      const id2 = gitService.getProjectId('/home/user/project', null);

      expect(id1).toBe(id2);
      expect(id1).toMatch(/^proj_[a-z0-9]+$/);
    });

    it('generates different IDs for different URLs', () => {
      const id1 = gitService.getProjectId('/project', 'https://github.com/user/repo1.git');
      const id2 = gitService.getProjectId('/project', 'https://github.com/user/repo2.git');

      expect(id1).not.toBe(id2);
    });

    it('generates different IDs for different repo roots when no URL', () => {
      const id1 = gitService.getProjectId('/home/user/project1', null);
      const id2 = gitService.getProjectId('/home/user/project2', null);

      expect(id1).not.toBe(id2);
    });

    it('handles special characters in URLs', () => {
      const url = 'https://github.com/user/repo-with-special_chars.123.git';
      const id = gitService.getProjectId('/project', url);

      expect(id).toMatch(/^proj_[a-z0-9]+$/);
      // Verify it's deterministic
      expect(id).toBe(gitService.getProjectId('/project', url));
    });

    it('handles very long URLs', () => {
      const longUrl = 'https://github.com/' + 'a'.repeat(1000) + '/repo.git';
      const id = gitService.getProjectId('/project', longUrl);

      expect(id).toMatch(/^proj_[a-z0-9]+$/);
      // Verify it's deterministic
      expect(id).toBe(gitService.getProjectId('/project', longUrl));
    });

    it('handles empty string URL by using repo root', () => {
      // Empty string is falsy, so it should fall back to repoRoot
      const idWithEmpty = gitService.getProjectId('/home/user/project', '');
      const idWithNull = gitService.getProjectId('/home/user/project', null);

      // Both should use repoRoot since '' is falsy
      expect(idWithEmpty).toBe(idWithNull);
    });

    it('handles URLs with unicode characters', () => {
      const url = 'https://github.com/user/репозиторий.git';
      const id = gitService.getProjectId('/project', url);

      expect(id).toMatch(/^proj_[a-z0-9]+$/);
      // Verify it's deterministic
      expect(id).toBe(gitService.getProjectId('/project', url));
    });

    it('handles paths with unicode characters', () => {
      const path = '/home/пользователь/проект';
      const id = gitService.getProjectId(path, null);

      expect(id).toMatch(/^proj_[a-z0-9]+$/);
      // Verify it's deterministic
      expect(id).toBe(gitService.getProjectId(path, null));
    });

    it('prefers remote URL over repo root when both provided', () => {
      const idWithUrl = gitService.getProjectId('/different/path', 'https://github.com/user/repo.git');
      const idWithSameUrl = gitService.getProjectId('/another/path', 'https://github.com/user/repo.git');

      // Same URL should produce same ID regardless of local path
      expect(idWithUrl).toBe(idWithSameUrl);
    });

    it('handles URLs with query strings and fragments', () => {
      const url = 'https://gitlab.com/user/repo.git?ref=main#readme';
      const id = gitService.getProjectId('/project', url);

      expect(id).toMatch(/^proj_[a-z0-9]+$/);
      expect(id).toBe(gitService.getProjectId('/project', url));
    });

    it('generates non-empty ID for minimal inputs', () => {
      const id = gitService.getProjectId('/', null);

      expect(id).toMatch(/^proj_[a-z0-9]+$/);
      expect(id.length).toBeGreaterThan(5); // proj_ + at least 1 char
    });
  });

  describe('createGitService', () => {
    it('returns an object with all required methods', () => {
      const service = createGitService();

      expect(typeof service.findRepoRoot).toBe('function');
      expect(typeof service.getRemoteUrl).toBe('function');
      expect(typeof service.getProjectId).toBe('function');
    });

    it('creates independent instances', () => {
      const service1 = createGitService();
      const service2 = createGitService();

      // Both should work independently
      expect(service1.getProjectId('/path', null)).toBe(service2.getProjectId('/path', null));
    });
  });
});
