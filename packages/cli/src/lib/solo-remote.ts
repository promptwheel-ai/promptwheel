/**
 * Push safety — remote URL normalization and push-time assertion.
 */

import { execSync } from 'node:child_process';

/**
 * Normalize a git remote URL to a canonical form: `github.com/org/repo`
 * Handles SSH (`git@github.com:org/repo.git`) and HTTPS (`https://github.com/org/repo.git`).
 */
export function normalizeRemoteUrl(url: string): string {
  let u = url.trim();

  // SSH: git@github.com:org/repo.git → github.com/org/repo
  const sshMatch = u.match(/^[\w-]+@([^:]+):(.+)$/);
  if (sshMatch) {
    u = `${sshMatch[1]}/${sshMatch[2]}`;
  } else {
    // HTTPS: https://github.com/org/repo.git → github.com/org/repo
    // eslint-disable-next-line security/detect-unsafe-regex
    const httpsMatch = u.match(/^https?:\/\/([^/]+)(\/.*)?$/i);
    if (httpsMatch) {
      u = `${httpsMatch[1]}${httpsMatch[2] ?? ''}`;
    }
  }

  // Strip trailing .git
  u = u.replace(/\.git$/, '');
  // Strip trailing slash
  u = u.replace(/\/+$/, '');

  return u.toLowerCase();
}

/**
 * Assert that the current origin matches the allowed remote recorded at init time.
 * Throws on mismatch. If `allowedRemote` is undefined, logs a warning but proceeds (backward compat).
 */
export async function assertPushSafe(cwd: string, allowedRemote: string | undefined): Promise<void> {
  if (allowedRemote === undefined) {
    console.warn('[push-safety] No allowedRemote configured — skipping push guard. Run "promptwheel solo init --force" to set one.');
    return;
  }

  const currentRemote = execSync('git remote get-url origin', { cwd, encoding: 'utf-8' }).trim();
  const normalizedCurrent = normalizeRemoteUrl(currentRemote);
  const normalizedAllowed = normalizeRemoteUrl(allowedRemote);

  if (normalizedCurrent !== normalizedAllowed) {
    throw new Error(
      `Push blocked: origin "${currentRemote}" (normalized: ${normalizedCurrent}) does not match ` +
      `allowed remote "${allowedRemote}" (normalized: ${normalizedAllowed}). ` +
      'Re-run "promptwheel solo init --force" if this is intentional.'
    );
  }
}
