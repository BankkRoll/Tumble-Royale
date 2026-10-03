/**
 * Course volume: the axis-aligned box players can occupy or touch in a round.
 *
 * Responsibilities:
 * - Unions every solid static piece, every obstacle collider (moving parts
 *   counted over their whole reach), the round's trigger volumes, spawn grid,
 *   respawn points and bot waypoints.
 * - Gives set dressing (stands, clouds, islands) a single box to keep out of.
 *   The round's `bounds` cannot serve: those are netcode quantisation limits,
 *   padded far past the course and down to the kill plane.
 */
import type { Collider } from '@dimforge/rapier3d-compat';
import {
  quatFromEulerYXZ,
  quatMul,
  rotateVec,
  type Quat,
  type RoundDefinition,
  type StaticPiece,
  type Vec3,
} from '@tumble/shared';
import type { ObstacleRuntime } from '../obstacles/types.ts';

const DEG = Math.PI / 180;

/** Axis-aligned box, world metres. */
export interface CourseBox {
  min: Vec3;
  max: Vec3;
}

/** Rapier `ShapeType` ids used below (the enum is a runtime value we avoid importing). */
const Shape = {
  Ball: 0,
  Cuboid: 1,
  Capsule: 2,
  TriMesh: 6,
  ConvexPolyhedron: 9,
  Cylinder: 10,
  Cone: 11,
  RoundCuboid: 12,
  RoundCylinder: 14,
  RoundCone: 15,
  RoundConvexPolyhedron: 16,
} as const;

/** An empty box that any {@link growPoint} call replaces. */
export function emptyBox(): CourseBox {
  return {
    min: { x: Infinity, y: Infinity, z: Infinity },
    max: { x: -Infinity, y: -Infinity, z: -Infinity },
  };
}

/** True when the box contains at least one point. */
export function isBoxEmpty(b: CourseBox): boolean {
  return !(b.min.x <= b.max.x && b.min.y <= b.max.y && b.min.z <= b.max.z);
}

/**
 * Grows `b` to include a point padded by per-axis half extents.
 *
 * @returns `b`.
 */
export function growPoint(b: CourseBox, p: Vec3, hx = 0, hy = hx, hz = hx): CourseBox {
  b.min.x = Math.min(b.min.x, p.x - hx);
  b.min.y = Math.min(b.min.y, p.y - hy);
  b.min.z = Math.min(b.min.z, p.z - hz);
  b.max.x = Math.max(b.max.x, p.x + hx);
  b.max.y = Math.max(b.max.y, p.y + hy);
  b.max.z = Math.max(b.max.z, p.z + hz);
  return b;
}

/** Grows `b` by a box centred at `c` with local half extents `h`, rotated by `q`. */
function growOriented(
  b: CourseBox,
  c: Vec3,
  h: Vec3,
  q: Quat,
  lo: Vec3 = { x: -h.x, y: -h.y, z: -h.z },
): void {
  const { x, y, z, w } = q;
  // Rotation matrix rows from the quaternion; the world AABB of an oriented box is |R|·h around the rotated centre.
  const m00 = 1 - 2 * (y * y + z * z);
  const m01 = 2 * (x * y - z * w);
  const m02 = 2 * (x * z + y * w);
  const m10 = 2 * (x * y + z * w);
  const m11 = 1 - 2 * (x * x + z * z);
  const m12 = 2 * (y * z - x * w);
  const m20 = 2 * (x * z - y * w);
  const m21 = 2 * (y * z + x * w);
  const m22 = 1 - 2 * (x * x + y * y);
  // Off-centre local boxes (convex hulls) are re-centred first.
  const hx = (h.x - lo.x) / 2;
  const hy = (h.y - lo.y) / 2;
  const hz = (h.z - lo.z) / 2;
  const ox = (h.x + lo.x) / 2;
  const oy = (h.y + lo.y) / 2;
  const oz = (h.z + lo.z) / 2;
  const cx = c.x + m00 * ox + m01 * oy + m02 * oz;
  const cy = c.y + m10 * ox + m11 * oy + m12 * oz;
  const cz = c.z + m20 * ox + m21 * oy + m22 * oz;
  growPoint(
    b,
    { x: cx, y: cy, z: cz },
    Math.abs(m00) * hx + Math.abs(m01) * hy + Math.abs(m02) * hz,
    Math.abs(m10) * hx + Math.abs(m11) * hy + Math.abs(m12) * hz,
    Math.abs(m20) * hx + Math.abs(m21) * hy + Math.abs(m22) * hz,
  );
}

/**
 * Local half extents of a static piece's bounding box, per the shape
 * conventions in `geometry.ts`.
 *
 * @param piece - Authored piece.
 * @returns Half extents along the piece's local axes.
 */
export function pieceHalfExtents(piece: StaticPiece): Vec3 {
  const s = piece.size;
  switch (piece.shape) {
    case 'cylinder':
    case 'hexPrism':
      return { x: s.x, y: s.y / 2, z: s.x };
    case 'sphere':
      return { x: s.x, y: s.x, z: s.x };
    case 'torus':
      return { x: s.x + s.y, y: s.y, z: s.x + s.y };
    default:
      return { x: s.x / 2, y: s.y / 2, z: s.z / 2 };
  }
}

/** Local min/max of a collider's shape, or null for shapes we do not measure. */
function shapeBounds(c: Collider): { lo: Vec3; hi: Vec3 } | null {
  const t = c.shapeType() as number;
  const box = (x: number, y: number, z: number) => ({ lo: { x: -x, y: -y, z: -z }, hi: { x, y, z } });
  switch (t) {
    case Shape.Ball: {
      const r = c.radius();
      return box(r, r, r);
    }
    case Shape.Cuboid:
    case Shape.RoundCuboid: {
      const h = c.halfExtents();
      if (!h) return null;
      const rr = t === Shape.RoundCuboid ? c.roundRadius() : 0;
      return box(h.x + rr, h.y + rr, h.z + rr);
    }
    case Shape.Capsule: {
      const r = c.radius();
      return box(r, c.halfHeight() + r, r);
    }
    case Shape.Cylinder:
    case Shape.Cone:
    case Shape.RoundCylinder:
    case Shape.RoundCone: {
      const rr = t === Shape.RoundCylinder || t === Shape.RoundCone ? c.roundRadius() : 0;
      const r = c.radius() + rr;
      return box(r, c.halfHeight() + rr, r);
    }
    case Shape.ConvexPolyhedron:
    case Shape.RoundConvexPolyhedron:
    case Shape.TriMesh: {
      const v = c.vertices();
      if (v.length < 3) return null;
      const lo = { x: Infinity, y: Infinity, z: Infinity };
      const hi = { x: -Infinity, y: -Infinity, z: -Infinity };
      for (let i = 0; i + 2 < v.length; i += 3) {
        lo.x = Math.min(lo.x, v[i]!);
        lo.y = Math.min(lo.y, v[i + 1]!);
        lo.z = Math.min(lo.z, v[i + 2]!);
        hi.x = Math.max(hi.x, v[i]!);
        hi.y = Math.max(hi.y, v[i + 1]!);
        hi.z = Math.max(hi.z, v[i + 2]!);
      }
      return { lo, hi };
    }
    default:
      return null;
  }
}

/** Offset (m) beyond which a moving collider is treated as an arm swinging about its body. */
const ARM_OFFSET = 0.5;

/**
 * Grows `b` by one solid obstacle collider, counting moving parts over their
 * reach so the result does not depend on the instant it was measured:
 * - fixed bodies: the collider at its pose;
 * - colliders hung off their body's origin (sweeper arms, hammer heads): the
 *   sphere they can sweep about that origin;
 * - colliders centred on their body (spinning bars, discs, plates): any yaw
 *   about their own centre.
 */
function growCollider(b: CourseBox, c: Collider, killY: number): void {
  if (c.isSensor()) return;
  const sb = shapeBounds(c);
  if (!sb) return;
  const body = c.parent();
  if (!body) return;
  // Composed from the body pose: collider poses only catch up with moved bodies on the next world step.
  const o = body.translation();
  const bq = body.rotation();
  const local = c.translationWrtParent() ?? { x: 0, y: 0, z: 0 };
  const lq = c.rotationWrtParent() ?? { x: 0, y: 0, z: 0, w: 1 };
  const off = rotateVec(bq, local);
  const p = { x: o.x + off.x, y: o.y + off.y, z: o.z + off.z };
  const q = quatMul(bq, lq);
  // Pooled projectiles (boulders, cannon balls) park below the kill plane between uses.
  if (p.y < killY || o.y < killY) return;
  if (body.isFixed()) {
    growOriented(b, p, sb.hi, q, sb.lo);
    return;
  }
  const ext = Math.max(Math.hypot(sb.hi.x, sb.hi.y, sb.hi.z), Math.hypot(sb.lo.x, sb.lo.y, sb.lo.z));
  const offset = Math.hypot(local.x, local.y, local.z);
  if (offset > ARM_OFFSET) {
    growPoint(b, o, offset + ext);
    return;
  }
  const posed = emptyBox();
  growOriented(posed, p, sb.hi, q, sb.lo);
  const halfY = (posed.max.y - posed.min.y) / 2;
  const reach = Math.hypot((posed.max.x - posed.min.x) / 2, (posed.max.z - posed.min.z) / 2);
  growPoint(b, { x: p.x, y: (posed.max.y + posed.min.y) / 2, z: p.z }, reach, halfY, reach);
}

/** Feet-to-head clearance counted around player-occupied points (m). */
const PLAYER_HEIGHT = 2;
const PLAYER_RADIUS = 1;

/**
 * Measures a round's course volume.
 *
 * @param round - Validated round (with the variation's obstacles already built into `runtimes`).
 * @param runtimes - The built obstacle runtimes (their colliders are measured where they stand now).
 * @returns The course box; a 20 m box around the spawn when the round is empty.
 * @example
 * const course = measureCourse(sim.round, sim.obstacleRuntimes);
 * createEnvironment(theme, { courseBounds: course });
 */
export function measureCourse(round: RoundDefinition, runtimes: readonly ObstacleRuntime[]): CourseBox {
  const b = emptyBox();
  for (const piece of round.geometry) {
    if (piece.decorative) continue;
    const r = piece.rotation;
    const q = quatFromEulerYXZ((r?.yaw ?? 0) * DEG, (r?.pitch ?? 0) * DEG, (r?.roll ?? 0) * DEG);
    growOriented(b, piece.position, pieceHalfExtents(piece), q);
  }
  for (const rt of runtimes) for (const c of rt.colliders) growCollider(b, c, round.killY);
  for (const t of round.triggers) {
    // The void trigger is a kill plane under the course, not something players stand in.
    if (t.kind === 'void') continue;
    const r = t.rotation;
    const q = quatFromEulerYXZ((r?.yaw ?? 0) * DEG, (r?.pitch ?? 0) * DEG, (r?.roll ?? 0) * DEG);
    growOriented(b, t.position, { x: t.size.x / 2, y: t.size.y / 2, z: t.size.z / 2 }, q);
    for (const p of t.respawn)
      growPoint(
        b,
        { x: p.x, y: p.y + PLAYER_HEIGHT / 2, z: p.z },
        PLAYER_RADIUS,
        PLAYER_HEIGHT / 2,
        PLAYER_RADIUS,
      );
  }
  const sp = round.spawn;
  const origins = sp.teamOrigins.length > 0 ? sp.teamOrigins : [sp.origin];
  const half = (sp.cols * sp.spacing) / 2;
  for (const o of origins)
    growPoint(b, { x: o.x, y: o.y + PLAYER_HEIGHT / 2, z: o.z }, half, PLAYER_HEIGHT / 2, half);
  for (const w of round.botNav) {
    growPoint(
      b,
      { x: w.position.x, y: w.position.y + PLAYER_HEIGHT / 2, z: w.position.z },
      PLAYER_RADIUS,
      PLAYER_HEIGHT / 2,
      PLAYER_RADIUS,
    );
  }
  if (isBoxEmpty(b)) growPoint(b, sp.origin, 10);
  return b;
}
