/**
 * Decoded replay: random access over a recording for playback and scrubbing.
 *
 * Responsibilities:
 * - decodes the frame stream once into flat typed arrays (players, camera)
 *   and per-obstacle change lists, and the event stream into timed events;
 * - locates any playback time (binary search) and interpolates a player's
 *   rendered state between the two surrounding samples, snapping teleports;
 * - looks up each obstacle's replicated state at a frame;
 * - lists events in a time window and the timeline markers (eliminations,
 *   the local player's qualification / elimination).
 *
 * All lookups after construction are allocation-free (callers pass reused
 * cursors and output objects), so the playback loop can call them per frame.
 */
import type { SimEvent } from '@tumble/sim';
import { ByteReader, ReplayDecodeError } from './codec.ts';
import {
  ANGLE_STEPS,
  CameraField,
  NET_MILLI_SCALE,
  NetKind,
  POS_SCALE,
  PlayerField,
  TIME_SCALE,
  VEL_SCALE,
  readEvent,
  type ReplayData,
  type ReplayHeader,
} from './format.ts';
import type { RecordableCamera, RecordablePlayer } from './recorder.ts';

/** Kinds of timeline marker. */
export type ReplayMarkerKind = 'eliminated' | 'qualified' | 'localEliminated' | 'localQualified';

/** A point of interest on the scrub bar. */
export interface ReplayMarker {
  /** Seconds from the start of the recording. */
  t: number;
  kind: ReplayMarkerKind;
  player: number;
}

/** Position within the recording (reuse one per caller). */
export interface TimelineCursor {
  /** Frame at or before the time. */
  i: number;
  /** Frame after it (equal to `i` at the end). */
  j: number;
  /** Fraction from `i` to `j`. */
  a: number;
  /** The located time (clamped to the recording). */
  t: number;
}

/** @returns A cursor at the start. */
export function createCursor(): TimelineCursor {
  return { i: 0, j: 0, a: 0, t: 0 };
}

const TAU = Math.PI * 2;
const ANGLE = TAU / ANGLE_STEPS;
/** A per-sample jump longer than this is a teleport/respawn: snap, don't smear. */
const TELEPORT_DIST = 3;

function lerpAngle(a: number, b: number, t: number): number {
  let d = b - a;
  d = Math.atan2(Math.sin(d), Math.cos(d));
  return a + d * t;
}

interface ObstacleTrack {
  /** Frame index each state takes effect at (ascending). */
  frames: number[];
  states: Float64Array[];
}

/**
 * A recording decoded for playback.
 *
 * @example
 * const tl = new ReplayTimeline(data);
 * const c = createCursor();
 * tl.locate(12.5, c);
 * tl.samplePlayer(0, c, out);
 */
export class ReplayTimeline {
  readonly header: ReplayHeader;
  readonly frameCount: number;
  readonly playerCount: number;
  /** Seconds from the first frame to the last. */
  readonly duration: number;
  /** Frame times in seconds from the first frame. */
  readonly times: Float64Array;
  readonly markers: ReplayMarker[] = [];
  /** Events in time order. */
  readonly events: SimEvent[] = [];
  /** Event times (seconds from the first frame), parallel to {@link events}. */
  readonly eventTimes: Float64Array;
  private readonly slotById = new Map<number, number>();
  private readonly pos: Float32Array;
  private readonly yaw: Float32Array;
  private readonly vel: Float32Array;
  private readonly state: Uint8Array;
  private readonly stateStart: Float32Array;
  private readonly flags: Uint8Array;
  private readonly misc: Uint8Array;
  private readonly present: Uint8Array;
  private readonly camKnown: Uint8Array;
  private readonly camMode: Uint8Array;
  private readonly camTarget: Int32Array;
  private readonly camYaw: Float32Array;
  private readonly camPitch: Float32Array;
  private readonly obstacles: ObstacleTrack[];

  /**
   * @param data - Recording (from the recorder or a validated file).
   * @throws {@link ReplayDecodeError} when the streams don't match the header.
   */
  constructor(data: ReplayData) {
    const h = data.header;
    this.header = h;
    const n = h.players.length;
    const f = h.frameCount;
    this.playerCount = n;
    this.frameCount = f;
    h.players.forEach((p, i) => this.slotById.set(p.id, i));
    this.times = new Float64Array(f);
    this.pos = new Float32Array(f * n * 3);
    this.yaw = new Float32Array(f * n);
    this.vel = new Float32Array(f * n * 3);
    this.state = new Uint8Array(f * n);
    this.stateStart = new Float32Array(f * n);
    this.flags = new Uint8Array(f * n);
    this.misc = new Uint8Array(f * n);
    this.present = new Uint8Array(f * n);
    this.camKnown = new Uint8Array(f);
    this.camMode = new Uint8Array(f);
    this.camTarget = new Int32Array(f);
    this.camYaw = new Float32Array(f);
    this.camPitch = new Float32Array(f);
    this.obstacles = h.obstacles.map(() => ({ frames: [], states: [] }));
    this.decodeFrames(data.frames);
    this.duration = f > 0 ? (this.times[f - 1] as number) : 0;
    this.eventTimes = new Float64Array(h.eventCount);
    this.decodeEvents(data.events);
  }

  // ---------------------------------------------------------------------------
  // Decoding
  // ---------------------------------------------------------------------------

  private decodeFrames(bytes: Uint8Array): void {
    const h = this.header;
    const n = this.playerCount;
    const r = new ByteReader(bytes);
    const q = {
      px: new Float64Array(n),
      py: new Float64Array(n),
      pz: new Float64Array(n),
      yaw: new Float64Array(n),
      vx: new Float64Array(n),
      vy: new Float64Array(n),
      vz: new Float64Array(n),
    };
    const state = new Uint8Array(n);
    const start = new Float32Array(n);
    const flags = new Uint8Array(n);
    const misc = new Uint8Array(n);
    const present = new Uint8Array(n);
    let camKnown = 0;
    let camMode = 0;
    let camTarget = -1;
    let camYaw = 0;
    let camPitch = 0;
    const netKind: number[] = h.obstacles.map(() => -1);
    const netLast: Float64Array[] = h.obstacles.map(() => new Float64Array(0));
    let ms = 0;
    for (let fi = 0; fi < this.frameCount; fi++) {
      ms += r.varint();
      const t = ms / 1000;
      this.times[fi] = t;

      const cm = r.u8();
      if (cm & CameraField.ModeTarget) {
        camMode = r.u8();
        camTarget = r.svarint();
        camKnown = 1;
      }
      if (cm & CameraField.Yaw) camYaw = (camYaw + r.svarint() + ANGLE_STEPS) % ANGLE_STEPS;
      if (cm & CameraField.Pitch) camPitch = (camPitch + r.svarint() + ANGLE_STEPS) % ANGLE_STEPS;
      this.camKnown[fi] = camKnown;
      this.camMode[fi] = camMode;
      this.camTarget[fi] = camTarget;
      this.camYaw[fi] = camYaw * ANGLE;
      // Pitch is small and may be negative: unwrap to (-π, π].
      this.camPitch[fi] = (camPitch > ANGLE_STEPS / 2 ? camPitch - ANGLE_STEPS : camPitch) * ANGLE;

      for (let s = 0; s < n; s++) {
        const mask = r.u8();
        if (mask & PlayerField.Presence) present[s] = present[s] ? 0 : 1;
        if (mask & PlayerField.Pos) {
          q.px[s] = (q.px[s] as number) + r.svarint();
          q.py[s] = (q.py[s] as number) + r.svarint();
          q.pz[s] = (q.pz[s] as number) + r.svarint();
        }
        if (mask & PlayerField.Yaw) q.yaw[s] = ((q.yaw[s] as number) + r.svarint() + ANGLE_STEPS) % ANGLE_STEPS;
        if (mask & PlayerField.Vel) {
          q.vx[s] = (q.vx[s] as number) + r.svarint();
          q.vy[s] = (q.vy[s] as number) + r.svarint();
          q.vz[s] = (q.vz[s] as number) + r.svarint();
        }
        if (mask & PlayerField.State) {
          state[s] = r.u8();
          start[s] = t - r.varint() / TIME_SCALE;
        }
        if (mask & PlayerField.Flags) flags[s] = r.u8();
        if (mask & PlayerField.Misc) misc[s] = r.u8();
        const k = fi * n + s;
        this.present[k] = present[s] as number;
        this.pos[k * 3] = (q.px[s] as number) / POS_SCALE;
        this.pos[k * 3 + 1] = (q.py[s] as number) / POS_SCALE;
        this.pos[k * 3 + 2] = (q.pz[s] as number) / POS_SCALE;
        this.yaw[k] = (q.yaw[s] as number) * ANGLE;
        this.vel[k * 3] = (q.vx[s] as number) / VEL_SCALE;
        this.vel[k * 3 + 1] = (q.vy[s] as number) / VEL_SCALE;
        this.vel[k * 3 + 2] = (q.vz[s] as number) / VEL_SCALE;
        this.state[k] = state[s] as number;
        this.stateStart[k] = start[s] as number;
        this.flags[k] = flags[s] as number;
        this.misc[k] = misc[s] as number;
      }

      const changed = r.varint();
      for (let c = 0; c < changed; c++) {
        const index = r.varint();
        const kind = r.u8();
        const len = r.varint();
        const track = this.obstacles[index];
        if (!track || (kind !== NetKind.Int && kind !== NetKind.Milli))
          throw new ReplayDecodeError(`Bad obstacle state ${index}`);
        const prev = netLast[index] as Float64Array;
        const comparable = netKind[index] === kind && prev.length === len;
        const next = new Float64Array(len);
        for (let v = 0; v < len; v++) next[v] = r.svarint() + (comparable ? (prev[v] as number) : 0);
        netKind[index] = kind;
        netLast[index] = next;
        const scale = kind === NetKind.Milli ? NET_MILLI_SCALE : 1;
        const out = scale === 1 ? next.slice() : next.map((v) => v / scale);
        track.frames.push(fi);
        track.states.push(out);
      }
    }
    if (!r.done) throw new ReplayDecodeError('Trailing frame data');
  }

  private decodeEvents(bytes: Uint8Array): void {
    const h = this.header;
    const r = new ByteReader(bytes);
    let cs = 0;
    for (let i = 0; i < h.eventCount; i++) {
      cs += r.varint();
      const t = cs / TIME_SCALE;
      const e = readEvent(r, h.strings);
      this.eventTimes[i] = t;
      this.events.push(e);
      if (e.type === 'eliminated' || e.type === 'qualified') {
        const local = e.player === h.localId;
        const kind: ReplayMarkerKind =
          e.type === 'eliminated'
            ? local
              ? 'localEliminated'
              : 'eliminated'
            : local
              ? 'localQualified'
              : 'qualified';
        this.markers.push({ t, kind, player: e.player });
      }
    }
    if (!r.done) throw new ReplayDecodeError('Trailing event data');
  }

  // ---------------------------------------------------------------------------
  // Lookup
  // ---------------------------------------------------------------------------

  /** Header slot of a player id, or -1. */
  slotOf(id: number): number {
    return this.slotById.get(id) ?? -1;
  }

  /**
   * Finds the samples around `t`.
   *
   * @param t - Seconds from the first frame (clamped).
   * @param out - Cursor to fill.
   */
  locate(t: number, out: TimelineCursor): TimelineCursor {
    const times = this.times;
    const last = this.frameCount - 1;
    const tc = Math.max(0, Math.min(this.duration, t));
    out.t = tc;
    if (last <= 0) {
      out.i = out.j = 0;
      out.a = 0;
      return out;
    }
    let lo = 0;
    let hi = last;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((times[mid] as number) <= tc) lo = mid;
      else hi = mid - 1;
    }
    out.i = lo;
    out.j = Math.min(last, lo + 1);
    const t0 = times[lo] as number;
    const t1 = times[out.j] as number;
    out.a = t1 > t0 ? (tc - t0) / (t1 - t0) : 0;
    return out;
  }

  /**
   * Interpolated rendered state of a player.
   *
   * @param slot - Header slot ({@link slotOf}).
   * @param c - Located cursor.
   * @param out - Filled in place.
   * @returns False when the player is absent at that time.
   */
  samplePlayer(slot: number, c: TimelineCursor, out: RecordablePlayer): boolean {
    const n = this.playerCount;
    if (slot < 0 || slot >= n) return false;
    const ki = c.i * n + slot;
    if (!this.present[ki]) return false;
    const kj = c.j * n + slot;
    const blend = this.present[kj] ? c.a : 0;
    const p = this.pos;
    const ix = ki * 3;
    const jx = kj * 3;
    const dx = (p[jx] as number) - (p[ix] as number);
    const dy = (p[jx + 1] as number) - (p[ix + 1] as number);
    const dz = (p[jx + 2] as number) - (p[ix + 2] as number);
    const teleport = Math.abs(dx) + Math.abs(dy) + Math.abs(dz) > TELEPORT_DIST;
    const a = teleport ? (blend < 0.5 ? 0 : 1) : blend;
    const k = a >= 1 ? kj : ki;
    out.x = (p[ix] as number) + dx * a;
    out.y = (p[ix + 1] as number) + dy * a;
    out.z = (p[ix + 2] as number) + dz * a;
    const v = this.vel;
    out.vx = (v[ix] as number) + ((v[jx] as number) - (v[ix] as number)) * a;
    out.vy = (v[ix + 1] as number) + ((v[jx + 1] as number) - (v[ix + 1] as number)) * a;
    out.vz = (v[ix + 2] as number) + ((v[jx + 2] as number) - (v[ix + 2] as number)) * a;
    out.facing = lerpAngle(this.yaw[ki] as number, this.yaw[kj] as number, a);
    out.state = this.state[k] as number;
    out.stateTime = Math.max(0, c.t - (this.stateStart[k] as number));
    out.flags = this.flags[k] as number;
    const m = this.misc[k] as number;
    out.grounded = (m & 1) !== 0;
    out.emote = (m >> 1) & 7;
    return true;
  }

  /**
   * The recorded live camera at a time.
   *
   * @returns False when no camera was recorded yet (spectated-only files, early frames).
   */
  sampleCamera(c: TimelineCursor, out: RecordableCamera): boolean {
    if (!this.camKnown[c.i]) return false;
    out.mode = this.camMode[c.i] as number;
    out.target = this.camTarget[c.i] as number;
    const same = this.camMode[c.j] === out.mode && this.camTarget[c.j] === out.target;
    const a = same ? c.a : 0;
    out.yaw = lerpAngle(this.camYaw[c.i] as number, this.camYaw[c.j] as number, a);
    out.pitch = (this.camPitch[c.i] as number) + ((this.camPitch[c.j] as number) - (this.camPitch[c.i] as number)) * a;
    return true;
  }

  /** Obstacle ids with replicated state (index = {@link obstacleState} index). */
  get obstacleIds(): readonly string[] {
    return this.header.obstacles;
  }

  /**
   * Replicated state of an obstacle at a frame.
   *
   * @param index - Obstacle index (header order).
   * @param frame - Frame index.
   * @returns The last state recorded at or before the frame, or null before the first.
   */
  obstacleState(index: number, frame: number): Float64Array | null {
    const tr = this.obstacles[index];
    if (!tr || tr.frames.length === 0) return null;
    const fr = tr.frames;
    if ((fr[0] as number) > frame) return null;
    let lo = 0;
    let hi = fr.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((fr[mid] as number) <= frame) lo = mid;
      else hi = mid - 1;
    }
    return tr.states[lo] as Float64Array;
  }

  /**
   * Index of the first event strictly after time `t`.
   *
   * @param t - Seconds from the first frame.
   */
  eventIndexAfter(t: number): number {
    const et = this.eventTimes;
    let lo = 0;
    let hi = et.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((et[mid] as number) <= t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /**
   * Calls `fn` for every event with `from < time ≤ to`.
   *
   * @param from - Exclusive start (seconds).
   * @param to - Inclusive end (seconds).
   * @param fn - Visitor.
   */
  forEachEvent(from: number, to: number, fn: (e: SimEvent, t: number) => void): void {
    const et = this.eventTimes;
    for (let i = this.eventIndexAfter(from); i < et.length && (et[i] as number) <= to; i++)
      fn(this.events[i] as SimEvent, et[i] as number);
  }
}
