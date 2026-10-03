/**
 * Rising Slime — a lethal goo surface whose height follows designer
 * keyframes as a pure function of time. The surface is a kinematic sensor
 * tagged `lethal` in the surface registry; the match sim eliminates/respawns
 * players who touch it.
 */
import { z } from 'zod';
import type { Collider } from '@dimforge/rapier3d-compat';
import {
  KinematicDriver,
  ObstacleGroups,
  RuntimeBase,
  createPoseBuffer,
  leadTelegraph,
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

/** One height keyframe: at match time `t` (s) the surface is at local height `h` (m). */
export const SlimeKeyframeSchema = z.object({ t: z.number(), h: z.number() });

/** Rising slime parameters. Origin = centre of the slime area at local height 0. */
export const risingSlimeSchema = z.object({
  /** Slime area along X (m). */
  width: z.number().positive().default(60),
  /** Slime area along Z (m). */
  depth: z.number().positive().default(60),
  /** Height curve; sorted by `t` at parse time. Held flat before the first and after the last key. */
  keyframes: z
    .array(SlimeKeyframeSchema)
    .min(1)
    .default([
      { t: 0, h: -3 },
      { t: 20, h: -3 },
      { t: 60, h: 2 },
      { t: 120, h: 6 },
    ])
    .transform((k) => [...k].sort((a, b) => a.t - b.t)),
  /** Interpolation between keys. */
  easing: z.enum(['linear', 'smooth']).default('smooth'),
  /** Warning before a rise begins (s). */
  telegraphLead: z.number().min(0).default(2),
  /** Depth of the lethal volume under the surface (m). */
  volumeDepth: z.number().positive().default(8),
});

/** Validated slime params. */
export type RisingSlimeParams = z.output<typeof risingSlimeSchema>;

/**
 * Surface height (m, local) at time t. Pure. `speedScale` compresses the curve in time.
 */
export function slimeHeight(t: number, p: RisingSlimeParams, speedScale = 1): number {
  const k = p.keyframes;
  const tt = t * speedScale;
  const first = k[0]!;
  if (tt <= first.t) return first.h;
  for (let i = 1; i < k.length; i++) {
    const b = k[i]!;
    if (tt <= b.t) {
      const a = k[i - 1]!;
      const span = b.t - a.t;
      let x = span > 0 ? (tt - a.t) / span : 1;
      if (p.easing === 'smooth') x = x * x * (3 - 2 * x);
      return a.h + (b.h - a.h) * x;
    }
  }
  return k[k.length - 1]!.h;
}

/**
 * Warning before the slime starts rising (0..1), plus a steady low glow while it rises.
 */
export function risingSlimeTelegraph(t: number, p: RisingSlimeParams, speedScale = 1): number {
  const k = p.keyframes;
  const tt = t * speedScale;
  for (let i = 1; i < k.length; i++) {
    const a = k[i - 1]!;
    const b = k[i]!;
    if (b.h <= a.h) continue;
    if (tt >= a.t && tt <= b.t) return 0.35;
    if (tt < a.t) return leadTelegraph((a.t - tt) / speedScale, p.telegraphLead);
  }
  return 0;
}

/**
 * Pure pose: a single sample at the surface height.
 */
export function risingSlimePose(
  t: number,
  p: RisingSlimeParams,
  out: PoseSample[],
  speedScale: number,
): void {
  if (out[0]) setPose(out[0], 0, slimeHeight(t, p, speedScale), 0, 0, 1, 0, 0);
}

class RisingSlimeRuntime extends RuntimeBase {
  private readonly driver: KinematicDriver;
  private readonly poses = createPoseBuffer(1);
  private rising = false;

  constructor(
    instance: ObstacleInstance<RisingSlimeParams>,
    ctx: ObstacleBuildContext,
    private readonly p: RisingSlimeParams,
  ) {
    super(instance, ctx);
    const { R } = ctx;
    const body = this.addBody(R.RigidBodyDesc.kinematicPositionBased());
    this.addCollider(
      R.ColliderDesc.cuboid(p.width / 2, p.volumeDepth / 2, p.depth / 2)
        .setTranslation(0, -p.volumeDepth / 2, 0)
        .setSensor(true)
        .setCollisionGroups(ObstacleGroups.hazard),
      body,
      { kind: 'slime', lethal: true },
    );
    this.driver = new KinematicDriver(body, this.frame);
    risingSlimePose(0, p, this.poses, ctx.speedScale);
    this.driver.teleport(this.poses[0]!);
  }

  update(ctx: ObstacleStepContext): void {
    const scale = this.build.speedScale;
    risingSlimePose(ctx.t, this.p, this.poses, scale);
    this.driver.drive(this.poses[0]!);
    const h0 = Number.isNaN(this.lastT) ? this.poses[0]!.pos.y : slimeHeight(this.lastT, this.p, scale);
    const rising = this.poses[0]!.pos.y > h0 + 1e-6;
    if (rising && !this.rising) this.cue(ctx.events, 'rise', 0, this.poses[0]!.pos.y, 0);
    this.rising = rising;
    this.endStep(ctx);
  }

  onTrigger(actor: ObstacleActor, _collider: Collider, entered: boolean, ctx: ObstacleStepContext): void {
    if (!entered) return;
    const p = actor.body.translation();
    ctx.events.push({
      type: 'obstacleCue',
      obstacle: this.instance.id,
      cue: 'splash',
      pos: { x: p.x, y: p.y, z: p.z },
    });
  }

  telegraph(t: number): number {
    return risingSlimeTelegraph(t, this.p, this.build.speedScale);
  }
}

/** Rising slime obstacle module. */
export const risingSlime: ObstacleModule<RisingSlimeParams> = {
  type: 'risingSlime',
  displayName: 'Gloop Tide',
  schema: risingSlimeSchema,
  pose: risingSlimePose,
  poseCount: () => 1,
  create: (instance, ctx) => new RisingSlimeRuntime(instance, ctx, risingSlimeSchema.parse(instance.params)),
  audioCues: ['rise', 'splash'],
};
