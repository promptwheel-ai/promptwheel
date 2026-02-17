/**
 * Daemon mode: types, config, pure functions, and main loop.
 *
 * The daemon wraps the existing auto mode — each wake cycle calls
 * runAutoMode() with bounded cycles. Between cycles, the session lock
 * is released so manual `promptwheel` runs can proceed.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { getPromptwheelDir } from './solo-config.js';
import { acquireSessionLock, releaseSessionLock } from './retention.js';
import { rotateDaemonLog, removeDaemonPid } from './daemon-fork.js';
import { notifyAll, type SessionNotification } from './daemon-notifier.js';
import { runAutoMode } from './solo-auto.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface NotificationTarget {
  type: 'webhook' | 'desktop';
  url?: string;
  template?: 'slack' | 'discord' | 'telegram' | 'generic';
  headers?: Record<string, string>;
}

export interface DaemonConfig {
  pollIntervalMinutes: number;
  cyclesPerWake: number;
  quietHours?: {
    start: string; // "22:00" 24h format
    end: string;   // "06:00"
    policy: 'pause' | 'boost';
  };
  notifications: NotificationTarget[];
  maxLogSizeMB: number;
  formula?: string;
  scope?: string;
}

export interface DaemonState {
  startedAt: number;
  lastWakeAt: number;
  lastTrigger: 'timer' | 'commits' | 'manual';
  totalWakes: number;
  totalCyclesCompleted: number;
  totalTicketsCompleted: number;
  totalTicketsFailed: number;
  currentInterval: number; // ms
  consecutiveNoWorkCycles: number;
}

export const DEFAULT_DAEMON_CONFIG: DaemonConfig = {
  pollIntervalMinutes: 30,
  cyclesPerWake: 3,
  notifications: [],
  maxLogSizeMB: 10,
};

// ── Wake metrics (written by finalize, read by daemon loop for notifications)
// ---------------------------------------------------------------------------

export interface DaemonWakeMetrics {
  cyclesCompleted: number;
  ticketsCompleted: number;
  ticketsFailed: number;
  prUrls: string[];
  reportPath?: string;
}

const WAKE_METRICS_FILE = 'daemon-wake-metrics.json';

export function writeDaemonWakeMetrics(repoRoot: string, metrics: DaemonWakeMetrics): void {
  const dir = getPromptwheelDir(repoRoot);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, WAKE_METRICS_FILE), JSON.stringify(metrics, null, 2));
}

export function readDaemonWakeMetrics(repoRoot: string): DaemonWakeMetrics | null {
  const filePath = path.join(getPromptwheelDir(repoRoot), WAKE_METRICS_FILE);
  try {
    if (!fs.existsSync(filePath)) return null;
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    // Clean up after reading
    fs.unlinkSync(filePath);
    return data;
  } catch {
    return null;
  }
}

// ── Pure functions ───────────────────────────────────────────────────────────

/**
 * Compute adaptive polling interval based on recent activity.
 *
 * - Work done + new commits → base * 0.5
 * - New commits but no proposals → base * 1.0
 * - No new commits → base * 1.5
 * - Quiet hours with boost → base * 0.25
 * - Floor: 5 minutes. Ceiling: base * 3.
 */
export function computeAdaptiveInterval(
  state: DaemonState,
  config: DaemonConfig,
  context: { hadWork: boolean; hadNewCommits: boolean; isQuietBoost: boolean },
): number {
  const baseMs = config.pollIntervalMinutes * 60_000;
  const floorMs = 5 * 60_000;
  const ceilingMs = baseMs * 3;

  let multiplier: number;

  if (context.isQuietBoost) {
    multiplier = 0.25;
  } else if (context.hadWork && context.hadNewCommits) {
    multiplier = 0.5;
  } else if (context.hadNewCommits) {
    multiplier = 1.0;
  } else {
    // No new commits — lengthen based on consecutive idle cycles
    multiplier = Math.min(1.5 + state.consecutiveNoWorkCycles * 0.25, 3.0);
  }

  return Math.max(floorMs, Math.min(Math.round(baseMs * multiplier), ceilingMs));
}

/**
 * Check if current time falls within the quiet hours window.
 * Handles midnight crossing (e.g. start=22:00, end=06:00).
 */
export function isInQuietHours(config: DaemonConfig, now?: Date): boolean {
  if (!config.quietHours) return false;

  const d = now ?? new Date();
  const currentMinutes = d.getHours() * 60 + d.getMinutes();

  const [startH, startM] = config.quietHours.start.split(':').map(Number);
  const [endH, endM] = config.quietHours.end.split(':').map(Number);
  const startMinutes = startH * 60 + startM;
  const endMinutes = endH * 60 + endM;

  if (startMinutes <= endMinutes) {
    // Same-day window (e.g. 09:00 – 17:00)
    return currentMinutes >= startMinutes && currentMinutes < endMinutes;
  } else {
    // Midnight-crossing window (e.g. 22:00 – 06:00)
    return currentMinutes >= startMinutes || currentMinutes < endMinutes;
  }
}

// ── State persistence ────────────────────────────────────────────────────────

const DAEMON_STATE_FILE = 'daemon-state.json';

export function readDaemonState(repoRoot: string): DaemonState | null {
  const filePath = path.join(getPromptwheelDir(repoRoot), DAEMON_STATE_FILE);
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

export function writeDaemonState(repoRoot: string, state: DaemonState): void {
  const dir = getPromptwheelDir(repoRoot);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, DAEMON_STATE_FILE),
    JSON.stringify(state, null, 2),
  );
}

export function createInitialDaemonState(config: DaemonConfig): DaemonState {
  return {
    startedAt: Date.now(),
    lastWakeAt: 0,
    lastTrigger: 'timer',
    totalWakes: 0,
    totalCyclesCompleted: 0,
    totalTicketsCompleted: 0,
    totalTicketsFailed: 0,
    currentInterval: config.pollIntervalMinutes * 60_000,
    consecutiveNoWorkCycles: 0,
  };
}

// ── Trigger check ────────────────────────────────────────────────────────────

interface TriggerResult {
  shouldWake: boolean;
  trigger: 'timer' | 'commits';
  hadNewCommits: boolean;
}

function checkTrigger(repoRoot: string, state: DaemonState): TriggerResult {
  const now = Date.now();
  const timerExpired = state.lastWakeAt === 0 || (now - state.lastWakeAt) >= state.currentInterval;

  // Check for new commits since last wake
  let hadNewCommits = false;
  if (state.lastWakeAt > 0) {
    try {
      const since = new Date(state.lastWakeAt).toISOString();
      const output = execSync(`git log --since="${since}" --oneline --max-count=1`, {
        cwd: repoRoot,
        encoding: 'utf-8',
        timeout: 10_000,
      }).trim();
      hadNewCommits = output.length > 0;
    } catch {
      // git log failed — proceed with timer only
    }
  }

  return {
    shouldWake: timerExpired || hadNewCommits,
    trigger: hadNewCommits ? 'commits' : 'timer',
    hadNewCommits,
  };
}

// ── Sleep helper ─────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// ── Main daemon loop ─────────────────────────────────────────────────────────

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

/**
 * Main daemon entry point. Runs in the forked child process.
 * Wakes periodically, runs bounded auto sessions, and sleeps.
 */
export async function startDaemon(repoRoot: string, config: DaemonConfig): Promise<void> {
  const state = readDaemonState(repoRoot) ?? createInitialDaemonState(config);
  state.startedAt = Date.now();
  writeDaemonState(repoRoot, state);

  let shutdown = false;
  process.on('SIGTERM', () => { shutdown = true; });
  process.on('SIGINT', () => { shutdown = true; });

  log(`Daemon started (pid=${process.pid}, interval=${config.pollIntervalMinutes}m)`);

  while (!shutdown) {
    rotateDaemonLog(repoRoot, config.maxLogSizeMB);

    const trigger = checkTrigger(repoRoot, state);
    const quiet = isInQuietHours(config);
    const isBoost = quiet && config.quietHours?.policy === 'boost';

    if (!trigger.shouldWake || (quiet && !isBoost)) {
      // Not time to wake yet, or in quiet hours with pause policy
      await sleep(Math.min(state.currentInterval, 60_000));
      if (shutdown) break;
      continue;
    }

    // Try to acquire session lock
    const lockResult = acquireSessionLock(repoRoot);
    if (!lockResult.acquired) {
      log('Session lock held by another process, skipping this cycle');
      await sleep(60_000);
      continue;
    }

    const wakeStart = Date.now();
    state.lastWakeAt = wakeStart;
    state.lastTrigger = trigger.trigger;
    state.totalWakes++;
    let hadWork = false;

    log(`Wake #${state.totalWakes} (trigger=${trigger.trigger})`);

    try {
      const exitCode = await runAutoMode({
        wheel: true,
        cycles: String(config.cyclesPerWake),
        formula: config.formula,
        scope: config.scope,
        daemon: true,
        yes: true,
        tui: false,
      });

      hadWork = exitCode === 0;
      if (hadWork) {
        state.consecutiveNoWorkCycles = 0;
      } else {
        state.consecutiveNoWorkCycles++;
      }
    } catch (err) {
      log(`Wake cycle error: ${err instanceof Error ? err.message : err}`);
      state.consecutiveNoWorkCycles++;
    }

    // Release session lock so manual runs can proceed
    releaseSessionLock(repoRoot);

    // Read metrics persisted by finalizeSession
    const wakeMetrics = readDaemonWakeMetrics(repoRoot);
    if (wakeMetrics) {
      state.totalCyclesCompleted += wakeMetrics.cyclesCompleted;
      state.totalTicketsCompleted += wakeMetrics.ticketsCompleted;
      state.totalTicketsFailed += wakeMetrics.ticketsFailed;
    }

    // Notifications
    if (config.notifications.length > 0) {
      const summary: SessionNotification = {
        repoName: path.basename(repoRoot),
        startTime: wakeStart,
        endTime: Date.now(),
        cyclesCompleted: wakeMetrics?.cyclesCompleted ?? 0,
        ticketsCompleted: wakeMetrics?.ticketsCompleted ?? 0,
        ticketsFailed: wakeMetrics?.ticketsFailed ?? 0,
        prUrls: wakeMetrics?.prUrls ?? [],
        trigger: trigger.trigger,
        reportPath: wakeMetrics?.reportPath,
      };
      await notifyAll(config.notifications, summary, log);
    }

    // Adaptive interval
    state.currentInterval = computeAdaptiveInterval(state, config, {
      hadWork,
      hadNewCommits: trigger.hadNewCommits,
      isQuietBoost: isBoost,
    });
    writeDaemonState(repoRoot, state);

    log(`Next wake in ${Math.round(state.currentInterval / 60_000)}m`);

    // Sleep until next wake
    const sleepTarget = state.currentInterval;
    const sleepChunk = 10_000; // Check shutdown every 10s
    let slept = 0;
    while (!shutdown && slept < sleepTarget) {
      await sleep(Math.min(sleepChunk, sleepTarget - slept));
      slept += sleepChunk;
    }
  }

  // Cleanup
  log('Daemon shutting down');
  removeDaemonPid(repoRoot);
  writeDaemonState(repoRoot, state);
}
