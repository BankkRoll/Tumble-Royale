/**
 * Cannon — lobs foam cannonballs down seeded lanes on a fixed rhythm.
 *
 * Balls are KINEMATIC bodies following closed-form ballistic arcs (then a
 * bouncing roll) that are pure functions of `(t, params)`: shot k fires at
 * `startDelay + k·period` down lane `cannonLane(k)`. A small pool of balls is
 * recycled round-robin, so nothing about the barrage ever needs replication.
 */
import type { Collider, RigidBody } from '@dimforge/rapier3d-compat';
import {
  InteractionGroups,
  quatFromAxisAngle,
  quatFromEulerYXZ,
  quatIdentity,
  vec3,
  type Vec3,
} from '@tumble/shared';
import { z } from 'zod';
import {
  ActorCooldowns,
  KinematicRig,
  PARK_Y,
  PhysicsBag,
  dirToWorld,
  emitCue,
  ensurePoseSamples,
  hash3,
  instanceFrame,
  mod,
  toWorld,
  writeSample,
} from './helpers-b.ts';
import type { ObstacleModule, ObstacleRuntime, PoseSample } from './types.ts';

/**
 * Cannon parameters. Metres, seconds, degrees. Origin = cannon base on the
 * floor; shots travel along local +Z.
 */
export const CannonSchema = z.object({
  /** Barrel pivot height above the base. */
  pivotHeight: z.number().positive().default(1.6),
  /** Barrel length (balls emerge from inside it). */
  barrelLength: z.number().positive().default(2.4),
  /** Distance along +Z to the landing line. */
  range: z.number().positive().default(22),
  /** Local Y of the ground where balls land. */
  landingHeight: z.number().default(0),
  laneCount: z.number().int().min(1).max(9).default(3),
  /** Lateral (X) distance between lanes at the landing line. */
  laneSpacing: z.number().min(0).default(4.5),
  /** Seconds from firing to landing. */
  flightTime: z.number().positive().default(1.5),
  /** Seconds rolling after landing before the ball pops away. */
  rollTime: z.number().min(0).default(2.2),
  /** Rolling speed after landing (m/s). */
  rollSpeed: z.number().min(0).default(8),
  /** First bounce height after landing; decays over the roll. */
  bounceHeight: z.number().min(0).default(0.9),
  /** Gravity used for the arc (m/s²); matches the world by default. */
  gravity: z.number().positive().default(24),
  /** Seconds between shots. */
  period: z.number().positive().default(2.2),
  /** Match time of the first shot. */
  startDelay: z.number().default(1),
  /** Lane order. */
  pattern: z.enum(['random', 'sequence', 'pingpong']).default('random'),
  seed: z.number().int().default(1),
  ballRadius: z.number().positive().default(0.85),
  /** Knock impulse on hit (N·s ≈ Δv); always stuns. */
  knockImpulse: z.number().min(0).default(13),
  /** Barrel slews to the next lane during this window before a shot (also the telegraph). */
  aimTime: z.number().min(0).default(0.7),
});

/** Validated Cannon parameters. */
export type CannonParams = z.output<typeof CannonSchema>;

/** Shot timing for one ball slot. */
export interface CannonShotInfo {
  /** Shot index this slot is carrying, or -1 when idle. */
  shot: number;
  /** Seconds (scaled) since that shot fired. */
  age: number;
  lane: number;
  /** In flight or rolling. */
  active: boolean;
}

/** Size of the recycled ball pool. */
export const cannonPoolSize = (p: CannonParams): number =>
  Math.ceil((p.flightTime + p.rollTime) / p.period) + 1;

/** Lane index for shot `k`. Pure. */
export function cannonLane(p: CannonParams, k: number): number {
  const n = p.laneCount;
  if (n <= 1) return 0;
  if (p.pattern === 'sequence') return mod(k, n);
  if (p.pattern === 'pingpong') {
    const m = mod(k, 2 * n - 2);
    return m < n ? m : 2 * n - 2 - m;
  }
  return Math.min(n - 1, Math.floor(hash3(p.seed, k, 0x0ca) * n));
}

/** Local X of a lane's landing point. */
export const cannonLaneX = (p: CannonParams, lane: number): number =>
  (lane - (p.laneCount - 1) / 2) * p.laneSpacing;

/** Most recent shot index at scaled time `ts` (-1 before the first shot). */
export const cannonShotIndex = (ts: number, p: CannonParams): number =>
  ts < p.startDelay ? -1 : Math.floor((ts - p.startDelay) / p.period);

/**
 * Which shot ball slot `slot` carries at scaled time `ts`. Pure.
 */
export function cannonSlotShot(
  ts: number,
  p: CannonParams,
  slot: number,
  out: CannonShotInfo,
): CannonShotInfo {
  const n = cannonPoolSize(p);
  const now = cannonShotIndex(ts, p);
  const k = now - mod(now - slot, n);
  out.shot = k;
  if (k < 0) {
    out.age = 0;
    out.lane = 0;
    out.active = false;
    return out;
  }
  out.age = ts - (p.startDelay + k * p.period);
  out.lane = cannonLane(p, k);
  out.active = out.age >= 0 && out.age < p.flightTime + p.rollTime;
  return out;
}

/** Initial (pivot-relative) launch velocity for a lane, written to `out`. */
export function cannonLaunchVelocity(p: CannonParams, lane: number, out: Vec3): Vec3 {
  const T = p.flightTime;
  out.x = cannonLaneX(p, lane) / T;
  out.z = p.range / T;
  const dy = p.landingHeight + p.ballRadius - p.pivotHeight;
  out.y = (dy + 0.5 * p.gravity * T * T) / T;
  return out;
}

/**
 * Local position and spin of a ball `age` seconds after firing down `lane`.
 * Starts at the barrel pivot (inside the barrel mesh), arcs, then bounce-rolls.
 */
export function cannonBallAt(
  p: CannonParams,
  lane: number,
  age: number,
  outPos: Vec3,
  outRot: { x: number; y: number; z: number; w: number },
): void {
  cannonLaunchVelocity(p, lane, v0);
  const hx = v0.x;
  const hz = v0.z;
  const hlen = Math.hypot(hx, hz) || 1;
  const dx = hx / hlen;
  const dz = hz / hlen;
  let dist: number;
  if (age <= p.flightTime) {
    outPos.x = hx * age;
    outPos.z = hz * age;
    outPos.y = p.pivotHeight + v0.y * age - 0.5 * p.gravity * age * age;
    dist = hlen * age;
  } else {
    const u = age - p.flightTime;
    const landX = hx * p.flightTime;
    const landZ = hz * p.flightTime;
    outPos.x = landX + dx * p.rollSpeed * u;
    outPos.z = landZ + dz * p.rollSpeed * u;
    outPos.y =
      p.landingHeight + p.ballRadius + p.bounceHeight * Math.abs(Math.sin(u * 5.5)) * Math.exp(-2.2 * u);
    dist = hlen * p.flightTime + p.rollSpeed * u;
  }
  // Rolling about (up × dir) by distance / radius, so the stripes read as a real roll.
  quatFromAxisAngle(dz, 0, -dx, dist / p.ballRadius, outRot);
}
const v0 = vec3();

/** Barrel aim (yaw, elevation in radians) and recoil (metres) at scaled time `ts`. Pure. */
export function cannonAim(
  ts: number,
  p: CannonParams,
  out: { yaw: number; pitch: number; recoil: number },
): void {
  const now = cannonShotIndex(ts, p);
  const nextT = p.startDelay + (now + 1) * p.period;
  const laneNow = cannonLane(p, Math.max(now, 0));
  const laneNext = cannonLane(p, now + 1);
  let blend = 0;
  if (p.aimTime > 0 && nextT - ts < p.aimTime) {
    const x = 1 - (nextT - ts) / p.aimTime;
    blend = x * x * (3 - 2 * x);
  }
  cannonLaunchVelocity(p, laneNow, aimA);
  cannonLaunchVelocity(p, laneNext, aimB);
  const vx = aimA.x + (aimB.x - aimA.x) * blend;
  const vy = aimA.y + (aimB.y - aimA.y) * blend;
  const vz = aimA.z + (aimB.z - aimA.z) * blend;
  out.yaw = Math.atan2(vx, vz);
  out.pitch = Math.atan2(vy, Math.hypot(vx, vz));
  const age = now < 0 ? 99 : ts - (p.startDelay + now * p.period);
  out.recoil = 0.45 * Math.exp(-9 * age) * Math.min(1, age * 40);
}
const aimA = vec3();
const aimB = vec3();

/** Telegraph 0–1: ramps up while the barrel takes aim before each shot. Pure. */
export function cannonTelegraph(t: number, p: CannonParams, speedScale: number): number {
  const ts = t * speedScale;
  const nextT = p.startDelay + (cannonShotIndex(ts, p) + 1) * p.period;
  if (p.aimTime <= 0) return 0;
  const left = nextT - ts;
  return left < p.aimTime ? 1 - left / p.aimTime : 0;
}

const aim = { yaw: 0, pitch: 0, recoil: 0 };
const slotInfo: CannonShotInfo = { shot: -1, age: 0, lane: 0, active: false };
const qTmp = quatIdentity();
const pTmp = vec3();

/**
 * Pure pose. Sample 0 = barrel (at the pivot, local +Z along the bore, recoil
 * applied). Samples 1…pool = balls; idle balls are parked at {@link PARK_Y}.
 */
export function cannonPose(t: number, p: CannonParams, out: PoseSample[], speedScale: number): void {
  const pool = cannonPoolSize(p);
  ensurePoseSamples(out, pool + 1);
  const ts = t * speedScale;
  cannonAim(ts, p, aim);
  quatFromEulerYXZ(aim.yaw, -aim.pitch, 0, qTmp);
  const cp = Math.cos(aim.pitch);
  const bx = Math.sin(aim.yaw) * cp;
  const by = Math.sin(aim.pitch);
  const bz = Math.cos(aim.yaw) * cp;
  writeSample(
    out[0] as PoseSample,
    -bx * aim.recoil,
    p.pivotHeight - by * aim.recoil,
    -bz * aim.recoil,
    qTmp,
  );
  for (let s = 0; s < pool; s++) {
    const sample = out[s + 1] as PoseSample;
    cannonSlotShot(ts, p, s, slotInfo);
    if (!slotInfo.active) {
      writeSample(sample, 0, PARK_Y - s * 4, 0, IDENTITY);
      continue;
    }
    cannonBallAt(p, slotInfo.lane, slotInfo.age, sample.pos, sample.rot);
  }
}
const IDENTITY = quatIdentity();

/** Cannon obstacle module. */
export const cannon: ObstacleModule<CannonParams> = {
  type: 'cannon',
  displayName: 'Foam Cannon',
  schema: CannonSchema,
  audioCues: ['cannonThump', 'cannonballLand', 'cannonHit'],
  pose: cannonPose,
  create(instance, ctx): ObstacleRuntime {
    const p = CannonSchema.parse(instance.params);
    const { R } = ctx;
    const scale = ctx.speedScale;
    const frame = instanceFrame(instance);
    const bag = new PhysicsBag(ctx);
    const pool = cannonPoolSize(p);

    const base = bag.fixed(frame);
    const baseH = Math.max(0.2, p.pivotHeight - 0.5);
    bag.collider(
      R.ColliderDesc.cylinder(baseH / 2, 1.3)
        .setTranslation(0, baseH / 2, 0)
        .setCollisionGroups(InteractionGroups.static),
      base,
      { kind: 'normal', ownerId: instance.id },
    );

    const bodies: RigidBody[] = [];
    const barrel = bag.kinematic(frame);
    bag.collider(
      R.ColliderDesc.capsule(p.barrelLength * 0.4, 0.55)
        .setRotation(quatFromAxisAngle(1, 0, 0, Math.PI / 2))
        .setTranslation(0, 0, p.barrelLength * 0.35)
        .setCollisionGroups(InteractionGroups.kinematic),
      barrel,
      { kind: 'normal', ownerId: instance.id },
    );
    bodies.push(barrel);

    const slotOf = new Map<number, number>();
    for (let s = 0; s < pool; s++) {
      const ball = bag.kinematic(frame);
      const c = bag.collider(
        R.ColliderDesc.ball(p.ballRadius)
          .setRestitution(0.6)
          .setCollisionGroups(InteractionGroups.kinematic)
          .setActiveEvents(R.ActiveEvents.COLLISION_EVENTS),
        ball,
        { kind: 'bouncy', stunOnTouch: true, ownerId: instance.id },
      );
      slotOf.set(c.handle, s);
      bodies.push(ball);
    }

    const rig = new KinematicRig(frame, bodies, (t, out) => cannonPose(t, p, out, scale));
    const lastShot = new Int32Array(pool).fill(-1);
    const landed = new Uint8Array(pool);
    const hits = new ActorCooldowns();
    const impulse = vec3();
    const info: CannonShotInfo = { shot: -1, age: 0, lane: 0, active: false };
    const muzzleLocal = vec3(0, p.pivotHeight, 0);
    const muzzle = vec3();
    toWorld(frame, muzzleLocal, null, muzzle, null);
    let lastFired = -1;

    return {
      instance,
      colliders: bag.colliders,
      update(sctx) {
        const ts = sctx.t * scale;
        for (let s = 0; s < pool; s++) {
          cannonSlotShot(ts, p, s, info);
          const k = info.active ? info.shot : -1;
          if (k !== lastShot[s]) {
            // A freshly fired (or freshly parked) ball must teleport, not sweep.
            rig.markSnap(s + 1);
            lastShot[s] = k;
            landed[s] = 0;
          }
          if (info.active && landed[s] === 0 && info.age >= p.flightTime) {
            landed[s] = 1;
            const b = rig.bodies[s + 1];
            if (b) emitCue(sctx.events, instance.id, 'cannonballLand', b.translation());
          }
        }
        rig.apply(sctx.t, sctx.dt);
        const fired = cannonShotIndex(ts, p);
        if (fired !== lastFired) {
          if (fired >= 0 && fired === lastFired + 1) emitCue(sctx.events, instance.id, 'cannonThump', muzzle);
          lastFired = fired;
        }
      },
      onContact(actor, collider: Collider, sctx) {
        const s = slotOf.get(collider.handle);
        if (s === undefined || actor.isGhost) return;
        cannonSlotShot(sctx.t * scale, p, s, info);
        if (!info.active || !hits.ready(actor.id, sctx.t)) return;
        hits.arm(actor.id, sctx.t, 0.8);
        cannonLaunchVelocity(p, info.lane, impulse);
        const len = Math.hypot(impulse.x, impulse.z) || 1;
        pTmp.x = (impulse.x / len) * p.knockImpulse;
        pTmp.y = 0;
        pTmp.z = (impulse.z / len) * p.knockImpulse;
        dirToWorld(frame, pTmp, impulse);
        impulse.y += p.knockImpulse * 0.45;
        actor.knock(impulse, true);
        emitCue(sctx.events, instance.id, 'cannonHit', actor.body.translation());
      },
      telegraph: (t) => cannonTelegraph(t, p, scale),
      dispose: () => bag.dispose(),
    };
  },
};
