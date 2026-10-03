/**
 * Shared building blocks for obstacle set A.
 *
 * Responsibilities:
 * - Instance frames: converting a placed instance (position + degrees) into a
 *   rigid transform once, and composing pure `pose()` samples onto it.
 * - Time shaping: closed-form waveforms (trapezoid reversals, duty cycles,
 *   schedule crossings) so every moving part stays a pure function of time.
 * - Runtime plumbing: body/collider bookkeeping, surface registration,
 *   kinematic driving and disposal shared by every set-A runtime.
 * - Gameplay helpers: motion-directed knockback with per-actor cooldowns,
 *   audio cue emission and net-state quantisation.
 *
 * Everything here is headless and deterministic (no wall clock, no Math.random).
 */
import type {
  Collider,
  ColliderDesc,
  ImpulseJoint,
  RevoluteImpulseJoint,
  RigidBody,
  RigidBodyDesc,
} from '@dimforge/rapier3d-compat';
import { InteractionGroups, quatFromEulerYXZ, quatIdentity, rotateVec, vec3, type Quat, type Vec3 } from '@tumble/shared';
import type { EventSink } from '../events.ts';
import type { SurfaceInfo } from '../physics/surfaces.ts';
import type {
  ObstacleActor,
  ObstacleBuildContext,
  ObstacleInstance,
  ObstacleRuntime,
  ObstacleStepContext,
  PoseSample,
} from './types.ts';

// -----------------------------------------------------------------------------
// Frames & poses
// -----------------------------------------------------------------------------

/** Degrees → radians. */
export const DEG2RAD = Math.PI / 180;

/** Two π, used by every periodic waveform. */
export const TAU = Math.PI * 2;

/** A rigid transform: where an instance sits in the world. */
export interface Frame {
  pos: Vec3;
  rot: Quat;
}

/**
 * Builds the world frame of a placed instance. Rotation is yaw/pitch/roll in
 * degrees (designer units), applied in Y-X-Z order.
 *
 * @param instance - The placed obstacle.
 * @returns A fresh frame (call once at build time, not per step).
 */
export function instanceFrame(instance: ObstacleInstance<unknown>): Frame {
  const r = instance.rotation ?? {};
  return {
    pos: vec3(instance.position.x, instance.position.y, instance.position.z),
    rot: quatFromEulerYXZ((r.yaw ?? 0) * DEG2RAD, (r.pitch ?? 0) * DEG2RAD, (r.roll ?? 0) * DEG2RAD),
  };
}

/**
 * Transforms a point from instance-local space to world space.
 *
 * @param frame - Instance frame.
 * @param local - Local point.
 * @param out - Receives the world point (must not alias `local`).
 */
export function toWorldPoint(frame: Frame, local: Vec3, out: Vec3): Vec3 {
  rotateVec(frame.rot, local, out);
  out.x += frame.pos.x;
  out.y += frame.pos.y;
  out.z += frame.pos.z;
  return out;
}

/**
 * Transforms a world point into instance-local space.
 *
 * @param frame - Instance frame.
 * @param world - World point.
 * @param out - Receives the local point (may alias `world`).
 */
export function toLocalPoint(frame: Frame, world: Vec3, out: Vec3): Vec3 {
  out.x = world.x - frame.pos.x;
  out.y = world.y - frame.pos.y;
  out.z = world.z - frame.pos.z;
  return rotateVecInverse(frame.rot, out, out);
}

/** Rotates `v` by the inverse (conjugate) of unit quaternion `q`. `out` may alias `v`. */
export function rotateVecInverse(q: Quat, v: Vec3, out: Vec3): Vec3 {
  const cx = -q.x;
  const cy = -q.y;
  const cz = -q.z;
  const w = q.w;
  const ix = w * v.x + cy * v.z - cz * v.y;
  const iy = w * v.y + cz * v.x - cx * v.z;
  const iz = w * v.z + cx * v.y - cy * v.x;
  const iw = -cx * v.x - cy * v.y - cz * v.z;
  out.x = ix * w + iw * -cx + iy * -cz - iz * -cy;
  out.y = iy * w + iw * -cy + iz * -cx - ix * -cz;
  out.z = iz * w + iw * -cz + ix * -cy - iy * -cx;
  return out;
}

/** `out = conj(a) * b` — the rotation of `b` expressed in `a`'s frame. `out` may alias either. */
export function quatRelative(a: Quat, b: Quat, out: Quat): Quat {
  const ax = -a.x;
  const ay = -a.y;
  const az = -a.z;
  const aw = a.w;
  const x = aw * b.x + ax * b.w + ay * b.z - az * b.y;
  const y = aw * b.y - ax * b.z + ay * b.w + az * b.x;
  const z = aw * b.z + ax * b.y - ay * b.x + az * b.w;
  const w = aw * b.w - ax * b.x - ay * b.y - az * b.z;
  out.x = x;
  out.y = y;
  out.z = z;
  out.w = w;
  return out;
}

/** `out = a * b`. `out` may alias either input. */
export function quatMultiply(a: Quat, b: Quat, out: Quat): Quat {
  const x = a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y;
  const y = a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x;
  const z = a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w;
  const w = a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z;
  out.x = x;
  out.y = y;
  out.z = z;
  out.w = w;
  return out;
}

/**
 * Composes a local pose sample onto an instance frame.
 *
 * @param frame - Instance frame.
 * @param sample - Local pose from a module's `pose()`.
 * @param outPos - World position.
 * @param outRot - World rotation.
 */
export function composePose(frame: Frame, sample: PoseSample, outPos: Vec3, outRot: Quat): void {
  toWorldPoint(frame, sample.pos, outPos);
  quatMultiply(frame.rot, sample.rot, outRot);
}

/**
 * Allocates a reusable pose buffer. Callers create one per runtime/visual and
 * pass it to `pose()` every step.
 *
 * @param count - Number of kinematic parts.
 */
export function createPoseBuffer(count: number): PoseSample[] {
  const out: PoseSample[] = [];
  for (let i = 0; i < count; i++) out.push({ pos: vec3(), rot: quatIdentity() });
  return out;
}

/** Writes a translation + rotation about a unit axis into a pose sample. */
export function setPose(
  out: PoseSample,
  x: number,
  y: number,
  z: number,
  ax: number,
  ay: number,
  az: number,
  angle: number,
): void {
  out.pos.x = x;
  out.pos.y = y;
  out.pos.z = z;
  const s = Math.sin(angle * 0.5);
  out.rot.x = ax * s;
  out.rot.y = ay * s;
  out.rot.z = az * s;
  out.rot.w = Math.cos(angle * 0.5);
}

// -----------------------------------------------------------------------------
// Time shaping (all pure, closed form)
// -----------------------------------------------------------------------------

/** Positive modulo: result in [0, m). */
export function modPos(v: number, m: number): number {
  const r = v % m;
  return r < 0 ? r + m : r;
}

/**
 * Trapezoid square wave in [-1, 1]: +1 for `period` seconds, then −1 for
 * `period` seconds, with linear ramps of `ramp` seconds centred on each switch.
 * Ramps are centred on every multiple of `period`, so t = 0 is a spin-up
 * through 0 toward +1 and the first reversal (+1 → −1) is centred on t = period.
 *
 * @param t - Time in seconds.
 * @param period - Seconds between direction switches. `<= 0` means never switch.
 * @param ramp - Ramp duration, clamped to the period.
 */
export function squareWave(t: number, period: number, ramp: number): number {
  if (period <= 0) return 1;
  const h = Math.min(Math.max(ramp, 1e-4), period) * 0.5;
  const u = modPos(t, 2 * period);
  if (u < h) return u / h;
  if (u < period - h) return 1;
  if (u < period + h) return (period - u) / h;
  if (u < 2 * period - h) return -1;
  return (u - 2 * period) / h;
}

/**
 * Exact integral of {@link squareWave} from 0 to t. Lets reversing spinners and
 * switching belts expose an angle/displacement that is a pure function of time
 * while staying continuous through every reversal.
 *
 * @returns Integrated travel in "seconds at unit speed".
 */
export function squareWaveIntegral(t: number, period: number, ramp: number): number {
  if (period <= 0) return t;
  const h = Math.min(Math.max(ramp, 1e-4), period) * 0.5;
  const u = modPos(t, 2 * period);
  if (u < h) return (u * u) / (2 * h);
  if (u < period - h) return h / 2 + (u - h);
  if (u < period + h) return period - 1.5 * h + (h * h - (period - u) * (period - u)) / (2 * h);
  if (u < 2 * period - h) return period - 1.5 * h - (u - period - h);
  return ((u - 2 * period) * (u - 2 * period)) / (2 * h);
}

/**
 * Seconds until the next direction switch of {@link squareWave}.
 *
 * @returns `Infinity` when the wave never switches.
 */
export function timeToSwitch(t: number, period: number): number {
  if (period <= 0) return Infinity;
  return period - modPos(t, period);
}

/**
 * Duty-cycle envelope in [0, 1]: ramps up over `ramp`, holds for the rest of
 * `onTime`, ramps down over `ramp`, then rests for `offTime`.
 *
 * @param t - Time in seconds.
 * @param onTime - Active seconds per cycle (includes ramp-up).
 * @param offTime - Idle seconds per cycle. `<= 0` keeps it always on.
 * @param ramp - Ramp seconds.
 */
export function dutyEnvelope(t: number, onTime: number, offTime: number, ramp: number): number {
  if (offTime <= 0) return 1;
  const period = onTime + offTime;
  const u = modPos(t, period);
  const r = Math.max(ramp, 1e-4);
  if (u < onTime) return Math.min(1, u / r);
  return Math.max(0, 1 - (u - onTime) / r);
}

/**
 * Warning intensity for an event `timeUntil` seconds away: 0 before `lead`,
 * rising to 1 at the event, shaped so it visibly pulses faster as it nears.
 */
export function leadTelegraph(timeUntil: number, lead: number): number {
  if (lead <= 0 || timeUntil > lead || timeUntil < 0) return 0;
  const k = 1 - timeUntil / lead;
  const pulse = 0.5 + 0.5 * Math.cos(k * k * Math.PI * 6);
  return k * (0.55 + 0.45 * pulse);
}

/**
 * True when a periodic schedule point `offset + k·period` lies in (t0, t1].
 * Used to emit one-shot audio cues exactly once per occurrence.
 */
export function crossedPeriodic(t0: number, t1: number, period: number, offset: number): boolean {
  if (!(t1 > t0) || period <= 0) return false;
  const k1 = Math.floor((t1 - offset) / period);
  const k0 = Math.floor((t0 - offset) / period);
  return k1 !== k0;
}

/** Piecewise-cubic ease in/out on [0, 1]. */
export function easeInOutCubic(x: number): number {
  const v = x < 0 ? 0 : x > 1 ? 1 : x;
  return v < 0.5 ? 4 * v * v * v : 1 - Math.pow(-2 * v + 2, 3) / 2;
}

// -----------------------------------------------------------------------------
// Runtime plumbing
// -----------------------------------------------------------------------------

/** Collision groups for obstacle colliders. */
export const ObstacleGroups = {
  /** Moving solid parts (kinematic and joint-driven dynamic bodies). */
  kinematic: InteractionGroups.kinematic,
  /** Static frames, posts, housings. */
  static: InteractionGroups.static,
  /** Sensors routed to `onTrigger`. */
  trigger: InteractionGroups.trigger,
  /** Lethal or stunning sensors (slime surface). */
  hazard: InteractionGroups.hazard,
} as const;

/**
 * Base class for set-A runtimes: tracks bodies, colliders, joints and surface
 * registrations so `dispose()` is always complete.
 */
export abstract class RuntimeBase implements ObstacleRuntime {
  readonly instance: ObstacleInstance;
  readonly colliders: Collider[] = [];
  /** World frame of the instance. */
  readonly frame: Frame;
  protected readonly bodies: RigidBody[] = [];
  protected readonly joints: ImpulseJoint[] = [];
  protected readonly build: ObstacleBuildContext;
  /** Match time of the previous `update`, NaN before the first. */
  protected lastT = Number.NaN;
  /** Tick of the latest `update`. */
  protected lastTick = 0;
  private disposed = false;

  protected constructor(instance: ObstacleInstance<unknown>, ctx: ObstacleBuildContext) {
    this.instance = instance as ObstacleInstance;
    this.build = ctx;
    this.frame = instanceFrame(instance);
  }

  /** Creates a body placed at the instance frame (plus an optional local offset). */
  protected addBody(desc: RigidBodyDesc, local?: Vec3): RigidBody {
    const p = local ? toWorldPoint(this.frame, local, vec3()) : this.frame.pos;
    desc.setTranslation(p.x, p.y, p.z).setRotation(this.frame.rot);
    const body = this.build.world.createRigidBody(desc);
    this.bodies.push(body);
    return body;
  }

  /** Creates a collider on `body` and optionally registers its surface info (ownerId filled in). */
  protected addCollider(desc: ColliderDesc, body: RigidBody, surface?: SurfaceInfo): Collider {
    const c = this.build.world.createCollider(desc, body);
    this.colliders.push(c);
    if (surface) this.build.surfaces.set(c.handle, { ...surface, ownerId: this.instance.id });
    return c;
  }

  abstract update(ctx: ObstacleStepContext): void;

  /** Records the step clock; call at the end of every `update`. */
  protected endStep(ctx: ObstacleStepContext): void {
    this.lastT = ctx.t;
    this.lastTick = ctx.tick;
  }

  /** Emits an `obstacleCue` event at an instance-local position. */
  protected cue(events: EventSink, cue: string, lx = 0, ly = 0, lz = 0): void {
    const p = toWorldPoint(this.frame, vec3(lx, ly, lz), vec3());
    events.push({ type: 'obstacleCue', obstacle: this.instance.id, cue, pos: p });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const { world, surfaces } = this.build;
    for (const c of this.colliders) surfaces.delete(c.handle);
    for (const j of this.joints) if (world.impulseJoints.contains(j.handle)) world.removeImpulseJoint(j, false);
    for (const b of this.bodies) if (world.bodies.contains(b.handle)) world.removeRigidBody(b);
    this.colliders.length = 0;
    this.bodies.length = 0;
    this.joints.length = 0;
  }
}

/**
 * Drives one kinematic position-based body from local pose samples. The first
 * drive teleports, so a round that starts mid-cycle (negative countdown time)
 * never produces a one-step velocity spike that would fling players.
 */
export class KinematicDriver {
  private primed = false;
  private readonly wp = vec3();
  private readonly wr = quatIdentity();

  constructor(
    readonly body: RigidBody,
    private readonly frame: Frame,
  ) {}

  /** Sets the body's next pose from a local sample. */
  drive(sample: PoseSample): void {
    composePose(this.frame, sample, this.wp, this.wr);
    if (!this.primed) {
      this.body.setTranslation(this.wp, true);
      this.body.setRotation(this.wr, true);
      this.primed = true;
    }
    this.body.setNextKinematicTranslation(this.wp);
    this.body.setNextKinematicRotation(this.wr);
  }

  /** Teleports without interpolated velocity (respawned boulders, parked parts). */
  teleport(sample: PoseSample): void {
    composePose(this.frame, sample, this.wp, this.wr);
    this.body.setTranslation(this.wp, true);
    this.body.setRotation(this.wr, true);
    this.body.setNextKinematicTranslation(this.wp);
    this.body.setNextKinematicRotation(this.wr);
  }
}

// -----------------------------------------------------------------------------
// Gameplay helpers
// -----------------------------------------------------------------------------

/**
 * Per-actor cooldown so a body grinding against a hammer is knocked once per
 * hit rather than every step. `Map.set` on an existing key does not allocate.
 */
export class ActorCooldown {
  private readonly last = new Map<number, number>();

  /**
   * @returns true (and arms the cooldown) when `actorId` may be affected at `t`.
   */
  ready(actorId: number, t: number, cooldown: number): boolean {
    const prev = this.last.get(actorId);
    if (prev !== undefined && t - prev < cooldown && t >= prev) return false;
    this.last.set(actorId, t);
    return true;
  }

  /** Seconds since the actor was last affected, or Infinity. */
  since(actorId: number, t: number): number {
    const prev = this.last.get(actorId);
    return prev === undefined ? Infinity : t - prev;
  }

  clear(): void {
    this.last.clear();
  }
}

const knockScratch = { v: vec3(), imp: vec3(), p: vec3() };

/** Options for {@link knockByMotion}. */
export interface KnockOptions {
  /** Horizontal velocity change in m/s. */
  speed: number;
  /** Upward velocity change in m/s. */
  lift: number;
  stun: boolean;
  /** Below this point speed (m/s) the push falls back to "away from the body centre". */
  minMotion?: number;
  /** Fallback/override horizontal direction (world). Used when the obstacle has a known push axis. */
  axis?: Vec3;
}

/**
 * Knocks an actor in the direction the obstacle surface is moving at the
 * actor's position (falls back to "away from the obstacle body"). The impulse
 * is scaled by the actor's mass so `speed` reads as a velocity change in m/s
 * regardless of character tuning.
 *
 * @param actor - The player being hit.
 * @param body - The obstacle body that hit them.
 * @param opts - Knock strength.
 */
export function knockByMotion(actor: ObstacleActor, body: RigidBody, opts: KnockOptions): void {
  const s = knockScratch;
  const ap = actor.body.translation();
  s.p.x = ap.x;
  s.p.y = ap.y;
  s.p.z = ap.z;
  let dx: number;
  let dz: number;
  if (opts.axis) {
    dx = opts.axis.x;
    dz = opts.axis.z;
  } else {
    body.velocityAtPoint(s.p, s.v);
    dx = s.v.x;
    dz = s.v.z;
    if (Math.hypot(dx, dz) < (opts.minMotion ?? 0.75)) {
      const bp = body.translation();
      dx = ap.x - bp.x;
      dz = ap.z - bp.z;
    }
  }
  const len = Math.hypot(dx, dz) || 1;
  const m = actor.body.mass() > 0 ? actor.body.mass() : 1;
  s.imp.x = (dx / len) * opts.speed * m;
  s.imp.y = opts.lift * m;
  s.imp.z = (dz / len) * opts.speed * m;
  actor.knock(s.imp, opts.stun);
}

// -----------------------------------------------------------------------------
// Hinges (tilt platforms, seesaws)
// -----------------------------------------------------------------------------

/** Local hinge axis index. */
export type HingeAxis = 'x' | 'z';

/**
 * Turns a revolute joint into a damped, self-centring, limited hinge.
 * Force-based so `stiffness` reads in N·m/rad regardless of body inertia.
 */
export function configureHinge(
  R: ObstacleBuildContext['R'],
  joint: ImpulseJoint,
  maxAngle: number,
  stiffness: number,
  damping: number,
): void {
  const j = joint as RevoluteImpulseJoint;
  j.setLimits(-maxAngle, maxAngle);
  j.configureMotorModel(R.MotorModel.ForceBased);
  j.configureMotorPosition(0, stiffness, damping);
  j.setContactsEnabled(false);
}

const hingeScratch = { q: quatIdentity(), v: vec3() };

/**
 * Hinge angle of `child` relative to `parent` about a local axis, assuming the
 * relative rotation is (close to) a pure rotation about that axis.
 */
export function hingeAngle(parent: Quat, child: Quat, axis: HingeAxis): number {
  const q = quatRelative(parent, child, hingeScratch.q);
  return 2 * Math.atan2(axis === 'x' ? q.x : q.z, q.w);
}

/** Relative angular speed of `child` about the parent's local `axis` (rad/s). */
export function hingeRate(parent: Quat, parentW: Vec3, childW: Vec3, axis: HingeAxis): number {
  const v = hingeScratch.v;
  v.x = childW.x - parentW.x;
  v.y = childW.y - parentW.y;
  v.z = childW.z - parentW.z;
  rotateVecInverse(parent, v, v);
  return axis === 'x' ? v.x : v.z;
}

/** Quantises a float to an int at `scale` steps per unit (net state packing). */
export const quantize = (v: number, scale: number): number => Math.round(v * scale);

/** Inverse of {@link quantize}. */
export const dequantize = (v: number | undefined, scale: number): number => (v ?? 0) / scale;

/** Shared scratch for actor-position reads in update loops. */
export const actorScratch = { world: vec3(), local: vec3() };

/**
 * Reads an actor's position into instance-local space without allocating
 * beyond Rapier's own getter.
 */
export function actorLocal(frame: Frame, actor: ObstacleActor, out: Vec3): Vec3 {
  const p = actor.body.translation();
  out.x = p.x;
  out.y = p.y;
  out.z = p.z;
  return toLocalPoint(frame, out, out);
}

/** Finds the actor owning `collider`'s parent body among `actors`, if any. */
export function actorIndexByBody(actors: readonly ObstacleActor[], body: RigidBody | null): number {
  if (!body) return -1;
  for (let i = 0; i < actors.length; i++) if (actors[i]!.body.handle === body.handle) return i;
  return -1;
}
