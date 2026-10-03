/**
 * Level-builder kit shared by the group-3 rounds (Tile Panic, Rising Goo
 * Tower, Jump Rope Royale, Last Tumbler Standing, Goo Peak Final).
 *
 * Responsibilities:
 * - Shaped crumble-tile fields. The `fallingTiles` module only builds full
 *   `cols × rows` rectangles, so masked shapes (discs, rings, plus signs,
 *   clipped squares) are emitted as one instance per contiguous run of a
 *   global tile lattice, merging identical consecutive rows into blocks.
 * - Small geometry helpers (polar placement, decorative scatter) and a
 *   deterministic hash for set dressing, so content stays pure data at runtime.
 */
import type { RoundDefinitionInput } from '@tumble/shared';

/** Obstacle instance as authored in round data. */
export type ObstacleInput = NonNullable<RoundDefinitionInput['obstacles']>[number];
/** Static geometry piece as authored. */
export type PieceInput = RoundDefinitionInput['geometry'][number];
/** Bot waypoint as authored. */
export type WaypointInput = NonNullable<RoundDefinitionInput['botNav']>[number];
/** Plain 3-vector. */
export interface V3 {
  x: number;
  y: number;
  z: number;
}

const SQRT3 = Math.sqrt(3);
const DEG = Math.PI / 180;

/** Shorthand vector constructor. */
export const v3 = (x: number, y: number, z: number): V3 => ({ x, y, z });

/**
 * Point on a horizontal circle. Angles follow the LEVELS.md generator
 * convention: `x = r·cos a`, `z = r·sin a`.
 *
 * @param r - Radius (m).
 * @param deg - Angle in degrees.
 * @param y - Height.
 */
export function polar(r: number, deg: number, y = 0): V3 {
  return { x: r * Math.cos(deg * DEG), y, z: r * Math.sin(deg * DEG) };
}

/**
 * Yaw (degrees) that turns an object's local +Z toward the world origin from
 * a point at polar angle `deg` (three.js: local +Z → (sin yaw, cos yaw)).
 */
export function yawTowardCentre(deg: number): number {
  return Math.atan2(-Math.cos(deg * DEG), -Math.sin(deg * DEG)) / DEG;
}

/**
 * Deterministic 0..1 hash of an integer pair, for set-dressing scatter.
 *
 * @example
 * const r = 30 + hash01(seed, i) * 20;
 */
export function hash01(a: number, b: number): number {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x7f4a7c15, 0xc2b2ae35);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/** Options for {@link tileField}. */
export interface TileFieldOptions {
  /** Instance id prefix; ids become `<prefix>-<row>-<run>`. */
  idPrefix: string;
  shape: 'square' | 'hex';
  /** Square: edge length. Hex: flat-to-flat width (the module's convention). */
  tileSize: number;
  gap: number;
  thickness: number;
  /** Shake time before a touched tile drops (module `warnTime`). */
  warnTime: number;
  /** Seconds before a fallen tile returns; 0 = never. */
  respawnTime?: number;
  /**
   * Match time from which tiles react to players. A function lets a field
   * crumble region by region (per emitted instance), approximating the
   * design's timed drops with what the module supports.
   */
  startTime?: number | ((cell: { x: number; z: number; row: number }) => number);
  /** Centre of the field's top surface (world). */
  centre: V3;
  /** Half-size of the lattice scan (m); cells outside are never emitted. */
  extent: number;
  /** Merge identical consecutive rows into one instance (default true). Off when `startTime` varies per row. */
  mergeRows?: boolean;
  /** Lattice cell filter on the cell centre, relative to `centre`. */
  include: (x: number, z: number) => boolean;
}

/** One emitted lattice cell (relative to the field centre). */
export interface TileCell {
  x: number;
  z: number;
  row: number;
  col: number;
}

/** Result of {@link tileField}. */
export interface TileField {
  instances: ObstacleInput[];
  /** Every tile centre, world space (top surface). */
  cells: V3[];
}

/**
 * Builds a masked crumble-tile field from `fallingTiles` instances laid on a
 * shared lattice, so neighbouring instances tile seamlessly.
 *
 * Algorithm: scan lattice rows `−N…N`, keep cells passing `include`, split
 * each row into contiguous runs, then merge runs that repeat on consecutive
 * rows into `cols × rows` blocks (hex blocks only from even rows). O(cells).
 *
 * @returns Instances plus world tile centres (for tests and bot nav).
 * @example
 * tileField({ idPrefix: 'layer-1', shape: 'hex', tileSize: 2.6, gap: 0.08, thickness: 0.5,
 *   warnTime: 1, centre: v3(0, 20, 0), extent: 17, include: (x, z) => Math.hypot(x, z) <= 16 });
 */
export function tileField(o: TileFieldOptions): TileField {
  const px = o.tileSize + o.gap;
  const pz = o.shape === 'hex' ? (px * SQRT3) / 2 : px;
  const nRows = Math.ceil(o.extent / pz);
  const nCols = Math.ceil(o.extent / px) + 1;
  const shiftOf = (row: number): number => (o.shape === 'hex' && ((row % 2) + 2) % 2 === 1 ? 0.5 : 0);

  interface Run {
    row: number;
    c0: number;
    c1: number;
  }
  const runsByRow: Run[][] = [];
  const cells: V3[] = [];
  for (let row = -nRows; row <= nRows; row++) {
    const z = row * pz;
    const shift = shiftOf(row);
    const runs: Run[] = [];
    let open: Run | null = null;
    for (let col = -nCols; col <= nCols; col++) {
      const x = (col + shift) * px;
      const inside = Math.abs(x) <= o.extent + 1e-6 && o.include(x, z);
      if (inside) {
        cells.push(v3(o.centre.x + x, o.centre.y, o.centre.z + z));
        if (open && open.c1 === col - 1) open.c1 = col;
        else runs.push((open = { row, c0: col, c1: col }));
      } else {
        open = null;
      }
    }
    runsByRow.push(runs);
  }

  interface Block {
    r0: number;
    r1: number;
    c0: number;
    c1: number;
  }
  const blocks: Block[] = [];
  {
    // Hex blocks must start on an even lattice row: the module shifts odd local
    // rows by +½ pitch, which matches the global lattice only from an even row.
    const canStart = (row: number): boolean => o.shape === 'square' || ((row % 2) + 2) % 2 === 0;
    let active = new Map<string, Block>();
    for (const runs of runsByRow) {
      const next = new Map<string, Block>();
      for (const run of runs) {
        const key = `${run.c0}:${run.c1}`;
        const b = (o.mergeRows ?? true) ? active.get(key) : undefined;
        if (b && b.r1 === run.row - 1 && canStart(b.r0)) {
          b.r1 = run.row;
          next.set(key, b);
        } else {
          const nb = { r0: run.row, r1: run.row, c0: run.c0, c1: run.c1 };
          blocks.push(nb);
          next.set(key, nb);
        }
      }
      active = next;
    }
  }

  const runIndex = new Map<number, number>();
  const instances: ObstacleInput[] = blocks.map((b) => {
    const k = runIndex.get(b.r0) ?? 0;
    runIndex.set(b.r0, k + 1);
    const rowShift = b.r1 > b.r0 ? (o.shape === 'hex' ? 0.25 : 0) : shiftOf(b.r0);
    const x = ((b.c0 + b.c1) / 2 + rowShift) * px;
    const z = ((b.r0 + b.r1) / 2) * pz;
    const st = typeof o.startTime === 'function' ? o.startTime({ x, z, row: b.r0 }) : (o.startTime ?? 0);
    const params: Record<string, unknown> = {
      shape: o.shape,
      cols: b.c1 - b.c0 + 1,
      rows: b.r1 - b.r0 + 1,
      tileSize: o.tileSize,
      gap: o.gap,
      thickness: o.thickness,
      warnTime: o.warnTime,
      respawnTime: o.respawnTime ?? 0,
      startTime: st,
    };
    return {
      id: `${o.idPrefix}-${b.r0 < 0 ? `m${-b.r0}` : b.r0}-${k}`,
      type: 'fallingTiles',
      position: v3(round3(o.centre.x + x), o.centre.y, round3(o.centre.z + z)),
      params,
    };
  });
  return { instances, cells };
}

/** Options for {@link roamGrid}. */
export interface RoamGridOptions {
  /** First waypoint id; ids are allocated consecutively. */
  idBase: number;
  /** Walking height (top surface) of the layer. */
  y: number;
  /** Grid spacing (m). */
  spacing: number;
  /** Half-size of the scan. */
  extent: number;
  /** Keep a grid point (x, z world). */
  include: (x: number, z: number) => boolean;
  /** Arrival radius. */
  radius?: number;
  /** Seed for neighbour ordering. */
  seed: number;
}

/**
 * A roaming waypoint grid for crumble-floor survivals: every point links to
 * its 4-neighbours, so bots following "the course" random-walk the whole layer
 * instead of camping one spot (standing still on crumble tiles is fatal).
 * Neighbour order is hashed so greedy bots (who always take `next[0]` on a
 * goal-less cyclic graph) still fan out, and alternate points carry `jump`
 * so bots hop seams the way players save tiles.
 *
 * @returns Waypoints with ids `idBase…`.
 */
export function roamGrid(o: RoamGridOptions): WaypointInput[] {
  const n = Math.floor(o.extent / o.spacing);
  const idAt = new Map<string, number>();
  const pts: { i: number; j: number; x: number; z: number }[] = [];
  for (let j = -n; j <= n; j++) {
    for (let i = -n; i <= n; i++) {
      const x = i * o.spacing;
      const z = j * o.spacing;
      if (!o.include(x, z)) continue;
      idAt.set(`${i}:${j}`, o.idBase + pts.length);
      pts.push({ i, j, x, z });
    }
  }
  const dirs: [number, number][] = [
    [1, 0],
    [0, 1],
    [-1, 0],
    [0, -1],
  ];
  return pts.map((p, k) => {
    const next: number[] = [];
    const rot = Math.floor(hash01(o.seed, k) * 4);
    for (let d = 0; d < 4; d++) {
      const [di, dj] = dirs[(d + rot) % 4] as [number, number];
      const id = idAt.get(`${p.i + di}:${p.j + dj}`);
      if (id !== undefined) next.push(id);
    }
    return {
      id: o.idBase + k,
      position: v3(round3(p.x), o.y, round3(p.z)),
      radius: o.radius ?? 1.8,
      next,
      action: (p.i + p.j) % 2 === 0 ? 'jump' : 'run',
    };
  });
}

/**
 * Same param override for every instance id — variations address the
 * generated tile instances one by one.
 */
export function overrideAll(
  instances: readonly ObstacleInput[],
  params: Record<string, unknown>,
): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const i of instances) out[i.id] = { ...params };
  return out;
}

/** Rounds to millimetres so generated data reads cleanly in diffs and dumps. */
export function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Rounds every component of a vector to millimetres. */
export function r3(v: V3): V3 {
  return { x: round3(v.x), y: round3(v.y), z: round3(v.z) };
}
