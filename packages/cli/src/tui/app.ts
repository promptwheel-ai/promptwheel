/**
 * TUI main application
 *
 * Keyboard-first terminal UI for solo mode.
 * Uses blessed for rendering, repos for state, services for actions.
 */

import blessed, { Widgets } from 'neo-blessed';
import type { DatabaseAdapter } from '@promptwheel/core/db';
import { AdaptivePoller } from './poller.js';
import { buildSnapshot, type TuiSnapshot } from './state.js';
import { createOverviewScreen } from './screens/overview.js';
import type { TuiScreen, TuiActions } from './types.js';

export type TuiAppDeps = {
  db: DatabaseAdapter;
  repoRoot: string;
  actions?: TuiActions;
};

/**
 * Manages screen lifecycle - mount/destroy/update
 */
class ScreenManager {
  private current: TuiScreen | null = null;
  private screen: Widgets.Screen;

  constructor(screen: Widgets.Screen) {
    this.screen = screen;
  }

  set(next: TuiScreen) {
    if (this.current) {
      this.current.destroy();
    }
    this.current = next;
    next.mount(this.screen);
    next.focus?.();
    this.screen.render();
  }

  update(snapshot: TuiSnapshot) {
    if (!this.current) return;
    this.current.update(snapshot);
    this.screen.render();
  }

  getCurrentName(): string | null {
    return this.current?.name ?? null;
  }

  destroy() {
    this.current?.destroy();
    this.current = null;
  }
}

function safeString(err: unknown): string {
  if (err instanceof Error) return err.stack || err.message;
  return String(err);
}

export async function startTuiApp(deps: TuiAppDeps): Promise<{ stop: () => Promise<void> }> {
  const { db, repoRoot, actions } = deps;

  const screen = blessed.screen({
    smartCSR: true,
    fullUnicode: true,
    title: 'PromptWheel',
  });

  // Toast bar at bottom for status messages
  const toast = blessed.box({
    parent: screen,
    bottom: 0,
    height: 1,
    width: '100%',
    tags: true,
    style: { fg: 'white' },
    content: ' {gray-fg}Starting...{/gray-fg}',
  });

  const manager = new ScreenManager(screen);
  const overview = createOverviewScreen({
    onHint: (msg) => {
      toast.setContent(` {gray-fg}${msg}{/gray-fg}`);
    },
  });

  manager.set(overview);

  let actionInFlight: Promise<void> | null = null;

  async function runAction(name: string, fn?: () => Promise<void>) {
    if (!fn) {
      toast.setContent(` {yellow-fg}${name} not configured{/yellow-fg}`);
      screen.render();
      return;
    }
    if (actionInFlight) {
      toast.setContent(` {gray-fg}Action already running...{/gray-fg}`);
      screen.render();
      return;
    }

    toast.setContent(` {cyan-fg}${name}...{/cyan-fg}`);
    screen.render();

    actionInFlight = (async () => {
      try {
        await fn();
        toast.setContent(` {green-fg}${name} complete{/green-fg}`);
      } catch (e) {
        toast.setContent(` {red-fg}${name} failed: ${safeString(e).slice(0, 50)}{/red-fg}`);
      } finally {
        actionInFlight = null;
        screen.render();
        poller.tickNow();
      }
    })();
  }

  // Global keybindings
  screen.key(['C-c'], async () => {
    await stop();
  });

  screen.key(['s'], () => void runAction('Scout', actions?.runScout));
  screen.key(['q'], () => void runAction('QA', actions?.runQa));
  screen.key(['r'], () => {
    toast.setContent(' {gray-fg}Refreshing...{/gray-fg}');
    screen.render();
    poller.tickNow();
  });

  // Poller wiring
  const poller = new AdaptivePoller<TuiSnapshot>({
    fetch: () => buildSnapshot({ db, repoRoot }),
    hash: (snap) => snap.etag,
    isActive: (snap) => snap.runs.activeCount > 0 || snap.runs.runningStep !== null,
    intervals: {
      idleMs: 1000,
      activeMs: 300,
      errorMs: 2000,
    },
    onUpdate: async (snap) => {
      manager.update(snap);
      toast.setContent(` {gray-fg}${snap.hintLine}{/gray-fg}`);
    },
    onError: (err) => {
      toast.setContent(` {red-fg}Poll error: ${safeString(err).slice(0, 50)}{/red-fg}`);
      screen.render();
    },
  });

  poller.start();

  async function stop() {
    poller.stop();
    manager.destroy();
    screen.destroy();
  }

  return { stop };
}
