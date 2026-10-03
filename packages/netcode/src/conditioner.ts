/**
 * Simulated bad network for tests and manual QA (`?lag=150&loss=0.02`).
 * Wraps any "deliver a packet" function on either peer.
 */
import { Rng } from '@tumble/shared';

/** Network impairments. All optional; omitted means a perfect link. */
export interface ConditionerOptions {
  /** Fixed one-way delay (ms). */
  latencyMs?: number;
  /** Uniform random extra delay in [0, jitterMs] (ms). */
  jitterMs?: number;
  /** Probability [0, 1] a packet is dropped. */
  loss?: number;
  /** Probability [0, 1] a packet is delivered twice. */
  duplicate?: number;
  /** Probability [0, 1] a packet is held back an extra `latency/2 + 20` ms so it arrives out of order. */
  reorder?: number;
  /**
   * Preserve send order (TCP-like): jitter delays but never reorders.
   * `reorder` still applies when set.
   */
  ordered?: boolean;
  /** Seed for the impairment RNG (deterministic tests). */
  seed?: number;
}

interface Pending {
  due: number;
  order: number;
  data: Uint8Array;
}

/**
 * Delays, drops, duplicates and reorders packets before handing them to
 * `deliver`. Time is driven by the caller: call {@link update} regularly
 * (game loop, server tick) or use {@link startAutoPump}.
 *
 * @example
 * const cond = new NetworkConditioner({ latencyMs: 75, loss: 0.02 }, (d) => ws.send(d), () => performance.now());
 * cond.send(packet);        // instead of ws.send(packet)
 * cond.update();            // every frame
 */
export class NetworkConditioner {
  private readonly rng: Rng;
  private readonly queue: Pending[] = [];
  private order = 0;
  private lastDue = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Packets dropped so far. */
  dropped = 0;
  /** Packets delivered so far (duplicates included). */
  delivered = 0;

  /**
   * @param opts - Impairments.
   * @param deliver - Receives each surviving packet.
   * @param now - Clock in ms.
   */
  constructor(
    public opts: ConditionerOptions,
    private readonly deliver: (data: Uint8Array) => void,
    private readonly now: () => number,
  ) {
    this.rng = new Rng(opts.seed ?? 0x5eed);
  }

  /** True when every impairment is zero (callers may bypass the conditioner). */
  get transparent(): boolean {
    const o = this.opts;
    return !o.latencyMs && !o.jitterMs && !o.loss && !o.duplicate && !o.reorder;
  }

  /** Packets waiting for delivery. */
  get inFlight(): number {
    return this.queue.length;
  }

  /**
   * Submits a packet. The bytes are copied, so the caller may reuse its buffer.
   */
  send(data: Uint8Array): void {
    const o = this.opts;
    if (o.loss && this.rng.next() < o.loss) {
      this.dropped++;
      return;
    }
    const copies = o.duplicate && this.rng.next() < o.duplicate ? 2 : 1;
    for (let c = 0; c < copies; c++) {
      let due = this.now() + (o.latencyMs ?? 0) + (o.jitterMs ? this.rng.next() * o.jitterMs : 0);
      const reordered = !!o.reorder && this.rng.next() < o.reorder;
      if (reordered) due += (o.latencyMs ?? 0) / 2 + 20;
      else if (o.ordered && due < this.lastDue) due = this.lastDue;
      if (!reordered) this.lastDue = Math.max(this.lastDue, due);
      this.queue.push({ due, order: this.order++, data: data.slice() });
    }
    if (this.queue.length > 1) this.queue.sort(byDue);
    this.update();
  }

  /** Delivers every packet whose time has come. */
  update(): void {
    const now = this.now();
    let n = 0;
    while (n < this.queue.length && this.queue[n]!.due <= now) n++;
    if (n === 0) return;
    const ready = this.queue.splice(0, n);
    for (const p of ready) {
      this.delivered++;
      this.deliver(p.data);
    }
  }

  /** Calls {@link update} on a timer (useful outside a game loop). */
  startAutoPump(intervalMs = 2): void {
    this.stopAutoPump();
    this.timer = setInterval(() => this.update(), intervalMs);
  }

  /** Stops the auto pump. */
  stopAutoPump(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Drops everything in flight. */
  clear(): void {
    this.queue.length = 0;
  }
}

const byDue = (a: Pending, b: Pending): number => a.due - b.due || a.order - b.order;

/**
 * Parses conditioner options from URL-style params:
 * `lag` (round-trip ms, split evenly between directions), `jitter`, `loss`, `dup`, `reorder`.
 *
 * @returns Options for ONE direction, or null when no impairment was requested.
 */
export function conditionerFromParams(params: URLSearchParams): ConditionerOptions | null {
  const num = (k: string): number => {
    const v = Number(params.get(k) ?? 0);
    return Number.isFinite(v) && v > 0 ? v : 0;
  };
  const lag = num('lag');
  const opts: ConditionerOptions = {
    latencyMs: lag / 2,
    jitterMs: num('jitter') / 2,
    loss: Math.min(1, num('loss')),
    duplicate: Math.min(1, num('dup')),
    reorder: Math.min(1, num('reorder')),
    ordered: true,
  };
  return opts.latencyMs || opts.jitterMs || opts.loss || opts.duplicate || opts.reorder ? opts : null;
}
