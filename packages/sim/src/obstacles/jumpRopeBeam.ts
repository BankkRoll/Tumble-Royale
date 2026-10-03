/**
 * Jump Rope Beam — foam beams sweeping around a central hub at jump height
 * and/or duck height, accelerating over the round. Angular velocity ramps
 * linearly to a cap; the angle is the closed-form integral of that curve, so
 * the pose is exact at any match time (no accumulated drift between peers).
 */
import type { Collider, RigidBody } from '@dimforge/rapier3d-compat';
import {
  InteractionGroups,
  quatFromAxisAngle,
  quatFromYaw,
  quatMul,
  rotateVec,
  vec3,
  type Quat,
  type Vec3,
} from '@tumble/shared';
import { z } from 'zod';
import {
  ActorCooldowns,
  DEG,
  KinematicRig,
  PhysicsBag,
  emitCue,
  ensurePoseSamples,
  instanceFrame,
  writeSample,
} from './helpers-b.ts';
import type {
  ObstacleActor,
  ObstacleModule,
  ObstacleRuntime,
  ObstacleStepContext,
  PoseSample,
} from './types.ts';

// Trip response as fractions of `knockImpulse`: a hop plus a shove back against the sweep. The
// backward part is what makes the rim risky (it slides you tangentially, i.e. slightly outward);
// tuned so 40 bots reach a 65% cut in ~55–90 s instead of the 8–13 s a forward knock gave.
const TRIP_UP = 0.5;
const TRIP_BACK = 0.6;

/** Jump Rope Beam parameters. Metres, degrees, seconds. Origin = hub base on the floor. */
export const JumpRopeBeamSchema = z.object({
  /** Beam reach from the hub centre. */
  radius: z.number().positive().default(10),
  /** `full` beams pass through the hub (two-sided); `arm` beams are one-sided. */
  mode: z.enum(['arm', 'full']).default('full'),
  /** Which heights are active: `low` (jump it), `high` (duck/dive under it), `both`. */
  layers: z.enum(['low', 'high', 'both']).default('low'),
  lowHeight: z.number().default(0.55),
  highHeight: z.number().default(1.95),
  /** Beams per layer, evenly spaced. */
  beamsPerLayer: z.number().int().min(1).max(4).default(1),
  /** Angular offset of the high layer relative to the low layer (degrees). */
  highOffset: z.number().default(90),
  /** High layer spins the same way or opposite to the low layer. */
  highDirection: z.enum(['same', 'opposite']).default('opposite'),
  /** 1 = CCW seen from above, -1 = CW. */
  direction: z.union([z.literal(1), z.literal(-1)]).default(1),
  /** Initial angular speed (deg/s). */
  startSpeed: z.number().min(0).default(40),
  /** Angular acceleration (deg/s²). */
  acceleration: z.number().min(0).default(2.5),
  /** Speed cap (deg/s). */
  maxSpeed: z.number().min(0).default(150),
  /** Match time the beams start moving (they hold still before). */
  startDelay: z.number().default(0),
  beamRadius: z.number().positive().default(0.3),
  hubRadius: z.number().positive().default(1.1),
  /**
   * Trip strength (Δv, m/s). A hit splits it into a hop up and a push back against the sweep,
   * so a missed jump costs a tumble behind the rope, not the round.
   */
  knockImpulse: z.number().min(0).default(8),
  stunOnHit: z.boolean().default(true),
});

/** Validated Jump Rope Beam parameters. */
export type JumpRopeBeamParams = z.output<typeof JumpRopeBeamSchema>;

/**
 * Swept angle in degrees after `u` seconds of motion: ω(u) = min(ω₀ + αu, ωmax),
 * integrated exactly.
 */
export function jumpRopeSweptDegrees(u: number, p: JumpRopeBeamParams): number {
  if (u <= 0) return 0;
  const w0 = Math.min(p.startSpeed, p.maxSpeed);
  const a = p.acceleration;
  if (a <= 0) return w0 * u;
  const tCap = Math.max(0, (p.maxSpeed - w0) / a);
  if (u <= tCap) return w0 * u + 0.5 * a * u * u;
  return w0 * tCap + 0.5 * a * tCap * tCap + p.maxSpeed * (u - tCap);
}

/** Angular speed (deg/s) at match time `t`, before the direction sign. */
export function jumpRopeSpeed(t: number, p: JumpRopeBeamParams, speedScale: number): number {
  const u = t * speedScale - p.startDelay;
  if (u <= 0) return 0;
  return Math.min(p.maxSpeed, Math.min(p.startSpeed, p.maxSpeed) + p.acceleration * u) * speedScale;
}

/** Active layers as height + direction sign + angle offset (degrees). */
export function jumpRopeLayers(p: JumpRopeBeamParams): { height: number; sign: number; offset: number }[] {
  const layers: { height: number; sign: number; offset: number }[] = [];
  if (p.layers !== 'high') layers.push({ height: p.lowHeight, sign: p.direction, offset: 0 });
  if (p.layers !== 'low')
    layers.push({
      height: p.highHeight,
      sign: p.highDirection === 'same' ? p.direction : -p.direction,
      offset: p.layers === 'both' ? p.highOffset : 0,
    });
  return layers;
}

const qTmp = { x: 0, y: 0, z: 0, w: 1 };

/** Pure pose: one rotor sample per active layer (low first). */
export function jumpRopeBeamPose(
  t: number,
  p: JumpRopeBeamParams,
  out: PoseSample[],
  speedScale: number,
): void {
  const swept = jumpRopeSweptDegrees(t * speedScale - p.startDelay, p);
  const lowSign = p.layers === 'high' ? 0 : 1;
  const count = p.layers === 'both' ? 2 : 1;
  ensurePoseSamples(out, count);
  for (let l = 0; l < count; l++) {
    const isHigh = l === 1 || lowSign === 0;
    const height = isHigh ? p.highHeight : p.lowHeight;
    const sign = isHigh && p.highDirection === 'opposite' ? -p.direction : p.direction;
    const offset = isHigh && p.layers === 'both' ? p.highOffset : 0;
    writeSample(out[l] as PoseSample, 0, height, 0, quatFromYaw((offset + sign * swept) * DEG, qTmp));
  }
}

/** Rim speed (m/s) above which chasing the beam is pointless; bots hold their ground and time the jump. */
const ROPE_CHASE_MAX_SPEED = 4.5;
/** How far behind the beam the bot hint sits (radians). */
const ROPE_TRAIL = 0.45;
const ropeLocal = vec3();
const ropeConj: Quat = { x: 0, y: 0, z: 0, w: 1 };

/**
 * Bot hint for a jump rope: the point just behind the nearest beam (in its
 * sweep) at the hint's distance from the hub, where the next pass is furthest
 * off. Once the beam's rim outruns a running Tumbler the hint's own bearing
 * comes back instead, so bots stand their ground and time the jump.
 *
 * @param out - On entry the bot's hint point; receives the spot.
 * @returns False when the hint is on another level than the hub.
 */
function ropeSafeSpot(
  t: number,
  p: JumpRopeBeamParams,
  scale: number,
  frame: { pos: Vec3; rot: Quat },
  out: Vec3,
): boolean {
  ropeConj.x = -frame.rot.x;
  ropeConj.y = -frame.rot.y;
  ropeConj.z = -frame.rot.z;
  ropeConj.w = frame.rot.w;
  ropeLocal.x = out.x - frame.pos.x;
  ropeLocal.y = out.y - frame.pos.y;
  ropeLocal.z = out.z - frame.pos.z;
  rotateVec(ropeConj, ropeLocal, ropeLocal);
  if (!(ropeLocal.y > -1.5 && ropeLocal.y < 4)) return false;
  const r = Math.min(p.radius - 1, Math.max(p.hubRadius + 1.2, Math.hypot(ropeLocal.x, ropeLocal.z)));
  // Local angle convention of the beams: a point at angle ψ is (cos ψ, −sin ψ).
  const hintAngle = Math.atan2(-ropeLocal.z, ropeLocal.x);
  let angle = hintAngle;
  const omega = jumpRopeSpeed(t, p, scale) * DEG;
  if (omega * r <= ROPE_CHASE_MAX_SPEED) {
    const layer = jumpRopeLayers(p)[0];
    if (layer) {
      const theta = (layer.offset + layer.sign * jumpRopeSweptDegrees(t * scale - p.startDelay, p)) * DEG;
      const arms = p.beamsPerLayer * (p.mode === 'full' ? 2 : 1);
      let bestGap = Infinity;
      for (let k = 0; k < arms; k++) {
        // Matches the build: beam b at yaw 2πb/n, and `full` beams also reach out the opposite side.
        const b = k % p.beamsPerLayer;
        const side = k >= p.beamsPerLayer ? Math.PI : 0;
        const behind = theta + (b / p.beamsPerLayer) * Math.PI * 2 + side - layer.sign * ROPE_TRAIL;
        const gap = Math.abs(Math.atan2(Math.sin(behind - hintAngle), Math.cos(behind - hintAngle)));
        if (gap < bestGap) {
          bestGap = gap;
          angle = behind;
        }
      }
    }
  }
  ropeLocal.x = Math.cos(angle) * r;
  ropeLocal.y = 0;
  ropeLocal.z = -Math.sin(angle) * r;
  rotateVec(frame.rot, ropeLocal, out);
  out.x += frame.pos.x;
  out.y += frame.pos.y;
  out.z += frame.pos.z;
  return true;
}

/** Jump Rope Beam obstacle module. */
export const jumpRopeBeam: ObstacleModule<JumpRopeBeamParams> = {
  type: 'jumpRopeBeam',
  displayName: 'Skip Sweeper',
  schema: JumpRopeBeamSchema,
  audioCues: ['ropeWhoosh', 'ropeHit'],
  pose: jumpRopeBeamPose,
  create(instance, ctx): ObstacleRuntime {
    const p = JumpRopeBeamSchema.parse(instance.params);
    const { R } = ctx;
    const scale = ctx.speedScale;
    const frame = instanceFrame(instance);
    const bag = new PhysicsBag(ctx);
    const hub = bag.fixed(frame);
    const hubH = Math.max(p.lowHeight, p.layers === 'low' ? p.lowHeight : p.highHeight) + 0.6;
    bag.collider(
      R.ColliderDesc.cylinder(hubH / 2, p.hubRadius)
        .setTranslation(0, hubH / 2, 0)
        .setCollisionGroups(InteractionGroups.static),
      hub,
      { kind: 'normal', ownerId: instance.id },
    );

    const layers = jumpRopeLayers(p);
    const rotors: RigidBody[] = [];
    const signOf = new Map<number, number>();
    const alongX = quatFromAxisAngle(0, 0, 1, Math.PI / 2);
    const reach = p.radius - p.hubRadius;
    for (const layer of layers) {
      const rotor = bag.kinematic(frame);
      for (let b = 0; b < p.beamsPerLayer; b++) {
        const yaw = (b / p.beamsPerLayer) * Math.PI * 2;
        const rot = quatMul(quatFromYaw(yaw), alongX);
        const sides = p.mode === 'full' ? [1, -1] : [1];
        for (const side of sides) {
          // Segments start at the hub surface so beams never overlap the static hub collider.
          // Beams are hazard sensors, not solid: a solid kinematic beam shoved missed Tumblers ahead of
          // the sweep (often off the edge), and pinching against a still beam launched them ~30 m up.
          const c = p.hubRadius + reach / 2;
          const col = bag.collider(
            R.ColliderDesc.capsule(Math.max(0.05, reach / 2 - p.beamRadius), p.beamRadius)
              .setTranslation(side * Math.cos(yaw) * c, 0, -side * Math.sin(yaw) * c)
              .setRotation(rot)
              .setSensor(true)
              .setCollisionGroups(InteractionGroups.hazard)
              .setActiveEvents(R.ActiveEvents.COLLISION_EVENTS),
            rotor,
            { kind: 'normal', ownerId: instance.id },
          );
          signOf.set(col.handle, layer.sign);
        }
      }
      rotors.push(rotor);
    }

    const rig = new KinematicRig(frame, rotors, (t, out) => jumpRopeBeamPose(t, p, out, scale));
    const hits = new ActorCooldowns();
    const impulse = vec3();
    /** Actors inside a beam that was still when they entered; tripped once it starts moving. */
    const waiting = new Map<number, { actor: ObstacleActor; sign: number }>();
    let lastLap = 0;

    /**
     * The trip: a stun with a short hop up and back against the sweep, so the
     * beam passes over the tumbling Tumbler and it gets up behind the rope
     * instead of being carried ahead of it and off the sandbar.
     */
    const trip = (actor: ObstacleActor, sign: number, sctx: ObstacleStepContext): void => {
      if (actor.isGhost || !hits.ready(actor.id, sctx.t)) return;
      hits.arm(actor.id, sctx.t, 0.8);
      const a = actor.body.translation();
      let rx = a.x - frame.pos.x;
      let rz = a.z - frame.pos.z;
      const len = Math.hypot(rx, rz) || 1;
      rx /= len;
      rz /= len;
      const k = p.knockImpulse;
      impulse.x = -rz * sign * k * TRIP_BACK;
      impulse.y = k * TRIP_UP;
      impulse.z = rx * sign * k * TRIP_BACK;
      actor.knock(impulse, p.stunOnHit);
      emitCue(sctx.events, instance.id, 'ropeHit', a);
    };

    const runtime: ObstacleRuntime & { botSafeSpot(t: number, out: Vec3): boolean } = {
      instance,
      colliders: bag.colliders,
      update(sctx) {
        rig.apply(sctx.t, sctx.dt);
        // One whoosh per half-turn keeps the audio rhythm in step with the beam.
        const lap = Math.floor(jumpRopeSweptDegrees(sctx.t * scale - p.startDelay, p) / 180);
        if (lap !== lastLap) {
          if (lap === lastLap + 1) emitCue(sctx.events, instance.id, 'ropeWhoosh', frame.pos);
          lastLap = lap;
        }
        if (waiting.size > 0 && jumpRopeSpeed(sctx.t, p, scale) > 0) {
          for (const w of waiting.values()) trip(w.actor, w.sign, sctx);
          waiting.clear();
        }
      },
      onTrigger(actor, collider: Collider, entered, sctx) {
        const sign = signOf.get(collider.handle);
        if (sign === undefined) return;
        if (!entered) {
          waiting.delete(actor.id);
          return;
        }
        if (jumpRopeSpeed(sctx.t, p, scale) <= 0) waiting.set(actor.id, { actor, sign });
        else trip(actor, sign, sctx);
      },
      botSafeSpot: (t: number, out: Vec3): boolean => ropeSafeSpot(t, p, scale, frame, out),
      dispose: () => bag.dispose(),
    };
    return runtime;
  },
};
