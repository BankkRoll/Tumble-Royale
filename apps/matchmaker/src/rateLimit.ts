/**
 * Fixed-window request limiter.
 *
 * In-process on purpose: limits only need to be roughly right, and keeping
 * them out of the shared store means a flood never adds load to Redis. With
 * several matchmaker instances behind a load balancer each enforces its own
 * window, so the effective limit is at most `max × instances`.
 */

/** Outcome of one {@link RateLimiter.hit}. */
export interface RateLimitResult {
  allowed: boolean;
  /** Milliseconds until the current window resets. */
  retryAfterMs: number;
}

/** Counts hits per key in fixed windows. */
export class RateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();
  private lastSweep = 0;

  /**
   * @param max - Hits allowed per key per window.
   * @param windowMs - Window length.
   * @param now - Clock (ms), injectable for tests.
   */
  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Records one hit for `key` and says whether it is within the limit. */
  hit(key: string): RateLimitResult {
    const t = this.now();
    this.sweep(t);
    let w = this.windows.get(key);
    if (!w || t - w.start >= this.windowMs) {
      w = { start: t, count: 0 };
      this.windows.set(key, w);
    }
    w.count++;
    return { allowed: w.count <= this.max, retryAfterMs: Math.max(0, w.start + this.windowMs - t) };
  }

  // PERF: drop expired windows at most once per window so the map cannot grow without bound.
  private sweep(t: number): void {
    if (t - this.lastSweep < this.windowMs) return;
    this.lastSweep = t;
    for (const [k, w] of this.windows) if (t - w.start >= this.windowMs) this.windows.delete(k);
  }
}
