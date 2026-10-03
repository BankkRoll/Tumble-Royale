/**
 * NTP-style clock synchronisation between a client and the server.
 *
 * Each Ping/Pong exchange yields (t0 client send, t1 server receive, t2 server
 * send, t3 client receive):
 *   rtt    = (t3 − t0) − (t2 − t1)
 *   offset = ((t1 − t0) + (t2 − t3)) / 2      (server clock − client clock)
 * The offset of a sample is only as good as its path symmetry, and queueing
 * delay is what makes paths asymmetric, so samples are ranked by RTT: the
 * estimate tracks the lowest-RTT sample in a sliding window, and samples whose
 * RTT is far above the window median are rejected as outliers. Applied offset
 * changes are slewed so `serverTimeNow()` never jumps backwards by more than a
 * few ms in steady state (obstacle poses would visibly stutter otherwise).
 */

/** Tuning for {@link ClockSync}. */
export interface ClockSyncOptions {
  /** Sliding window of samples considered. */
  window?: number;
  /** Max fraction of an offset correction applied per sample once synced. */
  gain?: number;
  /** Offset errors larger than this (ms) are applied immediately rather than slewed. */
  snapThresholdMs?: number;
}

interface Sample {
  offset: number;
  rtt: number;
}

/**
 * Estimates the server clock from Ping/Pong samples.
 *
 * @example
 * const clock = new ClockSync(() => performance.now());
 * send(writePing(w, clock.now()));
 * // on Pong:
 * clock.addSample(t0, t1, t2, clock.now());
 * const serverMs = clock.serverTimeNow();
 */
export class ClockSync {
  private readonly window: number;
  private readonly gain: number;
  private readonly snapThreshold: number;
  private readonly samples: Sample[] = [];
  private readonly sortScratch: number[] = [];
  private offsetMs = 0;
  private srtt = 0;
  private rttVar = 0;
  /** Number of accepted samples. */
  accepted = 0;
  /** Number of rejected outlier samples. */
  rejected = 0;
  private matchAnchorServer = 0;
  private matchAnchorTime = 0;
  private matchRunning = false;
  private consecutiveRejects = 0;

  /**
   * @param now - Local monotonic clock in ms (e.g. `performance.now`).
   * @param opts - Optional tuning.
   */
  constructor(
    readonly now: () => number,
    opts: ClockSyncOptions = {},
  ) {
    this.window = opts.window ?? 10;
    this.gain = opts.gain ?? 0.25;
    this.snapThreshold = opts.snapThresholdMs ?? 120;
  }

  /** True after the first accepted sample. */
  get synced(): boolean {
    return this.accepted > 0;
  }

  /** Estimated server clock minus local clock (ms). */
  get offset(): number {
    return this.offsetMs;
  }

  /** Smoothed round-trip time (ms). */
  get rtt(): number {
    return this.srtt;
  }

  /** Mean RTT deviation (ms): a jitter estimate. */
  get jitter(): number {
    return this.rttVar;
  }

  /**
   * Adds one Ping/Pong exchange.
   *
   * @returns False if the sample was rejected as an outlier or invalid.
   */
  addSample(t0: number, t1: number, t2: number, t3: number): boolean {
    const rtt = t3 - t0 - (t2 - t1);
    if (!Number.isFinite(rtt) || rtt < 0 || t3 < t0) return false;
    const offset = (t1 - t0 + (t2 - t3)) / 2;

    if (this.samples.length >= 4) {
      const median = this.medianRtt();
      if (rtt > median * 2 + 25) {
        this.rejected++;
        // A run of "outliers" means the path itself changed (new route, congestion): start over.
        if (++this.consecutiveRejects < 4) return false;
        this.samples.length = 0;
      }
    }
    this.consecutiveRejects = 0;
    this.samples.push({ offset, rtt });
    if (this.samples.length > this.window) this.samples.shift();

    if (this.accepted === 0) {
      this.srtt = rtt;
      this.rttVar = rtt / 2;
    } else {
      this.rttVar += (Math.abs(rtt - this.srtt) - this.rttVar) * 0.25;
      this.srtt += (rtt - this.srtt) * 0.125;
    }

    let best = this.samples[0]!;
    for (const s of this.samples) if (s.rtt < best.rtt) best = s;
    const target = best.offset;
    if (this.accepted === 0 || Math.abs(target - this.offsetMs) > this.snapThreshold) this.offsetMs = target;
    else this.offsetMs += (target - this.offsetMs) * this.gain;
    this.accepted++;
    return true;
  }

  /** Current server clock estimate in ms. */
  serverTimeNow(): number {
    return this.now() + this.offsetMs;
  }

  /** Converts a local timestamp to server time. */
  toServerTime(localMs: number): number {
    return localMs + this.offsetMs;
  }

  /**
   * Anchors match time: at server time `serverMs` the match clock read `matchTime` seconds.
   *
   * @param running - Whether match time advances (false while the sim is paused).
   */
  setMatchAnchor(serverMs: number, matchTime: number, running = true): void {
    this.matchAnchorServer = serverMs;
    this.matchAnchorTime = matchTime;
    this.matchRunning = running;
  }

  /** Estimated authoritative match time (s) right now. */
  matchTime(): number {
    if (!this.matchRunning) return this.matchAnchorTime;
    return this.matchAnchorTime + (this.serverTimeNow() - this.matchAnchorServer) / 1000;
  }

  /** Clears all samples (new connection). */
  reset(): void {
    this.samples.length = 0;
    this.accepted = 0;
    this.rejected = 0;
    this.offsetMs = 0;
    this.srtt = 0;
    this.rttVar = 0;
  }

  private medianRtt(): number {
    const a = this.sortScratch;
    a.length = 0;
    for (const s of this.samples) a.push(s.rtt);
    a.sort((x, y) => x - y);
    return a[a.length >> 1]!;
  }
}
