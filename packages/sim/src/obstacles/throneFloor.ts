/**
 * Throne Floor — the final's throne room: a round floor over the void where,
 * every cycle, thrones rise for all but a few of the Tumblers left. One
 * Tumbler per throne; when the floor opens, everyone without a seat falls.
 *
 * Responsibilities:
 * - Schedule (seeded, pure in time): cycles of ROAM → TELEGRAPH (the throne
 *   spots glow) → RISE → SCRAMBLE → SHAKE → FALLEN (floor collider off) →
 *   RESTORE. Roam lengths and spot orders come from the instance's Rng.
 * - Seats: decided by the server when each cycle's telegraph starts, from the
 *   players still standing (a quarter of the field, at least one, goes
 *   without), and replicated.
 * - Claims (authoritative sims only): the first Tumbler standing on a throne
 *   owns it; anyone else who lands on an owned throne is bounced off. An owner
 *   knocked off frees the throne. A cycle in which nobody holds a throne when
 *   the floor would open is voided (the floor stays).
 * - Bot hint: `botSafeSpot` names the nearest free throne (`botObjective`).
 * - Replication: seats per cycle, voided/judged bits and current owners.
 */
import type { Collider, RigidBody } from '@dimforge/rapier3d-compat';
import { rotateVec, vec3, type Rng, type Vec3 } from '@tumble/shared';
import { z } from 'zod';
import { ObstacleGroups, RuntimeBase, actorLocal, toLocalPoint, toWorldPoint } from './helpers-a.ts';
import type {
  ObstacleActor,
  ObstacleBuildContext,
  ObstacleInstance,
  ObstacleModule,
  ObstacleStepContext,
} from './types.ts';

const LocalPoint = z.object({ x: z.number(), y: z.number(), z: z.number() });

/** Most cycles a schedule can hold; keeps the replicated state inside the netcode's 64 values. */
export const THRONE_MAX_CYCLES = 24;
/** Most thrones in a room. */
export const THRONE_MAX_SEATS = 16;

function ringSpots(): { x: number; y: number; z: number }[] {
  const out: { x: number; y: number; z: number }[] = [];
  const r2 = (n: number): number => Math.round(n * 100) / 100;
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2 + Math.PI / 6;
    out.push({ x: r2(Math.cos(a) * 4.5), y: 0, z: r2(Math.sin(a) * 4.5) });
  }
  for (let k = 0; k < 10; k++) {
    const a = (k / 10) * Math.PI * 2;
    out.push({ x: r2(Math.cos(a) * 9), y: 0, z: r2(Math.sin(a) * 9) });
  }
  return out;
}

/** Throne Floor parameters. Metres, seconds. Origin = centre of the floor's top surface. */
export const ThroneFloorSchema = z.object({
  /** Floor disc radius (m). */
  radius: z.number().positive().default(13),
  thickness: z.number().positive().default(1),
  /** Throne spots, local, on the floor. Each cycle uses a seeded shuffle of them. */
  spots: z.array(LocalPoint).min(2).max(THRONE_MAX_SEATS).default(ringSpots()),
  /** Throne seat radius (m). */
  seatRadius: z.number().positive().default(0.95),
  /** Seat top above the floor when raised (m). */
  seatHeight: z.number().positive().default(1.1),
  /** Match time the first cycle starts (s). */
  startTime: z.number().default(0.5),
  /** Seeded roam length range (s, ÷ stage speed scale, never below 2 s). */
  roamMin: z.number().positive().default(3),
  roamMax: z.number().positive().default(5.5),
  /** Seconds the throne spots glow before the thrones rise. */
  telegraph: z.number().positive().default(0.9),
  riseTime: z.number().positive().default(0.45),
  /** Seconds the thrones stand before the floor shakes, in the first cycle. */
  scramble: z.number().positive().default(3),
  /** Scramble lost per cycle, down to `minScramble`. */
  scrambleStep: z.number().min(0).default(0.1),
  minScramble: z.number().positive().default(2),
  shakeTime: z.number().positive().default(0.7),
  /** Seconds the floor stays open. */
  downTime: z.number().positive().default(1.8),
  restoreTime: z.number().positive().default(0.8),
  /** Share of the standing field left without a throne each cycle (at least one). */
  cut: z.number().min(0).max(0.9).default(0.25),
  /** Bounce off an owned throne: horizontal / upward velocity change (m/s). */
  bounceSpeed: z.number().min(0).default(6),
  bounceLift: z.number().min(0).default(5),
  maxCycles: z.number().int().min(1).max(THRONE_MAX_CYCLES).default(THRONE_MAX_CYCLES),
});

/** Validated Throne Floor parameters. */
export type ThroneFloorParams = z.output<typeof ThroneFloorSchema>;

/** Cycle phase. */
export const ThronePhase = {
  Idle: 0,
  Roam: 1,
  Telegraph: 2,
  Rise: 3,
  Scramble: 4,
  Shake: 5,
  Fallen: 6,
  Restore: 7,
} as const;

/** One cycle of the schedule. Times are absolute match seconds. */
export interface ThroneCycle {
  readonly index: number;
  /** Spot indices in throne order; throne `j` uses `order[j]`. */
  readonly order: readonly number[];
  readonly start: number;
  readonly teleAt: number;
  readonly riseAt: number;
  readonly upAt: number;
  readonly shakeAt: number;
  readonly fallAt: number;
  readonly restoreAt: number;
  readonly end: number;
}

/**
 * Builds the cycle schedule. Consumes `rng` in a fixed order.
 *
 * @param p - Params.
 * @param speedScale - Stage speed scale (shortens roaming, never below 2 s).
 * @param rng - The instance's seeded generator.
 */
export function buildThroneSchedule(p: ThroneFloorParams, speedScale: number, rng: Rng): ThroneCycle[] {
  const out: ThroneCycle[] = [];
  let t = p.startTime;
  for (let c = 0; c < p.maxCycles; c++) {
    const roam = Math.max(
      2,
      rng.range(p.roamMin, Math.max(p.roamMin, p.roamMax)) / Math.max(0.1, speedScale),
    );
    const order = p.spots.map((_, i) => i);
    rng.shuffle(order);
    const teleAt = t + roam;
    const riseAt = teleAt + p.telegraph;
    const upAt = riseAt + p.riseTime;
    const shakeAt = upAt + Math.max(p.minScramble, p.scramble - p.scrambleStep * c);
    const fallAt = shakeAt + p.shakeTime;
    const restoreAt = fallAt + p.downTime;
    const end = restoreAt + p.restoreTime;
    out.push({ index: c, order, start: t, teleAt, riseAt, upAt, shakeAt, fallAt, restoreAt, end });
    t = end;
  }
  return out;
}

/** Index of the cycle running at `t`, or -1 before the first / after the last. */
export function throneCycleIndexAt(schedule: readonly ThroneCycle[], t: number): number {
  for (let i = 0; i < schedule.length; i++) if (t >= schedule[i]!.start && t < schedule[i]!.end) return i;
  return -1;
}

/** Phase of a cycle at `t`. */
export function thronePhaseOf(c: ThroneCycle, t: number): number {
  if (t < c.start || t >= c.end) return ThronePhase.Idle;
  if (t < c.teleAt) return ThronePhase.Roam;
  if (t < c.riseAt) return ThronePhase.Telegraph;
  if (t < c.upAt) return ThronePhase.Rise;
  if (t < c.shakeAt) return ThronePhase.Scramble;
  if (t < c.fallAt) return ThronePhase.Shake;
  if (t < c.restoreAt) return ThronePhase.Fallen;
  return ThronePhase.Restore;
}

const smooth = (x: number): number => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
/** Hidden thrones sit just under the floor surface. */
const HIDDEN_TOP = -0.15;
/** Column length below a throne's seat; long enough to stay rooted while raised. */
const COLUMN = 4;
const PARK_Y = -60;

/** Seat top (local y) of a throne at `t` within cycle `c`. */
export function throneTop(c: ThroneCycle, t: number, p: ThroneFloorParams): number {
  if (t < c.riseAt) return HIDDEN_TOP;
  if (t < c.upAt) return HIDDEN_TOP + (p.seatHeight - HIDDEN_TOP) * smooth((t - c.riseAt) / p.riseTime);
  if (t < c.restoreAt) return p.seatHeight;
  return p.seatHeight + (HIDDEN_TOP - p.seatHeight) * smooth((t - c.restoreAt) / p.restoreTime);
}

/**
 * Thrones for a standing field.
 *
 * @param p - Params.
 * @param standing - Players still in.
 * @returns Seats, from 1 up to the spot count.
 */
export function throneSeatsFor(p: ThroneFloorParams, standing: number): number {
  const out = Math.max(1, Math.floor(standing * p.cut));
  return Math.max(1, Math.min(p.spots.length, standing - out));
}

/** What the visual reads from a live floor. */
export interface ThroneFloorView {
  readonly schedule: readonly ThroneCycle[];
  /** Thrones in cycle `c`, 0 while not yet decided. */
  seatsIn(c: number): number;
  isVoided(c: number): boolean;
  /** Player id holding throne `j` of the current cycle, or -1. */
  ownerOf(j: number): number;
}

const NO_OWNER = -1;

/** Live throne floor. */
export class ThroneFloorRuntime extends RuntimeBase implements ThroneFloorView {
  readonly schedule: ThroneCycle[];
  readonly botObjective = true as const;
  private readonly floor: Collider;
  private floorEnabled = true;
  private readonly thrones: RigidBody[] = [];
  /** Spot each throne body stands at (-1 parked), to teleport rather than glide between spots. */
  private readonly throneSpot: Int32Array;
  private readonly seats: Int32Array;
  private readonly voided: Uint8Array;
  private readonly judged: Uint8Array;
  private readonly owners: Int32Array;
  private ownerCycle = -1;
  private readonly bounced = new Map<number, number>();
  private readonly authoritative: boolean;
  private readonly local = vec3();
  private readonly wp = vec3();
  private readonly imp = vec3();
  private actorXYZ = new Float64Array(0);

  constructor(
    instance: ObstacleInstance<ThroneFloorParams>,
    ctx: ObstacleBuildContext,
    readonly params: ThroneFloorParams,
  ) {
    super(instance, ctx);
    const p = params;
    const { R } = ctx;
    this.authoritative = ctx.authoritative ?? true;
    this.schedule = buildThroneSchedule(p, ctx.speedScale, ctx.rng);
    this.seats = new Int32Array(p.maxCycles);
    this.voided = new Uint8Array(p.maxCycles);
    this.judged = new Uint8Array(p.maxCycles);
    this.owners = new Int32Array(p.spots.length).fill(NO_OWNER);
    this.throneSpot = new Int32Array(p.spots.length).fill(-1);
    const base = this.addBody(R.RigidBodyDesc.fixed());
    this.floor = this.addCollider(
      R.ColliderDesc.cylinder(p.thickness / 2, p.radius)
        .setTranslation(0, -p.thickness / 2, 0)
        .setFriction(0.8)
        .setCollisionGroups(ObstacleGroups.static),
      base,
      { kind: 'normal' },
    );
    for (let j = 0; j < p.spots.length; j++) {
      const body = this.addBody(R.RigidBodyDesc.kinematicPositionBased(), vec3(0, PARK_Y, 0));
      this.addCollider(
        R.ColliderDesc.cylinder((p.seatHeight + COLUMN) / 2, p.seatRadius)
          .setFriction(0.9)
          .setCollisionGroups(ObstacleGroups.kinematic),
        body,
        { kind: 'normal' },
      );
      this.thrones.push(body);
    }
  }

  seatsIn(c: number): number {
    return Math.max(0, this.seats[c] ?? 0);
  }

  isVoided(c: number): boolean {
    return this.voided[c] === 1;
  }

  ownerOf(j: number): number {
    return this.owners[j] ?? NO_OWNER;
  }

  /** Cycle running at `t`, or null. */
  cycleAt(t: number): ThroneCycle | null {
    const k = throneCycleIndexAt(this.schedule, t);
    return k >= 0 ? this.schedule[k]! : null;
  }

  update(ctx: ObstacleStepContext): void {
    const t = ctx.t;
    const c = this.cycleAt(t);
    if (c && c.index !== this.ownerCycle) {
      this.ownerCycle = c.index;
      this.owners.fill(NO_OWNER);
    }
    if (c && this.authoritative) {
      if (t >= c.teleAt && this.seats[c.index] === 0) {
        let standing = 0;
        for (const a of ctx.actors) if (!a.isGhost) standing++;
        this.seats[c.index] = throneSeatsFor(this.params, standing);
        this.cue(ctx.events, 'telegraph', 0, 0.5, 0);
      }
    }
    this.poseThrones(c, t);
    if (c) {
      const phase = thronePhaseOf(c, t);
      if (this.authoritative && phase >= ThronePhase.Rise && phase <= ThronePhase.Fallen)
        this.claims(c, t, ctx);
      if (phase >= ThronePhase.Fallen && !this.judged[c.index]) this.judge(c, ctx);
      this.setFloor(!(phase === ThronePhase.Fallen && !this.voided[c.index]));
    } else {
      this.setFloor(true);
    }
    this.endStep(ctx);
  }

  private poseThrones(c: ThroneCycle | null, t: number): void {
    const p = this.params;
    const seats = c ? this.seatsIn(c.index) : 0;
    const top = c ? throneTop(c, t, p) : HIDDEN_TOP;
    for (let j = 0; j < this.thrones.length; j++) {
      const body = this.thrones[j]!;
      const spot = c && j < seats ? c.order[j]! : -1;
      if (spot < 0) {
        if (this.throneSpot[j] !== -1) {
          this.throneSpot[j] = -1;
          this.place(body, 0, PARK_Y, 0, true);
        }
        continue;
      }
      const s = p.spots[spot]!;
      const y = s.y + top - (p.seatHeight + COLUMN) / 2;
      const jump = this.throneSpot[j] !== spot;
      this.throneSpot[j] = spot;
      this.place(body, s.x, y, s.z, jump);
    }
  }

  private place(body: RigidBody, x: number, y: number, z: number, teleport: boolean): void {
    this.wp.x = x;
    this.wp.y = y;
    this.wp.z = z;
    toWorldPoint(this.frame, this.wp, this.wp);
    if (teleport) body.setTranslation(this.wp, true);
    body.setNextKinematicTranslation(this.wp);
  }

  private setFloor(enabled: boolean): void {
    if (this.floorEnabled === enabled) return;
    this.floorEnabled = enabled;
    this.floor.setEnabled(enabled);
  }

  /** First on a throne owns it; everyone else on an owned throne is bounced off. */
  private claims(c: ThroneCycle, t: number, ctx: ObstacleStepContext): void {
    const p = this.params;
    const actors = ctx.actors;
    if (this.actorXYZ.length < actors.length * 3) this.actorXYZ = new Float64Array(actors.length * 3);
    const xyz = this.actorXYZ;
    for (let a = 0; a < actors.length; a++) {
      const l = actorLocal(this.frame, actors[a]!, this.local);
      xyz[a * 3] = l.x;
      xyz[a * 3 + 1] = l.y;
      xyz[a * 3 + 2] = l.z;
    }
    const seats = this.seatsIn(c.index);
    const top = throneTop(c, t, p);
    const reach = (p.seatRadius + 0.2) ** 2;
    for (let j = 0; j < seats; j++) {
      const s = p.spots[c.order[j]!]!;
      const seatY = s.y + top;
      let owner = this.owners[j]!;
      let ownerOn = false;
      let best = -1;
      let bestD = Infinity;
      for (let a = 0; a < actors.length; a++) {
        const actor = actors[a]!;
        if (actor.isGhost) continue;
        const dy = xyz[a * 3 + 1]! - seatY;
        if (dy < 0.3 || dy > 1.8) continue;
        const d = (xyz[a * 3]! - s.x) ** 2 + (xyz[a * 3 + 2]! - s.z) ** 2;
        if (d > reach) continue;
        if (actor.id === owner) {
          ownerOn = true;
          continue;
        }
        if (d < bestD && !this.ownsAnother(actor.id, j, seats)) {
          bestD = d;
          best = a;
        }
      }
      if (owner !== NO_OWNER && !ownerOn) {
        owner = NO_OWNER;
        this.owners[j] = NO_OWNER;
      }
      if (owner === NO_OWNER && best >= 0) {
        owner = actors[best]!.id;
        this.owners[j] = owner;
        this.cue(ctx.events, 'claim', s.x, seatY + 0.5, s.z);
      }
      if (owner === NO_OWNER) continue;
      for (let a = 0; a < actors.length; a++) {
        const actor = actors[a]!;
        if (actor.isGhost || actor.id === owner) continue;
        const dy = xyz[a * 3 + 1]! - seatY;
        if (dy < 0.3 || dy > 1.8) continue;
        const dx = xyz[a * 3]! - s.x;
        const dz = xyz[a * 3 + 2]! - s.z;
        if (dx * dx + dz * dz > reach) continue;
        this.bounce(actor, dx, dz, t, ctx, s.x, seatY, s.z);
      }
    }
  }

  private ownsAnother(id: number, j: number, seats: number): boolean {
    for (let k = 0; k < seats; k++) if (k !== j && this.owners[k] === id) return true;
    return false;
  }

  private bounce(
    actor: ObstacleActor,
    dx: number,
    dz: number,
    t: number,
    ctx: ObstacleStepContext,
    sx: number,
    sy: number,
    sz: number,
  ): void {
    const last = this.bounced.get(actor.id);
    if (last !== undefined && t - last < 0.35 && t >= last) return;
    this.bounced.set(actor.id, t);
    const len = Math.hypot(dx, dz);
    // Dead centre (dropped straight on top of the owner): push along +X rather than not at all.
    const ux = len > 1e-3 ? dx / len : 1;
    const uz = len > 1e-3 ? dz / len : 0;
    const m = actor.body.mass() > 0 ? actor.body.mass() : 1;
    this.local.x = ux * this.params.bounceSpeed * m;
    this.local.y = this.params.bounceLift * m;
    this.local.z = uz * this.params.bounceSpeed * m;
    rotateVec(this.frame.rot, this.local, this.imp);
    actor.knock(this.imp, false);
    this.cue(ctx.events, 'bounce', sx, sy + 0.5, sz);
  }

  /** The floor opens: unless nobody holds a throne, in which case the cycle is voided. */
  private judge(c: ThroneCycle, ctx: ObstacleStepContext): void {
    this.judged[c.index] = 1;
    if (!this.authoritative) return;
    let held = 0;
    for (let j = 0; j < this.seatsIn(c.index); j++) if (this.owners[j] !== NO_OWNER) held++;
    if (held === 0 && ctx.actors.length > 0) {
      this.voided[c.index] = 1;
      this.cue(ctx.events, 'void', 0, 0.5, 0);
    } else {
      this.cue(ctx.events, 'drop', 0, 0.5, 0);
    }
  }

  /**
   * The nearest throne the asking bot could hold: free, or the one it is
   * already sitting on. Thrones are named from the telegraph on; while the
   * floor is plain, bots roam.
   */
  botSafeSpot(t: number, out: Vec3): boolean {
    const c = this.cycleAt(t);
    if (!c) return false;
    const phase = thronePhaseOf(c, t);
    if (phase < ThronePhase.Telegraph || phase > ThronePhase.Fallen) return false;
    const p = this.params;
    const hint = toLocalPoint(this.frame, out, this.local);
    const seats = this.seatsIn(c.index);
    let best = Infinity;
    let pick = -1;
    for (let j = 0; j < seats; j++) {
      const s = p.spots[c.order[j]!]!;
      const d = (s.x - hint.x) ** 2 + (s.z - hint.z) ** 2;
      const mine = d <= p.seatRadius * p.seatRadius && hint.y > s.y + throneTop(c, t, p);
      if (this.owners[j] !== NO_OWNER && !mine) continue;
      if (d < best) {
        best = d;
        pick = j;
      }
    }
    if (pick < 0) return false;
    const s = p.spots[c.order[pick]!]!;
    this.wp.x = s.x;
    this.wp.y = s.y + p.seatHeight;
    this.wp.z = s.z;
    toWorldPoint(this.frame, this.wp, out);
    return true;
  }

  /** `[seats per cycle…, voided bits, judged bits, owner + 1 per throne…]`. */
  getNetState(): number[] {
    const out = Array.from(this.seats);
    out.push(packBits(this.voided), packBits(this.judged));
    for (let j = 0; j < this.owners.length; j++) out.push(this.owners[j]! + 1);
    return out;
  }

  setNetState(state: readonly number[]): void {
    const n = this.seats.length;
    for (let c = 0; c < n; c++) this.seats[c] = state[c] ?? 0;
    unpackBits(state[n] ?? 0, this.voided);
    unpackBits(state[n + 1] ?? 0, this.judged);
    for (let j = 0; j < this.owners.length; j++) this.owners[j] = (state[n + 2 + j] ?? 0) - 1;
  }
}

function packBits(bits: Uint8Array): number {
  let w = 0;
  for (let k = 0; k < bits.length && k < 30; k++) if (bits[k]) w |= 1 << k;
  return w;
}

function unpackBits(w: number, bits: Uint8Array): void {
  for (let k = 0; k < bits.length && k < 30; k++) bits[k] = (w >>> k) & 1;
}

/** Throne Floor obstacle module. */
export const throneFloor: ObstacleModule<ThroneFloorParams> = {
  type: 'throneFloor',
  displayName: 'Throne Floor',
  schema: ThroneFloorSchema,
  create: (instance, ctx) => new ThroneFloorRuntime(instance, ctx, ThroneFloorSchema.parse(instance.params)),
  audioCues: ['telegraph', 'claim', 'bounce', 'drop', 'void'],
};
