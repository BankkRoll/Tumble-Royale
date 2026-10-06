/**
 * The last few seconds of a round as the client rendered them, in a fixed
 * ring buffer: the source of the elimination replay in online shows, where
 * the client only has its own interpolated snapshots (no full sim to replay).
 *
 * Responsibilities:
 * - sample every player (position, yaw, state, flags, emote), the live
 *   camera and the replicated obstacle states on the replay rate grid, into
 *   typed arrays sized once for the round;
 * - keep the round's sim events alongside (references in a fixed ring);
 * - turn what it holds into a regular {@link ReplayData} on demand, so the
 *   replay view plays it like any recording.
 *
 * PERF: after the first frames (obstacle slots are created as obstacles first
 * report state) writing a frame or an event allocates nothing, so it can run
 * every frame of every online round the feature is on for.
 */
import type { SimEvent } from '@tumble/sim';
import { REPLAY_RATE, type ReplayData } from './format.ts';
import {
  ReplayRecorder,
  type PlayerSampler,
  type RecordableCamera,
  type RecordablePlayer,
  type ReplayMeta,
} from './recorder.ts';

/** Seconds of round kept by default ("the last ~10 s"). */
export const TAPE_SECONDS = 10;
/** Events kept by default (references, newest win). */
export const TAPE_EVENTS = 4096;
/** Obstacles with replicated state the tape keeps (later ones are ignored). */
export const TAPE_MAX_OBSTACLES = 96;

interface ObstacleSlot {
  id: string;
  /** Values per frame (`capacity × stride`). */
  values: Float64Array;
  /** Values written per frame, -1 when the obstacle reported nothing. */
  lens: Int32Array;
  stride: number;
}

/**
 * Bounded recording of the most recent seconds of a round.
 *
 * @example
 * const tape = new ReplayTape(players.map((p) => p.id));
 * // every rendered frame
 * if (tape.due(t)) tape.frame(t, sampler, camera, sim.getObstacleNetStates());
 * tape.event(t, e);
 * // on elimination
 * const data = tape.toReplayData(meta);
 */
export class ReplayTape {
  /** Frames held at most. */
  readonly capacity: number;
  readonly rate: number;
  private readonly ids: readonly number[];
  private readonly times: Float64Array;
  private readonly pos: Float32Array;
  private readonly yaw: Float32Array;
  private readonly state: Uint8Array;
  private readonly stateTime: Float32Array;
  private readonly flags: Uint8Array;
  private readonly misc: Uint8Array;
  private readonly present: Uint8Array;
  private readonly camKnown: Uint8Array;
  private readonly camMode: Uint8Array;
  private readonly camTarget: Int32Array;
  private readonly camYaw: Float32Array;
  private readonly camPitch: Float32Array;
  private readonly obstacles: ObstacleSlot[] = [];
  private readonly obstacleIndex = new Map<string, number>();
  private readonly evTimes: Float64Array;
  private readonly ev: (SimEvent | null)[];
  private evHead = 0;
  private evCount = 0;
  private head = 0;
  private count = 0;
  private lastTick = -Infinity;
  private writing = 0;
  private readonly sampleOut: RecordablePlayer = {
    x: 0,
    y: 0,
    z: 0,
    vx: 0,
    vy: 0,
    vz: 0,
    state: 0,
    stateTime: 0,
    facing: 0,
    grounded: true,
    flags: 0,
    emote: 0,
  };
  private readonly writeObstacle = (values: readonly number[], id: string): void =>
    this.storeObstacle(id, values);

  /**
   * @param ids - Player ids, in the order the recording will list them.
   * @param seconds - Round seconds to keep.
   * @param rate - Samples per second.
   * @param maxEvents - Events to keep.
   */
  constructor(ids: readonly number[], seconds = TAPE_SECONDS, rate = REPLAY_RATE, maxEvents = TAPE_EVENTS) {
    this.ids = ids.slice();
    this.rate = rate;
    this.capacity = Math.max(2, Math.ceil(seconds * rate) + 1);
    const f = this.capacity;
    const n = this.ids.length;
    this.times = new Float64Array(f);
    this.pos = new Float32Array(f * n * 3);
    this.yaw = new Float32Array(f * n);
    this.state = new Uint8Array(f * n);
    this.stateTime = new Float32Array(f * n);
    this.flags = new Uint8Array(f * n);
    this.misc = new Uint8Array(f * n);
    this.present = new Uint8Array(f * n);
    this.camKnown = new Uint8Array(f);
    this.camMode = new Uint8Array(f);
    this.camTarget = new Int32Array(f);
    this.camYaw = new Float32Array(f);
    this.camPitch = new Float32Array(f);
    this.evTimes = new Float64Array(Math.max(1, maxEvents));
    this.ev = new Array<SimEvent | null>(Math.max(1, maxEvents)).fill(null);
  }

  /** Frames currently held. */
  get length(): number {
    return this.count;
  }

  /** Events currently held. */
  get eventCount(): number {
    return this.evCount;
  }

  /** Round time of the oldest frame held (NaN when empty). */
  get oldestTime(): number {
    return this.count === 0 ? Number.NaN : (this.times[this.slot(0)] as number);
  }

  /** Round time of the newest frame held (NaN when empty). */
  get newestTime(): number {
    return this.count === 0 ? Number.NaN : (this.times[this.slot(this.count - 1)] as number);
  }

  /** Bytes held in typed arrays (constant once every obstacle has reported). */
  get memoryBytes(): number {
    let n =
      this.times.byteLength +
      this.pos.byteLength +
      this.yaw.byteLength +
      this.state.byteLength +
      this.stateTime.byteLength +
      this.flags.byteLength +
      this.misc.byteLength +
      this.present.byteLength +
      this.camKnown.byteLength +
      this.camMode.byteLength +
      this.camTarget.byteLength +
      this.camYaw.byteLength +
      this.camPitch.byteLength +
      this.evTimes.byteLength +
      this.ev.length * 8;
    for (const o of this.obstacles) n += o.values.byteLength + o.lens.byteLength;
    return n;
  }

  /** Ring index of the k-th oldest frame. */
  private slot(k: number): number {
    return (this.head - this.count + k + this.capacity * 2) % this.capacity;
  }

  /**
   * Whether `t` reached the next sample point.
   *
   * @param t - Round time.
   */
  due(t: number): boolean {
    return Number.isFinite(t) && Math.floor(t * this.rate + 1e-6) > this.lastTick;
  }

  /**
   * Samples one frame if `t` reached the next sample point, overwriting the
   * oldest when full.
   *
   * @param t - Round time being rendered.
   * @param sample - Player sampler.
   * @param camera - Live camera, or null.
   * @param obstacles - Replicated obstacle states by id, or null.
   * @returns True when a frame was written.
   */
  frame(
    t: number,
    sample: PlayerSampler,
    camera: RecordableCamera | null,
    obstacles: ReadonlyMap<string, readonly number[]> | null,
  ): boolean {
    if (!this.due(t)) return false;
    this.lastTick = Math.floor(t * this.rate + 1e-6);
    const f = this.head;
    const n = this.ids.length;
    this.times[f] = t;
    const s = this.sampleOut;
    for (let i = 0; i < n; i++) {
      const k = f * n + i;
      if (!sample(this.ids[i] as number, s)) {
        this.present[k] = 0;
        continue;
      }
      this.present[k] = 1;
      this.pos[k * 3] = s.x;
      this.pos[k * 3 + 1] = s.y;
      this.pos[k * 3 + 2] = s.z;
      this.yaw[k] = s.facing;
      this.state[k] = s.state & 0xff;
      this.stateTime[k] = s.stateTime;
      this.flags[k] = s.flags & 0xff;
      this.misc[k] = (s.grounded ? 1 : 0) | ((s.emote & 7) << 1);
    }
    if (camera) {
      this.camKnown[f] = 1;
      this.camMode[f] = camera.mode;
      this.camTarget[f] = camera.target;
      this.camYaw[f] = camera.yaw;
      this.camPitch[f] = camera.pitch;
    } else this.camKnown[f] = 0;
    for (const o of this.obstacles) o.lens[f] = -1;
    this.writing = f;
    // forEach rather than for…of: no iterator or entry arrays per frame.
    obstacles?.forEach(this.writeObstacle);
    this.head = (this.head + 1) % this.capacity;
    this.count = Math.min(this.capacity, this.count + 1);
    return true;
  }

  private storeObstacle(id: string, values: readonly number[]): void {
    let i = this.obstacleIndex.get(id);
    if (i === undefined) {
      if (this.obstacles.length >= TAPE_MAX_OBSTACLES) return;
      i = this.obstacles.length;
      this.obstacleIndex.set(id, i);
      const stride = Math.max(4, values.length);
      this.obstacles.push({
        id,
        values: new Float64Array(this.capacity * stride),
        lens: new Int32Array(this.capacity).fill(-1),
        stride,
      });
    }
    const o = this.obstacles[i] as ObstacleSlot;
    if (values.length > o.stride) this.widen(o, values.length);
    const f = this.writing;
    const base = f * o.stride;
    for (let v = 0; v < values.length; v++) o.values[base + v] = values[v] as number;
    o.lens[f] = values.length;
  }

  /** A state grew past its slot (rare: a prop spawner adding props): re-lay the frames held. */
  private widen(o: ObstacleSlot, len: number): void {
    const stride = Math.max(len, o.stride * 2);
    const next = new Float64Array(this.capacity * stride);
    for (let f = 0; f < this.capacity; f++) {
      const l = o.lens[f] as number;
      if (l > 0) next.set(o.values.subarray(f * o.stride, f * o.stride + l), f * stride);
    }
    o.values = next;
    o.stride = stride;
  }

  /**
   * Keeps a sim event (overwriting the oldest when full).
   *
   * @param t - Round time it was rendered at.
   * @param e - The event (kept by reference; events own their data).
   */
  event(t: number, e: SimEvent): void {
    const cap = this.ev.length;
    this.ev[this.evHead] = e;
    this.evTimes[this.evHead] = t;
    this.evHead = (this.evHead + 1) % cap;
    this.evCount = Math.min(cap, this.evCount + 1);
  }

  /**
   * Calls `fn` for every event held, oldest first.
   *
   * @param fn - Visitor.
   */
  forEachEvent(fn: (e: SimEvent, t: number) => void): void {
    const cap = this.ev.length;
    for (let k = 0; k < this.evCount; k++) {
      const i = (this.evHead - this.evCount + k + cap) % cap;
      const e = this.ev[i];
      if (e) fn(e, this.evTimes[i] as number);
    }
  }

  /** Drops everything held (a new round reuses nothing: build a new tape instead). */
  clear(): void {
    this.count = 0;
    this.head = 0;
    this.evCount = 0;
    this.evHead = 0;
    this.ev.fill(null);
    this.lastTick = -Infinity;
  }

  /**
   * What the tape holds as a regular recording (allocates; call on demand).
   *
   * @param meta - Header facts; `players` must list the tape's ids in order.
   * @returns The recording, or null with fewer than two frames.
   */
  toReplayData(meta: ReplayMeta): ReplayData | null {
    if (this.count < 2) return null;
    const rec = new ReplayRecorder(meta, this.rate);
    const n = this.ids.length;
    const slotOf = new Map(this.ids.map((id, i) => [id, i]));
    const cam: RecordableCamera = { mode: 0, target: -1, yaw: 0, pitch: 0 };
    let f = 0;
    const sampler: PlayerSampler = (id, out) => {
      const i = slotOf.get(id);
      if (i === undefined) return false;
      const k = f * n + i;
      if (!this.present[k]) return false;
      out.x = this.pos[k * 3] as number;
      out.y = this.pos[k * 3 + 1] as number;
      out.z = this.pos[k * 3 + 2] as number;
      out.vx = 0;
      out.vy = 0;
      out.vz = 0;
      out.facing = this.yaw[k] as number;
      out.state = this.state[k] as number;
      out.stateTime = this.stateTime[k] as number;
      out.flags = this.flags[k] as number;
      const m = this.misc[k] as number;
      out.grounded = (m & 1) !== 0;
      out.emote = (m >> 1) & 7;
      return true;
    };
    for (let k = 0; k < this.count; k++) {
      f = this.slot(k);
      let camera: RecordableCamera | null = null;
      if (this.camKnown[f]) {
        cam.mode = this.camMode[f] as number;
        cam.target = this.camTarget[f] as number;
        cam.yaw = this.camYaw[f] as number;
        cam.pitch = this.camPitch[f] as number;
        camera = cam;
      }
      const states = new Map<string, number[]>();
      for (const o of this.obstacles) {
        const l = o.lens[f] as number;
        if (l < 0) continue;
        states.set(o.id, Array.from(o.values.subarray(f * o.stride, f * o.stride + l)));
      }
      rec.append(this.times[f] as number, sampler, camera, states);
    }
    const from = this.oldestTime;
    this.forEachEvent((e, t) => {
      if (t >= from) rec.event(t, e);
    });
    return rec.finish(null);
  }
}
