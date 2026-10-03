/**
 * Shared plumbing for obstacle set B: instance transforms, kinematic driving,
 * collider bookkeeping, per-actor cooldowns and cue emission.
 *
 * Responsibilities:
 * - Convert a designer-authored {@link ObstacleInstance} transform (degrees) into a
 *   world frame once at build time.
 * - Compose local poses (from pure `pose()` functions) into world poses without
 *   allocating.
 * - Drive kinematic bodies with discontinuity detection so time jumps (rewind,
 *   first step, countdown → PLAYING) never inject huge kinematic velocities.
 * - Track every body/collider an obstacle owns so `dispose()` is one call.
 *
 * Nothing here is part of the public obstacle API; set B modules use it internally.
 */
import type { Collider, ColliderDesc, RigidBody } from '@dimforge/rapier3d-compat';
import { quatFromEulerYXZ, quatIdentity, quatMul, rotateVec, vec3, type Quat, type Vec3 } from '@tumble/shared';
import type { EventSink } from '../events.ts';
import type { SurfaceInfo } from '../physics/surfaces.ts';
import type { ObstacleBuildContext, ObstacleInstance, PoseSample } from './types.ts';

/** Degrees → radians. */
export const DEG = Math.PI / 180;

/**
 * If consecutive updates are further apart than this (seconds) beyond one step,
 * kinematic bodies are teleported instead of swept: Rapier would otherwise derive
 * a velocity of `distance / dt` and launch anything touching the body.
 */
export const KINEMATIC_SNAP_GAP = 0.25;

/** Y used to park inactive kinematic parts (spent cannonballs, fallen bridge segments). */
export const PARK_Y = -1000;

/** A rigid world transform. */
export interface Frame {
  pos: Vec3;
  rot: Quat;
}

/**
 * Builds the world frame of a placed obstacle from its designer-authored
 * position and yaw/pitch/roll in degrees.
 *
 * @param instance - The placed obstacle.
 * @returns A fresh frame (build-time only).
 */
export function instanceFrame(instance: ObstacleInstance<unknown>): Frame {
  const r = instance.rotation;
  return {
    pos: vec3(instance.position.x, instance.position.y, instance.position.z),
    rot: quatFromEulerYXZ((r?.yaw ?? 0) * DEG, (r?.pitch ?? 0) * DEG, (r?.roll ?? 0) * DEG),
  };
}

/** @returns A fresh pose sample (identity). */
export const poseSample = (): PoseSample => ({ pos: vec3(), rot: quatIdentity() });

/**
 * Grows `out` to at least `n` samples. Allocates only the first time a caller
 * passes a short array, so steady-state pose evaluation is allocation-free.
 */
export function ensurePoseSamples(out: PoseSample[], n: number): void {
  while (out.length < n) out.push(poseSample());
}

/** Writes position + quaternion into a sample. */
export function writeSample(s: PoseSample, x: number, y: number, z: number, q: Quat): void {
  s.pos.x = x;
  s.pos.y = y;
  s.pos.z = z;
  s.rot.x = q.x;
  s.rot.y = q.y;
  s.rot.z = q.z;
  s.rot.w = q.w;
}

/**
 * Composes `frame * local` into `outPos`/`outRot` (world = frame ∘ local).
 * `outPos` may alias `localPos`; `outRot` may alias `localRot`.
 */
export function toWorld(frame: Frame, localPos: Vec3, localRot: Quat | null, outPos: Vec3, outRot: Quat | null): void {
  rotateVec(frame.rot, localPos, outPos);
  outPos.x += frame.pos.x;
  outPos.y += frame.pos.y;
  outPos.z += frame.pos.z;
  if (outRot) {
    if (localRot) quatMul(frame.rot, localRot, outRot);
    else {
      outRot.x = frame.rot.x;
      outRot.y = frame.rot.y;
      outRot.z = frame.rot.z;
      outRot.w = frame.rot.w;
    }
  }
}

/**
 * Rotates a local direction into world space (no translation).
 */
export function dirToWorld(frame: Frame, local: Vec3, out: Vec3): Vec3 {
  return rotateVec(frame.rot, local, out);
}

/**
 * Inverse of {@link toWorld} for points: world → obstacle-local.
 */
export function pointToLocal(frame: Frame, world: Vec3, out: Vec3): Vec3 {
  out.x = world.x - frame.pos.x;
  out.y = world.y - frame.pos.y;
  out.z = world.z - frame.pos.z;
  const q = frame.rot;
  scratchInv.x = -q.x;
  scratchInv.y = -q.y;
  scratchInv.z = -q.z;
  scratchInv.w = q.w;
  return rotateVec(scratchInv, out, out);
}
const scratchInv = quatIdentity();

/**
 * @returns True when `t` is not the step after `prevT`, i.e. the sim jumped in
 * time (first update, rewind/replay, phase change) and kinematics must snap.
 */
export function timeJumped(prevT: number, t: number, dt: number): boolean {
  return !Number.isFinite(prevT) || Math.abs(t - prevT - dt) > KINEMATIC_SNAP_GAP;
}

/**
 * Moves a kinematic position-based body to a world pose. When `snap` is set the
 * body is teleported so Rapier does not infer a velocity from the jump.
 */
export function driveKinematic(body: RigidBody, pos: Vec3, rot: Quat, snap: boolean): void {
  if (snap) {
    body.setTranslation(pos, true);
    body.setRotation(rot, true);
  }
  body.setNextKinematicTranslation(pos);
  body.setNextKinematicRotation(rot);
}

/**
 * Drives a fixed list of kinematic bodies from a pure pose function: sample i
 * of the pose output moves body i. Owns its scratch samples, so `apply` never
 * allocates.
 */
export class KinematicRig {
  /** Local-space samples from the most recent `apply`. */
  readonly samples: PoseSample[] = [];
  private prevT = Number.NaN;
  private readonly wp = vec3();
  private readonly wq = quatIdentity();

  /**
   * @param frame - Obstacle world frame.
   * @param bodies - Kinematic bodies, one per pose sample.
   * @param poseAt - Fills `out` with local poses at time `t`.
   */
  constructor(
    private readonly frame: Frame,
    readonly bodies: readonly RigidBody[],
    private readonly poseAt: (t: number, out: PoseSample[]) => void,
  ) {
    ensurePoseSamples(this.samples, bodies.length);
    this.snapFlags = new Uint8Array(bodies.length);
  }

  /**
   * Poses every body for time `t`.
   *
   * @param forceSnap - Teleport regardless of time continuity (e.g. a part was just respawned).
   */
  apply(t: number, dt: number, forceSnap = false): void {
    const snap = forceSnap || timeJumped(this.prevT, t, dt);
    this.prevT = t;
    this.poseAt(t, this.samples);
    for (let i = 0; i < this.bodies.length; i++) {
      const s = this.samples[i] as PoseSample;
      toWorld(this.frame, s.pos, s.rot, this.wp, this.wq);
      driveKinematic(this.bodies[i] as RigidBody, this.wp, this.wq, snap || this.snapFlags[i] === 1);
      this.snapFlags[i] = 0;
    }
  }

  /** Teleports body `i` on the next `apply` regardless of time continuity (respawned parts). */
  markSnap(i: number): void {
    this.snapFlags[i] = 1;
  }

  private readonly snapFlags: Uint8Array;
}

/**
 * Bookkeeping for everything an obstacle creates in the physics world, so
 * runtimes expose a stable `colliders` array and dispose with one call.
 */
export class PhysicsBag {
  readonly colliders: Collider[] = [];
  readonly bodies: RigidBody[] = [];

  constructor(private readonly ctx: ObstacleBuildContext) {}

  /** Creates a fixed body at a world frame. */
  fixed(frame: Frame): RigidBody {
    const { R, world } = this.ctx;
    const b = world.createRigidBody(
      R.RigidBodyDesc.fixed().setTranslation(frame.pos.x, frame.pos.y, frame.pos.z).setRotation(frame.rot),
    );
    this.bodies.push(b);
    return b;
  }

  /** Creates a kinematic position-based body at a world frame. */
  kinematic(frame: Frame): RigidBody {
    const { R, world } = this.ctx;
    const b = world.createRigidBody(
      R.RigidBodyDesc.kinematicPositionBased()
        .setTranslation(frame.pos.x, frame.pos.y, frame.pos.z)
        .setRotation(frame.rot),
    );
    this.bodies.push(b);
    return b;
  }

  /** Adopts a body created elsewhere (dynamic props) so it is freed on dispose. */
  adoptBody(body: RigidBody): RigidBody {
    this.bodies.push(body);
    return body;
  }

  /**
   * Attaches a collider and optionally registers gameplay surface data for it.
   *
   * @param desc - Fully configured collider description (groups, friction, sensor…).
   * @param body - Parent body.
   * @param surface - Surface data; `ownerId` is filled from the instance if omitted.
   */
  collider(desc: ColliderDesc, body: RigidBody, surface?: SurfaceInfo): Collider {
    const c = this.ctx.world.createCollider(desc, body);
    this.colliders.push(c);
    if (surface) this.ctx.surfaces.set(c.handle, surface);
    return c;
  }

  /** Removes every collider (and its surface entry) and body this bag created. */
  dispose(): void {
    const { world, surfaces } = this.ctx;
    for (const c of this.colliders) surfaces.delete(c.handle);
    // Removing a body also removes its colliders; freeing colliders first would double-free.
    for (const b of this.bodies) {
      if (world.getRigidBody(b.handle)) world.removeRigidBody(b);
    }
    this.colliders.length = 0;
    this.bodies.length = 0;
  }
}

/**
 * Emits an `obstacleCue` event. Allocates (events must own their positions), so
 * only call on actual cue edges, never per step.
 */
export function emitCue(events: EventSink, obstacle: string, cue: string, pos: Vec3): void {
  events.push({ type: 'obstacleCue', obstacle, cue, pos: { x: pos.x, y: pos.y, z: pos.z } });
}

/**
 * Per-actor "ready again at time T" bookkeeping (teleporters, hit cooldowns).
 * Keyed by actor id; entries are overwritten in place so steady state does not allocate.
 */
export class ActorCooldowns {
  private readonly until = new Map<number, number>();

  /** @returns True if the actor may trigger at time `t`. */
  ready(actorId: number, t: number): boolean {
    const u = this.until.get(actorId);
    return u === undefined || t >= u;
  }

  /** Blocks the actor until `t + seconds`. */
  arm(actorId: number, t: number, seconds: number): void {
    this.until.set(actorId, t + seconds);
  }

  /** Forgets all cooldowns (round reset). */
  clear(): void {
    this.until.clear();
  }
}

/**
 * Actors currently overlapping an obstacle's sensors, maintained from
 * `onTrigger` enter/exit. Backed by an array so per-step iteration is
 * allocation-free (a Map iterator would allocate every step).
 */
export class ActorSet<A extends { id: number }> {
  readonly items: A[] = [];

  /** Adds the actor if absent. */
  add(a: A): void {
    for (const x of this.items) if (x.id === a.id) return;
    this.items.push(a);
  }

  /** Removes the actor with this id if present. */
  remove(id: number): void {
    const i = this.items.findIndex((x) => x.id === id);
    if (i >= 0) {
      this.items[i] = this.items[this.items.length - 1] as A;
      this.items.pop();
    }
  }

  /** @returns True if the actor is in the set. */
  has(id: number): boolean {
    for (const x of this.items) if (x.id === id) return true;
    return false;
  }

  clear(): void {
    this.items.length = 0;
  }
}

/**
 * Smooth 0→1→0 pulse used for telegraphs: `count` pulses per second, sharpened.
 *
 * @param t - Seconds into the telegraph window.
 * @param rate - Pulses per second.
 */
export function pulse(t: number, rate: number): number {
  const s = 0.5 - 0.5 * Math.cos(t * rate * Math.PI * 2);
  return s * s;
}

/**
 * Rapier friction coefficient for a surface kind. Character tuning owns how a
 * surface *feels*; this only keeps loose props and tumbling (ragdolled) players
 * consistent with that feel.
 */
export function frictionFor(kind: SurfaceInfo['kind']): number {
  switch (kind) {
    case 'ice':
      return 0.02;
    case 'slide':
      return 0.0;
    case 'sticky':
      return 2.0;
    case 'slime':
      return 1.2;
    default:
      return 0.8;
  }
}

/**
 * A static oriented box in obstacle-local space. Static set-B obstacles describe
 * their colliders as part lists so the renderer can build matching meshes.
 */
export interface BoxPart {
  /** Centre, obstacle-local metres. */
  pos: Vec3;
  rot: Quat;
  /** Half extents in metres. */
  half: Vec3;
  /** What the part is for; renderers pick materials by role. */
  role: string;
}

/**
 * Two pillars and a crossbeam spanning local X, centred on the origin, base at
 * y = 0. Shared by checkpoint and finish arches (roles `pillar`, `beam`).
 */
export function archParts(width: number, height: number, pillar: number, depth: number): BoxPart[] {
  const hp = pillar / 2;
  const hd = depth / 2;
  const id = (): Quat => quatIdentity();
  return [
    { pos: vec3(-(width / 2 + hp), height / 2, 0), rot: id(), half: vec3(hp, height / 2, hd), role: 'pillar' },
    { pos: vec3(width / 2 + hp, height / 2, 0), rot: id(), half: vec3(hp, height / 2, hd), role: 'pillar' },
    { pos: vec3(0, height + hp, 0), rot: id(), half: vec3(width / 2 + pillar, hp, hd), role: 'beam' },
  ];
}

/** Positive modulo (JS `%` keeps the dividend's sign). */
export const mod = (a: number, n: number): number => ((a % n) + n) % n;

/**
 * Tiny deterministic integer hash of up to three ints, mixed into a [0, 1) float.
 * Used by pure schedules (popup patterns, cannon lanes) that cannot carry an Rng.
 */
export function hash3(a: number, b: number, c: number): number {
  let x = Math.imul((a | 0) ^ 0x9e3779b9, 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x ^ (b | 0), 0xc2b2ae35);
  x ^= x >>> 16;
  x = Math.imul(x ^ Math.imul(c | 0, 0x27d4eb2d), 0x165667b1);
  x ^= x >>> 15;
  return (x >>> 0) / 4294967296;
}
