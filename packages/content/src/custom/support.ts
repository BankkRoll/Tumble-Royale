/**
 * Walkable-surface model of a round, for the custom round rules that need to
 * know where players can stand: spawn slots on solid ground, a reachable
 * finish, bot legs over solid ground.
 *
 * Pure arithmetic over the round data (no physics engine), so the API, the
 * game servers and the editor all reach the same verdict. Every surface is a
 * footprint (rectangle or disc in X/Z) with the height range of its top.
 * Rotated pieces use their axis-aligned bounds and obstacles of unknown
 * orientation the square around their longest side, so the model errs toward
 * "reachable": a false "unreachable" would block a fair round, a false
 * "reachable" only lets the creator find the problem in Test play.
 */
import {
  quatFromEulerYXZ,
  rotateVec,
  type RoundDefinition,
  type StaticPiece,
  type Vec3,
} from '@tumble/shared';

const DEG = Math.PI / 180;
const GRAVITY = 24;

/** Movement envelope from LEVELS.md §0, with the dive and grab-climb allowances. */
export const MOVEMENT = {
  /** Highest ledge a jump or grab-climb gets onto (m). */
  climb: 2.6,
  /** Longest gap with a running jump and dive, landing level (m). */
  gap: 6.5,
  /** Gap shrinks by this per metre of rise. */
  gapPerRise: 1,
  /** Gap grows by this per metre of drop. */
  gapPerDrop: 0.8,
  /** Longest gap however far the drop. */
  maxGap: 9,
} as const;

/** Which part of the round a surface came from (for messages that point at it). */
export type SurfaceSource =
  { kind: 'geometry'; index: number } | { kind: 'obstacle'; id: string } | { kind: 'teleport'; id: string };

/** A walkable surface. */
export interface Surface {
  source: SurfaceSource;
  /** Disc footprint (cylinders, discs) or rectangle. */
  shape: 'rect' | 'disc';
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  /** Disc centre and radius (`shape === 'disc'`). */
  cx: number;
  cz: number;
  r: number;
  /** Lowest and highest point of the top surface (equal for flat floors). */
  yMin: number;
  yMax: number;
  /** Extra height a launch from here adds (bounce pads, bouncy pieces). */
  boost: number;
  /** Teleport destinations reached from this surface (indices into the surface list). */
  links: number[];
}

function rectSurface(
  source: SurfaceSource,
  cx: number,
  cz: number,
  hx: number,
  hz: number,
  yMin: number,
  yMax: number,
  boost = 0,
): Surface {
  return {
    source,
    shape: 'rect',
    minX: cx - hx,
    maxX: cx + hx,
    minZ: cz - hz,
    maxZ: cz + hz,
    cx,
    cz,
    r: Math.max(hx, hz),
    yMin: Math.min(yMin, yMax),
    yMax: Math.max(yMin, yMax),
    boost,
    links: [],
  };
}

function discSurface(
  source: SurfaceSource,
  cx: number,
  cz: number,
  r: number,
  y: number,
  boost = 0,
): Surface {
  return { ...rectSurface(source, cx, cz, r, r, y, y, boost), shape: 'disc', r };
}

/** World AABB half extents of a box with local half extents `h` rotated by yaw/pitch/roll (degrees). */
function rotatedHalf(h: Vec3, rot: StaticPiece['rotation']): Vec3 {
  const yaw = rot?.yaw ?? 0;
  const pitch = rot?.pitch ?? 0;
  const roll = rot?.roll ?? 0;
  if (yaw === 0 && pitch === 0 && roll === 0) return h;
  const q = quatFromEulerYXZ(yaw * DEG, pitch * DEG, roll * DEG);
  const axes = [
    rotateVec(q, { x: h.x, y: 0, z: 0 }),
    rotateVec(q, { x: 0, y: h.y, z: 0 }),
    rotateVec(q, { x: 0, y: 0, z: h.z }),
  ];
  return {
    x: axes.reduce((s, a) => s + Math.abs(a.x), 0),
    y: axes.reduce((s, a) => s + Math.abs(a.y), 0),
    z: axes.reduce((s, a) => s + Math.abs(a.z), 0),
  };
}

/** True when the rotation keeps a piece's top facing up (no pitch or roll worth a slope). */
const level = (rot: StaticPiece['rotation']): boolean =>
  Math.abs(rot?.pitch ?? 0) < 1 && Math.abs(rot?.roll ?? 0) < 1;

/**
 * Walkable surface of a static piece, or null for decorative pieces and shapes
 * nobody stands on (spheres, tori, arches).
 *
 * @param piece - Validated piece.
 * @param index - Its index in `geometry`.
 */
export function pieceSurface(piece: StaticPiece, index: number): Surface | null {
  if (piece.decorative) return null;
  const src: SurfaceSource = { kind: 'geometry', index };
  const p = piece.position;
  const s = piece.size;
  const boost = piece.surface === 'bouncy' ? 4 : 0;
  switch (piece.shape) {
    case 'box':
    case 'ramp':
    case 'wedge': {
      const h = rotatedHalf({ x: s.x / 2, y: s.y / 2, z: s.z / 2 }, piece.rotation);
      const top = p.y + h.y;
      const sloped = piece.shape !== 'box' || !level(piece.rotation);
      return rectSurface(src, p.x, p.z, h.x, h.z, sloped ? p.y - h.y : top, top, boost);
    }
    case 'cylinder':
    case 'hexPrism': {
      if (level(piece.rotation)) return discSurface(src, p.x, p.z, s.x, p.y + s.y / 2, boost);
      const h = rotatedHalf({ x: s.x, y: s.y / 2, z: s.x }, piece.rotation);
      return rectSurface(src, p.x, p.z, h.x, h.z, p.y + h.y, p.y + h.y, boost);
    }
    default:
      return null;
  }
}

/** Instance placement as the obstacle modules read it. */
interface PlacedObstacle {
  id: string;
  type: string;
  position: Vec3;
  rotation?: { yaw?: number; pitch?: number; roll?: number } | undefined;
}

const n = (p: Record<string, unknown>, key: string, fallback: number): number => {
  const v = p[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
};

const pointsOf = (v: unknown): Vec3[] =>
  Array.isArray(v)
    ? v.filter(
        (x): x is Vec3 =>
          typeof x === 'object' &&
          x !== null &&
          typeof (x as Vec3).x === 'number' &&
          typeof (x as Vec3).y === 'number' &&
          typeof (x as Vec3).z === 'number',
      )
    : [];

/** Rectangle of local extents (hx along local X, hz along local Z) rotated by the instance yaw. */
function yawRect(o: PlacedObstacle, hx: number, hz: number, yMin: number, yMax: number, boost = 0): Surface {
  const yaw = (o.rotation?.yaw ?? 0) * DEG;
  const c = Math.abs(Math.cos(yaw));
  const s = Math.abs(Math.sin(yaw));
  return rectSurface(
    { kind: 'obstacle', id: o.id },
    o.position.x,
    o.position.z,
    hx * c + hz * s,
    hx * s + hz * c,
    yMin,
    yMax,
    boost,
  );
}

/**
 * Walkable surfaces an obstacle adds (LEVELS.md §2: platform-like modules sit
 * with `position` at the centre of their top surface).
 *
 * @param o - Placed obstacle.
 * @param params - Its params with defaults applied.
 * @returns Zero or more surfaces; the first is the obstacle's own.
 */
export function obstacleSurfaces(o: PlacedObstacle, params: Record<string, unknown>): Surface[] {
  const y = o.position.y;
  const src: SurfaceSource = { kind: 'obstacle', id: o.id };
  switch (o.type) {
    case 'iceFloor':
    case 'stickyGoo':
    case 'tiltPlatform': {
      const shape = params.shape;
      if (shape === 'disc' || shape === 'hex')
        return [discSurface(src, o.position.x, o.position.z, n(params, 'radius', 5), y)];
      return [yawRect(o, n(params, 'sizeX', 8) / 2, n(params, 'sizeZ', 8) / 2, y, y)];
    }
    case 'conveyorBelt':
      return [yawRect(o, n(params, 'width', 4) / 2, n(params, 'length', 12) / 2, y, y)];
    case 'collapsingBridge': {
      const len = n(params, 'segments', 8) * (n(params, 'segmentLength', 2.5) + n(params, 'gap', 0.08));
      return [yawRect(o, n(params, 'width', 3.2) / 2, len / 2, y, y)];
    }
    case 'seesaw': {
      const half = n(params, 'length', 10) / 2;
      const tilt = Math.sin(n(params, 'maxTiltDeg', 18) * DEG) * half;
      return [yawRect(o, half, n(params, 'width', 3) / 2, y - tilt, y + tilt)];
    }
    case 'fallingTiles':
    case 'popupBlocks':
    case 'patternBoard':
    case 'puzzleFloor': {
      const size = n(params, o.type === 'popupBlocks' ? 'cellSize' : 'tileSize', 2) + n(params, 'gap', 0.1);
      return [yawRect(o, (n(params, 'cols', 5) * size) / 2, (n(params, 'rows', 5) * size) / 2, y, y)];
    }
    case 'spinningDisc':
      return [discSurface(src, o.position.x, o.position.z, n(params, 'radius', 6), y)];
    case 'rollingDrum': {
      const r = n(params, 'radius', 2.2);
      return [yawRect(o, n(params, 'length', 10) / 2, r, y + r, y + r)];
    }
    case 'slideRamp': {
      const len = n(params, 'length', 18);
      const drop = Math.sin(n(params, 'angle', 18) * DEG) * len;
      const half = Math.max(len, n(params, 'width', 6)) / 2;
      return [rectSurface(src, o.position.x, o.position.z, half * 2, half * 2, y - drop, y)];
    }
    case 'climbWall': {
      const w = n(params, 'width', 6) / 2;
      return [yawRect(o, w, n(params, 'thickness', 0.8) / 2 + 1, y, y + n(params, 'height', 8))];
    }
    case 'bouncePad': {
      const launch = params.launch as Vec3 | undefined;
      const up = typeof launch?.y === 'number' ? Math.max(0, launch.y) : 18;
      const along = Math.hypot(launch?.x ?? 0, launch?.z ?? 4);
      return [
        discSurface(
          src,
          o.position.x,
          o.position.z,
          n(params, 'radius', 1.4) + along * (up / GRAVITY),
          y,
          (up * up) / (2 * GRAVITY),
        ),
      ];
    }
    case 'movingPlatform': {
      const size = (params.size as Vec3 | undefined) ?? { x: 4, y: 0.6, z: 4 };
      const pts = pointsOf(params.points);
      const all = pts.length > 0 ? pts : [{ x: 0, y: 0, z: 0 }];
      const xs = all.map((p) => o.position.x + p.x);
      const zs = all.map((p) => o.position.z + p.z);
      const ys = all.map((p) => y + p.y);
      const r = Math.max(size.x, size.z) / 2;
      const x0 = Math.min(...xs);
      const x1 = Math.max(...xs);
      const z0 = Math.min(...zs);
      const z1 = Math.max(...zs);
      return [
        rectSurface(
          src,
          (x0 + x1) / 2,
          (z0 + z1) / 2,
          (x1 - x0) / 2 + r,
          (z1 - z0) / 2 + r,
          Math.min(...ys),
          Math.max(...ys),
        ),
      ];
    }
    case 'teleporterPair': {
      const pad = discSurface(src, o.position.x, o.position.z, n(params, 'padRadius', 1.2), y);
      const exits = pointsOf(params.exits).map((e) =>
        discSurface(
          { kind: 'teleport', id: o.id },
          o.position.x + e.x,
          o.position.z + e.z,
          n(params, 'padRadius', 1.2),
          y + e.y,
        ),
      );
      return [pad, ...exits];
    }
    default:
      return [];
  }
}

/** Every walkable surface of a round, with teleport links resolved. */
export function walkableSurfaces(
  round: RoundDefinition,
  paramsOf: (o: RoundDefinition['obstacles'][number]) => Record<string, unknown>,
): Surface[] {
  const out: Surface[] = [];
  round.geometry.forEach((piece, i) => {
    const s = pieceSurface(piece, i);
    if (s) out.push(s);
  });
  for (const o of round.obstacles) {
    const list = obstacleSurfaces(o, paramsOf(o));
    const first = out.length;
    out.push(...list);
    if (o.type === 'teleporterPair' && list.length > 1) {
      const twoWay = paramsOf(o).twoWay === true;
      for (let k = 1; k < list.length; k++) {
        out[first]!.links.push(first + k);
        if (twoWay) out[first + k]!.links.push(first);
      }
    }
  }
  return out;
}

/** True when the X/Z point lies on the surface's footprint. */
export function footprintContains(s: Surface, x: number, z: number, pad = 0): boolean {
  if (s.shape === 'disc') return Math.hypot(x - s.cx, z - s.cz) <= s.r + pad;
  return x >= s.minX - pad && x <= s.maxX + pad && z >= s.minZ - pad && z <= s.maxZ + pad;
}

/** Edge-to-edge horizontal distance between two footprints (0 when they overlap). */
export function footprintGap(a: Surface, b: Surface): number {
  if (a.shape === 'disc' && b.shape === 'disc')
    return Math.max(0, Math.hypot(a.cx - b.cx, a.cz - b.cz) - a.r - b.r);
  const dx = Math.max(0, a.minX - b.maxX, b.minX - a.maxX);
  const dz = Math.max(0, a.minZ - b.maxZ, b.minZ - a.maxZ);
  return Math.hypot(dx, dz);
}

/**
 * Surface under a standing point: the highest top within `below` metres under
 * `y` (or up to `above` over it).
 *
 * @returns The surface index, or -1 when the point is over nothing.
 */
export function surfaceUnder(surfaces: readonly Surface[], p: Vec3, below = 1.5, above = 0.6): number {
  let best = -1;
  let bestY = -Infinity;
  surfaces.forEach((s, i) => {
    if (!footprintContains(s, p.x, p.z)) return;
    if (s.yMax < p.y - below || s.yMin > p.y + above) return;
    if (s.yMax > bestY) {
      bestY = s.yMax;
      best = i;
    }
  });
  return best;
}

/** True when a Tumbler on `a` can get onto `b` with a jump, dive, climb or launch. */
export function canReach(a: Surface, b: Surface): boolean {
  const rise = b.yMin - a.yMax;
  if (rise > MOVEMENT.climb + a.boost) return false;
  const gap = footprintGap(a, b);
  const extra = a.boost > 0 ? Math.sqrt(a.boost) * 3 : 0;
  const limit =
    rise > 0
      ? MOVEMENT.gap + extra - MOVEMENT.gapPerRise * Math.max(0, rise - a.boost)
      : Math.min(MOVEMENT.maxGap, MOVEMENT.gap + MOVEMENT.gapPerDrop * -rise) + extra;
  return gap <= Math.max(0, limit);
}

/**
 * Surfaces reachable from the starting ones (breadth-first over {@link canReach}
 * and teleport links).
 *
 * @param surfaces - From {@link walkableSurfaces}.
 * @param start - Indices of the surfaces players start on.
 * @returns A flag per surface.
 */
export function reachableSurfaces(surfaces: readonly Surface[], start: readonly number[]): boolean[] {
  const seen = surfaces.map(() => false);
  const queue = start.filter((i) => i >= 0 && i < surfaces.length);
  for (const i of queue) seen[i] = true;
  for (let q = 0; q < queue.length; q++) {
    const a = surfaces[queue[q]!]!;
    const next = [...a.links];
    surfaces.forEach((b, j) => {
      if (!seen[j] && canReach(a, b)) next.push(j);
    });
    for (const j of next) {
      if (seen[j]) continue;
      seen[j] = true;
      queue.push(j);
    }
  }
  return seen;
}

/** Axis-aligned bounds of a (possibly rotated) trigger volume. */
export function triggerBox(t: RoundDefinition['triggers'][number]): { min: Vec3; max: Vec3 } {
  const h = rotatedHalf({ x: t.size.x / 2, y: t.size.y / 2, z: t.size.z / 2 }, t.rotation);
  return {
    min: { x: t.position.x - h.x, y: t.position.y - h.y, z: t.position.z - h.z },
    max: { x: t.position.x + h.x, y: t.position.y + h.y, z: t.position.z + h.z },
  };
}

/** True when a Tumbler standing on `s` can touch the trigger volume. */
export function surfaceTouches(s: Surface, t: RoundDefinition['triggers'][number]): boolean {
  const box = triggerBox(t);
  const gx = Math.max(0, s.minX - box.max.x, box.min.x - s.maxX);
  const gz = Math.max(0, s.minZ - box.max.z, box.min.z - s.maxZ);
  if (Math.hypot(gx, gz) > 1) return false;
  // Standing (capsule 1.8 m) or jumping (≈ 2 m apex) into it.
  return s.yMax + 3.8 >= box.min.y && s.yMin <= box.max.y;
}

/**
 * Spawn grid positions for `players` (the same grid the sim lays out, without
 * the seeded shuffle, which only reorders who stands where).
 *
 * @param spawn - The round's spawn block.
 * @param players - Seats to place.
 */
export function spawnGrid(spawn: RoundDefinition['spawn'], players: number): Vec3[] {
  const yaw = spawn.yaw * DEG;
  const sin = Math.sin(yaw);
  const cos = Math.cos(yaw);
  const cols = Math.max(1, Math.min(spawn.cols, players));
  const rows = Math.ceil(players / cols);
  const out: Vec3[] = [];
  for (let k = 0; k < players; k++) {
    const c = k % cols;
    const r = Math.floor(k / cols);
    const lx = (c - (cols - 1) / 2) * spawn.spacing;
    const lz = -(r - (rows - 1) / 2) * spawn.spacing;
    out.push({
      x: spawn.origin.x + lx * cos + lz * sin,
      y: spawn.origin.y,
      z: spawn.origin.z - lx * sin + lz * cos,
    });
  }
  return out;
}
