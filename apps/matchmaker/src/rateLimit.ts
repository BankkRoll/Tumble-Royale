/**
 * Fixed-window request limiters.
 *
 * {@link RateLimiter} counts in process. {@link SharedRateLimiter} counts in
 * the {@link MMStore}, so with Redis every matchmaker instance enforces one
 * window per key: behind a load balancer a client could otherwise get
 * `max × instances` by spreading requests. It keeps a local window in front
 * of the store: once a key is over the limit on this instance it is refused
 * without a store round trip, so a flood from one client costs Redis at most
 * `max` increments per window per instance.
 */
import type { MMStore } from './store.ts';

/** Outcome of one hit. */
export interface RateLimitResult {
  allowed: boolean;
  /** Milliseconds until the current window resets. */
  retryAfterMs: number;
}

/** Anything that can count hits per key. */
export interface Limiter {
  /** Records one hit for `key` and says whether it is within the limit. */
  hit(key: string): Promise<RateLimitResult>;
}

/** Counts hits per key in fixed windows, in process. */
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

/** Fixed windows shared by every instance through the store. */
export class SharedRateLimiter implements Limiter {
  private readonly local: RateLimiter;

  /**
   * @param store - Shared store (Redis in production).
   * @param prefix - Key namespace, e.g. `rl:ip`.
   * @param max - Hits allowed per key per window, across all instances.
   * @param windowMs - Window length.
   * @param now - Clock (ms).
   * @param onError - Called when the store fails; the hit is then judged by the local window alone.
   */
  constructor(
    private readonly store: MMStore,
    private readonly prefix: string,
    private readonly max: number,
    private readonly windowMs: number,
    now: () => number = Date.now,
    private readonly onError: (err: unknown) => void = () => undefined,
  ) {
    this.local = new RateLimiter(max, windowMs, now);
  }

  async hit(key: string): Promise<RateLimitResult> {
    const local = this.local.hit(key);
    if (!local.allowed) return local;
    try {
      const { count, ttlMs } = await this.store.hitWindow(`${this.prefix}:${key}`, this.windowMs);
      return { allowed: count <= this.max, retryAfterMs: ttlMs };
    } catch (err) {
      // NOTE: fail open to the per-instance window: a Redis blip must not lock every player out.
      this.onError(err);
      return local;
    }
  }
}
