/**
 * Lag compensation history for grab and dive-hit validation.
 *
 * A client acts on what it SAW: remote players interpolated ~100 ms in the past
 * plus half its RTT. When the server validates such an action it rewinds the
 * other players' capsules to that moment, bounded to {@link LAG_COMP_MAX_MS}
 * (spec: ≤ 150 ms) so high-ping players can't hit from too far in the past.
 *
 * The history is recorded once per server tick (after both sim steps); rewinds
 * between records are linearly interpolated, giving sub-tick precision.
 */
import { MAX_ENTITIES } from '@tumble/netcode';
import { SIM_DT, type Quat, type Vec3 } from '@tumble/shared';

/** Maximum rewind in ms. */
export const LAG_COMP_MAX_MS = 150;

/** Read access to the rewound capsules. */
export interface LagCompView {
  /** The (possibly fractional) sim tick this view represents. */
  readonly tick: number;
  /**
   * Writes player `id`'s rewound capsule centre into `out`.
   *
   * @returns False when the player has no history at this tick.
   */
  position(id: number, out: Vec3): boolean;
  /** Writes player `id`'s rewound orientation into `out`. */
  rotation(id: number, out: Quat): boolean;
}

const POSE = 7;

class RewindView implements LagCompView {
  tick = 0;
  private a = 0;
  private b = 0;
  private u = 0;

  constructor(private readonly owner: LagCompensator) {}

  set(tick: number, a: number, b: number, u: number): void {
    this.tick = tick;
    this.a = a;
    this.b = b;
    this.u = u;
  }

  position(id: number, out: Vec3): boolean {
    return this.owner.lerpPose(this.a, this.b, this.u, id, out, null);
  }

  rotation(id: number, out: Quat): boolean {
    return this.owner.lerpPose(this.a, this.b, this.u, id, null, out);
  }
}

/**
 * Ring of per-tick player poses.
 *
 * @example
 * // Validate a dive hit reported by player A against player B as A saw it:
 * const t = lag.viewTickFor(sim.tick, session.rttMs, interpDelayMs);
 * const hit = lag.rewind(t, (view) => view.position(b, tmp) && distance(tmp, diverPos) < 1.2);
 */
export class LagCompensator {
  private readonly frames: number;
  private readonly ticks: Float64Array;
  private readonly data: Float32Array;
  private readonly present: Uint8Array;
  private head = -1;
  private count = 0;
  private recording = -1;

  /**
   * @param historyMs - How far back to keep (≥ {@link LAG_COMP_MAX_MS}).
   * @param recordIntervalTicks - Sim ticks between records (2 at a 30 Hz record rate).
   */
  constructor(
    historyMs = LAG_COMP_MAX_MS + 100,
    private readonly recordIntervalTicks = 2,
  ) {
    this.frames = Math.ceil(historyMs / 1000 / (SIM_DT * recordIntervalTicks)) + 2;
    this.ticks = new Float64Array(this.frames).fill(-1);
    this.data = new Float32Array(this.frames * MAX_ENTITIES * POSE);
    this.present = new Uint8Array(this.frames * MAX_ENTITIES);
  }

  /** Starts a new record for sim tick `tick`. */
  begin(tick: number): void {
    this.head = (this.head + 1) % this.frames;
    this.recording = this.head;
    this.ticks[this.head] = tick;
    this.present.fill(0, this.head * MAX_ENTITIES, (this.head + 1) * MAX_ENTITIES);
    if (this.count < this.frames) this.count++;
  }

  /** Adds player `id`'s pose to the record started by {@link begin}. */
  add(id: number, pos: Vec3, rot: Quat): void {
    if (this.recording < 0 || id < 0 || id >= MAX_ENTITIES) return;
    const o = (this.recording * MAX_ENTITIES + id) * POSE;
    const d = this.data;
    d[o] = pos.x;
    d[o + 1] = pos.y;
    d[o + 2] = pos.z;
    d[o + 3] = rot.x;
    d[o + 4] = rot.y;
    d[o + 5] = rot.z;
    d[o + 6] = rot.w;
    this.present[this.recording * MAX_ENTITIES + id] = 1;
  }

  /** Newest recorded tick, or -1. */
  get newestTick(): number {
    return this.head < 0 ? -1 : this.ticks[this.head]!;
  }

  /**
   * The sim tick a client was looking at when it acted.
   *
   * @param currentTick - Server sim tick now.
   * @param rttMs - The client's RTT.
   * @param interpDelayMs - The client's remote render delay.
   * @returns A (fractional) tick, clamped to the compensation window.
   */
  viewTickFor(currentTick: number, rttMs: number, interpDelayMs: number): number {
    const backMs = Math.min(LAG_COMP_MAX_MS, Math.max(0, rttMs / 2 + interpDelayMs));
    return currentTick - backMs / 1000 / SIM_DT;
  }

  /**
   * Runs `fn` against player poses at `tick` (clamped to the available history).
   *
   * @returns Whatever `fn` returns, or undefined when there is no history.
   */
  rewind<T>(tick: number, fn: (view: LagCompView) => T): T | undefined {
    if (this.count === 0) return undefined;
    const oldestIdx = (this.head - this.count + 1 + this.frames) % this.frames;
    const newest = this.ticks[this.head]!;
    const oldest = this.ticks[oldestIdx]!;
    const t = Math.max(oldest, Math.min(newest, tick));
    let ia = this.head;
    for (let k = 0; k < this.count; k++) {
      const i = (this.head - k + this.frames) % this.frames;
      if (this.ticks[i]! <= t) {
        ia = i;
        break;
      }
    }
    const ib = ia === this.head ? ia : (ia + 1) % this.frames;
    const ta = this.ticks[ia]!;
    const tb = this.ticks[ib]!;
    const u = tb > ta ? (t - ta) / (tb - ta) : 0;
    this.view.set(t, ia, ib, u);
    return fn(this.view);
  }

  /** Clears the history (new round). */
  reset(): void {
    this.ticks.fill(-1);
    this.head = -1;
    this.count = 0;
    this.recording = -1;
  }

  private readonly view = new RewindView(this);

  /** @internal Interpolates a pose between two records (nlerp for rotation). */
  lerpPose(a: number, b: number, u: number, id: number, pos: Vec3 | null, rot: Quat | null): boolean {
    if (id < 0 || id >= MAX_ENTITIES) return false;
    const pa = this.present[a * MAX_ENTITIES + id] === 1;
    const pb = this.present[b * MAX_ENTITIES + id] === 1;
    if (!pa && !pb) return false;
    const oa = (a * MAX_ENTITIES + id) * POSE;
    const ob = (b * MAX_ENTITIES + id) * POSE;
    const src0 = pa ? oa : ob;
    const src1 = pb ? ob : oa;
    const d = this.data;
    if (pos) {
      pos.x = d[src0]! + (d[src1]! - d[src0]!) * u;
      pos.y = d[src0 + 1]! + (d[src1 + 1]! - d[src0 + 1]!) * u;
      pos.z = d[src0 + 2]! + (d[src1 + 2]! - d[src0 + 2]!) * u;
    }
    if (rot) {
      const sign = d[src0 + 3]! * d[src1 + 3]! + d[src0 + 4]! * d[src1 + 4]! + d[src0 + 5]! * d[src1 + 5]! + d[src0 + 6]! * d[src1 + 6]! < 0 ? -1 : 1;
      rot.x = d[src0 + 3]! + (sign * d[src1 + 3]! - d[src0 + 3]!) * u;
      rot.y = d[src0 + 4]! + (sign * d[src1 + 4]! - d[src0 + 4]!) * u;
      rot.z = d[src0 + 5]! + (sign * d[src1 + 5]! - d[src0 + 5]!) * u;
      rot.w = d[src0 + 6]! + (sign * d[src1 + 6]! - d[src0 + 6]!) * u;
      const len = Math.hypot(rot.x, rot.y, rot.z, rot.w) || 1;
      rot.x /= len;
      rot.y /= len;
      rot.z /= len;
      rot.w /= len;
    }
    return true;
  }
}
