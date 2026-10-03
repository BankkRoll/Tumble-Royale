/**
 * The Spiral (LEVELS.md R4 §4): a 12-sided conical helix around (0, ·, 215),
 * generated from the design formula instead of transcribing 30 rows by hand.
 *
 * Vertex k (0…30): φ = −90° + 30°·k, r = 16 + (8/12)·k,
 * x = r·cos φ, z = 215 + r·sin φ, y = 70 − 1.6·k. Lane width 7.
 *
 * Responsibilities: vertex/segment maths, the lane pieces (pads, ramps,
 * half-segment walls, outer corner posts, dodge pockets) and the chained
 * snowball lanes that roll the whole descent.
 */
import { box, cm, cyl, pillar, ramp, v, type Obstacle, type Piece } from '../gumdrop-gauntlet/kit.ts';

const DEG = Math.PI / 180;

/** Spiral axis (x, z). */
export const SPIRAL_CENTRE = { x: 0, z: 215 } as const;
export const SPIRAL_VERTICES = 31;
export const LANE_WIDTH = 7;
/** Vertices with an inner dodge pocket (the inner wall is omitted next to them). */
export const POCKET_VERTICES = [14, 18, 22, 26] as const;

/** One spiral vertex: lane centre on the walking surface. */
export interface SpiralVertex {
  k: number;
  x: number;
  y: number;
  z: number;
  r: number;
  /** Polar angle in radians. */
  phi: number;
}

/**
 * @param k - Vertex index 0…30.
 * @returns The lane-centre point at vertex `k`.
 */
export function spiralVertex(k: number): SpiralVertex {
  const phi = (-90 + 30 * k) * DEG;
  const r = 16 + (8 / 12) * k;
  return { k, phi, r, x: r * Math.cos(phi), y: 70 - 1.6 * k, z: SPIRAL_CENTRE.z + r * Math.sin(phi) };
}

/** Segment k → k+1 geometry. */
export interface SpiralSegment {
  k: number;
  /** Horizontal length. */
  length: number;
  /** Along-slope length. */
  slopeLength: number;
  /** Descent angle in degrees. */
  slopeDeg: number;
  /** Yaw (degrees) of the travel direction k → k+1. */
  travelYaw: number;
  mid: { x: number; y: number; z: number };
}

/** @param k - Segment index 0…29. */
export function spiralSegment(k: number): SpiralSegment {
  const a = spiralVertex(k);
  const b = spiralVertex(k + 1);
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const length = Math.hypot(dx, dz);
  const drop = a.y - b.y;
  return {
    k,
    length,
    slopeLength: Math.hypot(length, drop),
    slopeDeg: Math.atan2(drop, length) / DEG,
    travelYaw: Math.atan2(dx, dz) / DEG,
    mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 },
  };
}

/** Surface of segment k ≥ 24 is `slide` (turn 3 gets faster); the rest is ice. */
const segmentSurface = (k: number): 'ice' | 'slide' => (k >= 24 ? 'slide' : 'ice');
/** Colours alternate per half-turn so speed reads. */
const segmentColor = (k: number): string => (Math.floor(k / 6) % 2 === 0 ? 'primary' : 'secondary');

/** Point on segment `k` at fraction `t`, offset `lateral` metres along the lane's −local-X side. */
export function segmentPoint(k: number, t: number, lateral: number): { x: number; y: number; z: number } {
  const a = spiralVertex(k);
  const b = spiralVertex(k + 1);
  const s = spiralSegment(k);
  const yaw = s.travelYaw * DEG;
  // Left of travel (yaw θ faces (sin θ, cos θ)) is (cos θ, −sin θ) rotated: (cos θ, -sin θ) points right, so negate.
  const lx = -Math.cos(yaw);
  const lz = Math.sin(yaw);
  return {
    x: a.x + (b.x - a.x) * t + lx * lateral,
    y: a.y + (b.y - a.y) * t,
    z: a.z + (b.z - a.z) * t + lz * lateral,
  };
}

/** Whether lateral side `side` (±1, see {@link segmentPoint}) faces the spiral axis on segment k. */
function isInner(k: number, side: number): boolean {
  const p = segmentPoint(k, 0.5, side * 3.75);
  const q = segmentPoint(k, 0.5, -side * 3.75);
  const d = (o: { x: number; z: number }): number => Math.hypot(o.x - SPIRAL_CENTRE.x, o.z - SPIRAL_CENTRE.z);
  return d(p) < d(q);
}

/** Static pieces of the whole spiral lane. */
export function spiralGeometry(): Piece[] {
  const out: Piece[] = [];
  for (let k = 0; k < SPIRAL_VERTICES; k++) {
    const p = spiralVertex(k);
    const exitPad = k === SPIRAL_VERTICES - 1;
    out.push(
      pillar(cm(p.x), cm(p.y), cm(p.z), exitPad ? 5 : 3.5, 1, {
        surface: exitPad ? 'normal' : k >= 24 ? 'slide' : 'ice',
        color: exitPad ? 'safe' : segmentColor(Math.min(k, 29)),
      }),
    );
    if (exitPad) continue;
    // Outer corner post closes the gap between consecutive walls.
    const ox = Math.cos(p.phi);
    const oz = Math.sin(p.phi);
    if (k > 0)
      out.push(cyl(cm(p.x + ox * 3.75), cm(p.y + 1.25), cm(p.z + oz * 3.75), 1, 2.5, { color: 'neutral' }));
  }
  for (let k = 0; k < SPIRAL_VERTICES - 1; k++) {
    const s = spiralSegment(k);
    const uphillYaw = cm(s.travelYaw + 180);
    out.push(
      ramp(cm(s.mid.x), cm(s.mid.y), cm(s.mid.z), LANE_WIDTH, 1.6, cm(s.length + 0.4), {
        rotation: { yaw: uphillYaw },
        surface: segmentSurface(k),
        color: segmentColor(k),
        pattern: k >= 24 ? 'chevron' : 'none',
        bevel: 0.05,
      }),
    );
    // Full-length walls, except that the inner wall is halved next to a pocket so only that half opens.
    const pocket = (v: number): boolean => (POCKET_VERTICES as readonly number[]).includes(v);
    for (const side of [1, -1]) {
      const inner = isInner(k, side);
      const style = {
        rotation: { yaw: cm(s.travelYaw), pitch: cm(s.slopeDeg) },
        color: inner ? 'neutral' : '#9fd4f4',
        bevel: 0.1,
      };
      if (!inner || (!pocket(k) && !pocket(k + 1))) {
        const c = segmentPoint(k, 0.5, side * 3.75);
        out.push(box(cm(c.x), cm(c.y + 1.25), cm(c.z), 0.5, 2.5, cm(s.slopeLength + 0.4), style));
        continue;
      }
      for (const half of [0, 1]) {
        if (pocket(half === 0 ? k : k + 1)) continue;
        const c = segmentPoint(k, half === 0 ? 0.25 : 0.75, side * 3.75);
        out.push(box(cm(c.x), cm(c.y + 1.25), cm(c.z), 0.5, 2.5, cm(s.slopeLength / 2 + 0.25), style));
      }
    }
  }
  for (const k of POCKET_VERTICES) {
    const p = spiralVertex(k);
    out.push(
      pillar(cm(p.x - Math.cos(p.phi) * 4.5), cm(p.y), cm(p.z - Math.sin(p.phi) * 4.5), 3, 1, {
        color: 'safe',
        pattern: 'dots',
      }),
    );
  }
  return out;
}

/** Snowball speed down the tube (m/s) and the gap between balls (s). */
const BALL_SPEED = 11;
const BALL_INTERVAL = 6;

/**
 * The snowball: one `boulderLane` per segment, each pitched down its slope and
 * phased by the cumulative travel time, so a ball handed off at a vertex keeps
 * rolling down the next segment (`boulderLane` only rolls straight).
 */
export function spiralSnowballs(params: Record<string, unknown> = {}): Obstacle[] {
  const out: Obstacle[] = [];
  let t = 0;
  for (let k = 0; k < SPIRAL_VERTICES - 1; k++) {
    const s = spiralSegment(k);
    const a = spiralVertex(k);
    out.push({
      id: `s4-ball-${k}`,
      type: 'boulderLane',
      position: v(cm(a.x), cm(a.y), cm(a.z)),
      rotation: { yaw: cm(s.travelYaw), pitch: cm(s.slopeDeg) },
      params: {
        lanes: 1,
        length: cm(s.slopeLength),
        radius: 1.6,
        speed: BALL_SPEED,
        spawnPeriod: BALL_INTERVAL,
        phase: cm(t),
        dropHeight: k === 0 ? 4 : 0,
        dropTime: k === 0 ? 0.45 : 0.05,
        knockSpeed: 10,
        knockLift: 5,
        ...params,
      },
    });
    t += s.slopeLength / BALL_SPEED;
  }
  return out;
}
