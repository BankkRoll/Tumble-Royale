/**
 * The overview camera: one wide shot that frames the whole course.
 *
 * {@link courseBox} measures the course from its solid pieces (decoration
 * and the netcode's generous bounds would frame mostly sky), and
 * {@link overviewPose} backs the camera off along a fixed, slightly
 * downward view until that box fits the frustum, looking across the course's
 * long side so a long race fills the width of the screen.
 */
import { forwardOf, pose, type CamPose, type Vec3 } from './cameraMath.ts';

/** Axis-aligned box. */
export interface Box {
  min: Vec3;
  max: Vec3;
}

/** The parts of a round definition the overview reads. */
export interface OverviewRound {
  geometry: readonly {
    shape: string;
    position: Vec3;
    size: Vec3;
    decorative?: boolean;
  }[];
  spawn: { origin: Vec3 };
  bounds: Box;
}

/** Overview framing tuning. */
export const OVERVIEW = Object.freeze({
  /** Downward tilt of the shot (rad, ≈ 43°). */
  pitch: 0.75,
  /** Extra room around the course (fraction of the fitted distance). */
  padding: 0.08,
  /** Closest the overview gets (m), so a tiny arena still reads as a wide shot. */
  minDistance: 30,
});

/** Half extents a piece can reach from its centre, whatever its rotation. */
function reach(p: OverviewRound['geometry'][number]): Vec3 {
  const s = p.size;
  switch (p.shape) {
    case 'cylinder':
    case 'hexPrism':
      return { x: s.x, y: s.y / 2, z: s.x };
    case 'sphere':
      return { x: s.x, y: s.x, z: s.x };
    case 'torus': {
      const r = s.x + s.y;
      return { x: r, y: r, z: r };
    }
    default: {
      // Rotated boxes, ramps and arches: the half diagonal covers any orientation.
      const r = Math.hypot(s.x, s.y, s.z) / 2;
      return { x: r, y: r, z: r };
    }
  }
}

/**
 * The course's solid extent: every non-decorative piece plus the spawn,
 * falling back to the netcode bounds when the round has no geometry.
 *
 * @param round - Round definition.
 * @example
 * const box = courseBox(round);
 */
export function courseBox(round: OverviewRound): Box {
  const o = round.spawn.origin;
  const min = { x: o.x, y: o.y, z: o.z };
  const max = { x: o.x, y: o.y, z: o.z };
  let pieces = 0;
  for (const p of round.geometry) {
    if (p.decorative) continue;
    const r = reach(p);
    min.x = Math.min(min.x, p.position.x - r.x);
    min.y = Math.min(min.y, p.position.y - r.y);
    min.z = Math.min(min.z, p.position.z - r.z);
    max.x = Math.max(max.x, p.position.x + r.x);
    max.y = Math.max(max.y, p.position.y + r.y);
    max.z = Math.max(max.z, p.position.z + r.z);
    pieces++;
  }
  if (pieces === 0) return { min: { ...round.bounds.min }, max: { ...round.bounds.max } };
  return { min, max };
}

/**
 * A camera pose that fits `box` on screen.
 *
 * The view looks across the box's longer horizontal side, tilted down by
 * {@link OVERVIEW.pitch}; the box's eight corners are projected onto the
 * camera's right/up axes to find the distance at which both the horizontal
 * and vertical field of view hold them.
 *
 * @param box - What to frame.
 * @param fovYDeg - Vertical field of view (degrees).
 * @param aspect - Width / height.
 * @returns The pose.
 */
export function overviewPose(box: Box, fovYDeg: number, aspect: number): CamPose {
  const cx = (box.min.x + box.max.x) / 2;
  const cy = (box.min.y + box.max.y) / 2;
  const cz = (box.min.z + box.max.z) / 2;
  const hx = (box.max.x - box.min.x) / 2;
  const hy = (box.max.y - box.min.y) / 2;
  const hz = (box.max.z - box.min.z) / 2;
  // Long axis across the screen: a course along z is watched from the side (looking along +x).
  const yaw = hz > hx ? Math.PI / 2 : 0;
  const out = pose(cx, cy, cz, yaw, OVERVIEW.pitch);
  const f = forwardOf(out, { x: 0, y: 0, z: 0 });
  const r = { x: -Math.cos(yaw), y: 0, z: Math.sin(yaw) };
  // up = right × forward.
  const u = { x: r.y * f.z - r.z * f.y, y: r.z * f.x - r.x * f.z, z: r.x * f.y - r.y * f.x };
  const halfV = (Math.max(10, Math.min(120, fovYDeg)) * Math.PI) / 180 / 2;
  const tanV = Math.tan(halfV);
  const tanH = tanV * Math.max(0.2, aspect);
  let dist = 0;
  for (const sx of [-1, 1])
    for (const sy of [-1, 1])
      for (const sz of [-1, 1]) {
        const px = sx * hx;
        const py = sy * hy;
        const pz = sz * hz;
        const side = Math.abs(px * r.x + py * r.y + pz * r.z);
        const up = Math.abs(px * u.x + py * u.y + pz * u.z);
        const depth = px * f.x + py * f.y + pz * f.z;
        // The corner sits `depth` further along the view than the centre: it needs that much less distance.
        dist = Math.max(dist, side / tanH - depth, up / tanV - depth);
      }
  dist = Math.max(OVERVIEW.minDistance, dist * (1 + OVERVIEW.padding));
  out.x = cx - f.x * dist;
  out.y = cy - f.y * dist;
  out.z = cz - f.z * dist;
  return out;
}
