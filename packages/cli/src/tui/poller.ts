/**
 * Adaptive poller for TUI
 *
 * Polls faster when there's activity (running steps),
 * slows down when idle. Uses hash-based dedupe to avoid
 * unnecessary re-renders.
 */

export type AdaptivePollerIntervals = {
  idleMs: number;
  activeMs: number;
  errorMs: number;
};

export type AdaptivePollerOptions<T> = {
  fetch: () => Promise<T>;
  onUpdate: (snapshot: T) => void | Promise<void>;
  onError?: (err: unknown) => void;

  /**
   * Determines whether the app is "active" (e.g. a run is running),
   * which switches polling to activeMs.
   */
  isActive?: (snapshot: T) => boolean;

  /**
   * Used to avoid re-rendering when nothing changed.
   * If omitted, every tick calls onUpdate.
   */
  hash?: (snapshot: T) => string;

  intervals: AdaptivePollerIntervals;
};

export class AdaptivePoller<T> {
  private opts: AdaptivePollerOptions<T>;
  private stopped = true;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastHash: string | null = null;

  constructor(opts: AdaptivePollerOptions<T>) {
    this.opts = opts;
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    void this.loop();
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Force an immediate poll (e.g., after user action) */
  tickNow() {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    void this.loop();
  }

  private schedule(ms: number) {
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.loop(), ms);
  }

  private async loop() {
    if (this.stopped) return;

    try {
      const snap = await this.opts.fetch();

      const nextHash = this.opts.hash ? this.opts.hash(snap) : null;
      const changed = nextHash === null ? true : nextHash !== this.lastHash;

      if (changed) {
        await this.opts.onUpdate(snap);
        this.lastHash = nextHash;
      }

      const active = this.opts.isActive ? this.opts.isActive(snap) : false;
      this.schedule(active ? this.opts.intervals.activeMs : this.opts.intervals.idleMs);
    } catch (err) {
      this.opts.onError?.(err);
      this.schedule(this.opts.intervals.errorMs);
    }
  }
}
