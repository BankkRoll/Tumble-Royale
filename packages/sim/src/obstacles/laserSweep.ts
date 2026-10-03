/**
 * Laser Sweep — one or more soft glowing beams rotating around a pivot. The
 * beams are sensors on a kinematic rotor: they never physically block, but any
 * player overlapping a lit beam is knocked sideways and stunned. Rotation and
 * on/off duty cycle are pure functions of time.
 */
import type { RigidBody } from '@dimforge/rapier3d-compat';
import { InteractionGroups, quatFromAxisAngle, quatFromYaw, vec3 } from '@tumble/shared';
import { z } from 'zod';
import {
  ActorCooldowns,
  ActorSet,
  DEG,
  KinematicRig,
  PhysicsBag,
  emitCue,
  ensurePoseSamples,
  instanceFrame,
  mod,
  pulse,
  writeSample,
} from './helpers-b.ts';
import type { ObstacleActor, ObstacleModule, ObstacleRuntime, PoseSample } from './types.ts';

/** Laser Sweep parameters. Metres, degrees, seconds. Origin = pivot on the floor. */
export const LaserSweepSchema = z.object({
  /** Beam length from the pivot (`arm`), or half-length (`full`). */
  length: z.number().positive().default(8),
  /** `arm` beams start at the pivot; `full` beams pass through it both ways. */
  mode: z.enum(['arm', 'full']).default('arm'),
  /** Number of beams, evenly spaced around the pivot. */
  beams: z.number().int().min(1).max(6).default(1),
  /** Beam height above the origin. ~0.6 = jump over, ~1.7 = duck/dive under. */
  height: z.number().default(0.9),
  /** Beam radius (sensor half-thickness). */
  radius: z.number().positive().default(0.22),
  /** Angular speed in degrees per second. */
  speed: z.number().min(0).default(55),
  /** 1 = counter-clockwise seen from above, -1 = clockwise. */
  direction: z.union([z.literal(1), z.literal(-1)]).default(1),
  /** Starting angle in degrees. */
  phase: z.number().default(0),
  /** Seconds lit per duty cycle; 0 with `offTime` 0 = always lit. */
  onTime: z.number().min(0).default(0),
  /** Seconds dark per duty cycle. */
  offTime: z.number().min(0).default(0),
  /** Flicker warning before relighting. */
  warnTime: z.number().min(0).default(0.8),
  /** Vertical bob amplitude (0 = flat sweep). */
  bobAmplitude: z.number().min(0).default(0),
  bobPeriod: z.number().positive().default(3),
  /** Knock impulse along the sweep direction (N·s ≈ Δv). */
  knockImpulse: z.number().min(0).default(7),
  /** Per-player immunity after a hit. */
  hitCooldown: z.number().min(0).default(1.2),
});

/** Validated Laser Sweep parameters. */
export type LaserSweepParams = z.output<typeof LaserSweepSchema>;

/** Rotor angle in radians at match time `t`. Pure. */
export function laserAngle(t: number, p: LaserSweepParams, speedScale: number): number {
  return (p.phase + p.direction * p.speed * t * speedScale) * DEG;
}

/** Whether the beam is lit at match time `t`. Pure. */
export function laserLit(t: number, p: LaserSweepParams, speedScale: number): boolean {
  const cycle = p.onTime + p.offTime;
  if (p.offTime <= 0 || cycle <= 0) return true;
  return mod(t * speedScale, cycle) < p.onTime;
}

/** Warning flicker intensity 0–1 (only during the last `warnTime` of a dark phase). Pure. */
export function laserTelegraph(t: number, p: LaserSweepParams, speedScale: number): number {
  const cycle = p.onTime + p.offTime;
  if (p.offTime <= 0 || cycle <= 0) return 0;
  const u = mod(t * speedScale, cycle);
  const untilOn = cycle - u;
  return u >= p.onTime && untilOn < p.warnTime ? pulse(untilOn, 6) : 0;
}

/** Local yaw offset of beam `i`. */
export const laserBeamYaw = (p: LaserSweepParams, i: number): number => (i / p.beams) * Math.PI * 2;

const qTmp = { x: 0, y: 0, z: 0, w: 1 };

/** Pure pose: sample 0 is the rotor (beam hub) — all beams are rigidly attached to it. */
export function laserSweepPose(t: number, p: LaserSweepParams, out: PoseSample[], speedScale: number): void {
  ensurePoseSamples(out, 1);
  const bob = p.bobAmplitude > 0 ? p.bobAmplitude * Math.sin((t * speedScale * Math.PI * 2) / p.bobPeriod) : 0;
  writeSample(out[0] as PoseSample, 0, p.height + bob, 0, quatFromYaw(laserAngle(t, p, speedScale), qTmp));
}

/** Laser Sweep obstacle module. */
export const laserSweep: ObstacleModule<LaserSweepParams> = {
  type: 'laserSweep',
  displayName: 'Laser Sweep',
  schema: LaserSweepSchema,
  audioCues: ['laserHumStart', 'laserZap'],
  pose: laserSweepPose,
  create(instance, ctx): ObstacleRuntime {
    const p = LaserSweepSchema.parse(instance.params);
    const { R } = ctx;
    const scale = ctx.speedScale;
    const frame = instanceFrame(instance);
    const bag = new PhysicsBag(ctx);
    const rotor: RigidBody = bag.kinematic(frame);
    const halfLen = p.length / 2;
    for (let i = 0; i < p.beams; i++) {
      const yaw = laserBeamYaw(p, i);
      const q = quatFromAxisAngle(0, 1, 0, yaw);
      // Beams run along the rotor's local +X; `arm` beams start at the hub.
      const cx = p.mode === 'arm' ? Math.cos(yaw) * halfLen : 0;
      const cz = p.mode === 'arm' ? -Math.sin(yaw) * halfLen : 0;
      const hl = p.mode === 'arm' ? halfLen : p.length;
      bag.collider(
        R.ColliderDesc.cuboid(hl, p.radius, p.radius)
          .setTranslation(cx, 0, cz)
          .setRotation(q)
          .setSensor(true)
          .setCollisionGroups(InteractionGroups.hazard)
          .setActiveEvents(R.ActiveEvents.COLLISION_EVENTS),
        rotor,
        { kind: 'normal', stunOnTouch: true, ownerId: instance.id },
      );
    }
    const rig = new KinematicRig(frame, [rotor], (t, out) => laserSweepPose(t, p, out, scale));
    const inside = new ActorSet<ObstacleActor>();
    const cooldowns = new ActorCooldowns();
    const impulse = vec3();
    let wasLit = false;

    return {
      instance,
      colliders: bag.colliders,
      update(sctx) {
        rig.apply(sctx.t, sctx.dt);
        const lit = laserLit(sctx.t, p, scale);
        if (lit && !wasLit) emitCue(sctx.events, instance.id, 'laserHumStart', frame.pos);
        wasLit = lit;
        if (!lit) return;
        const hub = rotor.translation();
        for (const a of inside.items) {
          if (a.isGhost || !cooldowns.ready(a.id, sctx.t)) continue;
          cooldowns.arm(a.id, sctx.t, p.hitCooldown);
          const pos = a.body.translation();
          let rx = pos.x - hub.x;
          let rz = pos.z - hub.z;
          const len = Math.hypot(rx, rz) || 1;
          rx /= len;
          rz /= len;
          // Tangent of a CCW (seen from +Y) rotation about +Y at radial (rx, rz) is (rz, -rx).
          const s = p.direction;
          impulse.x = rz * s * p.knockImpulse;
          impulse.y = p.knockImpulse * 0.35;
          impulse.z = -rx * s * p.knockImpulse;
          a.knock(impulse, true);
          emitCue(sctx.events, instance.id, 'laserZap', pos);
        }
      },
      onTrigger(actor, _collider, entered) {
        if (entered) inside.add(actor);
        else inside.remove(actor.id);
      },
      telegraph: (t) => laserTelegraph(t, p, scale),
      dispose: () => {
        inside.clear();
        bag.dispose();
      },
    };
  },
};
