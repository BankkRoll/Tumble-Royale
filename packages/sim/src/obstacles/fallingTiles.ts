/**
 * Falling Tiles — a square or hex grid of tiles. A tile that a player stands
 * on shakes (`tileWarn`), then drops after `warnTime` (`tileFell`) and may
 * respawn. Standing is detected geometrically from actor positions each step
 * (plus contact routing), so it works identically on server and client.
 * Per-tile state replicates as one compact int per tile.
 */
import { z } from 'zod';
import type { Collider } from '@dimforge/rapier3d-compat';
import { SIM_DT, vec3, type Vec3 } from '@tumble/shared';
import { ObstacleGroups, RuntimeBase, actorLocal, toLocalPoint, toWorldPoint } from './helpers-a.ts';
import type {
  ObstacleActor,
  ObstacleBuildContext,
  ObstacleInstance,
  ObstacleModule,
  ObstacleRuntime,
  ObstacleStepContext,
} from './types.ts';

/** Falling tiles parameters. Origin = centre of the grid's top surface. */
export const fallingTilesSchema = z.object({
  shape: z.enum(['square', 'hex']).default('hex'),
  cols: z.number().int().min(1).max(64).default(8),
  rows: z.number().int().min(1).max(64).default(8),
  /** Square: edge length. Hex: flat-to-flat width (m). */
  tileSize: z.number().positive().default(2.2),
  /** Gap between neighbouring tiles (m). */
  gap: z.number().min(0).default(0.14),
  thickness: z.number().positive().default(0.5),
  /** Seconds a tile shakes before dropping. */
  warnTime: z.number().min(0).default(0.9),
  /** Seconds before a fallen tile returns; 0 = never. */
  respawnTime: z.number().min(0).default(0),
  /** Actor centres up to this height above the tile top count as standing (m). */
  standHeight: z.number().positive().default(2.2),
  /** Tiles ignore players before this match time (s) — e.g. during the countdown. */
  startTime: z.number().default(0),
});

/** Validated falling tiles params. */
export type FallingTilesParams = z.output<typeof fallingTilesSchema>;

/** Tile lifecycle states (wire values). */
export const TileState = { Idle: 0, Warning: 1, Fallen: 2 } as const;

/** Runtime state the visual reads (zero-allocation alternative to getNetState). */
export interface FallingTilesView extends ObstacleRuntime {
  readonly tileCount: number;
  /** {@link TileState} per tile. */
  readonly tileState: Uint8Array;
  /** Match time each tile entered its current state. */
  readonly tileTime: Float32Array;
}

/** Total tiles in the grid. */
export const fallingTileCount = (p: FallingTilesParams): number => p.cols * p.rows;

const SQRT3 = Math.sqrt(3);

/** Centre-to-centre pitch along X (m). */
const pitchX = (p: FallingTilesParams): number => p.tileSize + p.gap;
/** Centre-to-centre pitch along Z (m). */
const pitchZ = (p: FallingTilesParams): number => (p.shape === 'hex' ? (pitchX(p) * SQRT3) / 2 : pitchX(p));

/**
 * Local centre (top surface, y = 0) of tile `i` (row-major).
 *
 * @param i - Tile index.
 * @param p - Params.
 * @param out - Receives the centre.
 */
export function fallingTileCenter(i: number, p: FallingTilesParams, out: Vec3): Vec3 {
  const c = i % p.cols;
  const r = Math.floor(i / p.cols);
  const px = pitchX(p);
  let x = (c - (p.cols - 1) / 2) * px;
  // Hex rows interleave by half a tile; centre the whole field.
  if (p.shape === 'hex') x += ((r & 1) === 1 ? 0.5 : 0) * px - (p.rows > 1 ? 0.25 * px : 0);
  out.x = x;
  out.y = 0;
  out.z = (r - (p.rows - 1) / 2) * pitchZ(p);
  return out;
}

const lookupScratch = vec3();

/**
 * Tile under a local XZ point, or -1.
 */
export function fallingTileAt(x: number, z: number, p: FallingTilesParams): number {
  const pz = pitchZ(p);
  const r0 = Math.round(z / pz + (p.rows - 1) / 2);
  if (p.shape === 'square') {
    const c = Math.round(x / pitchX(p) + (p.cols - 1) / 2);
    if (c < 0 || c >= p.cols || r0 < 0 || r0 >= p.rows) return -1;
    const i = r0 * p.cols + c;
    fallingTileCenter(i, p, lookupScratch);
    const h = p.tileSize / 2 + p.gap / 2;
    return Math.abs(x - lookupScratch.x) <= h && Math.abs(z - lookupScratch.z) <= h ? i : -1;
  }
  // Hex: test the nearest centre in the three candidate rows (Voronoi of a hex grid = the hexes).
  let best = -1;
  let bestD = ((p.tileSize + p.gap) / SQRT3) ** 2;
  for (let r = r0 - 1; r <= r0 + 1; r++) {
    if (r < 0 || r >= p.rows) continue;
    const shift = ((r & 1) === 1 ? 0.5 : 0) - (p.rows > 1 ? 0.25 : 0);
    const c = Math.round(x / pitchX(p) - shift + (p.cols - 1) / 2);
    for (let cc = c - 1; cc <= c + 1; cc++) {
      if (cc < 0 || cc >= p.cols) continue;
      const i = r * p.cols + cc;
      fallingTileCenter(i, p, lookupScratch);
      const d = (x - lookupScratch.x) ** 2 + (z - lookupScratch.z) ** 2;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
  }
  return best;
}

/** Hex prism points (pointy-top, flats facing ±X) for a convex-hull collider. */
function hexHull(p: FallingTilesParams): Float32Array {
  const R = p.tileSize / SQRT3;
  const pts = new Float32Array(36);
  for (let k = 0; k < 6; k++) {
    const a = ((30 + 60 * k) * Math.PI) / 180;
    const x = Math.cos(a) * R;
    const z = Math.sin(a) * R;
    pts.set([x, 0, z, x, -p.thickness, z], k * 6);
  }
  return pts;
}

const MAX_PACKED_TICKS = 16383;

/** Falling tiles runtime. */
export class FallingTilesRuntime extends RuntimeBase implements FallingTilesView {
  readonly tileCount: number;
  readonly tileState: Uint8Array;
  readonly tileTime: Float32Array;
  private readonly tileColliders: Collider[] = [];
  private readonly tileByCollider = new Map<number, number>();
  private readonly local = vec3();

  constructor(
    instance: ObstacleInstance<FallingTilesParams>,
    ctx: ObstacleBuildContext,
    private readonly p: FallingTilesParams,
  ) {
    super(instance, ctx);
    const { R } = ctx;
    this.tileCount = fallingTileCount(p);
    this.tileState = new Uint8Array(this.tileCount);
    this.tileTime = new Float32Array(this.tileCount);
    const body = this.addBody(R.RigidBodyDesc.fixed());
    const hull = p.shape === 'hex' ? hexHull(p) : null;
    const c = vec3();
    for (let i = 0; i < this.tileCount; i++) {
      fallingTileCenter(i, p, c);
      const desc = hull
        ? R.ColliderDesc.convexHull(hull)!.setTranslation(c.x, 0, c.z)
        : R.ColliderDesc.cuboid(p.tileSize / 2, p.thickness / 2, p.tileSize / 2).setTranslation(c.x, -p.thickness / 2, c.z);
      const col = this.addCollider(desc.setFriction(0.8).setCollisionGroups(ObstacleGroups.static), body, { kind: 'normal' });
      this.tileByCollider.set(col.handle, i);
      this.tileColliders.push(col);
    }
  }

  private setState(i: number, state: number, t: number): void {
    this.tileState[i] = state;
    this.tileTime[i] = t;
    this.tileColliders[i]?.setEnabled(state !== TileState.Fallen);
  }

  private warn(i: number, ctx: ObstacleStepContext): void {
    if (this.tileState[i] !== TileState.Idle || ctx.t < this.p.startTime) return;
    this.setState(i, TileState.Warning, ctx.t);
    ctx.events.push({ type: 'tileWarn', obstacle: this.instance.id, tile: i });
    fallingTileCenter(i, this.p, this.local);
    this.cue(ctx.events, 'crack', this.local.x, 0, this.local.z);
  }

  private occupied(i: number, actors: readonly ObstacleActor[]): boolean {
    for (let a = 0; a < actors.length; a++) {
      const l = actorLocal(this.frame, actors[a]!, this.local);
      if (l.y > -0.5 && l.y < this.p.standHeight && fallingTileAt(l.x, l.z, this.p) === i) return true;
    }
    return false;
  }

  update(ctx: ObstacleStepContext): void {
    const p = this.p;
    for (let a = 0; a < ctx.actors.length; a++) {
      const actor = ctx.actors[a]!;
      if (actor.isGhost) continue;
      const l = actorLocal(this.frame, actor, this.local);
      if (l.y < -0.3 || l.y > p.standHeight) continue;
      const i = fallingTileAt(l.x, l.z, p);
      if (i >= 0) this.warn(i, ctx);
    }
    for (let i = 0; i < this.tileCount; i++) {
      const s = this.tileState[i];
      const age = ctx.t - this.tileTime[i]!;
      if (s === TileState.Warning && age >= p.warnTime) {
        this.setState(i, TileState.Fallen, ctx.t);
        ctx.events.push({ type: 'tileFell', obstacle: this.instance.id, tile: i });
        fallingTileCenter(i, p, this.local);
        this.cue(ctx.events, 'fall', this.local.x, 0, this.local.z);
      } else if (s === TileState.Fallen && p.respawnTime > 0 && age >= p.respawnTime && !this.occupied(i, ctx.actors)) {
        this.setState(i, TileState.Idle, ctx.t);
      }
    }
    this.endStep(ctx);
  }

  onContact(actor: ObstacleActor, collider: Collider, ctx: ObstacleStepContext): void {
    const i = this.tileByCollider.get(collider.handle);
    if (i === undefined || actor.isGhost) return;
    const l = actorLocal(this.frame, actor, this.local);
    // Side bumps don't count — only standing on top.
    if (l.y > -0.3) this.warn(i, ctx);
  }

  /**
   * Bot hint: the nearest intact, not-shaking tile to the bot's hint point.
   * On entry `out` holds the asking bot's hint (usually its position nudged
   * toward where it would like to go); tiles that still ignore players
   * (`startTime` not reached) count as closer so the crowd drifts onto them.
   *
   * @returns False when the hint is not on this field's layer or no tile is intact.
   */
  botSafeSpot(t: number, out: Vec3): boolean {
    const p = this.p;
    const l = toLocalPoint(this.frame, out, this.local);
    if (!(l.y > -1.5 && l.y < p.standHeight + 2)) return false;
    const lx = l.x;
    const lz = l.z;
    const dormant = t < p.startTime;
    const pitch = pitchX(p);
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < this.tileCount; i++) {
      if (this.tileState[i] !== TileState.Idle) continue;
      fallingTileCenter(i, p, this.local);
      let d = (this.local.x - lx) ** 2 + (this.local.z - lz) ** 2;
      if (dormant) d *= 0.5;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    // Ten tiles away is another part of the arena, not a safe spot near the bot.
    if (best < 0 || bestD > (10 * pitch) ** 2) return false;
    fallingTileCenter(best, p, this.local);
    toWorldPoint(this.frame, this.local, out);
    return true;
  }

  /** One int per tile: `state | ticksSinceChange << 2` (saturating). */
  getNetState(): number[] {
    const out: number[] = [];
    const now = Number.isNaN(this.lastT) ? 0 : this.lastT;
    for (let i = 0; i < this.tileCount; i++) {
      const ticks = Math.min(MAX_PACKED_TICKS, Math.max(0, Math.round((now - this.tileTime[i]!) / SIM_DT)));
      out.push(this.tileState[i]! | (ticks << 2));
    }
    return out;
  }

  setNetState(state: readonly number[]): void {
    const now = Number.isNaN(this.lastT) ? 0 : this.lastT;
    for (let i = 0; i < this.tileCount; i++) {
      const v = state[i] ?? 0;
      const s = v & 3;
      const t = now - (v >>> 2) * SIM_DT;
      if (s !== this.tileState[i]) this.setState(i, s, t);
      else this.tileTime[i] = t;
    }
  }
}

/** Falling tiles obstacle module. */
export const fallingTiles: ObstacleModule<FallingTilesParams> = {
  type: 'fallingTiles',
  displayName: 'Crumble Tiles',
  schema: fallingTilesSchema,
  create: (instance, ctx) => new FallingTilesRuntime(instance, ctx, fallingTilesSchema.parse(instance.params)),
  audioCues: ['crack', 'fall'],
};
