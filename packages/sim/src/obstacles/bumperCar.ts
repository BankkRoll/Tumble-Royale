/**
 * Bumper Cars — chunky carts circling closed spline tracks. Each cart's arc
 * length is the analytic integral of a sinusoidally varying speed, so carts
 * surge and dawdle unpredictably yet stay pure functions of time. Touching a
 * cart bumps the player away.
 */
import type { Collider, RigidBody } from '@dimforge/rapier3d-compat';
import { InteractionGroups, quatFromYaw, quatIdentity, vec3, type Vec3 } from '@tumble/shared';
import { z } from 'zod';
import {
  ActorCooldowns,
  KinematicRig,
  PhysicsBag,
  dirToWorld,
  emitCue,
  ensurePoseSamples,
  hash3,
  instanceFrame,
  mod,
  writeSample,
} from './helpers-b.ts';
import type { ObstacleModule, ObstacleRuntime, PoseSample } from './types.ts';

const PointXZ = z.object({ x: z.number(), z: z.number() });

/** Bumper Car parameters. Metres, seconds. Origin = track centre on the floor. */
export const BumperCarSchema = z.object({
  /** `oval` uses radiusX/radiusZ; `custom` uses `points` (closed loop, ≥ 3). */
  path: z.enum(['oval', 'custom']).default('oval'),
  radiusX: z.number().positive().default(10),
  radiusZ: z.number().positive().default(6),
  /** Closed Catmull-Rom control points in local XZ (custom path). */
  points: z.array(PointXZ).default([]),
  cars: z.number().int().min(1).max(12).default(3),
  /** Mean speed along the track (m/s). */
  speed: z.number().min(0).default(5),
  /** Speed swing as a fraction of `speed` (0 = constant, 0.5 = ±50%). */
  speedVariation: z.number().min(0).max(0.95).default(0.35),
  /** Seconds per surge/dawdle cycle. */
  variationPeriod: z.number().positive().default(4),
  /** 1 = forward along the point order, -1 = reverse. */
  direction: z.union([z.literal(1), z.literal(-1)]).default(1),
  carLength: z.number().positive().default(2.4),
  carWidth: z.number().positive().default(1.6),
  carHeight: z.number().positive().default(1.1),
  /** Horizontal bump impulse (N·s ≈ Δv). */
  bumpImpulse: z.number().min(0).default(9),
  /** Whether a bump also stuns. */
  stunOnBump: z.boolean().default(false),
  /** Seeds each cart's surge phase. */
  seed: z.number().int().default(1),
});

/** Validated Bumper Car parameters. */
export type BumperCarParams = z.output<typeof BumperCarSchema>;

/** Arc-length lookup table for a closed track. */
export interface TrackLut {
  /** Total loop length in metres. */
  length: number;
  /** Cumulative arc length at each sample (first = 0). */
  cum: Float64Array;
  xs: Float64Array;
  zs: Float64Array;
}

const SAMPLES_PER_SEGMENT = 32;
const lutCache = new WeakMap<BumperCarParams, TrackLut>();

/** Control points for a track (oval → 16-point ellipse). */
export function bumperTrackPoints(p: BumperCarParams): { x: number; z: number }[] {
  if (p.path === 'custom' && p.points.length >= 3) return p.points;
  const pts: { x: number; z: number }[] = [];
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    pts.push({ x: Math.cos(a) * p.radiusX, z: Math.sin(a) * p.radiusZ });
  }
  return pts;
}

/**
 * Builds (and memoises per params object) the arc-length table of the closed
 * uniform Catmull-Rom track. Memoisation only caches a pure derivation, so
 * `pose()` stays a pure function of its arguments.
 */
export function bumperTrackLut(p: BumperCarParams): TrackLut {
  const cached = lutCache.get(p);
  if (cached) return cached;
  const pts = bumperTrackPoints(p);
  const n = pts.length;
  const m = n * SAMPLES_PER_SEGMENT;
  const xs = new Float64Array(m + 1);
  const zs = new Float64Array(m + 1);
  const cum = new Float64Array(m + 1);
  for (let j = 0; j <= m; j++) {
    const seg = Math.floor(j / SAMPLES_PER_SEGMENT) % n;
    const u = (j % SAMPLES_PER_SEGMENT) / SAMPLES_PER_SEGMENT;
    const p0 = pts[(seg - 1 + n) % n]!;
    const p1 = pts[seg]!;
    const p2 = pts[(seg + 1) % n]!;
    const p3 = pts[(seg + 2) % n]!;
    xs[j] = catmull(p0.x, p1.x, p2.x, p3.x, u);
    zs[j] = catmull(p0.z, p1.z, p2.z, p3.z, u);
    if (j > 0) cum[j] = cum[j - 1]! + Math.hypot(xs[j]! - xs[j - 1]!, zs[j]! - zs[j - 1]!);
  }
  const lut: TrackLut = { length: cum[m]!, cum, xs, zs };
  lutCache.set(p, lut);
  return lut;
}

function catmull(p0: number, p1: number, p2: number, p3: number, u: number): number {
  const u2 = u * u;
  const u3 = u2 * u;
  return (
    0.5 * (2 * p1 + (-p0 + p2) * u + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u2 + (-p0 + 3 * p1 - 3 * p2 + p3) * u3)
  );
}

/**
 * Samples the track at arc length `s` (wrapped). Writes position (y = 0) and
 * returns the travel yaw (radians, 0 = +Z).
 */
export function sampleTrack(lut: TrackLut, s: number, out: Vec3): number {
  const L = lut.length;
  const d = L > 0 ? mod(s, L) : 0;
  let lo = 0;
  let hi = lut.cum.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (lut.cum[mid]! <= d) lo = mid;
    else hi = mid;
  }
  const c0 = lut.cum[lo]!;
  const span = lut.cum[hi]! - c0 || 1;
  const f = (d - c0) / span;
  const x0 = lut.xs[lo]!;
  const z0 = lut.zs[lo]!;
  const dx = lut.xs[hi]! - x0;
  const dz = lut.zs[hi]! - z0;
  out.x = x0 + dx * f;
  out.y = 0;
  out.z = z0 + dz * f;
  return Math.atan2(dx, dz);
}

/**
 * Arc length travelled by cart `i` at match time `t`:
 * s(t) = offset + dir·v0·(t − a·(cos(ωt+φ) − cos φ)/ω), the exact integral of
 * v(t) = v0·(1 + a·sin(ωt+φ)).
 */
export function bumperCarDistance(
  t: number,
  p: BumperCarParams,
  i: number,
  speedScale: number,
  loop: number,
): number {
  const ts = t * speedScale;
  const w = (Math.PI * 2) / p.variationPeriod;
  const phi = hash3(p.seed, i, 0xb0) * Math.PI * 2;
  const s = p.speed * (ts - (p.speedVariation * (Math.cos(w * ts + phi) - Math.cos(phi))) / w);
  return (i / p.cars) * loop + p.direction * s;
}

const pt = vec3();
const q = quatIdentity();

/** Pure pose: one sample per cart, positioned at its body centre and facing its travel direction. */
export function bumperCarPose(t: number, p: BumperCarParams, out: PoseSample[], speedScale: number): void {
  ensurePoseSamples(out, p.cars);
  const lut = bumperTrackLut(p);
  for (let i = 0; i < p.cars; i++) {
    let yaw = sampleTrack(lut, bumperCarDistance(t, p, i, speedScale, lut.length), pt);
    if (p.direction < 0) yaw += Math.PI;
    writeSample(out[i] as PoseSample, pt.x, p.carHeight / 2, pt.z, quatFromYaw(yaw, q));
  }
}

/** Bumper Car obstacle module. */
export const bumperCar: ObstacleModule<BumperCarParams> = {
  type: 'bumperCar',
  displayName: 'Bumper Carts',
  schema: BumperCarSchema,
  audioCues: ['bumperHonk'],
  pose: bumperCarPose,
  create(instance, ctx): ObstacleRuntime {
    const p = BumperCarSchema.parse(instance.params);
    const { R } = ctx;
    const scale = ctx.speedScale;
    const frame = instanceFrame(instance);
    const bag = new PhysicsBag(ctx);
    const r = Math.min(0.3, p.carHeight / 3);
    const bodies: RigidBody[] = [];
    const carOf = new Map<number, number>();
    for (let i = 0; i < p.cars; i++) {
      const body = bag.kinematic(frame);
      const c = bag.collider(
        R.ColliderDesc.roundCuboid(p.carWidth / 2 - r, p.carHeight / 2 - r, p.carLength / 2 - r, r)
          .setRestitution(0.5)
          .setCollisionGroups(InteractionGroups.kinematic)
          .setActiveEvents(R.ActiveEvents.COLLISION_EVENTS),
        body,
        { kind: 'normal', ownerId: instance.id },
      );
      carOf.set(c.handle, i);
      bodies.push(body);
    }
    const rig = new KinematicRig(frame, bodies, (t, out) => bumperCarPose(t, p, out, scale));
    const hits = new ActorCooldowns();
    const impulse = vec3();
    const local = vec3();

    return {
      instance,
      colliders: bag.colliders,
      update(sctx) {
        rig.apply(sctx.t, sctx.dt);
      },
      onContact(actor, collider: Collider, sctx) {
        const i = carOf.get(collider.handle);
        if (i === undefined || p.bumpImpulse <= 0 || !hits.ready(actor.id, sctx.t)) return;
        hits.arm(actor.id, sctx.t, 0.6);
        const car = rig.bodies[i]!.translation();
        const a = actor.body.translation();
        let dx = a.x - car.x;
        let dz = a.z - car.z;
        const len = Math.hypot(dx, dz);
        if (len < 1e-4) {
          // Dead-centre hit (landed on the roof): push along the cart's heading.
          const s = rig.samples[i]!;
          local.x = 2 * (s.rot.x * s.rot.z + s.rot.w * s.rot.y);
          local.y = 0;
          local.z = 1 - 2 * (s.rot.x * s.rot.x + s.rot.y * s.rot.y);
          dirToWorld(frame, local, local);
          dx = local.x;
          dz = local.z;
        } else {
          dx /= len;
          dz /= len;
        }
        impulse.x = dx * p.bumpImpulse;
        impulse.y = p.bumpImpulse * 0.3;
        impulse.z = dz * p.bumpImpulse;
        actor.knock(impulse, p.stunOnBump);
        emitCue(sctx.events, instance.id, 'bumperHonk', car);
      },
      dispose: () => bag.dispose(),
    };
  },
};
