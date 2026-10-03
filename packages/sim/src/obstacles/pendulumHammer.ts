/**
 * Pendulum Hammer — a giant mallet swinging across the course (in the local
 * X–Y plane) from an overhead gantry. A hit is a hard, stunning knock in the
 * head's direction of travel.
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

/** Pendulum hammer parameters. */
export const pendulumHammerSchema = z.object({
  /** Pivot height above the origin (m). */
  pivotHeight: z.number().positive().default(9),
  /** Pivot to head centre (m). */
  armLength: z.number().positive().default(6.8),
  /** Swing amplitude either side of vertical (degrees). */
  amplitudeDeg: z.number().min(1).max(170).default(65),
  /** Full swing cycle (s). Divided by speedScale. */
  period: z.number().positive().default(3.2),
  /** Cycle offset as a fraction 0..1 (stagger several hammers). */
  phase: z.number().default(0),
  headRadius: z.number().positive().default(1.2),
  /** Head length along the swing direction (m). */
  headLength: z.number().positive().default(2.6),
  armThickness: z.number().positive().default(0.35),
  /** Build the overhead gantry (two posts + beam) as static geometry. */
  supports: z.boolean().default(true),
  /** Horizontal knock velocity (m/s). */
  knockSpeed: z.number().min(0).default(15),
  /** Upward knock velocity (m/s). */
  knockLift: z.number().min(0).default(7),
  stun: z.boolean().default(true),
});

/** Validated pendulum hammer params. */
export type PendulumHammerParams = z.output<typeof pendulumHammerSchema>;

/** Swing angle (rad, about local +Z) at time t. */
export function pendulumAngle(t: number, p: PendulumHammerParams, speedScale: number): number {
  return p.amplitudeDeg * DEG2RAD * Math.sin(TAU * ((t * speedScale) / p.period + p.phase));
}

/**
 * Pure pose: a single sample for the arm+head assembly, rotating about the pivot.
 *
 * @param t - Match time (s).
 * @param p - Params.
 * @param out - At least one sample.
 * @param speedScale - Shortens the period.
 */
export function pendulumHammerPose(
  t: number,
  p: PendulumHammerParams,
  out: PoseSample[],
  speedScale: number,
): void {
  const s = out[0];
  if (!s) return;
  setPose(s, 0, p.pivotHeight, 0, 0, 0, 1, pendulumAngle(t, p, speedScale));
}

/**
 * "Wind-up" glow: peaks while the hammer hangs at the top of its arc, about
 * to drop. Pure function of time.
 */
export function pendulumHammerTelegraph(t: number, p: PendulumHammerParams, speedScale: number): number {
  const s = Math.abs(Math.sin(TAU * ((t * speedScale) / p.period + p.phase)));
  return Math.pow(s, 8);
}

/** Half-span between the gantry posts, outside the head's reach (m). */
export function pendulumSupportSpan(p: PendulumHammerParams): number {
  return (
    p.armLength * Math.sin(Math.min(p.amplitudeDeg, 90) * DEG2RAD) + p.headLength / 2 + p.headRadius + 0.8
  );
}

class PendulumHammerRuntime extends RuntimeBase {
  private readonly driver: KinematicDriver;
  private readonly poses = createPoseBuffer(1);
  private readonly cooldown = new ActorCooldown();
  private readonly hammerHandles = new Set<number>();

  constructor(
    instance: ObstacleInstance<PendulumHammerParams>,
    ctx: ObstacleBuildContext,
    private readonly p: PendulumHammerParams,
  ) {
    super(instance, ctx);
    const { R } = ctx;
    const body = this.addBody(R.RigidBodyDesc.kinematicPositionBased());
    const arm = this.addCollider(
      R.ColliderDesc.cuboid(p.armThickness / 2, p.armLength / 2, p.armThickness / 2)
        .setTranslation(0, -p.armLength / 2, 0)
        .setCollisionGroups(ObstacleGroups.kinematic),
      body,
    );
    const s = Math.SQRT1_2;
    const head = this.addCollider(
      R.ColliderDesc.roundCylinder(p.headLength / 2 - 0.15, p.headRadius - 0.15, 0.15)
        .setTranslation(0, -p.armLength, 0)
        // Rapier cylinders run along Y; lay the head along X, the swing direction.
        .setRotation({ x: 0, y: 0, z: s, w: s })
        .setRestitution(0.2)
        .setCollisionGroups(ObstacleGroups.kinematic),
      body,
    );
    this.hammerHandles.add(arm.handle).add(head.handle);
    this.driver = new KinematicDriver(body, this.frame);

    if (p.supports) {
      const gantry = this.addBody(R.RigidBodyDesc.fixed());
      const span = pendulumSupportSpan(p);
      const postH = p.pivotHeight + 0.6;
      for (const side of [-1, 1]) {
        this.addCollider(
          R.ColliderDesc.cylinder(postH / 2, 0.45)
            .setTranslation(side * span, postH / 2, 0)
            .setCollisionGroups(ObstacleGroups.static),
          gantry,
        );
      }
      this.addCollider(
        R.ColliderDesc.cuboid(span + 0.45, 0.4, 0.5)
          .setTranslation(0, p.pivotHeight + 0.6, 0)
          .setCollisionGroups(ObstacleGroups.static),
        gantry,
      );
    }
    pendulumHammerPose(0, p, this.poses, ctx.speedScale);
    this.driver.teleport(this.poses[0]!);
  }

  update(ctx: ObstacleStepContext): void {
    const scale = this.build.speedScale;
    pendulumHammerPose(ctx.t, this.p, this.poses, scale);
    this.driver.drive(this.poses[0]!);
    // Peak speed is at the bottom of the arc: sin() crosses zero every half cycle.
    const u0 = (this.lastT * scale) / this.p.period + this.p.phase;
    const u1 = (ctx.t * scale) / this.p.period + this.p.phase;
    if (crossedPeriodic(u0, u1, 0.5, 0))
      this.cue(ctx.events, 'whoosh', 0, this.p.pivotHeight - this.p.armLength, 0);
    this.endStep(ctx);
  }

  onContact(actor: ObstacleActor, collider: Collider, ctx: ObstacleStepContext): void {
    if (!this.hammerHandles.has(collider.handle) || actor.isGhost) return;
    if (!this.cooldown.ready(actor.id, ctx.t, 0.5)) return;
    knockByMotion(actor, this.driver.body, {
      speed: this.p.knockSpeed,
      lift: this.p.knockLift,
      stun: this.p.stun,
    });
    this.cue(ctx.events, 'bonk', 0, this.p.pivotHeight - this.p.armLength, 0);
  }

  telegraph(t: number): number {
    return pendulumHammerTelegraph(t, this.p, this.build.speedScale);
  }
}

/** Pendulum hammer obstacle module. */
export const pendulumHammer: ObstacleModule<PendulumHammerParams> = {
  type: 'pendulumHammer',
  displayName: 'Bonk Mallet',
  schema: pendulumHammerSchema,
  pose: pendulumHammerPose,
  poseCount: () => 1,
  create: (instance, ctx) =>
    new PendulumHammerRuntime(instance, ctx, pendulumHammerSchema.parse(instance.params)),
  audioCues: ['whoosh', 'bonk'],
};
