/**
 * Privacy-respecting gameplay analytics.
 *
 * Responsibilities:
 * - Accept only the shared allow-list of event names with small, flat
 *   properties (the API enforces the same and refuses anything else).
 * - Respect the player: nothing is queued while Settings → Gameplay → Share
 *   gameplay stats is off, which is the default under Do Not Track or Global
 *   Privacy Control.
 * - Sample per page load from the `analytics.sample` flag, so operators can
 *   dial the volume down (or to zero) without a release.
 * - Batch: flush every 15 s, and on `pagehide` with `navigator.sendBeacon`
 *   (as `text/plain`, a CORS-simple request that needs no preflight a dying
 *   page could not wait for). The beacon carries the access token in the body
 *   because beacons cannot set headers.
 * - Stay cheap and harmless: identical events within a second are folded,
 *   volume is capped per minute and per queue, and with no API (offline
 *   play, `?api=0`) or after a failed send events are dropped, never
 *   retried in a loop.
 *
 * Nothing identifying is sent beyond the account id the API derives from the
 * access token: no names, no chat, no IP-derived data, no device ids.
 */
import {
  ANALYTICS_LIMITS,
  isAnalyticsEvent,
  validAnalyticsProps,
  type AnalyticsEventName,
  type AnalyticsValue,
} from '@tumble/shared/liveops';

/** One queued event. */
export interface AnalyticsEvent {
  name: AnalyticsEventName;
  props: Record<string, AnalyticsValue>;
}

/** Options for {@link Analytics}. */
export interface AnalyticsOptions {
  /** `<api>/events`, or null when there is no reachable API (events are then dropped). */
  endpoint: () => string | null;
  /** Whether the player allows analytics right now (setting + browser signals). */
  allowed: () => boolean;
  /** `analytics.sample` (0..1). */
  sampleRate: () => number;
  /** A fresh access token for fetch flushes (may refresh), or null when signed out. */
  token?: () => Promise<string | null>;
  /** The stored access token without refreshing, for the `pagehide` beacon. */
  tokenSync?: () => string | null;
  fetch?: typeof fetch;
  sendBeacon?: (url: string, data: Blob) => boolean;
  /** Clock (ms). */
  now?: () => number;
  /** Uniform 0..1 (sampling). */
  random?: () => number;
  /** Batch interval (default 15 s). */
  flushMs?: number;
  /** Events accepted per rolling minute (default 60). */
  perMinute?: number;
  /** Events held between flushes (default 100); more are dropped. */
  maxQueue?: number;
  /** Identical events closer than this are folded (default 1 s). */
  dedupeMs?: number;
}

/** Why {@link Analytics.track} did not queue an event (tests, diagnostics). */
export type DropReason = 'not_allowed' | 'sampled_out' | 'no_api' | 'invalid' | 'duplicate' | 'rate_limited';

/**
 * Batches allow-listed gameplay events to `POST /events`.
 *
 * @example
 * const analytics = new Analytics({ endpoint: () => `${api}/events`, allowed: () => true, sampleRate: () => 1 });
 * analytics.install(window);
 * analytics.track('show_end', { placement: 3, playlist: 'main-show' });
 */
export class Analytics {
  private queue: AnalyticsEvent[] = [];
  private readonly recent: number[] = [];
  private readonly lastSeen = new Map<string, number>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** This page load's sampling roll, fixed so a session is all-in or all-out. */
  private readonly roll: number;
  private readonly now: () => number;
  /** Events dropped by reason (tests, diagnostics). */
  readonly dropped: Partial<Record<DropReason, number>> = {};

  constructor(private readonly opts: AnalyticsOptions) {
    this.now = opts.now ?? Date.now;
    this.roll = (opts.random ?? Math.random)();
  }

  /** Events waiting for the next flush. */
  get pending(): readonly AnalyticsEvent[] {
    return this.queue;
  }

  private drop(reason: DropReason): false {
    this.dropped[reason] = (this.dropped[reason] ?? 0) + 1;
    return false;
  }

  /**
   * Queues one event.
   *
   * @param name - Allow-listed event name.
   * @param props - Flat properties (short strings, numbers, booleans).
   * @returns True when queued.
   */
  track(name: AnalyticsEventName, props: Record<string, AnalyticsValue> = {}): boolean {
    if (!this.opts.allowed()) return this.drop('not_allowed');
    if (!(this.roll < this.opts.sampleRate())) return this.drop('sampled_out');
    if (!this.opts.endpoint()) return this.drop('no_api');
    const clean = validAnalyticsProps(props);
    if (!isAnalyticsEvent(name) || !clean) return this.drop('invalid');
    const t = this.now();
    const key = `${name}|${JSON.stringify(clean)}`;
    const seen = this.lastSeen.get(key);
    if (seen !== undefined && t - seen < (this.opts.dedupeMs ?? 1000)) return this.drop('duplicate');
    while (this.recent.length && t - this.recent[0]! >= 60_000) this.recent.shift();
    if (this.recent.length >= (this.opts.perMinute ?? 60) || this.queue.length >= (this.opts.maxQueue ?? 100))
      return this.drop('rate_limited');
    this.recent.push(t);
    this.lastSeen.set(key, t);
    if (this.lastSeen.size > 500) this.lastSeen.clear();
    this.queue.push({ name, props: clean });
    this.timer ??= setTimeout(() => void this.flush(), this.opts.flushMs ?? 15_000);
    return true;
  }

  private take(): AnalyticsEvent[][] {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const all = this.queue;
    this.queue = [];
    const batches: AnalyticsEvent[][] = [];
    for (let i = 0; i < all.length; i += ANALYTICS_LIMITS.maxBatch)
      batches.push(all.slice(i, i + ANALYTICS_LIMITS.maxBatch));
    return batches;
  }

  /** Sends everything queued with `fetch`. Never throws; a failed batch is dropped. */
  async flush(): Promise<void> {
    const url = this.opts.endpoint();
    const batches = this.take();
    if (!url || batches.length === 0) return;
    const token = (await this.opts.token?.().catch(() => null)) ?? null;
    const fetchFn = this.opts.fetch ?? globalThis.fetch.bind(globalThis);
    for (const events of batches) {
      await fetchFn(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ events }),
      }).catch(() => undefined);
    }
  }

  /**
   * Sends everything queued with `sendBeacon`, for a page that is going away
   * (falls back to a keepalive `fetch` where beacons are missing or refused).
   */
  flushOnHide(): void {
    const url = this.opts.endpoint();
    const batches = this.take();
    if (!url || batches.length === 0) return;
    const token = this.opts.tokenSync?.() ?? null;
    for (const events of batches) {
      const body = JSON.stringify({ events, ...(token ? { auth: token } : {}) });
      const blob = new Blob([body], { type: 'text/plain' });
      let sent: boolean;
      try {
        sent = this.opts.sendBeacon?.(url, blob) ?? false;
      } catch {
        // Some browsers throw instead of returning false (oversized payload, blocked type).
        sent = false;
      }
      if (!sent) {
        const fetchFn = this.opts.fetch ?? globalThis.fetch?.bind(globalThis);
        void fetchFn?.(url, {
          method: 'POST',
          headers: { 'content-type': 'text/plain' },
          body,
          keepalive: true,
        }).catch(() => undefined);
      }
    }
  }

  /**
   * Flushes on `pagehide` and when the tab is hidden (mobile browsers often
   * never fire `pagehide` for a backgrounded tab that is later killed).
   *
   * @param target - Usually `window`.
   * @param doc - Usually `document`, for `visibilitychange`.
   * @param beforeHide - Runs first on hide (e.g. to queue the session's error count).
   * @returns Removes the listeners.
   */
  install(
    target: Pick<Window, 'addEventListener' | 'removeEventListener'>,
    doc?: Pick<Document, 'addEventListener' | 'removeEventListener' | 'visibilityState'>,
    beforeHide?: () => void,
  ): () => void {
    const onHide = (): void => {
      beforeHide?.();
      this.flushOnHide();
    };
    const onVisibility = (): void => {
      if (doc?.visibilityState === 'hidden') onHide();
    };
    target.addEventListener('pagehide', onHide);
    doc?.addEventListener('visibilitychange', onVisibility);
    return () => {
      target.removeEventListener('pagehide', onHide);
      doc?.removeEventListener('visibilitychange', onVisibility);
    };
  }
}

// -----------------------------------------------------------------------------
// The game's instance
// -----------------------------------------------------------------------------

let instance: Analytics | null = null;

/**
 * Sets the game's analytics sink; until then (tools, tests, `?api=0` builds)
 * {@link track} does nothing.
 *
 * @param a - The instance, or null to remove it.
 */
export function setAnalytics(a: Analytics | null): void {
  instance = a;
}

/**
 * Records a gameplay event when analytics are installed and allowed.
 *
 * @param name - Allow-listed event name.
 * @param props - Flat properties.
 * @example
 * track('round_end', { round: 'tilt-town', qualified: true });
 */
export function track(name: AnalyticsEventName, props?: Record<string, AnalyticsValue>): void {
  instance?.track(name, props);
}

/** FPS buckets reported per round (`fps_bucket`). */
export const FPS_BUCKETS: readonly { max: number; label: string }[] = [
  { max: 20, label: '<20' },
  { max: 30, label: '20-30' },
  { max: 45, label: '30-45' },
  { max: 58, label: '45-58' },
  { max: Infinity, label: '58+' },
];

/**
 * Accumulates frame times over a round and reports the average as a bucket,
 * so a whole round costs one event instead of one per frame.
 */
export class FpsSampler {
  private frames = 0;
  private seconds = 0;

  /** Adds one rendered frame of `dt` seconds (ignores pauses longer than 1 s). */
  add(dt: number): void {
    if (!(dt > 0) || dt > 1) return;
    this.frames++;
    this.seconds += dt;
  }

  /**
   * The bucket of the average FPS since the last take, then resets.
   *
   * @returns The bucket label, or null with too few frames to mean anything.
   */
  take(): string | null {
    const fps = this.seconds > 0 ? this.frames / this.seconds : 0;
    const enough = this.frames >= 30;
    this.frames = 0;
    this.seconds = 0;
    if (!enough) return null;
    return FPS_BUCKETS.find((b) => fps < b.max)!.label;
  }
}
