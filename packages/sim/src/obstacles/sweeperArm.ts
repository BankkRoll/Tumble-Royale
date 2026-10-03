/**
 * Sweeper Arm — a low bar sweeping around a central post at ankle height that
 * players must jump. It accelerates over the round (survival pressure) and can
 * carry a second, head-height arm that forces a duck-or-dive decision.
 */
import { z } from 'zod';
import type { Collider, RigidBody } from '@dimforge/rapier3d-compat';
import {
  ActorCooldown,
  KinematicDriver,
  ObstacleGroups,
  RuntimeBase,
  createPoseBuffer,
  knockByMotion,
  setPose,
} from './helpers-a.ts';
import type {
  ObstacleActor,
  ObstacleBuildContext,
  ObstacleInstance,
  ObstacleModule,
  ObstacleStepContext,
  PoseSample,
} from './types.ts';

/** Sweeper arm parameters. */
export const sweeperArmSchema = z.object({
  /** Post centre to arm tip (m). */
  armLength: z.number().positive().default(9),
  /** Arms around the post, evenly spaced. */
  armCount: z.number().int().min(1).max(4).default(1),
  /** Lower arm centre height (m) — jump height. */
  armHeight: z.number().default(0.45),
  /** Bar radius (m). */
  armRadius: z.number().positive().default(0.32),
  postRadius: z.number().positive().default(0.75),
  postHeight: z.number().positive().default(1.4),
  /** Angular speed at t = 0 (rad/s). Scaled by speedScale. */
  baseSpeed: z.number().min(0).default(1.1),
  /** Angular speed cap (rad/s). Scaled by speedScale. */
  maxSpeed: z.number().min(0).default(3),
  /** Angular acceleration over the round (rad/s²); 0 keeps base speed. */
  accel: z.number().min(0).default(0.02),
  /** 1 counter-clockwise from above, -1 clockwise. */
  direction: z.union([z.literal(1), z.literal(-1)]).default(1),
  /** Starting angle (rad). */
  phase: z.number().default(0),
  /** Height of a second head-height arm (m), offset 90°; 0 disables it. */
  upperArmHeight: z.number().min(0).default(0),
  knockSpeed: z.number().min(0).default(7),
  knockLift: z.number().min(0).default(6),
  stun: z.boolean().default(false),
});

/** Validated sweeper params. */
export type SweeperArmParams = z.output<typeof sweeperArmSchema>;

/**
 * Closed-form sweep angle for a linearly accelerating, capped angular speed.
 *
 * @returns Angle in radians (before direction/phase).
 */
export function sweeperTravel(t: number, p: SweeperArmParams, speedScale: number): number {
  const w0 = p.baseSpeed * speedScale;
  const wMax = Math.max(p.maxSpeed * speedScale, w0);
  const a = p.accel * speedScale;
  if (t <= 0 || a <= 0) return w0 * t;
  const tm = (wMax - w0) / a;
  if (t <= tm) return w0 * t + 0.5 * a * t * t;
  return w0 * tm + 0.5 * a * tm * tm + wMax * (t - tm);
}

/** Current angular speed (rad/s). */
export function sweeperSpeed(t: number, p: SweeperArmParams, speedScale: number): number {
  const w0 = p.baseSpeed * speedScale;
  const wMax = Math.max(p.maxSpeed * speedScale, w0);
  return t <= 0 ? w0 : Math.min(wMax, w0 + p.accel * speedScale * t);
}

/** Number of kinematic parts: lower arm plus optional upper arm. */
export const sweeperPartCount = (p: SweeperArmParams): number => (p.upperArmHeight > 0 ? 2 : 1);

/**
 * Pure pose: sample 0 is the lower arm, sample 1 (optional) the upper arm.
 *
 * @param t - Match time (s).
 * @param p - Params.
 * @param out - At least {@link sweeperPartCount} samples.
 * @param speedScale - Multiplies all angular speeds.
 */
export function sweeperArmPose(t: number, p: SweeperArmParams, out: PoseSample[], speedScale: number): void {
  const angle = p.phase + p.direction * sweeperTravel(t, p, speedScale);
  if (out[0]) setPose(out[0], 0, p.armHeight, 0, 0, 1, 0, angle);
  if (p.upperArmHeight > 0 && out[1]) setPose(out[1], 0, p.upperArmHeight, 0, 0, 1, 0, angle + Math.PI / 2);
}

/** Glow rises as the arm approaches top speed. */
export function sweeperArmTelegraph(t: number, p: SweeperArmParams, speedScale: number): number {
  const w0 = p.baseSpeed * speedScale;
  const wMax = p.maxSpeed * speedScale;
  if (wMax <= w0) return 0;
  return Math.max(0, Math.min(1, (sweeperSpeed(t, p, speedScale) - w0) / (wMax - w0)));
}

class SweeperArmRuntime extends RuntimeBase {
  private readonly drivers: KinematicDriver[] = [];
  private readonly poses: PoseSample[];
  private readonly cooldown = new ActorCooldown();
  private readonly bodyByCollider = new Map<number, RigidBody>();

  constructor(
    instance: ObstacleInstance<SweeperArmParams>,
    ctx: ObstacleBuildContext,
    private readonly p: SweeperArmParams,
  ) {
    super(instance, ctx);
    const { R } = ctx;
    const parts = sweeperPartCount(p);
    this.poses = createPoseBuffer(parts);

    const post = this.addBody(R.RigidBodyDesc.fixed());
    this.addCollider(
      R.ColliderDesc.cylinder(p.postHeight / 2, p.postRadius)
        .setTranslation(0, p.postHeight / 2, 0)
        .setCollisionGroups(ObstacleGroups.static),
      post,
    );

    const reach = p.armLength - p.postRadius * 0.6;
    const s = Math.SQRT1_2;
    for (let part = 0; part < parts; part++) {
      const body = this.addBody(R.RigidBodyDesc.kinematicPositionBased());
      for (let a = 0; a < p.armCount; a++) {
        const yaw = (a / p.armCount) * Math.PI * 2;
        const cx = Math.cos(yaw) * (p.postRadius * 0.6 + reach / 2);
        const cz = -Math.sin(yaw) * (p.postRadius * 0.6 + reach / 2);
        // Capsule along Y → rotate onto X, then yaw around the post.
        const hy = Math.sin(yaw / 2);
        const hw = Math.cos(yaw / 2);
        const c = this.addCollider(
          R.ColliderDesc.capsule(Math.max(0.05, reach / 2 - p.armRadius), p.armRadius)
            .setTranslation(cx, 0, cz)
            .setRotation({ x: hy * s, y: hy * s, z: hw * s, w: hw * s })
            .setCollisionGroups(ObstacleGroups.kinematic),
          body,
        );
        this.bodyByCollider.set(c.handle, body);
      }
      this.drivers.push(new KinematicDriver(body, this.frame));
    }
    sweeperArmPose(0, p, this.poses, ctx.speedScale);
    for (let i = 0; i < parts; i++) this.drivers[i]!.teleport(this.poses[i]!);
  }

  update(ctx: ObstacleStepContext): void {
    sweeperArmPose(ctx.t, this.p, this.poses, this.build.speedScale);
    for (let i = 0; i < this.drivers.length; i++) this.drivers[i]!.drive(this.poses[i]!);
    this.endStep(ctx);
  }

  onContact(actor: ObstacleActor, collider: Collider, ctx: ObstacleStepContext): void {
    const body = this.bodyByCollider.get(collider.handle);
    if (!body || actor.isGhost) return;
    if (!this.cooldown.ready(actor.id, ctx.t, 0.4)) return;
    knockByMotion(actor, body, { speed: this.p.knockSpeed, lift: this.p.knockLift, stun: this.p.stun });
    this.cue(ctx.events, 'trip', 0, this.p.armHeight, 0);
  }

  telegraph(t: number): number {
    return sweeperArmTelegraph(t, this.p, this.build.speedScale);
  }
}

/** Sweeper arm obstacle module. */
export const sweeperArm: ObstacleModule<SweeperArmParams> = {
  type: 'sweeperArm',
  displayName: 'Ankle Sweeper',
  schema: sweeperArmSchema,
  pose: sweeperArmPose,
  poseCount: sweeperPartCount,
  create: (instance, ctx) => new SweeperArmRuntime(instance, ctx, sweeperArmSchema.parse(instance.params)),
  audioCues: ['trip'],
};
