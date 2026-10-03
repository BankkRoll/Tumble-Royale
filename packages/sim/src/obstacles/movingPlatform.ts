/**
 * Moving Platform — a rideable slab travelling through designer path points
 * with eased segments, ping-pong or loop, and pauses at the ends (or at every
 * point). Kinematic, pure function of time.
 */
import { z } from 'zod';
import { KinematicDriver, ObstacleGroups, RuntimeBase, createPoseBuffer, easeInOutCubic, modPos, setPose } from './helpers-a.ts';
import type { ObstacleBuildContext, ObstacleInstance, ObstacleModule, ObstacleStepContext, PoseSample } from './types.ts';

const Vec3Param = z.object({ x: z.number(), y: z.number(), z: z.number() });

/** Moving platform parameters. Points are instance-local positions of the platform's top centre. */
export const movingPlatformSchema = z.object({
  points: z
    .array(Vec3Param)
    .min(1)
    .default([
      { x: 0, y: 0, z: 0 },
      { x: 0, y: 0, z: 8 },
    ]),
  /** Platform extents (m). */
  size: Vec3Param.default({ x: 4, y: 0.6, z: 4 }),
  /** Travel speed along each segment (m/s, average). Scaled by speedScale. */
  speed: z.number().positive().default(3),
  /** pingPong: 0→n→0; loop: 0→n→0 via the closing segment. */
  mode: z.enum(['pingPong', 'loop']).default('pingPong'),
  /** Pause length (s). */
  pauseTime: z.number().min(0).default(1),
  /** Pause only at path ends, or at every point. */
  pauseAt: z.enum(['ends', 'all']).default('ends'),
  /** Segment easing. */
  easing: z.enum(['sine', 'cubic', 'linear']).default('sine'),
  /** Time offset (s). */
  phase: z.number().default(0),
  /** Continuous yaw spin (rad/s). */
  spin: z.number().default(0),
});

/** Validated moving platform params. */
export type MovingPlatformParams = z.output<typeof movingPlatformSchema>;

/** Number of path segments per cycle. */
function segmentCount(p: MovingPlatformParams): number {
  const n = p.points.length;
  if (n < 2) return 0;
  return p.mode === 'pingPong' ? 2 * (n - 1) : n;
}

/** Point index at the start of segment `s`. */
function segmentStart(s: number, p: MovingPlatformParams): number {
  const n = p.points.length;
  if (p.mode === 'loop') return s % n;
  return s < n - 1 ? s : 2 * (n - 1) - s;
}

/** Point index at the end of segment `s`. */
function segmentEnd(s: number, p: MovingPlatformParams): number {
  const n = p.points.length;
  if (p.mode === 'loop') return (s + 1) % n;
  return s + 1 < n ? s + 1 : 2 * (n - 1) - (s + 1);
}

function segmentPause(s: number, p: MovingPlatformParams): number {
  if (p.pauseAt === 'all') return p.pauseTime;
  const e = segmentEnd(s, p);
  return e === 0 || (p.mode === 'pingPong' && e === p.points.length - 1) ? p.pauseTime : 0;
}

function segmentDuration(s: number, p: MovingPlatformParams, speed: number): number {
  const a = p.points[segmentStart(s, p)]!;
  const b = p.points[segmentEnd(s, p)]!;
  return Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) / speed;
}

function ease(x: number, kind: MovingPlatformParams['easing']): number {
  if (kind === 'linear') return x;
  if (kind === 'cubic') return easeInOutCubic(x);
  return -(Math.cos(Math.PI * x) - 1) / 2;
}

/** Seconds for one full cycle. */
export function movingPlatformCycle(p: MovingPlatformParams, speedScale: number): number {
  const v = p.speed * speedScale;
  let total = 0;
  for (let s = 0; s < segmentCount(p); s++) total += segmentDuration(s, p, v) + segmentPause(s, p);
  return total;
}

/**
 * Pure pose: one sample at the platform's top centre.
 *
 * @param t - Match time (s).
 * @param p - Params.
 * @param out - At least one sample.
 * @param speedScale - Multiplies travel speed (pauses unchanged).
 */
export function movingPlatformPose(t: number, p: MovingPlatformParams, out: PoseSample[], speedScale: number): void {
  const o = out[0];
  if (!o) return;
  const yaw = p.spin * t;
  const segs = segmentCount(p);
  const first = p.points[0]!;
  if (segs === 0) {
    setPose(o, first.x, first.y, first.z, 0, 1, 0, yaw);
    return;
  }
  const v = p.speed * speedScale;
  const cycle = movingPlatformCycle(p, speedScale);
  let u = cycle > 0 ? modPos(t - p.phase, cycle) : 0;
  for (let s = 0; s < segs; s++) {
    const d = segmentDuration(s, p, v);
    const a = p.points[segmentStart(s, p)]!;
    const b = p.points[segmentEnd(s, p)]!;
    if (u < d) {
      const k = ease(d > 0 ? u / d : 1, p.easing);
      setPose(o, a.x + (b.x - a.x) * k, a.y + (b.y - a.y) * k, a.z + (b.z - a.z) * k, 0, 1, 0, yaw);
      return;
    }
    u -= d;
    const pause = segmentPause(s, p);
    if (u < pause) {
      setPose(o, b.x, b.y, b.z, 0, 1, 0, yaw);
      return;
    }
    u -= pause;
  }
  setPose(o, first.x, first.y, first.z, 0, 1, 0, yaw);
}

class MovingPlatformRuntime extends RuntimeBase {
  private readonly driver: KinematicDriver;
  private readonly poses = createPoseBuffer(1);

  constructor(
    instance: ObstacleInstance<MovingPlatformParams>,
    ctx: ObstacleBuildContext,
    private readonly p: MovingPlatformParams,
  ) {
    super(instance, ctx);
    const { R } = ctx;
    const body = this.addBody(R.RigidBodyDesc.kinematicPositionBased());
    const r = Math.min(0.15, p.size.y * 0.3);
    this.addCollider(
      R.ColliderDesc.roundCuboid(p.size.x / 2 - r, p.size.y / 2 - r, p.size.z / 2 - r, r)
        .setTranslation(0, -p.size.y / 2, 0)
        .setFriction(1)
        .setCollisionGroups(ObstacleGroups.kinematic),
      body,
      { kind: 'normal' },
    );
    this.driver = new KinematicDriver(body, this.frame);
    movingPlatformPose(0, p, this.poses, ctx.speedScale);
    this.driver.teleport(this.poses[0]!);
  }

  update(ctx: ObstacleStepContext): void {
    movingPlatformPose(ctx.t, this.p, this.poses, this.build.speedScale);
    this.driver.drive(this.poses[0]!);
    this.endStep(ctx);
  }
}

/** Moving platform obstacle module. */
export const movingPlatform: ObstacleModule<MovingPlatformParams> = {
  type: 'movingPlatform',
  displayName: 'Drifty Deck',
  schema: movingPlatformSchema,
  pose: movingPlatformPose,
  poseCount: () => 1,
  create: (instance, ctx) => new MovingPlatformRuntime(instance, ctx, movingPlatformSchema.parse(instance.params)),
  audioCues: [],
};
