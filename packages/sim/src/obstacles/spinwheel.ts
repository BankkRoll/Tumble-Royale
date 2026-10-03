/**
 * Spinwheel — radial arms sweeping around a central hub at torso height.
 * Players are shoved sideways in the arm's direction of travel. Optional
 * stacked tiers (alternating direction) and timed reversals with telegraph.
 */
import { z } from 'zod';
import type { RigidBody } from '@dimforge/rapier3d-compat';
import {
  ActorCooldown,
  KinematicDriver,
  ObstacleGroups,
  RuntimeBase,
  createPoseBuffer,
  crossedPeriodic,
  knockByMotion,
  leadTelegraph,
  setPose,
  squareWaveIntegral,
  timeToSwitch,
} from './helpers-a.ts';
import type {
  ObstacleActor,
  ObstacleBuildContext,
  ObstacleInstance,
  ObstacleModule,
  ObstacleStepContext,
  PoseSample,
} from './types.ts';
import type { Collider } from '@dimforge/rapier3d-compat';

/** Spinwheel parameters. Lengths in metres, angles in radians, times in seconds. */
export const spinwheelSchema = z.object({
  /** Hub centre to arm tip (m). */
  armLength: z.number().positive().default(7),
  /** Arms per tier, evenly spaced. */
  armCount: z.number().int().min(1).max(8).default(2),
  /** Height of the lowest tier's arm centre above the origin (m). */
  armHeight: z.number().default(0.9),
  /** Arm cross-section (m). */
  armThickness: z.number().positive().default(0.6),
  /** Stacked arm tiers. */
  tiers: z.number().int().min(1).max(4).default(1),
  /** Vertical spacing between tiers (m). */
  tierSpacing: z.number().positive().default(1.8),
  /** Alternate tiers spin in opposite directions. */
  counterRotateTiers: z.boolean().default(true),
  /** Angular speed (rad/s); negative spins clockwise seen from above. Scaled by speedScale. */
  speed: z.number().default(1.4),
  /** Starting angle (rad). */
  phase: z.number().default(0),
  /** Seconds between direction reversals; 0 never reverses. */
  reversePeriod: z.number().min(0).default(0),
  /** Seconds the reversal ramp takes. */
  reverseRamp: z.number().min(0.05).default(0.8),
  /** Seconds of warning glow before a reversal. */
  telegraphLead: z.number().min(0).default(1),
  hubRadius: z.number().positive().default(0.8),
  hubHeight: z.number().positive().default(2.4),
  /** Horizontal knock velocity (m/s). */
  knockSpeed: z.number().min(0).default(9),
  /** Upward knock velocity (m/s). */
  knockLift: z.number().min(0).default(4),
  /** Whether a hit stuns. */
  stun: z.boolean().default(false),
});

/** Validated spinwheel params. */
export type SpinwheelParams = z.output<typeof spinwheelSchema>;

/**
 * Pure pose: one sample per tier, the arm-assembly rotation about local +Y.
 *
 * @param t - Match time (s).
 * @param p - Params.
 * @param out - At least `p.tiers` samples.
 * @param speedScale - Difficulty multiplier on angular speed.
 */
export function spinwheelPose(t: number, p: SpinwheelParams, out: PoseSample[], speedScale: number): void {
  const travel = squareWaveIntegral(t, p.reversePeriod, p.reverseRamp);
  for (let i = 0; i < p.tiers && i < out.length; i++) {
    const dir = p.counterRotateTiers && i % 2 === 1 ? -1 : 1;
    const angle = p.phase + dir * p.speed * speedScale * travel + (i * Math.PI) / Math.max(1, p.armCount) / 2;
    setPose(out[i]!, 0, p.armHeight + i * p.tierSpacing, 0, 0, 1, 0, angle);
  }
}

/** Warning before each reversal, 0..1. */
export function spinwheelTelegraph(t: number, p: SpinwheelParams): number {
  return leadTelegraph(timeToSwitch(t, p.reversePeriod), p.telegraphLead);
}

class SpinwheelRuntime extends RuntimeBase {
  private readonly drivers: KinematicDriver[] = [];
  private readonly poses: PoseSample[];
  private readonly cooldown = new ActorCooldown();
  private readonly armBodyByCollider = new Map<number, RigidBody>();

  constructor(
    instance: ObstacleInstance<SpinwheelParams>,
    ctx: ObstacleBuildContext,
    private readonly p: SpinwheelParams,
  ) {
    super(instance, ctx);
    const { R } = ctx;
    this.poses = createPoseBuffer(p.tiers);

    const hub = this.addBody(R.RigidBodyDesc.fixed());
    this.addCollider(
      R.ColliderDesc.cylinder(p.hubHeight / 2, p.hubRadius)
        .setTranslation(0, p.hubHeight / 2, 0)
        .setCollisionGroups(ObstacleGroups.static),
      hub,
    );

    const half = p.armThickness / 2;
    const armHalfLen = (p.armLength - p.hubRadius * 0.5) / 2;
    for (let tier = 0; tier < p.tiers; tier++) {
      const body = this.addBody(R.RigidBodyDesc.kinematicPositionBased());
      for (let a = 0; a < p.armCount; a++) {
        const yaw = (a / p.armCount) * Math.PI * 2;
        const cx = Math.cos(yaw) * (p.hubRadius * 0.5 + armHalfLen);
        const cz = -Math.sin(yaw) * (p.hubRadius * 0.5 + armHalfLen);
        const c: Collider = this.addCollider(
          R.ColliderDesc.roundCuboid(armHalfLen - half * 0.3, half * 0.7, half * 0.7, half * 0.3)
            .setTranslation(cx, 0, cz)
            .setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) })
            .setFriction(0.4)
            .setCollisionGroups(ObstacleGroups.kinematic),
          body,
          { kind: 'normal' },
        );
        this.armBodyByCollider.set(c.handle, body);
      }
      this.drivers.push(new KinematicDriver(body, this.frame));
    }
    spinwheelPose(0, p, this.poses, ctx.speedScale);
    for (let i = 0; i < this.drivers.length; i++) this.drivers[i]!.teleport(this.poses[i]!);
  }

  update(ctx: ObstacleStepContext): void {
    spinwheelPose(ctx.t, this.p, this.poses, this.build.speedScale);
    for (let i = 0; i < this.drivers.length; i++) this.drivers[i]!.drive(this.poses[i]!);
    if (this.p.reversePeriod > 0 && crossedPeriodic(this.lastT, ctx.t, this.p.reversePeriod, 0)) {
      this.cue(ctx.events, 'reverse', 0, this.p.hubHeight, 0);
    }
    this.endStep(ctx);
  }

  onContact(actor: ObstacleActor, collider: Collider, ctx: ObstacleStepContext): void {
    const body = this.armBodyByCollider.get(collider.handle);
    if (!body || actor.isGhost) return;
    if (!this.cooldown.ready(actor.id, ctx.t, 0.35)) return;
    knockByMotion(actor, body, { speed: this.p.knockSpeed, lift: this.p.knockLift, stun: this.p.stun });
    this.cue(ctx.events, 'hit', 0, this.p.armHeight, 0);
  }

  telegraph(t: number): number {
    return spinwheelTelegraph(t, this.p);
  }
}

/** Spinwheel obstacle module. */
export const spinwheel: ObstacleModule<SpinwheelParams> = {
  type: 'spinwheel',
  displayName: 'Whirly Wheel',
  schema: spinwheelSchema,
  pose: spinwheelPose,
  poseCount: (p) => p.tiers,
  create: (instance, ctx) => new SpinwheelRuntime(instance, ctx, spinwheelSchema.parse(instance.params)),
  audioCues: ['whirr', 'reverse', 'hit'],
};
