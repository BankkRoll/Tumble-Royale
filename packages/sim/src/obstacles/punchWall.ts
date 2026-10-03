/**
 * Punch Wall — a wall of boxing pistons that wind up (telegraph), punch out
 * along local +Z, hold, and retract on a schedule. Pistons can fire in sync,
 * as a wave, alternating, or in a seeded-hash order (pure, no Rng needed).
 */
import { z } from 'zod';
import type { Collider } from '@dimforge/rapier3d-compat';
import { hash01, rotateVec, vec3, type Vec3 } from '@tumble/shared';
import {
  ActorCooldown,
  KinematicDriver,
  ObstacleGroups,
  RuntimeBase,
  createPoseBuffer,
  crossedPeriodic,
  knockByMotion,
  leadTelegraph,
  modPos,
  actorLocal,
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

/** Punch wall parameters. */
export const punchWallSchema = z.object({
  pistonCount: z.number().int().min(1).max(16).default(4),
  /** Centre-to-centre spacing along the wall (m). */
  pistonSpacing: z.number().positive().default(2.4),
  /** Square punch face size (m). */
  pistonSize: z.number().positive().default(1.7),
  /** Punch face centre height (m). */
  pistonHeight: z.number().default(1.1),
  /** Punch extension distance (m). */
  reach: z.number().positive().default(2.8),
  /** Full cycle per piston (s). Divided by speedScale. */
  period: z.number().positive().default(3),
  /** Wind-up warning before the punch (s). */
  telegraphLead: z.number().min(0).default(0.7),
  /** Extension time (s) — short = violent. */
  punchTime: z.number().positive().default(0.12),
  /** Time held fully extended (s). */
  holdTime: z.number().min(0).default(0.45),
  /** Retraction time (s). */
  retractTime: z.number().positive().default(0.9),
  /** Firing order across pistons. */
  pattern: z.enum(['sync', 'wave', 'alternate', 'random']).default('wave'),
  /** Delay between neighbours for the `wave` pattern (s). */
  waveStep: z.number().min(0).default(0.35),
  /** Global cycle offset (s). */
  phase: z.number().default(0),
  /** Salt for the `random` pattern so two walls differ. */
  seedSalt: z.number().int().default(0),
  wallHeight: z.number().positive().default(3),
  wallThickness: z.number().positive().default(0.8),
  knockSpeed: z.number().min(0).default(16),
  knockLift: z.number().min(0).default(6),
  stun: z.boolean().default(true),
});

/** Validated punch wall params. */
export type PunchWallParams = z.output<typeof punchWallSchema>;

/** Piston body depth (m). */
export const PUNCH_PISTON_DEPTH = 0.8;

/** Cycle offset (s, unscaled) of piston `i`. */
export function punchOffset(i: number, p: PunchWallParams): number {
  switch (p.pattern) {
    case 'sync':
      return 0;
    case 'wave':
      return i * p.waveStep;
    case 'alternate':
      return (i % 2) * p.period * 0.5;
    case 'random':
      return hash01(i * 7919 + p.seedSalt * 104729) * p.period;
  }
}

/** Position of time `t` within piston `i`'s cycle; 0 = punch starts. */
export function punchCycleTime(t: number, i: number, p: PunchWallParams, speedScale: number): number {
  return modPos(t * speedScale - p.phase - punchOffset(i, p), p.period);
}

/**
 * Piston extension (m along +Z) at cycle time `u`. Negative during wind-up.
 * @returns Extension in metres.
 */
export function punchExtension(u: number, p: PunchWallParams): number {
  if (u < p.punchTime) {
    const k = u / p.punchTime;
    return p.reach * (1 - (1 - k) * (1 - k));
  }
  if (u < p.punchTime + p.holdTime) return p.reach;
  const r0 = p.punchTime + p.holdTime;
  if (u < r0 + p.retractTime) {
    const k = (u - r0) / p.retractTime;
    return p.reach * (1 - k * k * (3 - 2 * k));
  }
  const lead = Math.min(p.telegraphLead, Math.max(0, p.period - r0 - p.retractTime));
  if (lead > 0 && u > p.period - lead) {
    const k = (u - (p.period - lead)) / lead;
    return -0.3 * Math.sin(k * Math.PI * 0.5);
  }
  return 0;
}

/** Resting Z of a piston body's centre (face flush just proud of the wall). */
export const punchRestZ = (p: PunchWallParams): number => p.wallThickness / 2 - PUNCH_PISTON_DEPTH / 2 + 0.15;

/** X of piston `i` along the wall. */
export const punchPistonX = (i: number, p: PunchWallParams): number =>
  (i - (p.pistonCount - 1) / 2) * p.pistonSpacing;

/**
 * Pure pose: one sample per piston.
 *
 * @param t - Match time (s).
 * @param p - Params.
 * @param out - At least `pistonCount` samples.
 * @param speedScale - Speeds up the whole schedule.
 */
export function punchWallPose(t: number, p: PunchWallParams, out: PoseSample[], speedScale: number): void {
  const z0 = punchRestZ(p);
  for (let i = 0; i < p.pistonCount && i < out.length; i++) {
    const ext = punchExtension(punchCycleTime(t, i, p, speedScale), p);
    setPose(out[i]!, punchPistonX(i, p), p.pistonHeight, z0 + ext, 0, 1, 0, 0);
  }
}

/** Wind-up warning for piston `i`, 0..1. */
export function punchPistonTelegraph(t: number, i: number, p: PunchWallParams, speedScale: number): number {
  const u = punchCycleTime(t, i, p, speedScale);
  return leadTelegraph((p.period - u) / speedScale, p.telegraphLead / speedScale);
}

/** Strongest warning across all pistons, 0..1. */
export function punchWallTelegraph(t: number, p: PunchWallParams, speedScale: number): number {
  let m = 0;
  for (let i = 0; i < p.pistonCount; i++) m = Math.max(m, punchPistonTelegraph(t, i, p, speedScale));
  return m;
}

class PunchWallRuntime extends RuntimeBase {
  private readonly drivers: KinematicDriver[] = [];
  private readonly poses: PoseSample[];
  private readonly cooldown = new ActorCooldown();
  private readonly pistonByCollider = new Map<number, number>();
  private readonly pushAxis: Vec3;
  private readonly scratch = vec3();

  constructor(
    instance: ObstacleInstance<PunchWallParams>,
    ctx: ObstacleBuildContext,
    private readonly p: PunchWallParams,
  ) {
    super(instance, ctx);
    const { R } = ctx;
    this.poses = createPoseBuffer(p.pistonCount);
    this.pushAxis = rotateVec(this.frame.rot, vec3(0, 0, 1), vec3());

    const width = p.pistonCount * p.pistonSpacing + 0.6;
    const wall = this.addBody(R.RigidBodyDesc.fixed());
    this.addCollider(
      R.ColliderDesc.cuboid(width / 2, p.wallHeight / 2, p.wallThickness / 2)
        .setTranslation(0, p.wallHeight / 2, -0.05)
        .setCollisionGroups(ObstacleGroups.static),
      wall,
    );

    const half = p.pistonSize / 2;
    for (let i = 0; i < p.pistonCount; i++) {
      const body = this.addBody(R.RigidBodyDesc.kinematicPositionBased());
      const c = this.addCollider(
        R.ColliderDesc.roundCuboid(
          half - 0.12,
          half - 0.12,
          PUNCH_PISTON_DEPTH / 2 - 0.12,
          0.12,
        ).setCollisionGroups(ObstacleGroups.kinematic),
        body,
      );
      this.pistonByCollider.set(c.handle, i);
      this.drivers.push(new KinematicDriver(body, this.frame));
    }
    punchWallPose(0, p, this.poses, ctx.speedScale);
    for (let i = 0; i < p.pistonCount; i++) this.drivers[i]!.teleport(this.poses[i]!);
  }

  update(ctx: ObstacleStepContext): void {
    const scale = this.build.speedScale;
    punchWallPose(ctx.t, this.p, this.poses, scale);
    for (let i = 0; i < this.drivers.length; i++) this.drivers[i]!.drive(this.poses[i]!);
    const t0 = this.lastT * scale - this.p.phase;
    const t1 = ctx.t * scale - this.p.phase;
    for (let i = 0; i < this.p.pistonCount; i++) {
      const off = punchOffset(i, this.p);
      if (crossedPeriodic(t0, t1, this.p.period, off)) {
        const s = this.poses[i]!.pos;
        this.cue(ctx.events, 'punch', s.x, s.y, s.z);
      }
    }
    this.endStep(ctx);
  }

  onContact(actor: ObstacleActor, collider: Collider, ctx: ObstacleStepContext): void {
    const i = this.pistonByCollider.get(collider.handle);
    if (i === undefined || actor.isGhost) return;
    const u = punchCycleTime(ctx.t, i, this.p, this.build.speedScale);
    const striking = u < this.p.punchTime + this.p.holdTime * 0.25;
    if (!striking) return;
    // Only actors in front of the wall get punched; ones on top ride along.

    const local = actorLocal(this.frame, actor, this.scratch);
    if (local.y > this.p.pistonHeight + this.p.pistonSize / 2 + 0.3) return;
    if (!this.cooldown.ready(actor.id, ctx.t, 0.5)) return;
    knockByMotion(actor, this.drivers[i]!.body, {
      speed: this.p.knockSpeed,
      lift: this.p.knockLift,
      stun: this.p.stun,
      axis: this.pushAxis,
    });
    this.cue(ctx.events, 'pow', local.x, local.y, local.z);
  }

  telegraph(t: number): number {
    return punchWallTelegraph(t, this.p, this.build.speedScale);
  }
}

/** Punch wall obstacle module. */
export const punchWall: ObstacleModule<PunchWallParams> = {
  type: 'punchWall',
  displayName: 'Pow Wall',
  schema: punchWallSchema,
  pose: punchWallPose,
  poseCount: (p) => p.pistonCount,
  create: (instance, ctx) => new PunchWallRuntime(instance, ctx, punchWallSchema.parse(instance.params)),
  audioCues: ['punch', 'pow'],
};
