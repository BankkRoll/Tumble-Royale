/**
 * Spinning Disc — a rideable turntable. Driven as a kinematic body via
 * `setNextKinematicRotation`, so Rapier derives the correct angular velocity
 * and the character controller can inherit platform velocity. Optional
 * timed reversals, a gentle wobble tilt and bumper knobs on top.
 */
import { z } from 'zod';
import type { Collider } from '@dimforge/rapier3d-compat';
import {
  ActorCooldown,
  DEG2RAD,
  KinematicDriver,
  ObstacleGroups,
  RuntimeBase,
  TAU,
  createPoseBuffer,
  crossedPeriodic,
  knockByMotion,
  leadTelegraph,
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

/** Spinning disc parameters. Origin = centre of the disc's top surface. */
export const spinningDiscSchema = z.object({
  radius: z.number().positive().default(6),
  thickness: z.number().positive().default(0.6),
  /** Angular speed (rad/s), positive = counter-clockwise from above. Scaled by speedScale. */
  speed: z.number().default(0.8),
  /** Starting angle (rad). */
  phase: z.number().default(0),
  /** Seconds between reversals; 0 = never. */
  reversePeriod: z.number().min(0).default(0),
  /** Reversal ramp (s). */
  reverseRamp: z.number().min(0.05).default(1.5),
  /** Warning before a reversal (s). */
  telegraphLead: z.number().min(0).default(1),
  /** Wobble tilt amplitude (degrees); 0 = flat. */
  wobbleDeg: z.number().min(0).max(20).default(0),
  /** Wobble cycle (s). */
  wobblePeriod: z.number().positive().default(6),
  /** Bumper knobs on top of the disc. */
  bumps: z.number().int().min(0).max(12).default(0),
  bumpRadius: z.number().positive().default(0.55),
  /** Knob push (m/s). */
  bumpKnock: z.number().min(0).default(6),
});

/** Validated spinning disc params. */
export type SpinningDiscParams = z.output<typeof spinningDiscSchema>;

/**
 * Pure pose: one sample — yaw spin, optionally pre-multiplied by a wobble
 * tilt about a slowly precessing horizontal axis.
 */
export function spinningDiscPose(
  t: number,
  p: SpinningDiscParams,
  out: PoseSample[],
  speedScale: number,
): void {
  const s = out[0];
  if (!s) return;
  const yaw = p.phase + p.speed * speedScale * squareWaveIntegral(t, p.reversePeriod, p.reverseRamp);
  s.pos.x = 0;
  s.pos.y = 0;
  s.pos.z = 0;
  const yy = Math.sin(yaw * 0.5);
  const yw = Math.cos(yaw * 0.5);
  if (p.wobbleDeg <= 0) {
    s.rot.x = 0;
    s.rot.y = yy;
    s.rot.z = 0;
    s.rot.w = yw;
    return;
  }
  const precess = (TAU * t) / p.wobblePeriod;
  const half = p.wobbleDeg * DEG2RAD * 0.5;
  const st = Math.sin(half);
  const ax = Math.cos(precess) * st;
  const az = Math.sin(precess) * st;
  const aw = Math.cos(half);
  // Hamilton product (ax, 0, az, aw) · (0, yy, 0, yw), expanded with the zero terms dropped.
  s.rot.x = ax * yw - az * yy;
  s.rot.y = aw * yy;
  s.rot.z = ax * yy + az * yw;
  s.rot.w = aw * yw;
}

/** Warning before each reversal, 0..1. */
export function spinningDiscTelegraph(t: number, p: SpinningDiscParams): number {
  return leadTelegraph(timeToSwitch(t, p.reversePeriod), p.telegraphLead);
}

/** Local XZ of bump `i` on the (unrotated) disc. */
export function spinningDiscBump(i: number, p: SpinningDiscParams): { x: number; z: number } {
  const a = (i / Math.max(1, p.bumps)) * TAU;
  return { x: Math.cos(a) * p.radius * 0.62, z: -Math.sin(a) * p.radius * 0.62 };
}

class SpinningDiscRuntime extends RuntimeBase {
  private readonly driver: KinematicDriver;
  private readonly poses = createPoseBuffer(1);
  private readonly cooldown = new ActorCooldown();
  private readonly bumpHandles = new Set<number>();

  constructor(
    instance: ObstacleInstance<SpinningDiscParams>,
    ctx: ObstacleBuildContext,
    private readonly p: SpinningDiscParams,
  ) {
    super(instance, ctx);
    const { R } = ctx;
    const body = this.addBody(R.RigidBodyDesc.kinematicPositionBased());
    this.addCollider(
      R.ColliderDesc.cylinder(p.thickness / 2, p.radius)
        .setTranslation(0, -p.thickness / 2, 0)
        .setFriction(1)
        .setCollisionGroups(ObstacleGroups.kinematic),
      body,
      { kind: 'normal' },
    );
    for (let i = 0; i < p.bumps; i++) {
      const b = spinningDiscBump(i, p);
      const c = this.addCollider(
        R.ColliderDesc.ball(p.bumpRadius)
          .setTranslation(b.x, 0, b.z)
          .setCollisionGroups(ObstacleGroups.kinematic),
        body,
        { kind: 'bouncy', bounceImpulse: p.bumpKnock },
      );
      this.bumpHandles.add(c.handle);
    }
    this.driver = new KinematicDriver(body, this.frame);
    spinningDiscPose(0, p, this.poses, ctx.speedScale);
    this.driver.teleport(this.poses[0]!);
  }

  update(ctx: ObstacleStepContext): void {
    spinningDiscPose(ctx.t, this.p, this.poses, this.build.speedScale);
    this.driver.drive(this.poses[0]!);
    if (this.p.reversePeriod > 0 && crossedPeriodic(this.lastT, ctx.t, this.p.reversePeriod, 0)) {
      this.cue(ctx.events, 'reverse');
    }
    this.endStep(ctx);
  }

  onContact(actor: ObstacleActor, collider: Collider, ctx: ObstacleStepContext): void {
    if (!this.bumpHandles.has(collider.handle) || actor.isGhost) return;
    if (!this.cooldown.ready(actor.id, ctx.t, 0.4)) return;
    knockByMotion(actor, this.driver.body, {
      speed: this.p.bumpKnock,
      lift: 2.5,
      stun: false,
      minMotion: Number.POSITIVE_INFINITY,
    });
    this.cue(ctx.events, 'boing');
  }

  telegraph(t: number): number {
    return spinningDiscTelegraph(t, this.p);
  }
}

/** Spinning disc obstacle module. */
export const spinningDisc: ObstacleModule<SpinningDiscParams> = {
  type: 'spinningDisc',
  displayName: 'Turntable Twirl',
  schema: spinningDiscSchema,
  pose: spinningDiscPose,
  poseCount: () => 1,
  create: (instance, ctx) =>
    new SpinningDiscRuntime(instance, ctx, spinningDiscSchema.parse(instance.params)),
  audioCues: ['reverse', 'boing'],
};
