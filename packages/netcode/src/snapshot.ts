/**
 * Snapshot encoding: quantised entity tables, per-client delta compression
 * against the client's last acknowledged snapshot, and interest management
 * under a per-packet byte budget.
 *
 * Model. Both peers keep a ring of "views" — the full quantised world as the
 * client knows it after decoding snapshot N. A snapshot names a baseline B (the
 * newest snapshot the client acked) and carries:
 *   - entities removed since B,
 *   - entities whose quantised record differs from B, each with a changed-field
 *     mask (or a full record if B does not have the entity),
 *   - obstacle net states whose version differs from B.
 * Entities that are unchanged, or that the priority accumulator defers, are
 * simply absent: view N = view B + included updates, identically on both sides.
 *
 * Interest. Each (client, entity) pair accumulates priority every snapshot: the
 * receiver's own player and spectate target are always sent; entities near the
 * receiver and race leaders accrue 1/snapshot (full rate); distant ones accrue
 * less (down to `minPriority`, i.e. ~5 Hz). Due entities are written highest
 * accumulator first until the byte budget is reached; the rest roll over.
 */
import type { CharacterFullState } from '@tumble/sim';
import type { Quat, Vec3 } from '@tumble/shared';
import { MAX_PLAYERS, SIM_DT, SIM_STEPS_PER_TICK } from '@tumble/shared';
import type { BitReader, BitWriter } from './bits.ts';
import { MsgType } from './protocol.ts';
import {
  dequantizeVelocity,
  dequantizeYaw,
  isYawOnly,
  packQuat,
  quantizeVelocity,
  quantizeYaw,
  quatFromYawInto,
  unpackQuat,
  yawOf,
  POSITION_BITS,
  QUAT_BITS,
  VELOCITY_BITS,
  YAW_BITS,
} from './quantize.ts';
import type { PositionQuantizer } from './quantize.ts';

// -----------------------------------------------------------------------------
// Layout
// -----------------------------------------------------------------------------

/** Bits for an entity id: the narrowest width that addresses every show seat. */
export const ENTITY_ID_BITS = Math.ceil(Math.log2(MAX_PLAYERS));
/**
 * Entity ids are player ids in [0, MAX_ENTITIES): the whole id space of
 * {@link ENTITY_ID_BITS}, so any id read off the wire indexes the tables safely.
 */
export const MAX_ENTITIES = 1 << ENTITY_ID_BITS;
/** Bits for the removal count, which can be every entity at once. */
const REMOVED_COUNT_BITS = ENTITY_ID_BITS + 1;
/** Snapshot views kept for delta baselines (≈1 s at 30 Hz). */
export const SNAPSHOT_HISTORY = 32;
/** Bits for "snapshots since baseline" (0 = no baseline). */
export const BASELINE_AGE_BITS = 5;
/** Bits for the character state id. */
export const STATE_BITS = 5;
/** Bits for "sim ticks since the state began"; the max value means "≥ 68 s". */
export const STATE_AGE_BITS = 12;
const STATE_AGE_MAX = (1 << STATE_AGE_BITS) - 1;
/** Bits for the character flags. */
export const FLAGS_BITS = 8;
/** Bits for the grab target when present. */
export const GRAB_BITS = 16;
/** Default per-snapshot byte budget. */
export const SNAPSHOT_BYTE_BUDGET = 1200;

/** Changed-field mask bits. */
export const EntityField = {
  Pos: 1 << 0,
  Rot: 1 << 1,
  Vel: 1 << 2,
  State: 1 << 3,
  Facing: 1 << 4,
  Flags: 1 << 5,
  Grab: 1 << 6,
} as const;
const FIELD_MASK_BITS = 7;
const ALL_FIELDS = (1 << FIELD_MASK_BITS) - 1;

// Int32 record layout per entity.
const PX = 0;
const PY = 1;
const PZ = 2;
const ROTK = 3;
const ROT = 4;
const VX = 5;
const VY = 6;
const VZ = 7;
const STATE = 8;
const START = 9;
const FACING = 10;
const FLAGS = 11;
const GRAB = 12;
/** Int32 slots per entity record. */
export const ENTITY_STRIDE = 13;

/** The replicated subset of {@link CharacterFullState}. */
export type NetEntitySource = Pick<
  CharacterFullState,
  'pos' | 'rot' | 'vel' | 'state' | 'stateTime' | 'facing' | 'flags' | 'grabTarget'
>;

/** A decoded entity, in world units. */
export interface NetEntityState {
  id: number;
  pos: Vec3;
  rot: Quat;
  vel: Vec3;
  state: number;
  /** Seconds in the current state as of the snapshot. */
  stateTime: number;
  facing: number;
  flags: number;
  /** Grab target id or -1. */
  grabTarget: number;
}

/** @returns A zeroed entity state (preallocate these; decoders fill them in place). */
export function createNetEntityState(): NetEntityState {
  return {
    id: 0,
    pos: { x: 0, y: 0, z: 0 },
    rot: { x: 0, y: 0, z: 0, w: 1 },
    vel: { x: 0, y: 0, z: 0 },
    state: 0,
    stateTime: 0,
    facing: 0,
    flags: 0,
    grabTarget: -1,
  };
}

/** Copies every field of `src` into `dst`. */
export function copyNetEntityState(src: NetEntityState, dst: NetEntityState): NetEntityState {
  dst.id = src.id;
  dst.pos.x = src.pos.x;
  dst.pos.y = src.pos.y;
  dst.pos.z = src.pos.z;
  dst.rot.x = src.rot.x;
  dst.rot.y = src.rot.y;
  dst.rot.z = src.rot.z;
  dst.rot.w = src.rot.w;
  dst.vel.x = src.vel.x;
  dst.vel.y = src.vel.y;
  dst.vel.z = src.vel.z;
  dst.state = src.state;
  dst.stateTime = src.stateTime;
  dst.facing = src.facing;
  dst.flags = src.flags;
  dst.grabTarget = src.grabTarget;
  return dst;
}

/** Global sim tick at which the snapshot for `serverTick` is taken (after both steps of the tick). */
export function simTickOf(serverTick: number): number {
  return serverTick * SIM_STEPS_PER_TICK;
}

/** Summary of round progress carried in every snapshot (~6 bytes). */
export interface NetRoundStatus {
  phase: number;
  /** Seconds left, -1 when untimed; 0.1 s resolution. */
  timeLeft: number;
  qualifiedCount: number;
  qualifyTarget: number;
  eliminatedCount: number;
  finished: boolean;
  /** Team scores (first `teamCount` entries are valid). */
  teamScores: number[];
  teamCount: number;
}

/** @returns A zeroed round status. */
export function createNetRoundStatus(): NetRoundStatus {
  return {
    phase: 0,
    timeLeft: -1,
    qualifiedCount: 0,
    qualifyTarget: 0,
    eliminatedCount: 0,
    finished: false,
    teamScores: [0, 0, 0, 0, 0, 0, 0],
    teamCount: 0,
  };
}

// -----------------------------------------------------------------------------
// Entity table (the authoritative "now", quantised once per tick)
// -----------------------------------------------------------------------------

/**
 * Quantised entity records indexed by entity id. The server fills one per tick
 * from the sim; snapshot views are rings of the same layout.
 */
export class EntityTable {
  readonly data = new Int32Array(MAX_ENTITIES * ENTITY_STRIDE);
  readonly present = new Uint8Array(MAX_ENTITIES);

  /** Marks every entity absent. */
  clear(): void {
    this.present.fill(0);
  }

  /** Removes one entity. */
  remove(id: number): void {
    if (id >= 0 && id < MAX_ENTITIES) this.present[id] = 0;
  }

  /**
   * Quantises a character state into the record for `id`.
   *
   * @param simTick - Global sim tick of the state (see {@link simTickOf}); anchors `stateTime`.
   */
  set(id: number, s: NetEntitySource, q: PositionQuantizer, simTick: number): void {
    if (id < 0 || id >= MAX_ENTITIES) return;
    const d = this.data;
    const o = id * ENTITY_STRIDE;
    d[o + PX] = q.qx(s.pos.x);
    d[o + PY] = q.qy(s.pos.y);
    d[o + PZ] = q.qz(s.pos.z);
    if (isYawOnly(s.rot)) {
      d[o + ROTK] = 0;
      d[o + ROT] = quantizeYaw(yawOf(s.rot));
    } else {
      d[o + ROTK] = 1;
      d[o + ROT] = packQuat(s.rot) | 0;
    }
    d[o + VX] = quantizeVelocity(s.vel.x);
    d[o + VY] = quantizeVelocity(s.vel.y);
    d[o + VZ] = quantizeVelocity(s.vel.z);
    d[o + STATE] = s.state & ((1 << STATE_BITS) - 1);
    const age = Math.max(0, Math.round(s.stateTime / SIM_DT));
    // Long-running states collapse to a sentinel so the record stops changing (no per-snapshot cost).
    d[o + START] = age >= STATE_AGE_MAX ? -1 : simTick - age;
    d[o + FACING] = quantizeYaw(s.facing);
    d[o + FLAGS] = s.flags & ((1 << FLAGS_BITS) - 1);
    d[o + GRAB] = s.grabTarget < 0 ? 0 : Math.min(s.grabTarget + 1, (1 << GRAB_BITS) - 1);
    this.present[id] = 1;
  }

  /** Dequantises the record for `id` into `out`. */
  get(id: number, q: PositionQuantizer, simTick: number, out: NetEntityState): NetEntityState {
    return decodeRecord(this.data, id * ENTITY_STRIDE, id, q, simTick, out);
  }
}

function decodeRecord(
  d: Int32Array,
  o: number,
  id: number,
  q: PositionQuantizer,
  simTick: number,
  out: NetEntityState,
): NetEntityState {
  out.id = id;
  q.dequantize(d[o + PX]!, d[o + PY]!, d[o + PZ]!, out.pos);
  if (d[o + ROTK] === 0) quatFromYawInto(dequantizeYaw(d[o + ROT]!), out.rot);
  else unpackQuat(d[o + ROT]! >>> 0, out.rot);
  out.vel.x = dequantizeVelocity(d[o + VX]!);
  out.vel.y = dequantizeVelocity(d[o + VY]!);
  out.vel.z = dequantizeVelocity(d[o + VZ]!);
  out.state = d[o + STATE]!;
  const start = d[o + START]!;
  out.stateTime = start === -1 ? STATE_AGE_MAX * SIM_DT : Math.max(0, simTick - start) * SIM_DT;
  out.facing = dequantizeYaw(d[o + FACING]!);
  out.flags = d[o + FLAGS]!;
  out.grabTarget = d[o + GRAB]! - 1;
  return out;
}

function diffMask(a: Int32Array, oa: number, b: Int32Array, ob: number): number {
  let m = 0;
  if (a[oa + PX] !== b[ob + PX] || a[oa + PY] !== b[ob + PY] || a[oa + PZ] !== b[ob + PZ])
    m |= EntityField.Pos;
  if (a[oa + ROTK] !== b[ob + ROTK] || a[oa + ROT] !== b[ob + ROT]) m |= EntityField.Rot;
  if (a[oa + VX] !== b[ob + VX] || a[oa + VY] !== b[ob + VY] || a[oa + VZ] !== b[ob + VZ])
    m |= EntityField.Vel;
  if (a[oa + STATE] !== b[ob + STATE] || a[oa + START] !== b[ob + START]) m |= EntityField.State;
  if (a[oa + FACING] !== b[ob + FACING]) m |= EntityField.Facing;
  if (a[oa + FLAGS] !== b[ob + FLAGS]) m |= EntityField.Flags;
  if (a[oa + GRAB] !== b[ob + GRAB]) m |= EntityField.Grab;
  return m;
}

function writeFields(w: BitWriter, d: Int32Array, o: number, mask: number, simTick: number): void {
  if (mask & EntityField.Pos) {
    w.writeBits(d[o + PX]!, POSITION_BITS);
    w.writeBits(d[o + PY]!, POSITION_BITS);
    w.writeBits(d[o + PZ]!, POSITION_BITS);
  }
  if (mask & EntityField.Rot) {
    const full = d[o + ROTK] === 1;
    w.writeBool(full);
    w.writeBits(d[o + ROT]! >>> 0, full ? QUAT_BITS : YAW_BITS);
  }
  if (mask & EntityField.Vel) {
    w.writeBits(d[o + VX]!, VELOCITY_BITS);
    w.writeBits(d[o + VY]!, VELOCITY_BITS);
    w.writeBits(d[o + VZ]!, VELOCITY_BITS);
  }
  if (mask & EntityField.State) {
    w.writeBits(d[o + STATE]!, STATE_BITS);
    const start = d[o + START]!;
    const age = start === -1 ? STATE_AGE_MAX : Math.min(STATE_AGE_MAX - 1, Math.max(0, simTick - start));
    w.writeBits(age, STATE_AGE_BITS);
  }
  if (mask & EntityField.Facing) w.writeBits(d[o + FACING]!, YAW_BITS);
  if (mask & EntityField.Flags) w.writeBits(d[o + FLAGS]!, FLAGS_BITS);
  if (mask & EntityField.Grab) {
    const g = d[o + GRAB]!;
    w.writeBool(g !== 0);
    if (g !== 0) w.writeBits(g, GRAB_BITS);
  }
}

function readFields(r: BitReader, d: Int32Array, o: number, mask: number, simTick: number): void {
  if (mask & EntityField.Pos) {
    d[o + PX] = r.readBits(POSITION_BITS);
    d[o + PY] = r.readBits(POSITION_BITS);
    d[o + PZ] = r.readBits(POSITION_BITS);
  }
  if (mask & EntityField.Rot) {
    const full = r.readBool();
    d[o + ROTK] = full ? 1 : 0;
    d[o + ROT] = r.readBits(full ? QUAT_BITS : YAW_BITS) | 0;
  }
  if (mask & EntityField.Vel) {
    d[o + VX] = r.readBits(VELOCITY_BITS);
    d[o + VY] = r.readBits(VELOCITY_BITS);
    d[o + VZ] = r.readBits(VELOCITY_BITS);
  }
  if (mask & EntityField.State) {
    d[o + STATE] = r.readBits(STATE_BITS);
    const age = r.readBits(STATE_AGE_BITS);
    d[o + START] = age === STATE_AGE_MAX ? -1 : simTick - age;
  }
  if (mask & EntityField.Facing) d[o + FACING] = r.readBits(YAW_BITS);
  if (mask & EntityField.Flags) d[o + FLAGS] = r.readBits(FLAGS_BITS);
  if (mask & EntityField.Grab) d[o + GRAB] = r.readBool() ? r.readBits(GRAB_BITS) : 0;
}

// -----------------------------------------------------------------------------
// Obstacles
// -----------------------------------------------------------------------------

/**
 * Replicated non-pure obstacle states (falling tiles, tilt platforms, props),
 * indexed by the order sent to clients in `joinRound.obstacleIds`. A version
 * counter per obstacle bumps whenever its values change, so snapshots only carry
 * obstacles the client's baseline has an older version of.
 */
export class ObstacleTable {
  readonly ids: readonly string[];
  readonly versions: Uint32Array;
  readonly values: number[][];
  private readonly index = new Map<string, number>();

  /** @param ids - Obstacle ids in wire order. */
  constructor(ids: readonly string[]) {
    this.ids = ids;
    this.versions = new Uint32Array(ids.length);
    this.values = ids.map(() => []);
    ids.forEach((id, i) => this.index.set(id, i));
  }

  /** Wire index of an obstacle id, or -1. */
  indexOf(id: string): number {
    return this.index.get(id) ?? -1;
  }

  /**
   * Copies current states from the sim and bumps versions of changed ones.
   *
   * @returns Number of obstacles in `states` unknown to this table (should be 0).
   */
  update(states: ReadonlyMap<string, readonly number[]>): number {
    let unknown = 0;
    for (const [id, vals] of states) {
      const i = this.index.get(id);
      if (i === undefined) {
        unknown++;
        continue;
      }
      const cur = this.values[i]!;
      let same = cur.length === vals.length && this.versions[i] !== 0;
      for (let k = 0; same && k < vals.length; k++) if (cur[k] !== vals[k]) same = false;
      if (same) continue;
      cur.length = vals.length;
      for (let k = 0; k < vals.length; k++) cur[k] = vals[k]!;
      this.versions[i] = this.versions[i]! + 1;
    }
    return unknown;
  }
}

const MAX_OBSTACLE_VALUES = 64;

function writeObstacleValues(w: BitWriter, vals: readonly number[]): void {
  const n = Math.min(vals.length, MAX_OBSTACLE_VALUES);
  w.writeVarUint(n);
  for (let k = 0; k < n; k++) {
    const v = vals[k]!;
    if (Number.isInteger(v) && v > -1073741824 && v < 1073741824) {
      w.writeBool(false);
      w.writeVarInt(v);
    } else {
      w.writeBool(true);
      w.writeFloat32(v);
    }
  }
}

function readObstacleValues(r: BitReader, out: number[]): void {
  const n = Math.min(r.readVarUint(), MAX_OBSTACLE_VALUES);
  out.length = n;
  for (let k = 0; k < n; k++) out[k] = r.readBool() ? r.readFloat32() : r.readVarInt();
}

// -----------------------------------------------------------------------------
// Header & status
// -----------------------------------------------------------------------------

function writeStatus(w: BitWriter, s: NetRoundStatus): void {
  w.writeBits(s.phase, 4);
  w.writeBool(s.finished);
  w.writeVarUint(s.timeLeft < 0 ? 0 : Math.round(s.timeLeft * 10) + 1);
  w.writeUint(s.qualifiedCount, 8);
  w.writeUint(s.qualifyTarget, 8);
  w.writeUint(s.eliminatedCount, 8);
  const n = Math.min(s.teamCount, 7);
  w.writeBits(n, 3);
  for (let i = 0; i < n; i++) w.writeVarInt(Math.round(s.teamScores[i] ?? 0));
}

function readStatus(r: BitReader, s: NetRoundStatus): void {
  s.phase = r.readBits(4);
  s.finished = r.readBool();
  const t = r.readVarUint();
  s.timeLeft = t === 0 ? -1 : (t - 1) / 10;
  s.qualifiedCount = r.readBits(8);
  s.qualifyTarget = r.readBits(8);
  s.eliminatedCount = r.readBits(8);
  s.teamCount = r.readBits(3);
  for (let i = 0; i < s.teamCount; i++) s.teamScores[i] = r.readVarInt();
}

// -----------------------------------------------------------------------------
// View ring (shared by encoder and decoder)
// -----------------------------------------------------------------------------

class ViewRing {
  readonly ids = new Int32Array(SNAPSHOT_HISTORY).fill(-1);
  readonly data = new Int32Array(SNAPSHOT_HISTORY * MAX_ENTITIES * ENTITY_STRIDE);
  readonly present = new Uint8Array(SNAPSHOT_HISTORY * MAX_ENTITIES);
  readonly obsVer: Uint32Array;
  readonly obstacleCount: number;

  constructor(obstacleCount: number) {
    this.obstacleCount = obstacleCount;
    this.obsVer = new Uint32Array(SNAPSHOT_HISTORY * Math.max(1, obstacleCount));
  }

  find(snapshotId: number): number {
    const slot = snapshotId % SNAPSHOT_HISTORY;
    return this.ids[slot] === snapshotId ? slot : -1;
  }

  /** Initialises `slot` for `snapshotId` as a copy of `baseSlot` (or empty when -1). */
  begin(slot: number, snapshotId: number, baseSlot: number): void {
    const stride = MAX_ENTITIES * ENTITY_STRIDE;
    const ostride = Math.max(1, this.obstacleCount);
    if (baseSlot >= 0 && baseSlot !== slot) {
      this.data.copyWithin(slot * stride, baseSlot * stride, (baseSlot + 1) * stride);
      this.present.copyWithin(slot * MAX_ENTITIES, baseSlot * MAX_ENTITIES, (baseSlot + 1) * MAX_ENTITIES);
      this.obsVer.copyWithin(slot * ostride, baseSlot * ostride, (baseSlot + 1) * ostride);
    } else if (baseSlot < 0) {
      this.present.fill(0, slot * MAX_ENTITIES, (slot + 1) * MAX_ENTITIES);
      this.obsVer.fill(0, slot * ostride, (slot + 1) * ostride);
    }
    this.ids[slot] = snapshotId;
  }

  reset(): void {
    this.ids.fill(-1);
  }
}

const SNAPSHOT_ID_MOD = 65536;

/** Snapshots between `baseline` and `current` under 16-bit wraparound. */
function snapshotAge(current: number, baseline: number): number {
  return (current - baseline + SNAPSHOT_ID_MOD) % SNAPSHOT_ID_MOD;
}

// -----------------------------------------------------------------------------
// Encoder (server, one per client)
// -----------------------------------------------------------------------------

/** World state for one snapshot, shared by every client's encoder that tick. */
export interface SnapshotFrame {
  /** 16-bit wrapping snapshot id. */
  snapshotId: number;
  serverTick: number;
  /** Round epoch; changes reset every baseline. */
  epoch: number;
  /** Match time in seconds after this tick's steps. */
  matchTime: number;
  entities: EntityTable;
  obstacles: ObstacleTable;
  status: NetRoundStatus;
  /** Entity ids at the front of the standings (always full rate). */
  leaders: ArrayLike<number>;
  quantizer: PositionQuantizer;
}

/** The receiving client, for interest management and prediction acks. */
export interface SnapshotViewer {
  /** The client's own entity id, or -1 when it has none (pure spectator). */
  playerId: number;
  /** Entity the client is spectating, or -1. */
  spectateTarget: number;
  /** Last input sequence the server consumed for this client, or -1. */
  ackedInputSeq: number;
  /**
   * World point a free spectator camera looks at (v7 `spectate.focus`), or
   * null. Distance priority is measured from it when the viewer has neither
   * an entity of its own nor a spectate target, so a free camera gets the
   * Tumblers around it at full rate instead of every one at the floor rate.
   */
  focus?: { x: number; y: number; z: number } | null;
}

/** Tuning for {@link SnapshotEncoder}. */
export interface SnapshotEncoderOptions {
  /** Soft packet size limit in bytes. */
  byteBudget?: number;
  /** Entities within this radius (m) of the viewer accrue full priority. */
  nearRadius?: number;
  /** Floor of the per-snapshot priority for distant entities (1 = every snapshot). */
  minPriority?: number;
  /** Number of obstacles in the round's {@link ObstacleTable}. */
  obstacleCount?: number;
}

/** Statistics of the last {@link SnapshotEncoder.encode}. */
export interface SnapshotEncodeStats {
  bytes: number;
  entitiesWritten: number;
  entitiesDeferred: number;
  obstaclesWritten: number;
  baselineAge: number;
}

/**
 * Builds delta-compressed, priority-filtered snapshots for one client.
 * Allocation-free after construction.
 */
export class SnapshotEncoder {
  private views: ViewRing;
  private readonly accum = new Float32Array(MAX_ENTITIES);
  private readonly order = new Int32Array(MAX_ENTITIES);
  private readonly masks = new Int32Array(MAX_ENTITIES);
  private readonly byteBudget: number;
  private readonly nearRadius: number;
  private readonly minPriority: number;
  private ackedId = -1;
  private epoch = -1;
  /** Stats of the most recent encode. */
  readonly stats: SnapshotEncodeStats = {
    bytes: 0,
    entitiesWritten: 0,
    entitiesDeferred: 0,
    obstaclesWritten: 0,
    baselineAge: 0,
  };

  /** @param opts - Optional tuning. */
  constructor(opts: SnapshotEncoderOptions = {}) {
    this.byteBudget = opts.byteBudget ?? SNAPSHOT_BYTE_BUDGET;
    this.nearRadius = opts.nearRadius ?? 20;
    this.minPriority = opts.minPriority ?? 0.17;
    this.views = new ViewRing(opts.obstacleCount ?? 0);
  }

  /** Forgets every baseline: the next snapshot is a full one (new round, resumed session). */
  reset(obstacleCount = this.views.obstacleCount): void {
    if (obstacleCount !== this.views.obstacleCount) this.views = new ViewRing(obstacleCount);
    else this.views.reset();
    this.ackedId = -1;
    this.accum.fill(0);
  }

  /** Records the client's newest decoded snapshot id (from its InputBatch). */
  ack(snapshotId: number): void {
    if (snapshotId < 0 || this.views.find(snapshotId) < 0) return;
    if (this.ackedId < 0 || seqNewer16(snapshotId, this.ackedId)) this.ackedId = snapshotId;
  }

  /**
   * Writes one snapshot for this client.
   *
   * @param w - A reset writer.
   * @param frame - The shared world state for this tick.
   * @param viewer - Who is receiving it.
   * @returns Stats (also kept in {@link stats}).
   */
  encode(w: BitWriter, frame: SnapshotFrame, viewer: SnapshotViewer): SnapshotEncodeStats {
    if (frame.epoch !== this.epoch) {
      this.reset(frame.obstacles.ids.length);
      this.epoch = frame.epoch;
    }
    const views = this.views;
    const simTick = simTickOf(frame.serverTick);
    let baseSlot = -1;
    let baseAge = 0;
    if (this.ackedId >= 0) {
      baseAge = snapshotAge(frame.snapshotId, this.ackedId);
      baseSlot = baseAge > 0 && baseAge < SNAPSHOT_HISTORY ? views.find(this.ackedId) : -1;
      if (baseSlot < 0) baseAge = 0;
    }
    const slot = frame.snapshotId % SNAPSHOT_HISTORY;
    views.begin(slot, frame.snapshotId, baseSlot);

    w.writeBits(MsgType.Snapshot, 8);
    w.writeBits(frame.snapshotId, 16);
    w.writeBits(frame.serverTick, 32);
    w.writeBits(frame.epoch & 0xff, 8);
    w.writeBits(baseAge, BASELINE_AGE_BITS);
    w.writeBool(viewer.ackedInputSeq >= 0);
    if (viewer.ackedInputSeq >= 0) w.writeBits(viewer.ackedInputSeq, 32);
    w.writeFloat32(frame.matchTime);
    writeStatus(w, frame.status);

    const cur = frame.entities;
    const vd = views.data;
    const vp = views.present;
    const viewBase = slot * MAX_ENTITIES;

    // Removals.
    let removed = 0;
    for (let id = 0; id < MAX_ENTITIES; id++) if (vp[viewBase + id] && !cur.present[id]) removed++;
    w.writeBits(removed, REMOVED_COUNT_BITS);
    for (let id = 0; id < MAX_ENTITIES && removed > 0; id++) {
      if (vp[viewBase + id] && !cur.present[id]) {
        w.writeBits(id, ENTITY_ID_BITS);
        vp[viewBase + id] = 0;
        this.accum[id] = 0;
      }
    }

    // Obstacles go before entities so tile collapses are never starved by the entity budget.
    const obs = frame.obstacles;
    const ostride = Math.max(1, views.obstacleCount);
    let obstaclesWritten = 0;
    for (let i = 0; i < obs.ids.length && i < views.obstacleCount; i++) {
      const vi = slot * ostride + i;
      if (obs.versions[i] === views.obsVer[vi]) continue;
      if (w.byteLength > this.byteBudget / 2) break;
      w.writeBool(true);
      w.writeVarUint(i);
      writeObstacleValues(w, obs.values[i]!);
      views.obsVer[vi] = obs.versions[i]!;
      obstaclesWritten++;
    }
    w.writeBool(false);

    // Interest: score every changed entity, then write the most overdue first.
    const q = frame.quantizer;
    const ref =
      viewer.spectateTarget >= 0 && cur.present[viewer.spectateTarget]
        ? viewer.spectateTarget
        : viewer.playerId;
    const hasEntityRef = ref >= 0 && ref < MAX_ENTITIES && cur.present[ref] === 1;
    const focus = hasEntityRef ? null : (viewer.focus ?? null);
    const hasRef = hasEntityRef || focus !== null;
    const rx = hasEntityRef ? cur.data[ref * ENTITY_STRIDE + PX]! : focus ? q.qx(focus.x) : 0;
    const ry = hasEntityRef ? cur.data[ref * ENTITY_STRIDE + PY]! : focus ? q.qy(focus.y) : 0;
    const rz = hasEntityRef ? cur.data[ref * ENTITY_STRIDE + PZ]! : focus ? q.qz(focus.z) : 0;
    let candidates = 0;
    for (let id = 0; id < MAX_ENTITIES; id++) {
      if (!cur.present[id]) continue;
      const co = id * ENTITY_STRIDE;
      const inBase = vp[viewBase + id] === 1;
      const mask = inBase ? diffMask(cur.data, co, vd, (viewBase + id) * ENTITY_STRIDE) : -1;
      if (mask === 0) {
        this.accum[id] = 0;
        continue;
      }
      let p: number;
      if (id === viewer.playerId) p = 1e6;
      else if (id === viewer.spectateTarget) p = 1e5;
      else if (isLeader(frame.leaders, id) || !hasRef) p = 1;
      else {
        const dx = (cur.data[co + PX]! - rx) * q.step.x;
        const dy = (cur.data[co + PY]! - ry) * q.step.y;
        const dz = (cur.data[co + PZ]! - rz) * q.step.z;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        p = dist <= this.nearRadius ? 1 : Math.max(this.minPriority, this.nearRadius / dist);
      }
      // Appearances and state changes (stun, dive, finish) are what players notice first.
      if (mask === -1 || mask & EntityField.State) p += 1;
      this.accum[id] = this.accum[id]! + p;
      if (this.accum[id]! < 1) continue;
      this.masks[id] = mask;
      // Insertion sort by accumulator, descending; n ≤ MAX_ENTITIES.
      let j = candidates++;
      while (j > 0 && this.accum[this.order[j - 1]!]! < this.accum[id]!) {
        this.order[j] = this.order[j - 1]!;
        j--;
      }
      this.order[j] = id;
    }

    let written = 0;
    let deferred = 0;
    for (let k = 0; k < candidates; k++) {
      const id = this.order[k]!;
      const mask = this.masks[id]!;
      const mark = w.mark();
      w.writeBool(true);
      w.writeBits(id, ENTITY_ID_BITS);
      const full = mask === -1;
      w.writeBool(full);
      if (!full) w.writeBits(mask, FIELD_MASK_BITS);
      writeFields(w, cur.data, id * ENTITY_STRIDE, full ? ALL_FIELDS : mask, simTick);
      // Reserve 1 byte for the terminator; the viewer's own entity is never dropped (prediction needs it).
      if (w.byteLength + 1 > this.byteBudget && id !== viewer.playerId) {
        w.rewind(mark);
        deferred = candidates - k;
        break;
      }
      const vo = (viewBase + id) * ENTITY_STRIDE;
      const co = id * ENTITY_STRIDE;
      for (let k = 0; k < ENTITY_STRIDE; k++) vd[vo + k] = cur.data[co + k]!;
      vp[viewBase + id] = 1;
      this.accum[id] = 0;
      written++;
    }
    w.writeBool(false);

    const s = this.stats;
    s.bytes = w.byteLength;
    s.entitiesWritten = written;
    s.entitiesDeferred = deferred;
    s.obstaclesWritten = obstaclesWritten;
    s.baselineAge = baseAge;
    return s;
  }
}

function isLeader(leaders: ArrayLike<number>, id: number): boolean {
  for (let i = 0; i < leaders.length; i++) if (leaders[i] === id) return true;
  return false;
}

function seqNewer16(a: number, b: number): boolean {
  const d = snapshotAge(a, b);
  return d !== 0 && d < 32768;
}

// -----------------------------------------------------------------------------
// Decoder (client)
// -----------------------------------------------------------------------------

/**
 * Result of decoding one snapshot. Preallocated and reused: consume it
 * synchronously (copy what you keep).
 */
export interface DecodedSnapshot {
  snapshotId: number;
  serverTick: number;
  epoch: number;
  /** Baseline snapshot id, or -1 for a full snapshot. */
  baselineId: number;
  /** Newest input sequence of the receiving client the server had consumed, or -1. */
  ackedInputSeq: number;
  matchTime: number;
  status: NetRoundStatus;
  /** Entities updated by this snapshot (entries `[0, entityCount)`). */
  entities: NetEntityState[];
  entityCount: number;
  /** Entity ids removed by this snapshot. */
  removed: Int32Array;
  removedCount: number;
  /** Obstacle wire indices updated (entries `[0, obstacleCount)`), values in `obstacleValues[i]`. */
  obstacleIndices: Int32Array;
  obstacleValues: number[][];
  obstacleCount: number;
  /** Encoded size in bytes. */
  bytes: number;
}

/** @returns A preallocated decode target. */
export function createDecodedSnapshot(): DecodedSnapshot {
  return {
    snapshotId: 0,
    serverTick: 0,
    epoch: 0,
    baselineId: -1,
    ackedInputSeq: -1,
    matchTime: 0,
    status: createNetRoundStatus(),
    entities: Array.from({ length: MAX_ENTITIES }, createNetEntityState),
    entityCount: 0,
    removed: new Int32Array(MAX_ENTITIES),
    removedCount: 0,
    obstacleIndices: new Int32Array(256),
    obstacleValues: Array.from({ length: 256 }, () => [] as number[]),
    obstacleCount: 0,
    bytes: 0,
  };
}

/** Why {@link SnapshotDecoder.decode} rejected a snapshot. */
export type SnapshotDecodeResult = 'ok' | 'malformed' | 'missingBaseline' | 'staleEpoch';

/**
 * Client-side snapshot decoder: rebuilds full views from deltas.
 * Allocation-free after construction.
 */
export class SnapshotDecoder {
  private readonly views = new ViewRing(0);
  private epoch = -1;
  /** Newest snapshot id decoded in the current epoch, or -1. */
  newestId = -1;

  /** Forgets all views (new round / resume). */
  reset(): void {
    this.views.reset();
    this.newestId = -1;
  }

  /**
   * Decodes a snapshot (reader positioned after the type byte).
   *
   * @param q - Position quantiser of the current round.
   * @param out - Decode target.
   */
  decode(r: BitReader, q: PositionQuantizer, out: DecodedSnapshot): SnapshotDecodeResult {
    const startBits = r.bitPosition - 8;
    const snapshotId = r.readBits(16);
    const serverTick = r.readBits(32);
    const epoch = r.readBits(8);
    const baseAge = r.readBits(BASELINE_AGE_BITS);
    const ackedInputSeq = r.readBool() ? r.readBits(32) : -1;
    const matchTime = r.readFloat32();
    if (r.overflow) return 'malformed';

    if (epoch !== this.epoch) {
      // Only a full snapshot can open a new epoch.
      if (baseAge !== 0) return 'staleEpoch';
      this.reset();
      this.epoch = epoch;
    }
    const views = this.views;
    let baseSlot = -1;
    let baselineId = -1;
    if (baseAge > 0) {
      baselineId = (snapshotId - baseAge + SNAPSHOT_ID_MOD) % SNAPSHOT_ID_MOD;
      baseSlot = views.find(baselineId);
      if (baseSlot < 0) return 'missingBaseline';
    }
    readStatus(r, out.status);

    const slot = snapshotId % SNAPSHOT_HISTORY;
    // Decode into the slot only after validation, so a malformed packet can't corrupt a baseline we may need.
    views.begin(slot, snapshotId, baseSlot);
    const vd = views.data;
    const vp = views.present;
    const viewBase = slot * MAX_ENTITIES;
    const simTick = simTickOf(serverTick);

    out.removedCount = r.readBits(REMOVED_COUNT_BITS);
    for (let i = 0; i < out.removedCount && i < MAX_ENTITIES; i++) {
      const id = r.readBits(ENTITY_ID_BITS);
      out.removed[i] = id;
      vp[viewBase + id] = 0;
    }

    out.obstacleCount = 0;
    while (r.readBool() && !r.overflow) {
      const idx = r.readVarUint();
      const n = out.obstacleCount;
      if (n < out.obstacleIndices.length) {
        out.obstacleIndices[n] = idx;
        readObstacleValues(r, out.obstacleValues[n]!);
        out.obstacleCount++;
      } else {
        readObstacleValues(r, scratchValues);
      }
    }

    out.entityCount = 0;
    while (r.readBool() && !r.overflow) {
      const id = r.readBits(ENTITY_ID_BITS);
      const full = r.readBool();
      const mask = full ? ALL_FIELDS : r.readBits(FIELD_MASK_BITS);
      const vo = (viewBase + id) * ENTITY_STRIDE;
      if (!full && vp[viewBase + id] !== 1) {
        views.ids[slot] = -1;
        return 'malformed';
      }
      readFields(r, vd, vo, mask, simTick);
      vp[viewBase + id] = 1;
      decodeRecord(vd, vo, id, q, simTick, out.entities[out.entityCount++]!);
    }
    if (r.overflow) {
      views.ids[slot] = -1;
      return 'malformed';
    }

    out.snapshotId = snapshotId;
    out.serverTick = serverTick;
    out.epoch = epoch;
    out.baselineId = baselineId;
    out.ackedInputSeq = ackedInputSeq;
    out.matchTime = matchTime;
    out.bytes = Math.ceil((r.bitPosition - startBits) / 8);
    if (this.newestId < 0 || seqNewer16(snapshotId, this.newestId)) this.newestId = snapshotId;
    return 'ok';
  }

  /**
   * Reads the full reconstructed world for a decoded snapshot id (every present
   * entity, not just the updated ones).
   *
   * @returns Number of entities written to `out`.
   */
  readView(snapshotId: number, serverTick: number, q: PositionQuantizer, out: NetEntityState[]): number {
    const slot = this.views.find(snapshotId);
    if (slot < 0) return 0;
    const base = slot * MAX_ENTITIES;
    const simTick = simTickOf(serverTick);
    let n = 0;
    for (let id = 0; id < MAX_ENTITIES && n < out.length; id++) {
      if (!this.views.present[base + id]) continue;
      decodeRecord(this.views.data, (base + id) * ENTITY_STRIDE, id, q, simTick, out[n++]!);
    }
    return n;
  }
}

const scratchValues: number[] = [];
