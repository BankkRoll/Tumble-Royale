/**
 * Boulder Lane — giant candy balls dropped in at the lane start and rolled
 * down local +Z on a fixed schedule. Every ball is a kinematic body whose
 * pose is a pure function of time (spawn index → lane, age → distance and
 * roll angle), so nothing needs replicating. A fixed pool of bodies is
 * recycled: slot j always carries spawns k ≡ j (mod pool).
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
  knockByMotion,
  modPos,
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

/** Boulder lane parameters. Origin = centre of the lane start line, ground level. */
export const boulderLaneSchema = z.object({
  lanes: z.number().int().min(1).max(12).default(3),
  /** Lane centre spacing along X (m). */
  laneSpacing: z.number().positive().default(5),
  /** Roll distance along +Z before a ball vanishes (m). */
  length: z.number().positive().default(40),
  radius: z.number().positive().default(1.6),
  /** Rolling speed (m/s). Scaled by speedScale. */
  speed: z.number().positive().default(7),
  /** Seconds between spawns. */
  spawnPeriod: z.number().positive().default(2.2),
  /** Lane choice per spawn. */
  laneOrder: z.enum(['cycle', 'pingpong', 'hash']).default('hash'),
  /** Salt for `hash` lane order so two lanes differ. */
  seedSalt: z.number().int().default(0),
  /** Time of spawn #0 (s). */
  phase: z.number().default(0),
  /** Balls drop in from this height above the ground (m). */
  dropHeight: z.number().min(0).default(4),
  /** Drop-in duration (s). */
  dropTime: z.number().positive().default(0.45),
  knockSpeed: z.number().min(0).default(14),
  knockLift: z.number().min(0).default(8),
  stun: z.boolean().default(true),
});

/** Validated boulder lane params. */
export type BoulderLaneParams = z.output<typeof boulderLaneSchema>;

/** Y used for inactive (parked) pool slots; visuals hide anything below it. */
export const BOULDER_PARKED_Y = -1000;

/** Seconds a ball takes to roll the full lane. */
export const boulderTravelTime = (p: BoulderLaneParams, speedScale: number): number =>
  p.length / (p.speed * speedScale);

/** Pool size: maximum balls alive at once (+1 so a slot is never reused while live). */
export const boulderPoolSize = (p: BoulderLaneParams, speedScale: number): number =>
  Math.ceil(boulderTravelTime(p, speedScale) / p.spawnPeriod) + 1;

/** Lane index for spawn `k`. */
export function boulderLaneOf(k: number, p: BoulderLaneParams): number {
  if (p.lanes <= 1) return 0;
  if (p.laneOrder === 'cycle') return modPos(k, p.lanes);
  if (p.laneOrder === 'pingpong') {
    const span = 2 * (p.lanes - 1);
    const u = modPos(k, span);
    return u < p.lanes ? u : span - u;
  }
  return Math.min(p.lanes - 1, Math.floor(hash01(k * 31 + p.seedSalt * 977 + 7) * p.lanes));
}

/** Spawn index carried by pool slot `j` at time t (may be negative before the first spawn). */
export function boulderSlotSpawn(t: number, j: number, pool: number, p: BoulderLaneParams): number {
  const latest = Math.floor((t - p.phase) / p.spawnPeriod);
  return latest - modPos(latest - j, pool);
}

/**
 * Pure pose: one sample per pool slot. Inactive slots are parked at
 * {@link BOULDER_PARKED_Y}.
 *
 * @param t - Match time (s).
 * @param p - Params.
 * @param out - At least {@link boulderPoolSize} samples.
 * @param speedScale - Multiplies roll speed.
 */
export function boulderLanePose(
  t: number,
  p: BoulderLaneParams,
  out: PoseSample[],
  speedScale: number,
): void {
  const pool = boulderPoolSize(p, speedScale);
  const v = p.speed * speedScale;
  const travel = boulderTravelTime(p, speedScale);
  for (let j = 0; j < pool && j < out.length; j++) {
    const k = boulderSlotSpawn(t, j, pool, p);
    const age = t - (p.phase + k * p.spawnPeriod);
    const x = (boulderLaneOf(k, p) - (p.lanes - 1) / 2) * p.laneSpacing;
    if (age < 0 || age > travel) {
      setPose(out[j]!, x, BOULDER_PARKED_Y, 0, 1, 0, 0, 0);
      continue;
    }
    const d = age * v;
    const drop = age < p.dropTime ? p.dropHeight * (1 - age / p.dropTime) ** 2 : 0;
    // Spawn-dependent starting spin so the stripes don't all line up.
    setPose(out[j]!, x, p.radius + drop, d, 1, 0, 0, d / p.radius + k * 1.7);
  }
}

class BoulderLaneRuntime extends RuntimeBase {
  private readonly drivers: KinematicDriver[] = [];
  private readonly balls: Collider[] = [];
  private readonly slotSpawn: number[] = [];
  private readonly slotActive: boolean[] = [];
  private readonly poses: PoseSample[];
  private readonly pool: number;
  private readonly cooldown = new ActorCooldown();
  private readonly slotByCollider = new Map<number, number>();
  private readonly axis: Vec3;

  constructor(
    instance: ObstacleInstance<BoulderLaneParams>,
    ctx: ObstacleBuildContext,
    private readonly p: BoulderLaneParams,
  ) {
    super(instance, ctx);
    const { R } = ctx;
    this.pool = boulderPoolSize(p, ctx.speedScale);
    this.poses = createPoseBuffer(this.pool);
    this.axis = rotateVec(this.frame.rot, vec3(0, 0, 1), vec3());
    for (let j = 0; j < this.pool; j++) {
      const body = this.addBody(R.RigidBodyDesc.kinematicPositionBased());
      const c = this.addCollider(
        R.ColliderDesc.ball(p.radius).setRestitution(0.3).setCollisionGroups(ObstacleGroups.kinematic),
        body,
      );
      this.slotByCollider.set(c.handle, j);
      this.balls.push(c);
      this.drivers.push(new KinematicDriver(body, this.frame));
      this.slotSpawn.push(Number.NaN);
      this.slotActive.push(false);
    }
    this.apply(0, null);
  }

  private apply(t: number, ctx: ObstacleStepContext | null): void {
    const scale = this.build.speedScale;
    boulderLanePose(t, this.p, this.poses, scale);
    for (let j = 0; j < this.pool; j++) {
      const k = boulderSlotSpawn(t, j, this.pool, this.p);
      const sample = this.poses[j]!;
      const active = sample.pos.y > BOULDER_PARKED_Y + 1;
      // A recycled slot or a park/unpark is a teleport: driving it would imply a huge velocity.
      if (k !== this.slotSpawn[j] || active !== this.slotActive[j]) {
        this.drivers[j]!.teleport(sample);
        this.balls[j]!.setEnabled(active);
        if (active && ctx && !Number.isNaN(this.lastT))
          this.cue(ctx.events, 'boulderSpawn', sample.pos.x, sample.pos.y, sample.pos.z);
        this.slotSpawn[j] = k;
        this.slotActive[j] = active;
      } else {
        this.drivers[j]!.drive(sample);
      }
    }
  }

  update(ctx: ObstacleStepContext): void {
    this.apply(ctx.t, ctx);
    this.endStep(ctx);
  }

  onContact(actor: ObstacleActor, collider: Collider, ctx: ObstacleStepContext): void {
    const j = this.slotByCollider.get(collider.handle);
    if (j === undefined || actor.isGhost || !this.cooldown.ready(actor.id, ctx.t, 0.6)) return;
    knockByMotion(actor, this.drivers[j]!.body, {
      speed: this.p.knockSpeed,
      lift: this.p.knockLift,
      stun: this.p.stun,
      axis: this.axis,
    });
    const s = this.poses[j]!.pos;
    this.cue(ctx.events, 'squash', s.x, s.y, s.z);
  }
}

/** Boulder lane obstacle module. */
export const boulderLane: ObstacleModule<BoulderLaneParams> = {
  type: 'boulderLane',
  displayName: 'Jawbreaker Alley',
  schema: boulderLaneSchema,
  pose: boulderLanePose,
  poseCount: boulderPoolSize,
  create: (instance, ctx) => new BoulderLaneRuntime(instance, ctx, boulderLaneSchema.parse(instance.params)),
  audioCues: ['boulderSpawn', 'squash'],
};
