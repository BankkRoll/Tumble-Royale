/**
 * Records what the local client renders during a round into the compact
 * replay streams (see docs/design/REPLAYS.md).
 *
 * Responsibilities:
 * - samples every player at {@link REPLAY_RATE} Hz of round time (position,
 *   yaw, character state, flags, emote) with quantisation and
 *   per-field delta encoding behind a change mask, so idle or eliminated
 *   players cost one byte a frame;
 * - records the live camera (mode, target, yaw, pitch) for the "your view"
 *   replay camera;
 * - records replicated obstacle net states only when they change (props,
 *   tiles, doors, tilt); time-driven obstacles need nothing but the clock;
 * - records every sim event with a centisecond timestamp;
 * - can hand out a snapshot mid-round (watching the round you were knocked
 *   out of) and a final recording with the outcome.
 *
 * Pure: it only sees a sampler callback, never the sim or the renderer.
 */
import type { SimEvent } from '@tumble/sim';
import { ByteWriter, writeZeroRuns } from './codec.ts';
import {
  ANGLE_STEPS,
  CameraField,
  GAME_VERSION,
  NET_FLOAT_SCALE,
  NetKind,
  POS_SCALE,
  PlayerField,
  REPLAY_FORMAT_VERSION,
  REPLAY_RATE,
  StringTable,
  TIME_SCALE,
  isRecordableEvent,
  writeEvent,
  type ReplayData,
  type ReplayHeader,
  type ReplayOutcome,
  type ReplayPlayer,
} from './format.ts';

/** The fields of one player's rendered state the recorder reads. */
export interface RecordablePlayer {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  state: number;
  stateTime: number;
  facing: number;
  grounded: boolean;
  flags: number;
  emote: number;
}

/** Fills `out` with a player's rendered state; false when the player is absent. */
export type PlayerSampler = (id: number, out: RecordablePlayer) => boolean;

/** The live camera at a sample (see {@link CameraModeCode}). */
export interface RecordableCamera {
  mode: number;
  /** Followed player, or -1. */
  target: number;
  yaw: number;
  pitch: number;
}

/** Header fields known when a round starts (the rest is filled in on output). */
export type ReplayMeta = Omit<
  ReplayHeader,
  | 'format'
  | 'gameVersion'
  | 'rate'
  | 'startTime'
  | 'obstacles'
  | 'strings'
  | 'frameCount'
  | 'eventCount'
  | 'duration'
  | 'outcome'
> & { players: ReplayPlayer[] };

const TAU = Math.PI * 2;
const HALF_TURN = ANGLE_STEPS / 2;

/** Quantised angle in [0, ANGLE_STEPS). */
function qAngle(a: number): number {
  const n = Math.round((a / TAU) * ANGLE_STEPS) % ANGLE_STEPS;
  return n < 0 ? n + ANGLE_STEPS : n;
}

/** Shortest wrapped difference of two quantised angles. */
function dAngle(next: number, prev: number): number {
  let d = next - prev;
  if (d >= HALF_TURN) d -= ANGLE_STEPS;
  else if (d < -HALF_TURN) d += ANGLE_STEPS;
  return d;
}

function qi(v: number, scale: number): number {
  return Number.isFinite(v) ? Math.round(v * scale) : 0;
}

/** Last value written per player (all quantised), so the next frame can send deltas. */
interface Track {
  present: boolean;
  px: number;
  py: number;
  pz: number;
  yaw: number;
  state: number;
  flags: number;
  misc: number;
}

interface NetTrack {
  kind: number;
  values: Float64Array;
  /** Change between the last two written states (second-order prediction). */
  delta: Float64Array;
}

/**
 * Round recorder. One per watched round.
 *
 * @example
 * const rec = new ReplayRecorder(meta);
 * // every rendered frame
 * if (rec.due(t)) rec.frame(t, (id, out) => source.sample(id, out), camera, sim.getObstacleNetStates());
 * // every sim event
 * rec.event(t, e);
 * const data = rec.finish({ qualified, eliminated });
 */
export class ReplayRecorder {
  readonly rate: number;
  private readonly frames = new ByteWriter(64 * 1024);
  private readonly events = new ByteWriter(16 * 1024);
  private readonly scratch = new ByteWriter(1024);
  private readonly strings = new StringTable();
  private readonly obstacleIds: string[] = [];
  private readonly obstacleIndex = new Map<string, number>();
  private readonly netTracks: (NetTrack | null)[] = [];
  private netScratch = new Float64Array(64);
  private netResidual = new Float64Array(64);
  private readonly tracks: Track[];
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
  private cam = { mode: -1, target: -2, yaw: 0, pitch: 0 };
  private startTime = Number.NaN;
  private lastTick = -1;
  /** Actual sample time of the last frame, in ms from the first. */
  private lastMs = 0;
  private frameCount = 0;
  private eventCount = 0;
  private lastEventCs = 0;
  private outcome: ReplayOutcome | null = null;
  private finished = false;
  private readonly recordedAt: string;

  /**
   * @param meta - Round, show and player info.
   * @param rate - Samples per second (default {@link REPLAY_RATE}).
   */
  constructor(
    readonly meta: ReplayMeta,
    rate = REPLAY_RATE,
  ) {
    this.rate = rate;
    this.recordedAt = meta.recordedAt;
    this.tracks = meta.players.map(() => ({
      present: false,
      px: 0,
      py: 0,
      pz: 0,
      yaw: 0,
      state: -1,
      flags: 0,
      misc: 0,
    }));
  }

  /** Frames recorded so far. */
  get recordedFrames(): number {
    return this.frameCount;
  }

  /** Seconds covered so far. */
  get duration(): number {
    return this.lastTick < 0 ? 0 : this.lastMs / 1000;
  }

  /** Encoded bytes so far (frames + events). */
  get byteLength(): number {
    return this.frames.length + this.events.length;
  }

  /** Bytes actually held in memory (writer capacities). */
  get memoryBytes(): number {
    return this.frames.capacity + this.events.capacity + this.scratch.capacity;
  }

  /** True once {@link finish} ran. */
  get closed(): boolean {
    return this.finished;
  }

  private tickOf(t: number): number {
    return Math.floor((t - this.startTime) * this.rate + 1e-6);
  }

  /**
   * Whether `t` has reached the next sample point (cheap; lets callers skip
   * gathering obstacle states on frames that won't be recorded).
   *
   * @param t - Current round time.
   */
  due(t: number): boolean {
    if (this.finished || !Number.isFinite(t)) return false;
    return Number.isNaN(this.startTime) || this.tickOf(t) > this.lastTick;
  }

  /**
   * Records one frame if `t` reached the next sample point.
   *
   * @param t - Round time being rendered.
   * @param sample - Player sampler.
   * @param camera - Live camera, or null when not known.
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
    this.write(t, sample, camera, obstacles);
    return true;
  }

  /**
   * Records a frame that was already sampled on a rate grid elsewhere (a
   * {@link ReplayTape} being turned into a recording): only time order is
   * enforced, since its sample times need not line up with this recorder's grid.
   *
   * @param t - Round time the frame was sampled at.
   * @param sample - Player sampler.
   * @param camera - Live camera, or null when not known.
   * @param obstacles - Replicated obstacle states by id, or null.
   * @returns True when a frame was written.
   */
  append(
    t: number,
    sample: PlayerSampler,
    camera: RecordableCamera | null,
    obstacles: ReadonlyMap<string, readonly number[]> | null,
  ): boolean {
    if (this.finished || !Number.isFinite(t)) return false;
    if (!Number.isNaN(this.startTime) && t + 5e-4 < this.startTime + this.lastMs / 1000) return false;
    this.write(t, sample, camera, obstacles);
    return true;
  }

  private write(
    t: number,
    sample: PlayerSampler,
    camera: RecordableCamera | null,
    obstacles: ReadonlyMap<string, readonly number[]> | null,
  ): void {
    if (Number.isNaN(this.startTime)) this.startTime = t;
    // Frames are due on the rate grid but stamped with the real sample time, so
    // irregular frame pacing (or a late frame) never shifts the recorded state in time.
    const ms = Math.max(this.lastMs, Math.round((t - this.startTime) * 1000));
    const w = this.frames;
    w.varint(this.lastTick < 0 ? 0 : ms - this.lastMs);
    this.lastTick = this.tickOf(t);
    this.lastMs = ms;
    this.writeCamera(camera);
    const s = this.sampleOut;
    const players = this.meta.players;
    for (let i = 0; i < players.length; i++) {
      const ok = sample((players[i] as ReplayPlayer).id, s);
      this.writePlayer(this.tracks[i] as Track, ok, s);
    }
    this.writeObstacles(obstacles);
    this.frameCount++;
  }

  private writeCamera(c: RecordableCamera | null): void {
    const w = this.frames;
    const cam = this.cam;
    if (!c) {
      w.u8(0);
      return;
    }
    const yaw = qAngle(c.yaw);
    const pitch = qAngle(c.pitch);
    let mask = 0;
    if (c.mode !== cam.mode || c.target !== cam.target) mask |= CameraField.ModeTarget;
    if (yaw !== cam.yaw) mask |= CameraField.Yaw;
    if (pitch !== cam.pitch) mask |= CameraField.Pitch;
    w.u8(mask);
    if (mask & CameraField.ModeTarget) {
      w.u8(c.mode);
      w.svarint(c.target);
      cam.mode = c.mode;
      cam.target = c.target;
    }
    if (mask & CameraField.Yaw) w.svarint(dAngle(yaw, cam.yaw));
    if (mask & CameraField.Pitch) w.svarint(dAngle(pitch, cam.pitch));
    cam.yaw = yaw;
    cam.pitch = pitch;
  }

  private writePlayer(tr: Track, ok: boolean, s: RecordablePlayer): void {
    const w = this.frames;
    if (!ok) {
      if (tr.present) {
        tr.present = false;
        w.u8(PlayerField.Presence);
      } else w.u8(0);
      return;
    }
    const px = qi(s.x, POS_SCALE);
    const py = qi(s.y, POS_SCALE);
    const pz = qi(s.z, POS_SCALE);
    const yaw = qAngle(s.facing);
    const misc = (s.grounded ? 1 : 0) | ((s.emote & 7) << 1);
    let mask = 0;
    if (!tr.present) mask |= PlayerField.Presence;
    if (px !== tr.px || py !== tr.py || pz !== tr.pz) mask |= PlayerField.Pos;
    if (yaw !== tr.yaw) mask |= PlayerField.Yaw;
    if (s.state !== tr.state) mask |= PlayerField.State;
    if ((s.flags & 0xff) !== tr.flags) mask |= PlayerField.Flags;
    if (misc !== tr.misc) mask |= PlayerField.Misc;
    w.u8(mask);
    if (mask & PlayerField.Pos) {
      w.svarint(px - tr.px);
      w.svarint(py - tr.py);
      w.svarint(pz - tr.pz);
    }
    if (mask & PlayerField.Yaw) w.svarint(dAngle(yaw, tr.yaw));
    if (mask & PlayerField.State) {
      w.u8(s.state & 0xff);
      w.varint(Math.max(0, qi(s.stateTime, TIME_SCALE)));
    }
    if (mask & PlayerField.Flags) w.u8(s.flags & 0xff);
    if (mask & PlayerField.Misc) w.u8(misc);
    tr.present = true;
    tr.px = px;
    tr.py = py;
    tr.pz = pz;
    tr.yaw = yaw;
    tr.state = s.state;
    tr.flags = s.flags & 0xff;
    tr.misc = misc;
  }

  private writeObstacles(states: ReadonlyMap<string, readonly number[]> | null): void {
    const out = this.scratch;
    out.reset();
    let changed = 0;
    if (states) {
      for (const [id, values] of states) {
        let index = this.obstacleIndex.get(id);
        if (index === undefined) {
          index = this.obstacleIds.length;
          this.obstacleIds.push(id);
          this.obstacleIndex.set(id, index);
          this.netTracks.push(null);
        }
        if (this.writeNet(out, index, values)) changed++;
      }
    }
    this.frames.varint(changed);
    if (changed > 0) this.frames.bytes(out.view());
  }

  /** Writes one obstacle's state when it differs from the last written one. */
  private writeNet(out: ByteWriter, index: number, values: readonly number[]): boolean {
    const n = values.length;
    if (this.netScratch.length < n)
      this.netScratch = new Float64Array(Math.max(n, this.netScratch.length * 2));
    const qv = this.netScratch;
    let kind: number = NetKind.Int;
    for (let i = 0; i < n; i++) {
      const v = values[i] as number;
      if (Number.isFinite(v) && !Number.isInteger(v)) {
        kind = NetKind.Float;
        break;
      }
    }
    const scale = kind === NetKind.Float ? NET_FLOAT_SCALE : 1;
    for (let i = 0; i < n; i++) {
      const v = Math.round((values[i] as number) * scale);
      qv[i] = Number.isSafeInteger(v) ? v : 0;
    }
    const prev = this.netTracks[index] ?? null;
    const comparable = !!prev && prev.kind === kind && prev.values.length === n;
    if (comparable) {
      let same = true;
      for (let i = 0; i < n; i++)
        if (prev.values[i] !== qv[i]) {
          same = false;
          break;
        }
      if (same) return false;
    }
    out.varint(index);
    out.u8(kind);
    out.varint(n);
    if (this.netResidual.length < n) this.netResidual = new Float64Array(this.netScratch.length);
    const res = this.netResidual;
    // Counters such as "ticks since" rise by the same step every sample: predicting
    // last value + last change turns them (and anything at rest) into zero runs.
    for (let i = 0; i < n; i++) {
      const q = qv[i] as number;
      res[i] = comparable ? q - (prev.values[i] as number) - (prev.delta[i] as number) : q;
    }
    writeZeroRuns(out, res, n);
    if (comparable) {
      for (let i = 0; i < n; i++) prev.delta[i] = (qv[i] as number) - (prev.values[i] as number);
      prev.values.set(qv.subarray(0, n));
    } else this.netTracks[index] = { kind, values: qv.slice(0, n), delta: new Float64Array(n) };
    return true;
  }

  /**
   * Records a sim event at round time `t`. Events before the first frame (or
   * of kinds without an encoding) are dropped.
   *
   * @param t - Round time the event was rendered at.
   * @param e - Event.
   */
  event(t: number, e: SimEvent): void {
    if (this.finished || Number.isNaN(this.startTime) || !isRecordableEvent(e)) return;
    const cs = Math.max(this.lastEventCs, Math.round((t - this.startTime) * TIME_SCALE));
    this.events.varint(cs - this.lastEventCs);
    this.lastEventCs = cs;
    writeEvent(this.events, e, this.strings);
    this.eventCount++;
  }

  private header(): ReplayHeader {
    return {
      ...this.meta,
      format: REPLAY_FORMAT_VERSION,
      gameVersion: GAME_VERSION,
      recordedAt: this.recordedAt,
      rate: this.rate,
      startTime: Number.isNaN(this.startTime) ? 0 : this.startTime,
      players: this.meta.players,
      obstacles: this.obstacleIds.slice(),
      strings: this.strings.list.slice(),
      frameCount: this.frameCount,
      eventCount: this.eventCount,
      duration: this.duration,
      outcome: this.outcome,
    };
  }

  /**
   * The recording so far, without closing it (copies the streams).
   *
   * @returns Null before the first frame.
   */
  snapshot(): ReplayData | null {
    if (this.frameCount === 0) return null;
    return { header: this.header(), frames: this.frames.snapshot(), events: this.events.snapshot() };
  }

  /**
   * Closes the recording.
   *
   * @param outcome - Round result (null when unknown, e.g. the player left).
   * @returns The recording, or null when no frame was ever captured.
   */
  finish(outcome: ReplayOutcome | null): ReplayData | null {
    if (this.finished) return null;
    this.outcome = outcome;
    const data = this.snapshot();
    this.finished = true;
    // Release the growable buffers; the returned copy is right-sized.
    this.frames.finish();
    this.events.finish();
    this.scratch.finish();
    return data;
  }
}
