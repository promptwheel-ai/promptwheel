/**
 * Update checker — prompts user when a new version is available.
 *
 * Similar to Claude Code and Codex CLI update notifications.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawn } from 'node:child_process';
import chalk from 'chalk';

const PACKAGE_NAME = '@promptwheel/cli';
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours
const CACHE_FILE = path.join(os.homedir(), '.promptwheel', 'update-check.json');

interface UpdateCache {
  lastCheck: number;
  latestVersion: string | null;
  dismissed: string | null; // Version the user dismissed
}

function loadCache(): UpdateCache {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    }
  } catch {
    // Ignore
  }
  return { lastCheck: 0, latestVersion: null, dismissed: null };
}

function saveCache(cache: UpdateCache): void {
  try {
    const dir = path.dirname(CACHE_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
  } catch {
    // Non-fatal
  }
}

/**
 * Fetch the latest version from npm registry.
 */
async function fetchLatestVersion(): Promise<string | null> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(null), 5000);

    // Use npm view to get the latest version
    const proc = spawn('npm', ['view', PACKAGE_NAME, 'version'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    });

    let output = '';
    proc.stdout?.on('data', (data) => {
      output += data.toString();
    });

    proc.on('close', (code) => {
      clearTimeout(timeout);
      if (code === 0 && output.trim()) {
        resolve(output.trim());
      } else {
        resolve(null);
      }
    });

    proc.on('error', () => {
      clearTimeout(timeout);
      resolve(null);
    });
  });
}

/**
 * Compare semver versions. Returns:
 *  -1 if a < b
 *   0 if a == b
 *   1 if a > b
 */
function compareVersions(a: string, b: string): number {
  const partsA = a.replace(/^v/, '').split('.').map(Number);
  const partsB = b.replace(/^v/, '').split('.').map(Number);

  for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
    const numA = partsA[i] ?? 0;
    const numB = partsB[i] ?? 0;
    if (numA < numB) return -1;
    if (numA > numB) return 1;
  }
  return 0;
}

/**
 * Check if an update is available. Returns the latest version if update needed.
 * Uses caching to avoid hitting npm on every invocation.
 */
export async function checkForUpdate(currentVersion: string): Promise<string | null> {
  const cache = loadCache();
  const now = Date.now();

  // Use cached value if recent enough
  if (now - cache.lastCheck < CHECK_INTERVAL_MS && cache.latestVersion) {
    if (compareVersions(cache.latestVersion, currentVersion) > 0) {
      // Don't notify if user dismissed this version
      if (cache.dismissed === cache.latestVersion) {
        return null;
      }
      return cache.latestVersion;
    }
    return null;
  }

  // Fetch from npm
  const latestVersion = await fetchLatestVersion();

  // Update cache
  cache.lastCheck = now;
  cache.latestVersion = latestVersion;
  saveCache(cache);

  if (latestVersion && compareVersions(latestVersion, currentVersion) > 0) {
    // Don't notify if user dismissed this version
    if (cache.dismissed === latestVersion) {
      return null;
    }
    return latestVersion;
  }

  return null;
}

/**
 * Dismiss update notification for a specific version.
 */
export function dismissUpdate(version: string): void {
  const cache = loadCache();
  cache.dismissed = version;
  saveCache(cache);
}

/**
 * Print update notification banner.
 */
export function printUpdateNotification(currentVersion: string, latestVersion: string): void {
  console.log();
  console.log(chalk.yellow('┌─────────────────────────────────────────────────────┐'));
  console.log(chalk.yellow('│') + chalk.bold('  Update available! ') + chalk.gray(`${currentVersion} → `) + chalk.green(latestVersion) + chalk.yellow('                │'));
  console.log(chalk.yellow('│') + chalk.gray('  Run ') + chalk.cyan('npm install -g @promptwheel/cli') + chalk.gray(' to update') + chalk.yellow('    │'));
  console.log(chalk.yellow('│') + chalk.gray('  Or:  ') + chalk.cyan('promptwheel update') + chalk.yellow('                            │'));
  console.log(chalk.yellow('└─────────────────────────────────────────────────────┘'));
  console.log();
}

/**
 * Run the self-update command.
 */
export async function runSelfUpdate(): Promise<boolean> {
  console.log(chalk.cyan('Updating @promptwheel/cli...'));
  console.log();

  return new Promise((resolve) => {
    const proc = spawn('npm', ['install', '-g', PACKAGE_NAME], {
      stdio: 'inherit',
    });

    proc.on('close', (code) => {
      if (code === 0) {
        console.log();
        console.log(chalk.green('✓ Update complete!'));
        resolve(true);
      } else {
        console.log();
        console.log(chalk.red('✗ Update failed. Try running manually:'));
        console.log(chalk.gray(`  npm install -g ${PACKAGE_NAME}`));
        resolve(false);
      }
    });

    proc.on('error', (err) => {
      console.log();
      console.log(chalk.red(`✗ Update failed: ${err.message}`));
      console.log(chalk.gray(`  Try running manually: npm install -g ${PACKAGE_NAME}`));
      resolve(false);
    });
  });
}

/**
 * Check for updates in the background (non-blocking).
 * Returns a promise that resolves to the latest version if available.
 */
export function checkForUpdateInBackground(currentVersion: string): Promise<string | null> {
  // Run check in background, don't block CLI startup
  return checkForUpdate(currentVersion).catch(() => null);
}
