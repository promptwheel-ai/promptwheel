/**
 * Daemon forking and PID management.
 *
 * Handles spawning a detached child process, PID file management,
 * and log rotation.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { getPromptwheelDir } from './solo-config.js';

const DAEMON_PID_FILE = 'daemon.pid';
const DAEMON_LOG_FILE = 'daemon.log';
const DAEMON_LOG_ROTATED = 'daemon.log.1';

// ── PID management ───────────────────────────────────────────────────────────

export function readDaemonPid(repoRoot: string): number | null {
  const pidPath = path.join(getPromptwheelDir(repoRoot), DAEMON_PID_FILE);
  try {
    if (!fs.existsSync(pidPath)) return null;
    const pid = parseInt(fs.readFileSync(pidPath, 'utf-8').trim(), 10);
    return isNaN(pid) || pid <= 0 ? null : pid;
  } catch {
    return null;
  }
}

export function writeDaemonPid(repoRoot: string, pid: number): void {
  const dir = getPromptwheelDir(repoRoot);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, DAEMON_PID_FILE), String(pid));
}

export function removeDaemonPid(repoRoot: string): void {
  const pidPath = path.join(getPromptwheelDir(repoRoot), DAEMON_PID_FILE);
  try {
    if (fs.existsSync(pidPath)) fs.unlinkSync(pidPath);
  } catch { /* non-fatal */ }
}

/**
 * Check if a daemon process is alive via signal 0.
 */
export function isDaemonRunning(repoRoot: string): boolean {
  const pid = readDaemonPid(repoRoot);
  if (pid === null) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    // Process dead — stale PID file
    removeDaemonPid(repoRoot);
    return false;
  }
}

// ── Fork ─────────────────────────────────────────────────────────────────────

export interface ForkOptions {
  interval?: number;
  formula?: string;
  scope?: string;
}

/**
 * Fork a detached daemon child process.
 * The child runs `promptwheel solo daemon __run` with the same env.
 * Returns the child PID.
 */
export function forkDaemon(repoRoot: string, options: ForkOptions): number {
  const dir = getPromptwheelDir(repoRoot);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const logPath = path.join(dir, DAEMON_LOG_FILE);
  const logFd = fs.openSync(logPath, 'a');

  // Build args for the child
  const args = ['solo', 'daemon', '__run'];
  if (options.interval) args.push('--interval', String(options.interval));
  if (options.formula) args.push('--formula', options.formula);
  if (options.scope) args.push('--scope', options.scope);

  // Find the promptwheel binary — use the same entry point that's running now
  const binPath = process.argv[1];

  const child = spawn(process.execPath, [binPath, ...args], {
    cwd: repoRoot,
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env },
  });

  child.unref();
  fs.closeSync(logFd);

  const pid = child.pid!;
  writeDaemonPid(repoRoot, pid);
  return pid;
}

// ── Stop ─────────────────────────────────────────────────────────────────────

/**
 * Stop the daemon process gracefully.
 * Sends SIGTERM, waits up to 10s, then SIGKILL as last resort.
 */
export async function stopDaemon(repoRoot: string): Promise<boolean> {
  const pid = readDaemonPid(repoRoot);
  if (pid === null) return false;

  try {
    // Check if alive
    process.kill(pid, 0);
  } catch {
    removeDaemonPid(repoRoot);
    return false;
  }

  // Send SIGTERM
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    removeDaemonPid(repoRoot);
    return false;
  }

  // Wait for process to exit (poll every 500ms, up to 10s)
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 500));
    try {
      process.kill(pid, 0);
    } catch {
      // Process is gone
      removeDaemonPid(repoRoot);
      return true;
    }
  }

  // Last resort: SIGKILL
  try {
    process.kill(pid, 'SIGKILL');
  } catch { /* already dead */ }
  removeDaemonPid(repoRoot);
  return true;
}

// ── Log rotation ─────────────────────────────────────────────────────────────

/**
 * Rotate daemon.log when it exceeds maxSizeMB.
 * Renames current log to daemon.log.1, starts fresh.
 */
export function rotateDaemonLog(repoRoot: string, maxSizeMB: number): void {
  const dir = getPromptwheelDir(repoRoot);
  const logPath = path.join(dir, DAEMON_LOG_FILE);

  try {
    if (!fs.existsSync(logPath)) return;
    const stats = fs.statSync(logPath);
    if (stats.size < maxSizeMB * 1024 * 1024) return;

    const rotatedPath = path.join(dir, DAEMON_LOG_ROTATED);
    // Overwrite any existing rotated log
    if (fs.existsSync(rotatedPath)) fs.unlinkSync(rotatedPath);
    fs.renameSync(logPath, rotatedPath);
  } catch { /* non-fatal */ }
}

/**
 * Get the daemon log file path.
 */
export function getDaemonLogPath(repoRoot: string): string {
  return path.join(getPromptwheelDir(repoRoot), DAEMON_LOG_FILE);
}
