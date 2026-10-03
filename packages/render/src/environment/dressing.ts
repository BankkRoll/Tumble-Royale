/**
 * Set-dressing placement rules shared by every environment layer.
 *
 * Responsibilities:
 * - Builds the {@link KeepOut} volume for a course: the playable box padded by
 *   the gameplay camera's reach, plus the intro flyover's camera path and its
 *   sightlines to the look-at targets.
 * - Answers "does this prop overlap the keep-out?" for boxes and for cloud
 *   drift lanes (infinite along X), so clouds never drift through a course and
 *   no backdrop prop sits between a camera and what it is looking at.
 * - Places the spectator stands beside the course at the height of the floor
 *   they face, instead of at the lowest point of the level.
 *
 * Pure data: no three.js objects, so tests can check every round headlessly.
 */
import type { RoundDefinition } from '@tumble/shared';

/** Plain 3-vector. */
export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

/** Axis-aligned box. */
export interface BoxLike {
  min: Vec3Like;
  max: Vec3Like;
}

/** A sphere dressing must not touch. */
export interface KeepOutSphere {
  c: Vec3Like;
  r: number;
}

/** Everything backdrop props must stay out of. */
export interface KeepOut {
  /** Course plus gameplay camera reach. */
  box: BoxLike;
  /** Flyover camera positions and their sightlines. */
  spheres: KeepOutSphere[];
}

/** A stand placement (mirrors {@link CrowdStandPlacement}). */
export interface StandPlan {
  /** Front-centre of the stand at floor level. */
  position: Vec3Like;
  /** Radians; the crowd faces local -Z rotated by this yaw. */
  yaw: number;
  width: number;
  rows: number;
}

/** Where the stands go and which floor height they face. */
export interface StandAnchors {
  /** Floor point at the start (spawn). */
  start: Vec3Like;
  /** Floor point at the goal (finish line / crown); the start again for arenas. */
  end: Vec3Like;
}

/**
 * Gameplay camera reach around a player, from the third-person rig defaults:
 * the side camera sits 12 m out, the top-down tilt 15 m along a 60° arm.
 */
export const CAMERA_REACH = { side: 13, up: 16, down: 4 } as const;
/** Radius kept clear around every flyover camera sample (m). */
export const FLYOVER_CLEARANCE = 5;
/** Radius kept clear around flyover sightlines (m). */
export const SIGHTLINE_CLEARANCE = 3;

/** Stand footprint from the bleacher geometry in `crowd.ts`. */
export function standDepth(rows: number): number {
  return rows * 1.3 + 0.6;
}

/** Stand height from the bleacher geometry in `crowd.ts` (back wall top). */
export function standHeight(rows: number): number {
  return rows * 0.7 + 3.2;
}

/** World AABB of a stand (yaw is a multiple of 90° in every plan we make; others are bounded conservatively). */
export function standBox(s: StandPlan): BoxLike {
  const d = standDepth(s.rows);
  const h = standHeight(s.rows);
  const c = Math.cos(s.yaw);
  const sn = Math.sin(s.yaw);
  // Local footprint x ∈ [-w/2, w/2], z ∈ [0, d]; rotate the 4 corners about Y.
  const xs: number[] = [];
  const zs: number[] = [];
  for (const lx of [-s.width / 2, s.width / 2])
    for (const lz of [0, d]) {
      xs.push(s.position.x + lx * c + lz * sn);
      zs.push(s.position.z - lx * sn + lz * c);
    }
  return {
    min: { x: Math.min(...xs), y: s.position.y - 0.5, z: Math.min(...zs) },
    max: { x: Math.max(...xs), y: s.position.y + h, z: Math.max(...zs) },
  };
}

/** True when two boxes overlap. */
export function boxesOverlap(a: BoxLike, b: BoxLike): boolean {
  return (
    a.min.x < b.max.x &&
    a.max.x > b.min.x &&
    a.min.y < b.max.y &&
    a.max.y > b.min.y &&
    a.min.z < b.max.z &&
    a.max.z > b.min.z
  );
}

/** True when a sphere touches a box. */
export function sphereHitsBox(s: KeepOutSphere, b: BoxLike): boolean {
  const dx = Math.max(b.min.x - s.c.x, 0, s.c.x - b.max.x);
  const dy = Math.max(b.min.y - s.c.y, 0, s.c.y - b.max.y);
  const dz = Math.max(b.min.z - s.c.z, 0, s.c.z - b.max.z);
  return dx * dx + dy * dy + dz * dz < s.r * s.r;
}

/** True when a box overlaps the keep-out volume. */
export function keepOutHitsBox(k: KeepOut, b: BoxLike): boolean {
  if (boxesOverlap(k.box, b)) return true;
  for (const s of k.spheres) if (sphereHitsBox(s, b)) return true;
  return false;
}

/**
 * A cloud drift lane: the cloud slides along X forever (it wraps), so it
 * sweeps every X at a fixed Y/Z band.
 */
export interface DriftLane {
  y0: number;
  y1: number;
  z0: number;
  z1: number;
}

/** True when a drift lane (infinite along X) crosses the keep-out volume. */
export function keepOutHitsLane(k: KeepOut, lane: DriftLane): boolean {
  const huge = 1e9;
  return keepOutHitsBox(k, {
    min: { x: -huge, y: lane.y0, z: lane.z0 },
    max: { x: huge, y: lane.y1, z: lane.z1 },
  });
}

/** Catmull-Rom sample through `pts` at u ∈ [0,1] (same curve as the level viewer and camera rig). */
export function catmullRom(pts: readonly Vec3Like[], u: number): Vec3Like {
  const n = pts.length;
  if (n === 1) return { ...pts[0]! };
  const f = Math.min(Math.max(u, 0), 1) * (n - 1);
  const i = Math.min(Math.floor(f), n - 2);
  const t = f - i;
  const p0 = pts[Math.max(i - 1, 0)]!;
  const p1 = pts[i]!;
  const p2 = pts[i + 1]!;
  const p3 = pts[Math.min(i + 2, n - 1)]!;
  const t2 = t * t;
  const t3 = t2 * t;
  const c = (a: number, b: number, cc: number, d: number): number =>
    0.5 * (2 * b + (-a + cc) * t + (2 * a - 5 * b + 4 * cc - d) * t2 + (-a + 3 * b - 3 * cc + d) * t3);
  return { x: c(p0.x, p1.x, p2.x, p3.x), y: c(p0.y, p1.y, p2.y, p3.y), z: c(p0.z, p1.z, p2.z, p3.z) };
}

/** Intro camera path: camera positions and the points they look at. */
export interface CameraPath {
  path: readonly Vec3Like[];
  /** One target per path point, or a single target for all. */
  lookAt: readonly Vec3Like[];
}

/**
 * Builds the keep-out volume for a course.
 *
 * @param course - Playable box (see `measureCourse` in `@tumble/sim/match`).
 * @param flyover - Intro camera path, when the scene has one.
 * @returns The keep-out volume.
 * @example
 * const keepOut = buildKeepOut(course, round.flyover);
 */
export function buildKeepOut(course: BoxLike, flyover?: CameraPath): KeepOut {
  const box: BoxLike = {
    min: {
      x: course.min.x - CAMERA_REACH.side,
      y: course.min.y - CAMERA_REACH.down,
      z: course.min.z - CAMERA_REACH.side,
    },
    max: {
      x: course.max.x + CAMERA_REACH.side,
      y: course.max.y + CAMERA_REACH.up,
      z: course.max.z + CAMERA_REACH.side,
    },
  };
  const spheres: KeepOutSphere[] = [];
  if (flyover && flyover.path.length > 0) {
    const samples = Math.max(16, flyover.path.length * 12);
    for (let i = 0; i <= samples; i++) {
      const u = i / samples;
      const cam = catmullRom(flyover.path, u);
      spheres.push({ c: cam, r: FLYOVER_CLEARANCE });
      const target = flyover.lookAt.length > 1 ? catmullRom(flyover.lookAt, u) : flyover.lookAt[0];
      if (!target) continue;
      const len = Math.hypot(target.x - cam.x, target.y - cam.y, target.z - cam.z);
      const steps = Math.ceil(len / (SIGHTLINE_CLEARANCE * 1.5));
      for (let s = 1; s < steps; s++) {
        const f = s / steps;
        spheres.push({
          c: {
            x: cam.x + (target.x - cam.x) * f,
            y: cam.y + (target.y - cam.y) * f,
            z: cam.z + (target.z - cam.z) * f,
          },
          r: SIGHTLINE_CLEARANCE,
        });
      }
    }
  }
  return { box, spheres };
}

/**
 * Floor anchors for the stands: the spawn and the goal (finish line or crown,
 * else the spawn again).
 *
 * @param round - Round definition.
 * @returns Start and end floor points.
 */
export function standAnchorsForRound(round: Pick<RoundDefinition, 'spawn' | 'triggers'>): StandAnchors {
  const start = { ...round.spawn.origin };
  const goal =
    round.triggers.find((t) => t.kind === 'finish') ?? round.triggers.find((t) => t.kind === 'crown');
  const end = goal ? { x: goal.position.x, y: goal.position.y - goal.size.y / 2, z: goal.position.z } : start;
  return { start, end };
}

/** Environment inputs that place a round's backdrop. */
export interface RoundDressing {
  courseBounds: BoxLike;
  keepOut: KeepOut;
  standAnchors: StandAnchors;
}

/**
 * Everything `createEnvironment` needs to dress a round: its course box, the
 * keep-out (course, gameplay camera reach, intro flyover) and the stand anchors.
 *
 * @param round - The round being shown.
 * @param course - Its playable box (`measureCourse(sim.round, sim.obstacleRuntimes)`).
 * @returns Options to spread into `createEnvironment`.
 * @example
 * const env = createEnvironment(theme, { ...roundDressing(round, course), seed: round.decorSeed });
 */
export function roundDressing(
  round: Pick<RoundDefinition, 'spawn' | 'triggers' | 'flyover'>,
  course: BoxLike,
): RoundDressing {
  return {
    courseBounds: course,
    keepOut: buildKeepOut(course, round.flyover),
    standAnchors: standAnchorsForRound(round),
  };
}

/** Gap between the course box and the front row (m), so the crowd reads as beside the course, not on it. */
const STAND_GAP = 2;

/**
 * Places two stands: one beside the start on the +X side, one beside the goal
 * on the -X side, each facing the course with its front row a little below
 * the floor it watches. Stands step outward until clear of the keep-out
 * (flyover camera paths can swing wide of the course).
 *
 * @param course - Playable box.
 * @param anchors - Floor points the stands face.
 * @param keepOut - Volume the stands must not touch.
 * @returns Two stand placements.
 */
export function planStands(course: BoxLike, anchors: StandAnchors, keepOut: KeepOut): StandPlan[] {
  const width = 18;
  const rows = 4;
  const plans: StandPlan[] = [];
  const sides: [Vec3Like, 1 | -1][] = [
    [anchors.start, 1],
    [anchors.end, -1],
  ];
  for (const [anchor, side] of sides) {
    const zMin = course.min.z + width / 2;
    const zMax = course.max.z - width / 2;
    const z = zMin <= zMax ? Math.min(Math.max(anchor.z, zMin), zMax) : (course.min.z + course.max.z) / 2;
    const edge = side > 0 ? keepOut.box.max.x + STAND_GAP : keepOut.box.min.x - STAND_GAP;
    const plan: StandPlan = {
      position: { x: edge, y: anchor.y - 1, z },
      yaw: (side * Math.PI) / 2,
      width,
      rows,
    };
    for (let i = 0; i < 40 && keepOutHitsBox(keepOut, standBox(plan)); i++) plan.position.x += side * 3;
    plans.push(plan);
  }
  return plans;
}
