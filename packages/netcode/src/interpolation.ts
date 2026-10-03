/**
 * Remote-entity smoothing: an adaptive render clock that trails the snapshot
 * stream, and a per-entity interpolator (cubic Hermite using replicated
 * velocity, brief extrapolation, then hold).
 */
import type { Quat } from '@tumble/shared';
import { copyNetEntityState, createNetEntityState, type NetEntityState } from './snapshot.ts';

/** Tuning for {@link InterpolationClock}. */
export interface InterpolationClockOptions {
  /** Snapshot interval in ms. */
  intervalMs?: number;
  /** Lower bound on the render delay behind the newest snapshot (ms). */
  minDelayMs?: number;
  /** Upper bound on the render delay (ms). */
  maxDelayMs?: number;
}

/**
 * Maps local time onto the snapshot timeline (`serverTick × tickMs`) minus an
 * adaptive delay, so remote entities are rendered between two received
 * snapshots almost all the time.
 *
 * The offset between the snapshot timeline and the local clock tracks the
 * EARLIEST arrivals (least-queued packets); lateness beyond that is jitter and
 * sets the delay: `max(minDelay, 2 × interval + 3 × jitter)`, clamped. The
 * output timeline never jumps in steady state: it speeds up or slows down by at
 * most 5% to converge, snapping only on errors above 250 ms.
 */
export class InterpolationClock {
  private readonly intervalMs: number;
  private readonly minDelay: number;
  private readonly maxDelay: number;
  private offset = 0;
  private jitterMs = 0;
  private hasOffset = false;
  private renderT = 0;
  private lastLocal = 0;
  private hasRender = false;
  /** Current render delay behind the newest snapshot (ms). */
  delayMs: number;

  /** @param opts - Optional tuning. */
  constructor(opts: InterpolationClockOptions = {}) {
    this.intervalMs = opts.intervalMs ?? 1000 / 30;
    this.minDelay = opts.minDelayMs ?? 100;
    this.maxDelay = opts.maxDelayMs ?? 250;
    this.delayMs = this.minDelay;
  }

  /** Arrival jitter estimate (ms). */
  get jitter(): number {
    return this.jitterMs;
  }

  /**
   * Feeds one snapshot arrival.
   *
   * @param localNowMs - Local arrival time.
   * @param snapshotTimeMs - The snapshot's position on the server timeline (`serverTick × tickMs`).
   */
  onSnapshot(localNowMs: number, snapshotTimeMs: number): void {
    const sample = snapshotTimeMs - localNowMs;
    if (!this.hasOffset) {
      this.offset = sample;
      this.hasOffset = true;
    } else if (sample > this.offset) {
      this.offset = sample;
    } else {
      // Drift slowly toward later arrivals so a sustained latency increase is eventually adopted.
      this.offset += (sample - this.offset) * 0.002;
      this.jitterMs += (Math.min(this.offset - sample, 500) - this.jitterMs) * 0.05;
    }
    const want = Math.max(this.minDelay, 2 * this.intervalMs + 3 * this.jitterMs);
    this.delayMs = want > this.maxDelay ? this.maxDelay : want;
  }

  /** @returns The time on the snapshot timeline to render remotes at. */
  renderTime(localNowMs: number): number {
    const target = localNowMs + this.offset - this.delayMs;
    if (!this.hasRender) {
      this.renderT = target;
      this.lastLocal = localNowMs;
      this.hasRender = true;
      return target;
    }
    const dt = Math.max(0, localNowMs - this.lastLocal);
    this.lastLocal = localNowMs;
    let t = this.renderT + dt;
    const err = target - t;
    if (err > 250 || err < -250) t = target;
    else {
      const maxAdj = dt * 0.05;
      t += err > maxAdj ? maxAdj : err < -maxAdj ? -maxAdj : err;
    }
    this.renderT = t;
    return t;
  }

  /** Forgets timing (new connection / round). */
  reset(): void {
    this.hasOffset = false;
    this.hasRender = false;
    this.jitterMs = 0;
    this.delayMs = this.minDelay;
  }
}

/** An interpolated entity ready for rendering. */
export interface RenderEntityState extends NetEntityState {
  /** True when the sample is extrapolated past the newest snapshot (or held after the limit). */
  extrapolated: boolean;
}

/** @returns A preallocated render state. */
export function createRenderEntityState(): RenderEntityState {
  return { ...createNetEntityState(), extrapolated: false };
}

/** Tuning for {@link SnapshotInterpolator}. */
export interface SnapshotInterpolatorOptions {
  /** Samples kept per entity. */
  capacity?: number;
  /** Extrapolate at most this far past the newest sample, then hold (ms). */
  maxExtrapolationMs?: number;
  /** A gap longer than this between samples inserts a hold sample instead of a long blend (ms). */
  gapMs?: number;
  /** Displacements faster than this (m/s) are treated as teleports and not blended. */
  teleportSpeed?: number;
}

/**
 * Buffers snapshot samples for one remote entity and samples it at any render
 * time. Allocation-free after construction.
 */
export class SnapshotInterpolator {
  private readonly cap: number;
  private readonly maxExtrapolation: number;
  private readonly gapMs: number;
  private readonly teleportSpeed: number;
  private readonly times: Float64Array;
  private readonly snaps: Uint8Array;
  private readonly states: NetEntityState[];
  private head = 0;
  private count = 0;

  /** @param opts - Optional tuning. */
  constructor(opts: SnapshotInterpolatorOptions = {}) {
    this.cap = opts.capacity ?? 32;
    this.maxExtrapolation = opts.maxExtrapolationMs ?? 250;
    this.gapMs = opts.gapMs ?? 250;
    this.teleportSpeed = opts.teleportSpeed ?? 60;
    this.times = new Float64Array(this.cap);
    this.snaps = new Uint8Array(this.cap);
    this.states = Array.from({ length: this.cap }, createNetEntityState);
  }

  /** Number of buffered samples. */
  get size(): number {
    return this.count;
  }

  /** Timeline position of the newest sample, or -Infinity. */
  get newestTime(): number {
    return this.count === 0 ? -Infinity : this.times[this.idx(this.count - 1)]!;
  }

  /**
   * Adds a sample. Samples not newer than the newest are ignored (reordered or
   * duplicated snapshots).
   */
  push(timeMs: number, state: NetEntityState): void {
    if (this.count > 0) {
      const lastI = this.idx(this.count - 1);
      const lastT = this.times[lastI]!;
      if (timeMs <= lastT) return;
      const prev = this.states[lastI]!;
      if (timeMs - lastT > this.gapMs) {
        // The entity was unchanged (or deferred) for a while: pin its old pose until just before the new sample.
        const holdT = timeMs - Math.min(this.gapMs / 2, 50);
        if (holdT > lastT) {
          const held = this.append(holdT);
          copyNetEntityState(prev, held);
          held.vel.x = held.vel.y = held.vel.z = 0;
          this.snaps[this.idx(this.count - 1)] = 0;
        }
      }
      const s = this.append(timeMs);
      copyNetEntityState(state, s);
      const p = this.states[this.idx(this.count - 2)]!;
      const dtS = (timeMs - this.times[this.idx(this.count - 2)]!) / 1000;
      const dx = s.pos.x - p.pos.x;
      const dy = s.pos.y - p.pos.y;
      const dz = s.pos.z - p.pos.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      this.snaps[this.idx(this.count - 1)] = dist > this.teleportSpeed * dtS + 1 ? 1 : 0;
      return;
    }
    copyNetEntityState(state, this.append(timeMs));
    this.snaps[this.idx(0)] = 1;
  }

  /**
   * Samples the entity at `timeMs` on the snapshot timeline.
   *
   * @returns False when no samples exist.
   */
  sample(timeMs: number, out: RenderEntityState): boolean {
    if (this.count === 0) return false;
    const first = this.idx(0);
    if (timeMs <= this.times[first]!) {
      copyNetEntityState(this.states[first]!, out);
      out.extrapolated = false;
      return true;
    }
    // Newest-first scan: render time is almost always within the last few samples.
    let k = this.count - 1;
    while (k > 0 && this.times[this.idx(k)]! > timeMs) k--;
    const ai = this.idx(k);
    const a = this.states[ai]!;
    const ta = this.times[ai]!;

    if (k === this.count - 1) {
      const dtMs = Math.min(timeMs - ta, this.maxExtrapolation);
      const dt = dtMs / 1000;
      copyNetEntityState(a, out);
      out.pos.x += a.vel.x * dt;
      out.pos.y += a.vel.y * dt;
      out.pos.z += a.vel.z * dt;
      out.stateTime = a.stateTime + dt;
      out.extrapolated = true;
      return true;
    }

    const bi = this.idx(k + 1);
    const b = this.states[bi]!;
    const tb = this.times[bi]!;
    const u = (timeMs - ta) / (tb - ta);
    copyNetEntityState(a, out);
    out.extrapolated = false;
    out.stateTime =
      a.state === b.state
        ? a.stateTime + (b.stateTime - a.stateTime) * u
        : a.stateTime + (timeMs - ta) / 1000;
    if (this.snaps[bi] === 1) return true;

    const T = (tb - ta) / 1000;
    if (velocityConsistent(a, b, T)) hermite(a, b, u, T, out);
    else linear(a, b, u, T, out);
    slerpInto(a.rot, b.rot, u, out.rot);
    out.facing = a.facing + angleDiff(a.facing, b.facing) * u;
    return true;
  }

  /** Drops all samples (entity removed / round change). */
  clear(): void {
    this.count = 0;
    this.head = 0;
  }

  private idx(k: number): number {
    return (this.head + k) % this.cap;
  }

  private append(timeMs: number): NetEntityState {
    if (this.count === this.cap) {
      this.head = (this.head + 1) % this.cap;
      this.count--;
    }
    const i = this.idx(this.count++);
    this.times[i] = timeMs;
    return this.states[i]!;
  }
}

/**
 * Hermite needs velocities that agree with the displacement. A bounce or hit
 * between samples breaks that and makes the curve overshoot; detect it by
 * comparing the trapezoid-predicted displacement with the actual one.
 */
function velocityConsistent(a: NetEntityState, b: NetEntityState, T: number): boolean {
  const ex = b.pos.x - a.pos.x - ((a.vel.x + b.vel.x) / 2) * T;
  const ey = b.pos.y - a.pos.y - ((a.vel.y + b.vel.y) / 2) * T;
  const ez = b.pos.z - a.pos.z - ((a.vel.z + b.vel.z) / 2) * T;
  return ex * ex + ey * ey + ez * ez < 0.25 * 0.25;
}

function hermite(a: NetEntityState, b: NetEntityState, u: number, T: number, out: NetEntityState): void {
  const u2 = u * u;
  const u3 = u2 * u;
  const h00 = 2 * u3 - 3 * u2 + 1;
  const h10 = u3 - 2 * u2 + u;
  const h01 = -2 * u3 + 3 * u2;
  const h11 = u3 - u2;
  const d00 = 6 * u2 - 6 * u;
  const d10 = 3 * u2 - 4 * u + 1;
  const d01 = -6 * u2 + 6 * u;
  const d11 = 3 * u2 - 2 * u;
  out.pos.x = h00 * a.pos.x + h10 * T * a.vel.x + h01 * b.pos.x + h11 * T * b.vel.x;
  out.pos.y = h00 * a.pos.y + h10 * T * a.vel.y + h01 * b.pos.y + h11 * T * b.vel.y;
  out.pos.z = h00 * a.pos.z + h10 * T * a.vel.z + h01 * b.pos.z + h11 * T * b.vel.z;
  out.vel.x = (d00 * a.pos.x + d01 * b.pos.x) / T + d10 * a.vel.x + d11 * b.vel.x;
  out.vel.y = (d00 * a.pos.y + d01 * b.pos.y) / T + d10 * a.vel.y + d11 * b.vel.y;
  out.vel.z = (d00 * a.pos.z + d01 * b.pos.z) / T + d10 * a.vel.z + d11 * b.vel.z;
}

function linear(a: NetEntityState, b: NetEntityState, u: number, T: number, out: NetEntityState): void {
  out.pos.x = a.pos.x + (b.pos.x - a.pos.x) * u;
  out.pos.y = a.pos.y + (b.pos.y - a.pos.y) * u;
  out.pos.z = a.pos.z + (b.pos.z - a.pos.z) * u;
  out.vel.x = (b.pos.x - a.pos.x) / T;
  out.vel.y = (b.pos.y - a.pos.y) / T;
  out.vel.z = (b.pos.z - a.pos.z) / T;
}

function angleDiff(from: number, to: number): number {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

function slerpInto(a: Quat, b: Quat, t: number, out: Quat): void {
  let bx = b.x;
  let by = b.y;
  let bz = b.z;
  let bw = b.w;
  let cos = a.x * bx + a.y * by + a.z * bz + a.w * bw;
  if (cos < 0) {
    cos = -cos;
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
  }
  let s0 = 1 - t;
  let s1 = t;
  if (cos < 0.9995) {
    const theta = Math.acos(cos);
    const sin = Math.sin(theta);
    s0 = Math.sin((1 - t) * theta) / sin;
    s1 = Math.sin(t * theta) / sin;
  }
  const x = s0 * a.x + s1 * bx;
  const y = s0 * a.y + s1 * by;
  const z = s0 * a.z + s1 * bz;
  const w = s0 * a.w + s1 * bw;
  const len = Math.hypot(x, y, z, w) || 1;
  out.x = x / len;
  out.y = y / len;
  out.z = z / len;
  out.w = w / len;
}
