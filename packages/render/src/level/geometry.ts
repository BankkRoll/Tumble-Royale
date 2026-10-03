import {
  BufferGeometry,
  ExtrudeGeometry,
  LatheGeometry,
  Matrix4,
  Shape,
  SphereGeometry,
  TorusGeometry,
  Vector2,
} from 'three/webgpu';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import type { StaticPiece } from '@tumble/shared';

/**
 * Chunky toy geometry for every `StaticPiece` shape. All geometries are centred
 * on the piece's bounding-box centre (the `position` in round data) and match the
 * size conventions documented on `StaticPieceSchema`:
 *
 * | shape    | size                         | orientation (before rotation)                        |
 * |----------|------------------------------|------------------------------------------------------|
 * | box      | x,y,z full extents           | axis aligned                                         |
 * | ramp     | x,y,z full extents           | right-triangle prism; top slopes UP towards +Z, tall face at +Z |
 * | wedge    | x,y,z full extents           | symmetric roof prism; ridge along Z at the top, slopes down to ±X |
 * | cylinder | x = radius, y = height       | axis along Y                                         |
 * | hexPrism | x = circumradius, y = height | axis along Y, a vertex on +X                         |
 * | sphere   | x = radius                   | —                                                    |
 * | torus    | x = major, y = tube radius   | ring lying flat in XZ (axis Y); pitch 90 stands it up |
 * | arch     | x = width, y = height, z = depth | doorway in the XY plane, opening along Z         |
 *
 * Level colliders in `@tumble/sim` must use the same conventions.
 */

/** Tessellation detail: 0 = cheapest (Low tier / far LOD), 2 = hero. */
export type GeometryDetail = 0 | 1 | 2;

const SEGMENTS: Record<GeometryDetail, { radial: number; bevel: number; sphere: number }> = {
  0: { radial: 16, bevel: 1, sphere: 14 },
  1: { radial: 28, bevel: 2, sphere: 22 },
  2: { radial: 40, bevel: 3, sphere: 32 },
};

const fitMatrix = new Matrix4();

/** Scales and recentres `geo` so its bounding box exactly matches the target extents. */
function fitToBox(geo: BufferGeometry, sx: number, sy: number, sz: number): BufferGeometry {
  geo.computeBoundingBox();
  const bb = geo.boundingBox!;
  const cx = (bb.min.x + bb.max.x) / 2;
  const cy = (bb.min.y + bb.max.y) / 2;
  const cz = (bb.min.z + bb.max.z) / 2;
  const kx = sx / Math.max(bb.max.x - bb.min.x, 1e-4);
  const ky = sy / Math.max(bb.max.y - bb.min.y, 1e-4);
  const kz = sz / Math.max(bb.max.z - bb.min.z, 1e-4);
  geo.translate(-cx, -cy, -cz);
  geo.applyMatrix4(fitMatrix.makeScale(kx, ky, kz));
  return geo;
}

function clampBevel(bevel: number, ...dims: number[]): number {
  const limit = Math.min(...dims) * 0.45;
  return Math.max(0.005, Math.min(bevel, limit));
}

/** Lathe profile for a cylinder with rounded top and bottom rims. */
function beveledCylinder(radius: number, height: number, bevel: number, detail: GeometryDetail, sides?: number): BufferGeometry {
  const b = clampBevel(bevel, radius, height);
  const steps = SEGMENTS[detail].bevel * 2 + 1;
  const pts: Vector2[] = [new Vector2(0, -height / 2)];
  for (let i = 0; i <= steps; i++) {
    const a = -Math.PI / 2 + (i / steps) * (Math.PI / 2);
    pts.push(new Vector2(radius - b + Math.cos(a) * b, -height / 2 + b + Math.sin(a) * b));
  }
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * (Math.PI / 2);
    pts.push(new Vector2(radius - b + Math.cos(a) * b, height / 2 - b + Math.sin(a) * b));
  }
  pts.push(new Vector2(0, height / 2));
  return new LatheGeometry(pts, sides ?? SEGMENTS[detail].radial);
}

function extrudeBeveled(shape: Shape, depth: number, bevel: number, detail: GeometryDetail): ExtrudeGeometry {
  return new ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: SEGMENTS[detail].bevel + 1,
    curveSegments: SEGMENTS[detail].radial / 2,
  });
}

/** Right-triangle prism rising towards +Z. */
function ramp(sx: number, sy: number, sz: number, bevel: number, detail: GeometryDetail): BufferGeometry {
  const b = clampBevel(bevel, sx, sy, sz) * 0.6;
  // Shape lives in (z, y); the extrusion axis becomes X.
  const s = new Shape();
  s.moveTo(-sz / 2, -sy / 2);
  s.lineTo(sz / 2, -sy / 2);
  s.lineTo(sz / 2, sy / 2);
  s.closePath();
  const geo = extrudeBeveled(s, sx, b, detail);
  // Basis: shape x → world z, shape y → world y, extrude z → world -x (det +1 keeps winding).
  geo.applyMatrix4(fitMatrix.set(0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1));
  return fitToBox(geo, sx, sy, sz);
}

/** Symmetric roof prism, ridge along Z. */
function wedge(sx: number, sy: number, sz: number, bevel: number, detail: GeometryDetail): BufferGeometry {
  const b = clampBevel(bevel, sx, sy, sz) * 0.6;
  const s = new Shape();
  s.moveTo(-sx / 2, -sy / 2);
  s.lineTo(sx / 2, -sy / 2);
  s.lineTo(0, sy / 2);
  s.closePath();
  return fitToBox(extrudeBeveled(s, sz, b, detail), sx, sy, sz);
}

function hexPrism(radius: number, height: number, bevel: number, detail: GeometryDetail): BufferGeometry {
  const b = clampBevel(bevel, radius, height) * 0.7;
  const s = new Shape();
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const x = Math.cos(a) * (radius - b);
    const y = Math.sin(a) * (radius - b);
    if (i === 0) s.moveTo(x, y);
    else s.lineTo(x, y);
  }
  s.closePath();
  const geo = extrudeBeveled(s, Math.max(height - 2 * b, 0.01), b, detail);
  // Shape XY → world XZ with the extrusion pointing up.
  geo.rotateX(-Math.PI / 2);
  geo.computeBoundingBox();
  const bb = geo.boundingBox!;
  geo.translate(0, -(bb.min.y + bb.max.y) / 2, 0);
  return geo;
}

/** Doorway arch: two legs joined by an elliptical top, open along Z. */
function arch(width: number, height: number, depth: number, bevel: number, detail: GeometryDetail): BufferGeometry {
  const t = Math.min(width * 0.2, 0.9, height * 0.3);
  const ry = Math.min(width / 2, height * 0.6);
  const rx = width / 2;
  const yc = height / 2 - ry;
  const ix = rx - t;
  const iy = Math.max(ry - t, 0.05);
  const curve = SEGMENTS[detail].radial / 2;

  const s = new Shape();
  s.moveTo(-rx, -height / 2);
  s.lineTo(-ix, -height / 2);
  s.lineTo(-ix, yc);
  for (let i = 1; i <= curve; i++) {
    const a = Math.PI - (i / curve) * Math.PI;
    s.lineTo(Math.cos(a) * ix, yc + Math.sin(a) * iy);
  }
  s.lineTo(ix, -height / 2);
  s.lineTo(rx, -height / 2);
  s.lineTo(rx, yc);
  for (let i = 1; i <= curve; i++) {
    const a = (i / curve) * Math.PI;
    s.lineTo(Math.cos(a) * rx, yc + Math.sin(a) * ry);
  }
  s.closePath();
  const b = clampBevel(bevel, t, depth) * 0.6;
  return fitToBox(extrudeBeveled(s, depth, b, detail), width, height, depth);
}

/**
 * Builds the toy-style geometry for a static piece, in piece-local space.
 *
 * @param piece - Validated static piece.
 * @param detail - Tessellation level.
 * @returns A fresh, non-indexed geometry with `position`, `normal` and `uv`.
 */
export function createPieceGeometry(piece: StaticPiece, detail: GeometryDetail = 1): BufferGeometry {
  const { x, y, z } = piece.size;
  const seg = SEGMENTS[detail];
  let geo: BufferGeometry;
  switch (piece.shape) {
    case 'box': {
      const r = clampBevel(piece.bevel, x, y, z);
      geo = new RoundedBoxGeometry(x, y, z, seg.bevel, r);
      break;
    }
    case 'cylinder':
      geo = beveledCylinder(x, y, piece.bevel, detail);
      break;
    case 'hexPrism':
      geo = hexPrism(x, y, piece.bevel, detail);
      break;
    case 'ramp':
      geo = ramp(x, y, z, piece.bevel, detail);
      break;
    case 'wedge':
      geo = wedge(x, y, z, piece.bevel, detail);
      break;
    case 'sphere':
      geo = new SphereGeometry(x, seg.sphere, Math.round(seg.sphere * 0.66));
      break;
    case 'torus':
      // Lies flat like the collider ring; designers use pitch 90 to stand a hoop up.
      geo = new TorusGeometry(x, Math.max(y, 0.02), Math.round(seg.radial / 2), seg.radial * 2).rotateX(Math.PI / 2);
      break;
    case 'arch':
      geo = arch(x, y, z, piece.bevel, detail);
      break;
  }
  if (geo.index) {
    const flat = geo.toNonIndexed();
    geo.dispose();
    geo = flat;
  }
  for (const name of Object.keys(geo.attributes)) {
    if (name !== 'position' && name !== 'normal' && name !== 'uv') geo.deleteAttribute(name);
  }
  geo.clearGroups();
  return geo;
}

/**
 * Rounded rail used to highlight a grabbable top edge.
 *
 * @param length - Rail length along local X.
 * @param thickness - Rail cross-section size.
 */
export function createEdgeRailGeometry(length: number, thickness: number): BufferGeometry {
  const geo = new RoundedBoxGeometry(Math.max(length, thickness), thickness, thickness, 2, thickness * 0.45);
  const flat = geo.toNonIndexed();
  geo.dispose();
  return flat;
}

/**
 * Lathe ring hugging the top rim of a cylinder-like piece (grab highlight).
 *
 * @param radius - Outer radius of the piece.
 * @param thickness - Tube thickness.
 */
export function createRimRingGeometry(radius: number, thickness: number): BufferGeometry {
  const geo = new TorusGeometry(radius, thickness / 2, 8, 48);
  geo.rotateX(Math.PI / 2);
  const flat = geo.toNonIndexed();
  geo.dispose();
  return flat;
}

/** Hex prism helper exported for decor (crystal pillars, basalt steps). */
export function createHexPrismGeometry(radius: number, height: number, bevel = 0.1, detail: GeometryDetail = 1): BufferGeometry {
  return hexPrism(radius, height, bevel, detail);
}

/** Beveled cylinder helper exported for decor and scenes (podiums, platforms). */
export function createBeveledCylinderGeometry(
  radius: number,
  height: number,
  bevel = 0.15,
  detail: GeometryDetail = 1,
  sides?: number,
): BufferGeometry {
  return beveledCylinder(radius, height, bevel, detail, sides);
}
