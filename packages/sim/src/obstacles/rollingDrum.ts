/**
 * Rolling Drum — a giant candy-striped cylinder spinning about its long axis.
 * Players run on top like a log-roll. Driven with `setNextKinematicRotation`, so
 * Rapier derives the drum's angular velocity and contacts carry the surface
 * speed (ω·r) to riders exactly as a real spinning log would.
 */
import type { RigidBody } from '@dimforge/rapier3d-compat';
import { InteractionGroups, quatFromAxisAngle } from '@tumble/shared';
import { z } from 'zod';
import {
  DEG,
  KinematicRig,
  PhysicsBag,
  emitCue,
  ensurePoseSamples,
  instanceFrame,
  writeSample,
} from './helpers-b.ts';
import type { ObstacleModule, ObstacleRuntime, PoseSample } from './types.ts';

/** Rolling Drum parameters. Metres, degrees, seconds. Origin = centre of the drum's axis (local X). */
export const RollingDrumSchema = z.object({
  radius: z.number().positive().default(2.2),
  /** Length along local X. */
  length: z.number().positive().default(10),
  /**
   * Spin in degrees/second. Positive moves the top surface toward −Z (against a
   * +Z course: a treadmill); negative carries riders forward.
   */
  spinSpeed: z.number().default(45),
  /** `constant` spin, or `reversing`: ω(t) = ω₀·cos(2πt/reversePeriod). */
  profile: z.enum(['constant', 'reversing']).default('constant'),
  /** Seconds per full forward/back reversal cycle. */
  reversePeriod: z.number().positive().default(8),
  /** Grip ridges around the circumference (0 = smooth). */
  ridges: z.number().int().min(0).max(24).default(8),
  ridgeHeight: z.number().min(0).default(0.18),
  friction: z.number().min(0).default(1.1),
});

/** Validated Rolling Drum parameters. */
export type RollingDrumParams = z.output<typeof RollingDrumSchema>;

/**
 * Drum roll angle about local +X in radians at match time `t`. The reversing
 * profile integrates ω₀·cos analytically, so the angle is exact at any `t`.
 */
export function drumAngle(t: number, p: RollingDrumParams, speedScale: number): number {
  const w0 = -p.spinSpeed * DEG * speedScale;
  if (p.profile === 'reversing') {
    const k = (Math.PI * 2) / p.reversePeriod;
    return (w0 / k) * Math.sin(k * t);
  }
  return w0 * t;
}

/** Angular velocity (rad/s about local +X) at match time `t`, for surface-speed readouts. */
export function drumAngularVelocity(t: number, p: RollingDrumParams, speedScale: number): number {
  const w0 = -p.spinSpeed * DEG * speedScale;
  return p.profile === 'reversing' ? w0 * Math.cos(((Math.PI * 2) / p.reversePeriod) * t) : w0;
}

const q = { x: 0, y: 0, z: 0, w: 1 };

/** Pure pose: sample 0 is the drum (at the origin, rolled about +X). */
export function rollingDrumPose(
  t: number,
  p: RollingDrumParams,
  out: PoseSample[],
  speedScale: number,
): void {
  ensurePoseSamples(out, 1);
  writeSample(out[0] as PoseSample, 0, 0, 0, quatFromAxisAngle(1, 0, 0, drumAngle(t, p, speedScale), q));
}

/** Rolling Drum obstacle module. */
export const rollingDrum: ObstacleModule<RollingDrumParams> = {
  type: 'rollingDrum',
  displayName: 'Rolling Drum',
  schema: RollingDrumSchema,
  audioCues: ['drumReverse'],
  pose: rollingDrumPose,
  create(instance, ctx): ObstacleRuntime {
    const p = RollingDrumSchema.parse(instance.params);
    const { R } = ctx;
    const scale = ctx.speedScale;
    const frame = instanceFrame(instance);
    const bag = new PhysicsBag(ctx);
    const drum: RigidBody = bag.kinematic(frame);
    const alongX = quatFromAxisAngle(0, 0, 1, Math.PI / 2);
    bag.collider(
      R.ColliderDesc.cylinder(p.length / 2, p.radius)
        .setRotation(alongX)
        .setFriction(p.friction)
        .setCollisionGroups(InteractionGroups.kinematic),
      drum,
      { kind: 'normal', ownerId: instance.id },
    );
    for (let i = 0; i < p.ridges && p.ridgeHeight > 0; i++) {
      const a = (i / p.ridges) * Math.PI * 2;
      const rr = p.radius + p.ridgeHeight / 2 - 0.05;
      bag.collider(
        R.ColliderDesc.cuboid(p.length / 2 - 0.1, p.ridgeHeight / 2 + 0.05, 0.12)
          .setTranslation(0, Math.cos(a) * rr, Math.sin(a) * rr)
          .setRotation(quatFromAxisAngle(1, 0, 0, a))
          .setFriction(p.friction)
          .setCollisionGroups(InteractionGroups.kinematic),
        drum,
        { kind: 'normal', ownerId: instance.id },
      );
    }
    const rig = new KinematicRig(frame, [drum], (t, out) => rollingDrumPose(t, p, out, scale));
    let lastSign = 0;

    return {
      instance,
      colliders: bag.colliders,
      update(sctx) {
        rig.apply(sctx.t, sctx.dt);
        if (p.profile === 'reversing') {
          const s = Math.sign(drumAngularVelocity(sctx.t, p, scale));
          if (lastSign !== 0 && s !== 0 && s !== lastSign)
            emitCue(sctx.events, instance.id, 'drumReverse', frame.pos);
          if (s !== 0) lastSign = s;
        }
      },
      dispose: () => bag.dispose(),
    };
  },
};
