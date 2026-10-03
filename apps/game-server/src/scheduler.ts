/**
 * Drift-free fixed-rate scheduler for the server tick loop.
 *
 * Tick N is due at `epoch + N × period` on the high-resolution clock, so timer
 * lateness never accumulates. Node timers only have ~1 ms granularity (and
 * often fire 1–2 ms late), so the loop sleeps with `setTimeout` until shortly
 * before the deadline and finishes the wait with `setImmediate` turns. After a
 * long stall (GC pause, debugger) it runs a bounded number of catch-up ticks,
 * then re-anchors instead of fast-forwarding through the backlog.
 */

/** Options for {@link TickScheduler}. */
export interface TickSchedulerOptions {
  /** Ticks per second. */
  hz: number;
  /** Monotonic clock in ms. */
  now?: () => number;
  /** Max ticks run back-to-back when behind. */
  maxCatchUp?: number;
  /** Wake this many ms early from `setTimeout` and spin the rest with `setImmediate`. */
  spinMs?: number;
}

/**
 * Calls `onTick` at a fixed rate.
 *
 * @example
 * const s = new TickScheduler({ hz: 30 }, (tick) => rooms.tick(tick));
 * s.start();
 */
export class TickScheduler {
  readonly periodMs: number;
  private readonly now: () => number;
  private readonly maxCatchUp: number;
  private readonly spinMs: number;
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private immediate: NodeJS.Immediate | null = null;
  /** Clock time (ms) at which tick 0 was due. */
  epochMs = 0;
  /** Number of ticks run so far. */
  tick = 0;
  /** Ticks skipped by re-anchoring after stalls. */
  skipped = 0;
  /** How late the most recent tick started (ms). */
  lastLatenessMs = 0;

  /**
   * @param opts - Rate and clock.
   * @param onTick - Called with the tick index being run.
   */
  constructor(
    opts: TickSchedulerOptions,
    private readonly onTick: (tick: number) => void,
  ) {
    this.periodMs = 1000 / opts.hz;
    this.now = opts.now ?? (() => performance.now());
    this.maxCatchUp = opts.maxCatchUp ?? 4;
    this.spinMs = opts.spinMs ?? 2;
  }

  /** Starts ticking; tick 0 is due one period from now. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.epochMs = this.now() + this.periodMs - this.tick * this.periodMs;
    this.schedule();
  }

  /** Stops ticking. */
  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    if (this.immediate) clearImmediate(this.immediate);
    this.timer = null;
    this.immediate = null;
  }

  /** Clock time (ms) at which tick `n` is due. */
  dueTime(n: number): number {
    return this.epochMs + n * this.periodMs;
  }

  private readonly loop = (): void => {
    this.timer = null;
    this.immediate = null;
    if (!this.running) return;
    let now = this.now();
    let ran = 0;
    while (now >= this.dueTime(this.tick) && ran < this.maxCatchUp && this.running) {
      this.lastLatenessMs = now - this.dueTime(this.tick);
      this.onTick(this.tick);
      this.tick++;
      ran++;
      now = this.now();
    }
    if (ran === this.maxCatchUp && now >= this.dueTime(this.tick)) {
      const behind = Math.floor((now - this.dueTime(this.tick)) / this.periodMs) + 1;
      this.skipped += behind;
      // Shift the epoch rather than the tick counter so tick ids stay contiguous for snapshots and acks.
      this.epochMs += behind * this.periodMs;
    }
    this.schedule();
  };

  private schedule(): void {
    if (!this.running) return;
    const wait = this.dueTime(this.tick) - this.now();
    if (wait > this.spinMs) this.timer = setTimeout(this.loop, Math.max(0, wait - this.spinMs));
    else this.immediate = setImmediate(this.loop);
  }
}
