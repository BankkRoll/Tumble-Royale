/**
 * Paint Grid — the floor of a team painting round, as a grid of cells that
 * remember which team painted them last.
 *
 * Responsibilities:
 * - Painting: a grounded Tumbler paints the cell under its capsule centre in
 *   its team colour every step; landing a dive paints a splash block; holding
 *   a paint-bucket power-up paints a three-cell-wide swath.
 * - Rinse arms: a pure-f(t) rotating rinse (water curtain at a harmless
 *   height) washes the cells under each arm back to neutral.
 * - Paint buckets: touch pickups that grant the super-roller for a while, then
 *   reappear after a cooldown.
 * - Scoring: painted value per team (raised stage cells count extra) is held
 *   as a live level, exposed through `addTeamScores` for team rules.
 * - Replication: per-cell team indices packed 3 bits per cell, plus bucket and
 *   power-up timers.
 * - Bot hint: `botSafeSpot` spreads painters over the most neutral blocks.
 *
 * Teams come from the actor (`team`, duck-typed: the match sim's actors expose
 * it; foreign actors without a team never paint).
 */
import { SIM_DT, vec3, type Vec3 } from '@tumble/shared';
import { z } from 'zod';
import { CharacterState } from '../character/types.ts';
import { RuntimeBase, actorLocal, toWorldPoint } from './helpers-a.ts';
import type {
  ObstacleActor,
  ObstacleBuildContext,
  ObstacleInstance,
  ObstacleModule,
  ObstacleStepContext,
} from './types.ts';

const Rect = z.object({
  x: z.number(),
  z: z.number(),
  sizeX: z.number().positive(),
  sizeZ: z.number().positive(),
});

/** Paint Grid parameters. Metres, seconds, rad/s. Origin = centre of the grid at floor height. */
export const PaintGridSchema = z.object({
  cols: z.number().int().min(1).max(64).default(24),
  rows: z.number().int().min(1).max(64).default(24),
  /** Cell edge (m). */
  cellSize: z.number().positive().default(2),
  /** Teams that can paint (cells store 0…teams-1). */
  teams: z.number().int().min(2).max(4).default(4),
  /** Raised stages: cells whose centre lies inside count `mult`× and sit at `height`. */
  stages: z
    .array(Rect.extend({ height: z.number().default(0), mult: z.number().int().min(1).default(2) }))
    .default([]),
  /** Unpaintable areas (ramps, fountain base). */
  blocked: z.array(Rect).default([]),
  /** Areas painted for a team at the start (corner spawn pads). */
  prepaint: z.array(Rect.extend({ team: z.number().int().min(0).max(3) })).default([]),
  /** Feet within this height of a cell's surface count as standing on it (m). */
  standTolerance: z.number().positive().default(0.6),
  /** Dive-landing splash radius in cells (1 ⇒ 3 × 3). */
  splashRadius: z.number().int().min(0).max(3).default(1),
  /** Rinse arms (0 disables the rinse). */
  rinseArms: z.number().int().min(0).max(4).default(2),
  /** Rinse arm reach from the hub (m). */
  rinseLength: z.number().positive().default(16),
  /** Rinse starts this far out from the hub (m). */
  rinseHubRadius: z.number().min(0).default(3),
  /** Visual arm height (m): the arm itself never touches players. */
  rinseHeight: z.number().positive().default(3.5),
  /** Width of the washed strip under each arm (m). */
  rinseWidth: z.number().positive().default(1.2),
  /** Base angular speed (rad/s, + = counter-clockwise from above). Scaled by speedScale. */
  rinseSpeed: z.number().default(0.45),
  /** Piecewise-linear speed keyframes after t = 0 (rad/s); constant after the last. */
  rinseSchedule: z.array(z.object({ t: z.number().min(0), speed: z.number() })).default([]),
  /** Paint-bucket pickup spots (local). */
  buckets: z.array(z.object({ x: z.number(), z: z.number() })).default([]),
  /** Super-roller duration after grabbing a bucket (s). */
  bucketDuration: z.number().positive().default(6),
  /** Seconds a bucket stays gone after its power-up ends. */
  bucketRespawn: z.number().min(0).default(12),
  /** Horizontal pickup reach around a bucket (m). */
  bucketRadius: z.number().positive().default(1.3),
});

/** Validated Paint Grid parameters. */
export type PaintGridParams = z.output<typeof PaintGridSchema>;

/** Capsule centre to sole for the standard Tumbler capsule. */
const FEET_OFFSET = 0.9;
/** Cells packed per net-state number (base 5: 5^12 stays below the netcode's 2^30 integer range). */
const CELLS_PER_WORD = 12;
/** Bucket timers saturate at ~273 s of match time (14 bits). */
const MAX_TIMER_TICKS = 16383;

/** Total cells. */
export const paintCellCount = (p: PaintGridParams): number => p.cols * p.rows;

/** Local centre (x, z) of cell `i` (row-major, row along +Z). */
export function paintCellCenter(i: number, p: PaintGridParams, out: Vec3): Vec3 {
  const c = i % p.cols;
  const r = Math.floor(i / p.cols);
  out.x = (c - (p.cols - 1) / 2) * p.cellSize;
  out.y = 0;
  out.z = (r - (p.rows - 1) / 2) * p.cellSize;
  return out;
}

/** Cell under a local point, or -1 outside the grid. */
export function paintCellAt(x: number, z: number, p: PaintGridParams): number {
  const c = Math.floor(x / p.cellSize + p.cols / 2);
  const r = Math.floor(z / p.cellSize + p.rows / 2);
  if (c < 0 || c >= p.cols || r < 0 || r >= p.rows) return -1;
  return r * p.cols + c;
}

const inRect = (x: number, z: number, r: { x: number; z: number; sizeX: number; sizeZ: number }): boolean =>
  Math.abs(x - r.x) <= r.sizeX / 2 && Math.abs(z - r.z) <= r.sizeZ / 2;

/** Static per-cell layout: surface height and point value (0 = unpaintable). */
export interface PaintLayout {
  readonly height: Float32Array;
  readonly value: Uint8Array;
}

/** Computes each cell's surface height and value from stages and blocked areas. */
export function paintLayout(p: PaintGridParams): PaintLayout {
  const n = paintCellCount(p);
  const height = new Float32Array(n);
  const value = new Uint8Array(n);
  const c = vec3();
  for (let i = 0; i < n; i++) {
    paintCellCenter(i, p, c);
    value[i] = 1;
    for (const s of p.stages) {
      if (inRect(c.x, c.z, s)) {
        height[i] = s.height;
        value[i] = s.mult;
      }
    }
    for (const b of p.blocked) if (inRect(c.x, c.z, b)) value[i] = 0;
  }
  return { height, value };
}

/**
 * Rinse rotation angle at time t (rad): the closed-form integral of the
 * piecewise-linear speed schedule, so it stays a pure function of time.
 */
export function paintRinseAngle(t: number, p: PaintGridParams, speedScale: number): number {
  if (t <= 0) return p.rinseSpeed * speedScale * t;
  let angle = 0;
  let t0 = 0;
  let w0 = p.rinseSpeed;
  for (const k of p.rinseSchedule) {
    if (k.t <= t0) {
      w0 = k.speed;
      continue;
    }
    const end = Math.min(t, k.t);
    const wEnd = w0 + ((k.speed - w0) * (end - t0)) / (k.t - t0);
    angle += ((w0 + wEnd) / 2) * (end - t0);
    if (t <= k.t) return angle * speedScale;
    t0 = k.t;
    w0 = k.speed;
  }
  return (angle + w0 * (t - t0)) * speedScale;
}

/** Unit XZ direction of rinse arm `k` at `angle` (counter-clockwise seen from above). */
export function paintRinseDir(angle: number, k: number, arms: number, out: Vec3): Vec3 {
  const a = angle + (k / Math.max(1, arms)) * Math.PI * 2;
  out.x = Math.cos(a);
  out.y = 0;
  out.z = -Math.sin(a);
  return out;
}

/** What the visual reads from a live paint grid. */
export interface PaintGridView {
  readonly cellCount: number;
  /** Team per cell, -1 = unpainted. */
  readonly cellOwner: Int8Array;
  /** Match time each cell last changed owner. */
  readonly cellTime: Float32Array;
  /** Match time each bucket is next available. */
  readonly bucketReadyAt: Float32Array;
  /** Painted value per team. */
  readonly teamValue: Float64Array;
}

/** Actor fields the match sim provides beyond {@link ObstacleActor}. */
interface PaintActor extends ObstacleActor {
  readonly team?: number;
  readonly state?: number;
  readonly grounded?: boolean;
}

/** Live paint grid. */
export class PaintGridRuntime extends RuntimeBase implements PaintGridView {
  readonly cellCount: number;
  readonly cellOwner: Int8Array;
  readonly cellTime: Float32Array;
  readonly bucketReadyAt: Float32Array;
  readonly teamValue: Float64Array;
  private readonly layout: PaintLayout;
  /** Actor id → super-roller end time. */
  private readonly rollerUntil = new Map<number, number>();
  /** Actor ids whose current dive already splashed. */
  private readonly splashed = new Map<number, boolean>();
  private readonly cellCenters: Float32Array;
  private readonly local = vec3();
  private readonly dir = vec3();
  private readonly spot = vec3();
  private readonly botEpoch = new Int32Array(6).fill(-1);
  private readonly botCell = new Int32Array(6);

  constructor(
    instance: ObstacleInstance<PaintGridParams>,
    ctx: ObstacleBuildContext,
    readonly params: PaintGridParams,
  ) {
    super(instance, ctx);
    const p = params;
    this.cellCount = paintCellCount(p);
    this.cellOwner = new Int8Array(this.cellCount).fill(-1);
    this.cellTime = new Float32Array(this.cellCount);
    this.bucketReadyAt = new Float32Array(p.buckets.length);
    this.teamValue = new Float64Array(4);
    this.layout = paintLayout(p);
    this.cellCenters = new Float32Array(this.cellCount * 2);
    const c = vec3();
    for (let i = 0; i < this.cellCount; i++) {
      paintCellCenter(i, p, c);
      this.cellCenters[i * 2] = c.x;
      this.cellCenters[i * 2 + 1] = c.z;
      for (const pre of p.prepaint)
        if (pre.team < p.teams && inRect(c.x, c.z, pre)) this.setOwner(i, pre.team, -Infinity);
    }
  }

  private setOwner(i: number, team: number, t: number): void {
    const v = this.layout.value[i]!;
    if (v === 0) return;
    const prev = this.cellOwner[i]!;
    if (prev === team) return;
    if (prev >= 0) this.teamValue[prev] = this.teamValue[prev]! - v;
    if (team >= 0) this.teamValue[team] = this.teamValue[team]! + v;
    this.cellOwner[i] = team;
    this.cellTime[i] = t;
  }

  private paintBlock(ci: number, cr: number, radius: number, team: number, t: number): void {
    const p = this.params;
    for (let r = Math.max(0, cr - radius); r <= Math.min(p.rows - 1, cr + radius); r++) {
      for (let c = Math.max(0, ci - radius); c <= Math.min(p.cols - 1, ci + radius); c++)
        this.setOwner(r * p.cols + c, team, t);
    }
  }

  update(ctx: ObstacleStepContext): void {
    const p = this.params;
    const t = ctx.t;
    if (t >= 0) {
      for (let a = 0; a < ctx.actors.length; a++) this.paintActor(ctx.actors[a] as PaintActor, t, ctx);
      if (p.rinseArms > 0) this.rinse(t);
    }
    this.endStep(ctx);
  }

  private paintActor(actor: PaintActor, t: number, ctx: ObstacleStepContext): void {
    const p = this.params;
    const team = actor.team ?? -1;
    if (actor.isGhost || team < 0 || team >= p.teams) return;
    const l = actorLocal(this.frame, actor, this.local);
    const i = paintCellAt(l.x, l.z, p);
    if (i < 0) return;
    const feet = l.y - FEET_OFFSET - this.layout.height[i]!;
    const onSurface = feet > -p.standTolerance && feet < p.standTolerance;
    const grounded = actor.grounded ?? onSurface;
    const state = actor.state ?? -1;
    const diving = state === CharacterState.Dive || state === CharacterState.DiveSlide;
    if (!diving) this.splashed.set(actor.id, false);
    this.tryBucket(actor, l, t, ctx);
    if (!grounded || !onSurface) return;
    const c = i % p.cols;
    const r = Math.floor(i / p.cols);
    if (diving && !this.splashed.get(actor.id)) {
      this.splashed.set(actor.id, true);
      this.paintBlock(c, r, p.splashRadius, team, t);
      this.cue(
        ctx.events,
        'splash',
        this.cellCenters[i * 2]!,
        this.layout.height[i]!,
        this.cellCenters[i * 2 + 1]!,
      );
      return;
    }
    if ((this.rollerUntil.get(actor.id) ?? -Infinity) > t) {
      // Swath across the direction of travel: the cell plus its two side neighbours.
      const v = actor.body.linvel();
      const alongX = Math.abs(v.x) >= Math.abs(v.z);
      for (let k = -1; k <= 1; k++) {
        const cc = alongX ? c : c + k;
        const rr = alongX ? r + k : r;
        if (cc >= 0 && cc < p.cols && rr >= 0 && rr < p.rows) this.setOwner(rr * p.cols + cc, team, t);
      }
      return;
    }
    this.setOwner(i, team, t);
  }

  private tryBucket(actor: PaintActor, l: Vec3, t: number, ctx: ObstacleStepContext): void {
    const p = this.params;
    for (let b = 0; b < p.buckets.length; b++) {
      if (this.bucketReadyAt[b]! > t) continue;
      const bk = p.buckets[b]!;
      const dx = l.x - bk.x;
      const dz = l.z - bk.z;
      if (dx * dx + dz * dz > p.bucketRadius * p.bucketRadius || l.y > 3) continue;
      this.rollerUntil.set(actor.id, t + p.bucketDuration);
      this.bucketReadyAt[b] = t + p.bucketDuration + p.bucketRespawn;
      this.cue(ctx.events, 'bucket', bk.x, 0.6, bk.z);
      return;
    }
  }

  /** Washes every cell whose centre lies under a rinse arm's strip. */
  private rinse(t: number): void {
    const p = this.params;
    const angle = paintRinseAngle(t, p, this.build.speedScale);
    const half = p.rinseWidth / 2;
    for (let k = 0; k < p.rinseArms; k++) {
      const d = paintRinseDir(angle, k, p.rinseArms, this.dir);
      for (let i = 0; i < this.cellCount; i++) {
        if (this.cellOwner[i]! < 0) continue;
        const x = this.cellCenters[i * 2]!;
        const z = this.cellCenters[i * 2 + 1]!;
        const along = x * d.x + z * d.z;
        if (along < p.rinseHubRadius || along > p.rinseLength) continue;
        if (Math.abs(x * d.z - z * d.x) <= half) this.setOwner(i, -1, t);
      }
    }
  }

  /** Adds painted value per team (team rules read this every step). */
  addTeamScores(out: number[]): void {
    for (let team = 0; team < this.params.teams && team < out.length; team++)
      out[team] = (out[team] ?? 0) + this.teamValue[team]!;
  }

  /**
   * Spreads painters: each bot decision phase (bots think on staggered ticks)
   * gets its own target block, re-picked every few seconds among a handful of
   * seeded candidates, preferring blocks with the most unpainted cells. A free
   * bucket draws one phase's bots to it.
   */
  botSafeSpot(t: number, out: Vec3): boolean {
    const p = this.params;
    const phase = ((Math.round(t / SIM_DT) % 6) + 6) % 6;
    const epoch = Math.floor(t / 3.5);
    if (phase === 0) {
      for (let b = 0; b < p.buckets.length; b++) {
        if (this.bucketReadyAt[b]! > t) continue;
        const bk = p.buckets[(b + epoch) % p.buckets.length]!;
        this.spot.x = bk.x;
        this.spot.y = 0;
        this.spot.z = bk.z;
        toWorldPoint(this.frame, this.spot, out);
        return true;
      }
    }
    if (this.botEpoch[phase] !== epoch) {
      this.botEpoch[phase] = epoch;
      let best = -1;
      let bestScore = -1;
      for (let k = 0; k < 4; k++) {
        const h = hashInt(epoch * 92821 + phase * 6151 + k * 131);
        const cell = h % this.cellCount;
        const score = this.neutralAround(cell);
        if (score > bestScore) {
          bestScore = score;
          best = cell;
        }
      }
      this.botCell[phase] = best;
    }
    const cell = this.botCell[phase]!;
    this.spot.x = this.cellCenters[cell * 2]!;
    this.spot.y = this.layout.height[cell]!;
    this.spot.z = this.cellCenters[cell * 2 + 1]!;
    toWorldPoint(this.frame, this.spot, out);
    return true;
  }

  private neutralAround(cell: number): number {
    const p = this.params;
    const c = cell % p.cols;
    const r = Math.floor(cell / p.cols);
    let n = 0;
    for (let rr = Math.max(0, r - 1); rr <= Math.min(p.rows - 1, r + 1); rr++) {
      for (let cc = Math.max(0, c - 1); cc <= Math.min(p.cols - 1, c + 1); cc++) {
        const i = rr * p.cols + cc;
        if (this.layout.value[i]! > 0 && this.cellOwner[i]! < 0) n += this.layout.value[i]!;
      }
    }
    return n;
  }

  /**
   * `[…owners packed base 5 (12 cells per word), …bucket ready ticks (2 per
   * word, 14 bits each)]`. Fits the netcode's 64-value budget for 576 cells
   * and 8 buckets. Super-roller timers stay server-side: their paint arrives
   * through the cells anyway.
   */
  getNetState(): number[] {
    const out: number[] = [];
    for (let base = 0; base < this.cellCount; base += CELLS_PER_WORD) {
      let w = 0;
      let m = 1;
      for (let k = 0; k < CELLS_PER_WORD && base + k < this.cellCount; k++) {
        w += (this.cellOwner[base + k]! + 1) * m;
        m *= 5;
      }
      out.push(w);
    }
    for (let b = 0; b < this.bucketReadyAt.length; b += 2) {
      const lo = toTicks(this.bucketReadyAt[b]!);
      const hi = b + 1 < this.bucketReadyAt.length ? toTicks(this.bucketReadyAt[b + 1]!) : 0;
      out.push(lo + hi * (MAX_TIMER_TICKS + 1));
    }
    return out;
  }

  setNetState(state: readonly number[]): void {
    const now = Number.isNaN(this.lastT) ? 0 : this.lastT;
    let o = 0;
    for (let base = 0; base < this.cellCount; base += CELLS_PER_WORD) {
      let w = state[o++] ?? 0;
      for (let k = 0; k < CELLS_PER_WORD && base + k < this.cellCount; k++) {
        this.setOwner(base + k, (w % 5) - 1, now);
        w = Math.floor(w / 5);
      }
    }
    for (let b = 0; b < this.bucketReadyAt.length; b += 2) {
      const w = state[o++] ?? 0;
      this.bucketReadyAt[b] = (w % (MAX_TIMER_TICKS + 1)) * SIM_DT;
      if (b + 1 < this.bucketReadyAt.length)
        this.bucketReadyAt[b + 1] = Math.floor(w / (MAX_TIMER_TICKS + 1)) * SIM_DT;
    }
  }
}

function toTicks(t: number): number {
  return Math.max(0, Math.min(MAX_TIMER_TICKS, Math.round(t / SIM_DT)));
}

/** Small integer hash (xorshift-multiply), for seeded candidate picks. */
function hashInt(n: number): number {
  let x = (n ^ 0x9e3779b9) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b) >>> 0;
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35) >>> 0;
  return (x ^ (x >>> 16)) >>> 0;
}

/** Paint Grid obstacle module. */
export const paintGrid: ObstacleModule<PaintGridParams> = {
  type: 'paintGrid',
  displayName: 'Paint Plaza',
  schema: PaintGridSchema,
  create: (instance, ctx) => new PaintGridRuntime(instance, ctx, PaintGridSchema.parse(instance.params)),
  audioCues: ['splash', 'bucket'],
};
