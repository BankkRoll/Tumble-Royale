/**
 * Static level geometry → fixed Rapier colliders.
 *
 * Shape conventions (shared with the renderer's level builder). Every piece's
 * `position` is the centre of its bounding box; `rotation` is yaw/pitch/roll
 * in degrees applied in Y-X-Z order.
 *
 * | shape    | size                                  | collider                                              |
 * |----------|---------------------------------------|-------------------------------------------------------|
 * | box      | full extents x, y, z                  | cuboid                                                |
 * | cylinder | x = radius, y = height                | cylinder along Y                                      |
 * | ramp     | full extents                          | right-triangle prism: low edge at −Z, rising to +Z    |
 * | wedge    | full extents                          | roof prism: ridge along Z at top, faces fall to ±X    |
 * | sphere   | x = radius                            | ball                                                  |
 * | hexPrism | x = circumradius, y = height          | convex hull, vertices at k·60° (flat sides on ±Z)     |
 * | torus    | x = major radius, y = tube radius     | ring of capsules lying in the XZ plane                |
 * | arch     | x = width, y = height, z = depth      | two legs + lintel                                     |
 */
import type { Collider, ColliderDesc, RigidBody, World } from '@dimforge/rapier3d-compat';
import {
  InteractionGroups,
  quatFromAxisAngle,
  quatFromEulerYXZ,
  quatMul,
  rotateVec,
  vec3,
  type Quat,
  type RoundDefinition,
  type StaticPiece,
  type Vec3,
} from '@tumble/shared';
import type { Rapier } from '../physics/rapier.ts';
import type { SurfaceInfo, SurfaceRegistry } from '../physics/surfaces.ts';

const DEG = Math.PI / 180;

/** Segments used to approximate a torus with capsules. */
const TORUS_SEGMENTS = 16;

/** Result of {@link buildStaticGeometry}. */
export interface StaticGeometry {
  /** The single fixed body every level collider hangs off. */
  body: RigidBody;
  colliders: Collider[];
}

/**
 * Creates fixed colliders for every non-decorative static piece and registers
 * non-default surfaces (ice, conveyor, grabbable…) in `surfaces`.
 *
 * @param R - Rapier namespace.
 * @param world - Target world.
 * @param round - Validated round definition.
 * @param surfaces - Registry receiving surface info, keyed by collider handle.
 * @returns The body and colliders created.
 */
export function buildStaticGeometry(
  R: Rapier,
  world: World,
  round: RoundDefinition,
  surfaces: SurfaceRegistry,
): StaticGeometry {
  const body = world.createRigidBody(R.RigidBodyDesc.fixed());
  const colliders: Collider[] = [];
  for (let i = 0; i < round.geometry.length; i++) {
    const piece = round.geometry[i] as StaticPiece;
    if (piece.decorative) continue;
    const info: SurfaceInfo | null =
      piece.surface !== 'normal' || piece.grabbable
        ? { kind: piece.surface, grabbable: piece.grabbable || undefined, ownerId: `geometry-${i}` }
        : null;
    for (const part of pieceParts(R, piece)) {
      part.desc.setCollisionGroups(InteractionGroups.static).setFriction(frictionFor(piece.surface));
      const c = world.createCollider(part.desc, body);
      colliders.push(c);
      if (info) surfaces.set(c.handle, info);
    }
  }
  return { body, colliders };
}

/** Base Rapier friction per surface; the controller layers its own handling on top. */
function frictionFor(kind: StaticPiece['surface']): number {
  switch (kind) {
    case 'ice':
    case 'slide':
      return 0.02;
    case 'sticky':
      return 1.5;
    default:
      return 0.7;
  }
}

interface Part {
  desc: ColliderDesc;
}

/**
 * Collider descriptors for one piece, already placed in world space.
 * Build-time only; allocations are fine here.
 */
export function pieceParts(R: Rapier, piece: StaticPiece): Part[] {
  const rot = quatFromEulerYXZ(
    (piece.rotation?.yaw ?? 0) * DEG,
    (piece.rotation?.pitch ?? 0) * DEG,
    (piece.rotation?.roll ?? 0) * DEG,
  );
  const s = piece.size;
  const parts: Part[] = [];
  const place = (desc: ColliderDesc | null, local: Vec3 = vec3(), localRot: Quat | null = null): void => {
    if (!desc) return;
    const off = rotateVec(rot, local);
    const r = localRot ? quatMul(rot, localRot) : rot;
    desc
      .setTranslation(piece.position.x + off.x, piece.position.y + off.y, piece.position.z + off.z)
      .setRotation(r);
    parts.push({ desc });
  };
  const hx = Math.max(s.x / 2, 0.01);
  const hy = Math.max(s.y / 2, 0.01);
  const hz = Math.max(s.z / 2, 0.01);
  switch (piece.shape) {
    case 'box':
      place(R.ColliderDesc.cuboid(hx, hy, hz));
      break;
    case 'cylinder':
      place(R.ColliderDesc.cylinder(Math.max(s.y / 2, 0.01), Math.max(s.x, 0.01)));
      break;
    case 'sphere':
      place(R.ColliderDesc.ball(Math.max(s.x, 0.01)));
      break;
    case 'ramp':
      place(R.ColliderDesc.convexHull(rampPoints(hx, hy, hz)));
      break;
    case 'wedge':
      place(R.ColliderDesc.convexHull(wedgePoints(hx, hy, hz)));
      break;
    case 'hexPrism':
      place(R.ColliderDesc.convexHull(hexPoints(Math.max(s.x, 0.01), hy)));
      break;
    case 'torus': {
      const major = Math.max(s.x, 0.1);
      const tube = Math.max(s.y, 0.05);
      const step = (Math.PI * 2) / TORUS_SEGMENTS;
      // Chord length between segment centres; capsule caps overlap the joints.
      const half = major * Math.sin(step / 2);
      for (let k = 0; k < TORUS_SEGMENTS; k++) {
        const a = (k + 0.5) * step;
        const centre = vec3(Math.cos(a) * major, 0, Math.sin(a) * major);
        const tx = -Math.sin(a);
        const tz = Math.cos(a);
        // Capsules run along local Y; rotate Y onto the tangent (axis = Y × t).
        const segRot = quatFromAxisAngle(tz, 0, -tx, Math.PI / 2);
        place(R.ColliderDesc.capsule(half, tube), centre, segRot);
      }
      break;
    }
    case 'arch': {
      const leg = Math.max(0.4, s.x * 0.15);
      const lintel = Math.max(0.4, s.y * 0.15);
      const legH = Math.max(s.y - lintel, 0.1);
      for (const side of [-1, 1]) {
        place(R.ColliderDesc.cuboid(leg / 2, legH / 2, hz), vec3(side * (hx - leg / 2), -hy + legH / 2, 0));
      }
      place(R.ColliderDesc.cuboid(hx, lintel / 2, hz), vec3(0, hy - lintel / 2, 0));
      break;
    }
  }
  return parts;
}

function rampPoints(hx: number, hy: number, hz: number): Float32Array {
  // prettier-ignore
  return new Float32Array([
    -hx, -hy, -hz,  hx, -hy, -hz,
    -hx, -hy,  hz,  hx, -hy,  hz,
    -hx,  hy,  hz,  hx,  hy,  hz,
  ]);
}

function wedgePoints(hx: number, hy: number, hz: number): Float32Array {
  // prettier-ignore
  return new Float32Array([
    -hx, -hy, -hz,  hx, -hy, -hz,
    -hx, -hy,  hz,  hx, -hy,  hz,
     0,  hy, -hz,   0,  hy,  hz,
  ]);
}

function hexPoints(r: number, hy: number): Float32Array {
  const pts = new Float32Array(12 * 3);
  for (let k = 0; k < 6; k++) {
    const a = (k * Math.PI) / 3;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    pts.set([x, -hy, z, x, hy, z], k * 6);
  }
  return pts;
}
