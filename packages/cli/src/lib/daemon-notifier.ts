/**
 * Daemon notification system.
 *
 * Sends session summaries to webhooks (Slack, Discord, Telegram, generic)
 * and desktop notifications. All failures are caught and logged — never
 * stop the daemon loop.
 */

import { execSync } from 'node:child_process';
import type { NotificationTarget } from './daemon.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface SessionNotification {
  repoName: string;
  startTime: number;
  endTime: number;
  cyclesCompleted: number;
  ticketsCompleted: number;
  ticketsFailed: number;
  prUrls: string[];
  trigger: 'timer' | 'commits' | 'manual';
  reportPath?: string;
}

export interface Notifier {
  notify(summary: SessionNotification): Promise<void>;
}

// ── Webhook templates ────────────────────────────────────────────────────────

function formatSlack(s: SessionNotification): object {
  const elapsed = Math.round((s.endTime - s.startTime) / 60_000);
  const lines = [
    `*PromptWheel* completed a cycle on \`${s.repoName}\``,
    `> Trigger: ${s.trigger} | Duration: ${elapsed}m`,
    `> Cycles: ${s.cyclesCompleted} | Tickets: ${s.ticketsCompleted} done, ${s.ticketsFailed} failed`,
  ];
  if (s.prUrls.length > 0) {
    lines.push(`> PRs: ${s.prUrls.join(', ')}`);
  }
  return {
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } },
    ],
  };
}

function formatDiscord(s: SessionNotification): object {
  const elapsed = Math.round((s.endTime - s.startTime) / 60_000);
  return {
    embeds: [{
      title: `PromptWheel - ${s.repoName}`,
      description: [
        `**Trigger:** ${s.trigger}`,
        `**Duration:** ${elapsed}m`,
        `**Cycles:** ${s.cyclesCompleted}`,
        `**Tickets:** ${s.ticketsCompleted} done, ${s.ticketsFailed} failed`,
        ...(s.prUrls.length > 0 ? [`**PRs:** ${s.prUrls.join(', ')}`] : []),
      ].join('\n'),
      color: s.ticketsFailed > 0 ? 0xff6b35 : 0x4caf50,
    }],
  };
}

function formatTelegram(s: SessionNotification): object {
  const elapsed = Math.round((s.endTime - s.startTime) / 60_000);
  const lines = [
    `*PromptWheel* \u2014 \`${s.repoName}\``,
    `Trigger: ${s.trigger} | Duration: ${elapsed}m`,
    `Cycles: ${s.cyclesCompleted} | Tickets: ${s.ticketsCompleted} done, ${s.ticketsFailed} failed`,
  ];
  if (s.prUrls.length > 0) {
    lines.push(`PRs: ${s.prUrls.join(', ')}`);
  }
  return {
    text: lines.join('\n'),
    parse_mode: 'Markdown',
  };
}

function formatGeneric(s: SessionNotification): object {
  return {
    event: 'promptwheel.daemon.wake_complete',
    repo: s.repoName,
    trigger: s.trigger,
    startTime: s.startTime,
    endTime: s.endTime,
    cyclesCompleted: s.cyclesCompleted,
    ticketsCompleted: s.ticketsCompleted,
    ticketsFailed: s.ticketsFailed,
    prUrls: s.prUrls,
    reportPath: s.reportPath,
  };
}

// ── WebhookNotifier ──────────────────────────────────────────────────────────

class WebhookNotifier implements Notifier {
  constructor(
    private url: string,
    private template: 'slack' | 'discord' | 'telegram' | 'generic',
    private headers: Record<string, string>,
  ) {}

  async notify(summary: SessionNotification): Promise<void> {
    const formatters = {
      slack: formatSlack,
      discord: formatDiscord,
      telegram: formatTelegram,
      generic: formatGeneric,
    };
    const body = formatters[this.template](summary);

    const response = await fetch(this.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...this.headers,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      throw new Error(`Webhook ${this.template} returned ${response.status}: ${response.statusText}`);
    }
  }
}

// ── DesktopNotifier ──────────────────────────────────────────────────────────

class DesktopNotifier implements Notifier {
  async notify(summary: SessionNotification): Promise<void> {
    const title = 'PromptWheel';
    const msg = `${summary.ticketsCompleted} tickets completed on ${summary.repoName}`;

    const platform = process.platform;
    try {
      if (platform === 'darwin') {
        execSync(`osascript -e 'display notification "${msg}" with title "${title}"'`, { timeout: 5000 });
      } else if (platform === 'linux') {
        execSync(`notify-send "${title}" "${msg}"`, { timeout: 5000 });
      }
      // Windows: no-op for now
    } catch {
      // Desktop notification failed — non-fatal
    }
  }
}

// ── Factory ──────────────────────────────────────────────────────────────────

export function createNotifier(target: NotificationTarget): Notifier {
  if (target.type === 'desktop') {
    return new DesktopNotifier();
  }
  if (!target.url) {
    throw new Error('Webhook notification target requires a url');
  }
  return new WebhookNotifier(
    target.url,
    target.template ?? 'generic',
    target.headers ?? {},
  );
}

/**
 * Send notifications to all configured targets.
 * All failures are caught and logged — never throws.
 */
export async function notifyAll(
  targets: NotificationTarget[],
  summary: SessionNotification,
  log: (msg: string) => void,
): Promise<void> {
  for (const target of targets) {
    try {
      await createNotifier(target).notify(summary);
    } catch (err) {
      log(`Notification failed (${target.type}/${target.template ?? 'default'}): ${err instanceof Error ? err.message : err}`);
    }
  }
}
