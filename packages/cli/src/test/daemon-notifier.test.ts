import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createNotifier, notifyAll, type SessionNotification } from '../lib/daemon-notifier.js';
import type { NotificationTarget } from '../lib/daemon.js';

const baseSummary: SessionNotification = {
  repoName: 'my-project',
  startTime: Date.now() - 300_000,
  endTime: Date.now(),
  cyclesCompleted: 3,
  ticketsCompleted: 5,
  ticketsFailed: 1,
  prUrls: ['https://github.com/org/repo/pull/42'],
  trigger: 'timer',
};

describe('createNotifier', () => {
  it('creates a desktop notifier for desktop type', () => {
    const notifier = createNotifier({ type: 'desktop' });
    expect(notifier).toBeDefined();
    expect(typeof notifier.notify).toBe('function');
  });

  it('creates a webhook notifier for webhook type', () => {
    const notifier = createNotifier({
      type: 'webhook',
      url: 'https://hooks.slack.com/services/test',
      template: 'slack',
    });
    expect(notifier).toBeDefined();
    expect(typeof notifier.notify).toBe('function');
  });
});

describe('notifyAll', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('calls log on notification failure without throwing', async () => {
    const messages: string[] = [];
    const log = (msg: string) => messages.push(msg);

    // This webhook URL won't resolve — should fail gracefully
    const targets: NotificationTarget[] = [
      { type: 'webhook', url: 'http://localhost:1/nonexistent', template: 'generic' },
    ];

    await notifyAll(targets, baseSummary, log);
    // Should have logged a failure message
    expect(messages.length).toBeGreaterThan(0);
    expect(messages[0]).toContain('Notification failed');
  });

  it('handles empty targets array', async () => {
    const log = vi.fn();
    await notifyAll([], baseSummary, log);
    expect(log).not.toHaveBeenCalled();
  });
});
