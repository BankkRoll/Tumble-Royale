/**
 * Bumper Pillar — a springy column that boings players away from its centre.
 * Can orbit and bob as a pure function of time to make a moving field.
 */
import { z } from 'zod';
import type { Collider } from '@dimforge/rapier3d-compat';
import {
  ActorCooldown,
  KinematicDriver,
  ObstacleGroups,
  RuntimeBase,
  TAU,
  createPoseBuffer,
  knockByMotion,
  setPose,
} from './helpers-a.ts';
import type {
  ObstacleActor,
  ObstacleBuildContext,
  ObstacleInstance,
  ObstacleModule,
  ObstacleRuntime,
  ObstacleStepContext,
  PoseSample,
} from './types.ts';

/** Bumper pillar parameters. */
export const bumperPillarSchema = z.object({
  radius: z.number().positive().default(1),
  height: z.number().positive().default(2.6),
  /** Outward velocity change on touch (m/s). */
  bounceSpeed: z.number().min(0).default(10),
  /** Upward velocity change on touch (m/s). */
  bounceLift: z.number().min(0).default(3),
  /** Radius of an optional circular orbit (m); 0 keeps it in place. */
  orbitRadius: z.number().min(0).default(0),
  /** Orbit angular speed (rad/s). Scaled by speedScale. */
  orbitSpeed: z.number().default(0.8),
  /** Vertical bob amplitude (m). */
  bobAmplitude: z.number().min(0).default(0),
  /** Bob cycle (s). */
  bobPeriod: z.number().positive().default(2),
  /** Orbit start angle (rad). */
  phase: z.number().default(0),
  /** Minimum seconds between bounces of the same player. */
  cooldown: z.number().min(0).default(0.25),
});

/** Validated bumper params. */
export type BumperPillarParams = z.output<typeof bumperPillarSchema>;

/** Extra runtime state the visual reads for its squash-and-wobble. */
export interface BumperPillarView extends ObstacleRuntime {
  /** Match time of the most recent bounce, or -Infinity. */
  readonly lastHitTime: number;
}

/**
 * Pure pose: the pillar base position (orbit + bob). Rotation stays upright.
 *
 * @param t - Match time (s).
 * @param p - Params.
 * @param out - At least one sample.
 * @param speedScale - Multiplies orbit speed.
 */
export function bumperPillarPose(t: number, p: BumperPillarParams, out: PoseSample[], speedScale: number): void {
  const s = out[0];
  if (!s) return;
  const a = p.phase + p.orbitSpeed * speedScale * t;
  const bob = p.bobAmplitude > 0 ? p.bobAmplitude * (0.5 - 0.5 * Math.cos((TAU * t) / p.bobPeriod)) : 0;
  setPose(s, Math.cos(a) * p.orbitRadius, bob, -Math.sin(a) * p.orbitRadius, 0, 1, 0, 0);
}

class BumperPillarRuntime extends RuntimeBase implements BumperPillarView {
  lastHitTime = Number.NEGATIVE_INFINITY;
  private readonly driver: KinematicDriver;
  private readonly poses = createPoseBuffer(1);
  private readonly cooldown = new ActorCooldown();

  constructor(
    instance: ObstacleInstance<BumperPillarParams>,
    ctx: ObstacleBuildContext,
    private readonly p: BumperPillarParams,
  ) {
    super(instance, ctx);
    const { R } = ctx;
    const body = this.addBody(R.RigidBodyDesc.kinematicPositionBased());
    this.addCollider(
      R.ColliderDesc.roundCylinder(p.height / 2 - 0.2, p.radius - 0.2, 0.2)
        .setTranslation(0, p.height / 2, 0)
        .setRestitution(0.8)
        .setCollisionGroups(ObstacleGroups.kinematic),
      body,
      { kind: 'bouncy', bounceImpulse: p.bounceSpeed },
    );
    this.driver = new KinematicDriver(body, this.frame);
    bumperPillarPose(0, p, this.poses, ctx.speedScale);
    this.driver.teleport(this.poses[0]!);
  }

  update(ctx: ObstacleStepContext): void {
    bumperPillarPose(ctx.t, this.p, this.poses, this.build.speedScale);
    this.driver.drive(this.poses[0]!);
    this.endStep(ctx);
  }

  onContact(actor: ObstacleActor, _collider: Collider, ctx: ObstacleStepContext): void {
    if (actor.isGhost || !this.cooldown.ready(actor.id, ctx.t, this.p.cooldown)) return;
    // Bumpers always push radially: their own motion is slow and would read as "sticky".
    knockByMotion(actor, this.driver.body, {
      speed: this.p.bounceSpeed,
      lift: this.p.bounceLift,
      stun: false,
      minMotion: Number.POSITIVE_INFINITY,
    });
    this.lastHitTime = ctx.t;
    const pos = actor.body.translation();
    ctx.events.push({ type: 'bounce', player: actor.id, pos: { x: pos.x, y: pos.y, z: pos.z }, obstacle: this.instance.id });
    this.cue(ctx.events, 'boing', 0, this.p.height * 0.5, 0);
  }
}

/** Bumper pillar obstacle module. */
export const bumperPillar: ObstacleModule<BumperPillarParams> = {
  type: 'bumperPillar',
  displayName: 'Boing Pillar',
  schema: bumperPillarSchema,
  pose: bumperPillarPose,
  poseCount: () => 1,
  create: (instance, ctx) => new BumperPillarRuntime(instance, ctx, bumperPillarSchema.parse(instance.params)),
  audioCues: ['boing'],
};
