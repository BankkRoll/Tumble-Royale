/**
 * Pattern Board — the memory floor of a logic round: a grid of tiles showing
 * symbols, a big screen naming the safe symbol, and tiles that drop.
 *
 * Responsibilities:
 * - Schedule: a deterministic sequence of *board rounds* (SHOW → HIDE →
 *   DECIDE → DROP → RESTORE). Phase timings are a pure function of time,
 *   params and the stage speed scale; symbol layouts, targets and twists come
 *   from the instance's seeded Rng, so server and clients agree without
 *   sending them.
 * - Rules per board round (teach → memory → two-tile targets → double target
 *   → NOT round → low sweeper → seeded twists), layout generation with the
 *   no-identical-neighbours and not-all-in-one-line constraints.
 * - DROP: every tile outside the safe set shakes, then drops (collider off)
 *   and later rises again. If the drop would leave nobody standing on a safe
 *   tile, that board round is voided and nothing drops.
 * - Sweeper: a low bar sweeping the board during DECIDE from a given board
 *   round on; its pose is pure, so bots can predict and jump it.
 * - Bot hint: `botSafeSpot` names a correct tile (spread over the safe tiles
 *   by bot decision phase); bots apply their own memory accuracy.
 * - Replication: per board round "voided" and "judged" bits.
 */
import type { Collider, RigidBody } from '@dimforge/rapier3d-compat';
import { SIM_DT, quatFromYaw, vec3, type Rng, type Vec3 } from '@tumble/shared';
import { z } from 'zod';
import {
  ActorCooldown,
  KinematicDriver,
  ObstacleGroups,
  RuntimeBase,
  actorLocal,
  createPoseBuffer,
  knockByMotion,
  toWorldPoint,
} from './helpers-a.ts';
import { ensurePoseSamples, writeSample } from './helpers-b.ts';
import type {
  ObstacleActor,
  ObstacleBuildContext,
  ObstacleInstance,
  ObstacleModule,
  ObstacleStepContext,
  PoseSample,
} from './types.ts';

// -----------------------------------------------------------------------------
// Params
// -----------------------------------------------------------------------------

/** Pattern Board parameters. Metres, seconds, rad/s. Origin = centre of the board's top surface. */
export const PatternBoardSchema = z.object({
  cols: z.number().int().min(2).max(6).default(4),
  rows: z.number().int().min(2).max(6).default(4),
  tileSize: z.number().positive().default(6),
  gap: z.number().min(0).default(1),
  thickness: z.number().positive().default(0.8),
  /** Fill the gaps with walkable seam strips that drop with their tiles (no fall-throughs between reveals). */
  solidSeams: z.boolean().default(true),
  /** Seam tops sit this far below the tile tops (m): a free step, but a visible channel. */
  seamDepth: z.number().min(0).default(0.08),
  /** Match time of the first SHOW (s). */
  startTime: z.number().default(0.5),
  /** Board round number the show starts at (later rounds = harder timings). */
  startRound: z.number().int().min(1).default(1),
  /** When > 0: SHOW lasts this long from board round 2 on (memory marathon). */
  showFlat: z.number().min(0).default(0),
  /** From this board round on, the layout shifts one column during HIDE (0 = never). */
  shiftFrom: z.number().int().min(0).default(0),
  /** Wrong tiles shake this long before dropping (s). */
  shakeTime: z.number().positive().default(0.6),
  /** Dropped tiles stay down this long (s). */
  downTime: z.number().positive().default(1.9),
  /** Tiles take this long to rise back (s). */
  riseTime: z.number().positive().default(0.6),
  /** Visual fall distance (m). */
  fallDepth: z.number().positive().default(12),
  /** Floors for stage-scaled phases (s). */
  minShow: z.number().positive().default(1.5),
  minDecide: z.number().positive().default(3),
  /** First board round with the sweeper bar (0 = never). */
  sweeperFrom: z.number().int().min(0).default(7),
  sweeperLength: z.number().positive().default(14.5),
  sweeperHeight: z.number().default(0.55),
  sweeperRadius: z.number().positive().default(0.3),
  /** Angular speed (rad/s). Scaled by speedScale. */
  sweeperSpeed: z.number().default(1.6),
  /** Height the bar parks at between sweeps (harmless, m). */
  sweeperParkHeight: z.number().default(6),
  hubRadius: z.number().positive().default(0.6),
  hubHeight: z.number().positive().default(0.9),
  knockSpeed: z.number().min(0).default(6),
  knockLift: z.number().min(0).default(5),
  /** Board rounds pre-generated (the round's hard cap ends the show before these run out). */
  maxRounds: z.number().int().min(1).max(60).default(40),
  /** Big screen centre relative to the origin, and its size (visual). */
  screen: z
    .object({
      x: z.number(),
      y: z.number(),
      z: z.number(),
      width: z.number().positive(),
      height: z.number().positive(),
    })
    .default({ x: 0, y: 12, z: 21.4, width: 22, height: 10.5 }),
});

/** Validated Pattern Board parameters. */
export type PatternBoardParams = z.output<typeof PatternBoardSchema>;

// -----------------------------------------------------------------------------
// Symbols, kinds, phases
// -----------------------------------------------------------------------------

/** The eight symbols, each a distinct shape AND colour. Ids are wire values. */
export const PATTERN_SYMBOLS = ['star', 'heart', 'moon', 'bolt', 'flower', 'drop', 'crown', 'cloud'] as const;

/** Symbol display colours (shape carries the meaning; colour reinforces it). */
export const PATTERN_SYMBOL_COLORS = [
  '#ffd23f',
  '#ff4f8b',
  '#b9a6ff',
  '#ff8a3d',
  '#6ee7a8',
  '#3fa9ff',
  '#ffb8f0',
  '#e8f4ff',
] as const;

/** Board round twist. */
export const PatternKind = { Normal: 0, Double: 1, Not: 2 } as const;

/** Board round phase. */
export const PatternPhase = { Idle: 0, Show: 1, Hide: 2, Decide: 3, Drop: 4, Fallen: 5, Rise: 6 } as const;

/** One pre-generated board round. Times are absolute match seconds. */
export interface BoardRound {
  /** 0-based position in the schedule. */
  readonly index: number;
  /** Board round number used by the rules table (1 = teaching round). */
  readonly number: number;
  readonly kind: number;
  /** Symbol per tile while lit during SHOW. */
  readonly shown: Uint8Array;
  /** Symbol per tile from HIDE on (differs from `shown` when the board shifts). */
  readonly symbols: Uint8Array;
  /** Column shift applied during HIDE (-1, 0, +1). */
  readonly shift: number;
  /** Target symbols (second is -1 unless DOUBLE). */
  readonly targets: readonly [number, number];
  /** Bit i set = tile i is safe. */
  readonly safeMask: number;
  /** Tiles stay lit through DECIDE (teaching round). */
  readonly litDecide: boolean;
  readonly sweeper: boolean;
  readonly start: number;
  readonly hideAt: number;
  readonly decideAt: number;
  readonly dropAt: number;
  readonly fallAt: number;
  readonly riseAt: number;
  readonly end: number;
}

interface PhaseTiming {
  show: number;
  hide: number;
  decide: number;
  litDecide: boolean;
  sweeper: boolean;
}

/** Rules-table timings for a board round number, before stage scaling. */
function baseTiming(n: number, p: PatternBoardParams): PhaseTiming {
  const sweeper = p.sweeperFrom > 0 && n >= p.sweeperFrom;
  let t: PhaseTiming;
  if (n <= 1) t = { show: 2.5, hide: 0, decide: 6, litDecide: true, sweeper };
  else if (n === 2) t = { show: 5, hide: 1, decide: 5, litDecide: false, sweeper };
  else if (n === 3) t = { show: 4, hide: 1, decide: 4.5, litDecide: false, sweeper };
  else if (n === 4) t = { show: 4, hide: 1, decide: 4, litDecide: false, sweeper };
  else if (n === 5) t = { show: 3.5, hide: 1, decide: 4, litDecide: false, sweeper };
  else if (n <= 7) t = { show: 3, hide: 1, decide: 4, litDecide: false, sweeper };
  else
    t = {
      show: Math.max(1.5, 2.5 - 0.25 * (n - 8)),
      hide: 0.75,
      decide: Math.max(3, 3.5 - 0.1 * (n - 8)),
      litDecide: false,
      sweeper,
    };
  if (p.showFlat > 0 && n >= 2) {
    t.show = p.showFlat;
    t.decide += 0.5;
  }
  return t;
}

/** Board round twist for a round number (rounds 8+ pick NOT/DOUBLE on alternate rounds, seeded). */
function kindFor(n: number, rng: Rng): number {
  if (n === 5) return PatternKind.Double;
  if (n === 6) return PatternKind.Not;
  if (n >= 8 && (n - 8) % 2 === 1) return rng.chance(0.5) ? PatternKind.Not : PatternKind.Double;
  return PatternKind.Normal;
}

// -----------------------------------------------------------------------------
// Layout generation
// -----------------------------------------------------------------------------

const CENTRE_TILES_4X4 = [5, 6, 9, 10];

/** Orthogonally adjacent identical pairs in a layout. */
function adjacencyConflicts(sym: Uint8Array, cols: number, rows: number): number {
  let n = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const s = sym[r * cols + c];
      if (c + 1 < cols && sym[r * cols + c + 1] === s) n++;
      if (r + 1 < rows && sym[(r + 1) * cols + c] === s) n++;
    }
  }
  return n;
}

/** Tiles showing `symbol`. */
function tilesOf(sym: Uint8Array, symbol: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < sym.length; i++) if (sym[i] === symbol) out.push(i);
  return out;
}

/** True when every tile of `symbol` lies in one row or one column. */
function inOneLine(sym: Uint8Array, symbol: number, cols: number): boolean {
  const t = tilesOf(sym, symbol);
  if (t.length < 2) return false;
  const row = Math.floor(t[0]! / cols);
  const col = t[0]! % cols;
  return t.every((i) => Math.floor(i / cols) === row) || t.every((i) => i % cols === col);
}

/** Shuffles a symbol multiset into the grid, keeping the layout with the fewest identical neighbours. */
function scatter(
  multiset: number[],
  cols: number,
  rows: number,
  rng: Rng,
  avoid: (sym: Uint8Array) => boolean,
): Uint8Array {
  let best: Uint8Array | null = null;
  let bestCost = Infinity;
  const sym = new Uint8Array(multiset.length);
  for (let tries = 0; tries < 400 && bestCost > 0; tries++) {
    rng.shuffle(multiset);
    sym.set(multiset);
    const cost = adjacencyConflicts(sym, cols, rows) + (avoid(sym) ? 10 : 0);
    if (cost < bestCost) {
      bestCost = cost;
      best = sym.slice();
    }
  }
  return best ?? sym.slice();
}

/** Symbols in play for a round number: 4 (teaching), 6 (round 3) or all 8. */
function symbolsInPlay(n: number, rng: Rng): number[] {
  if (n <= 2) return [0, 1, 2, 3];
  const all = [0, 1, 2, 3, 4, 5, 6, 7];
  if (n === 3)
    return rng
      .shuffle(all)
      .slice(0, 6)
      .sort((a, b) => a - b);
  return all;
}

function pickTarget(candidates: number[], prev: number, rng: Rng): number {
  const pool = candidates.filter((s) => s !== prev);
  return rng.pick(pool.length > 0 ? pool : candidates);
}

/**
 * Generates one board round's layout, targets and safe set.
 *
 * @returns Layout (16 tiles for 4 × 4), the targets and the safe-tile bitmask.
 */
function generateRound(
  n: number,
  kind: number,
  prevTarget: number,
  p: PatternBoardParams,
  rng: Rng,
): { symbols: Uint8Array; targets: [number, number] } {
  const cols = p.cols;
  const rows = p.rows;
  const tiles = cols * rows;
  const play = symbolsInPlay(n, rng);
  let symbols: Uint8Array;
  if (n <= 1) {
    // Teaching round: each symbol owns a quadrant.
    const order = rng.shuffle(play.slice());
    symbols = new Uint8Array(tiles);
    for (let i = 0; i < tiles; i++) {
      const q = (Math.floor(i / cols) >= rows / 2 ? 2 : 0) + (i % cols >= cols / 2 ? 1 : 0);
      symbols[i] = order[q % order.length]!;
    }
    return { symbols, targets: [pickTarget(play, prevTarget, rng), -1] };
  }
  if (n === 2 && cols === 4 && rows === 4) {
    // A permuted Latin square never repeats a symbol in a row or column, so no neighbours match.
    const sp = rng.shuffle(play.slice());
    const rp = rng.shuffle([0, 1, 2, 3]);
    const cp = rng.shuffle([0, 1, 2, 3]);
    symbols = new Uint8Array(tiles);
    for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) symbols[r * 4 + c] = sp[(rp[r]! + cp[c]!) % 4]!;
    return { symbols, targets: [pickTarget(play, prevTarget, rng), -1] };
  }
  const multiset: number[] = [];
  let quads: number[] = [];
  if (n === 3) {
    // Two symbols on 4 tiles, four on 2 tiles.
    quads = rng.shuffle(play.slice()).slice(0, 2);
    for (const s of play) for (let k = 0; k < (quads.includes(s) ? 4 : 2); k++) multiset.push(s);
  } else {
    for (let k = 0; multiset.length < tiles; k++) multiset.push(play[k % play.length]!);
  }
  while (multiset.length < tiles) multiset.push(play[multiset.length % play.length]!);
  multiset.length = tiles;

  // Pick targets first so the layout can avoid putting them in one line.
  let targets: [number, number];
  if (kind === PatternKind.Double) {
    const a = pickTarget(play, prevTarget, rng);
    const b = pickTarget(
      play.filter((s) => s !== a),
      prevTarget,
      rng,
    );
    targets = [a, b];
  } else if (n === 3) {
    const pairs = play.filter((s) => !quads.includes(s));
    targets = [pickTarget(rng.chance(0.7) ? pairs : quads, prevTarget, rng), -1];
  } else {
    targets = [pickTarget(play, prevTarget, rng), -1];
  }
  const lineCheck = n >= 4 && kind !== PatternKind.Not;
  symbols = scatter(
    multiset,
    cols,
    rows,
    rng,
    (sym) => lineCheck && targets.some((t) => t >= 0 && inOneLine(sym, t, cols)),
  );

  if (kind === PatternKind.Not) {
    // NOT rounds use a symbol with a centre tile, so hugging the edge is never the answer.
    const centre = cols === 4 && rows === 4 ? CENTRE_TILES_4X4 : [];
    const withCentre = play.filter(
      (s) => s !== prevTarget && tilesOf(symbols, s).some((i) => centre.includes(i)),
    );
    targets = [withCentre.length > 0 ? rng.pick(withCentre) : pickTarget(play, prevTarget, rng), -1];
  }
  return { symbols, targets };
}

function safeMaskFor(symbols: Uint8Array, kind: number, targets: readonly [number, number]): number {
  let mask = 0;
  for (let i = 0; i < symbols.length; i++) {
    const hit = symbols[i] === targets[0] || (targets[1] >= 0 && symbols[i] === targets[1]);
    if (kind === PatternKind.Not ? !hit : hit) mask |= 1 << i;
  }
  return mask;
}

function shiftColumns(sym: Uint8Array, shift: number, cols: number): Uint8Array {
  if (shift === 0) return sym;
  const out = new Uint8Array(sym.length);
  for (let i = 0; i < sym.length; i++) {
    const r = Math.floor(i / cols);
    const c = i % cols;
    out[r * cols + ((((c + shift) % cols) + cols) % cols)] = sym[i]!;
  }
  return out;
}

/** Phase timings of every board round: pure in (params, speedScale). */
function timeline(p: PatternBoardParams, speedScale: number): (PhaseTiming & { start: number; n: number })[] {
  const s = speedScale > 0 ? speedScale : 1;
  const out: (PhaseTiming & { start: number; n: number })[] = [];
  let t = p.startTime;
  for (let k = 0; k < p.maxRounds; k++) {
    const n = p.startRound + k;
    const b = baseTiming(n, p);
    const show = Math.max(Math.min(p.minShow, b.show), b.show / s);
    const decide = Math.max(Math.min(p.minDecide, b.decide), b.decide / s);
    const hide = b.hide / s;
    out.push({ ...b, show, hide, decide, start: t, n });
    t += show + hide + decide + p.shakeTime + p.downTime + p.riseTime;
  }
  return out;
}

/**
 * Builds the full board-round schedule. Layouts and targets consume `rng` in a
 * fixed order, so the same seed always produces the same show.
 *
 * @param p - Params.
 * @param speedScale - Stage speed scale (divides phase durations, with floors).
 * @param rng - The instance's seeded generator.
 */
export function buildPatternSchedule(p: PatternBoardParams, speedScale: number, rng: Rng): BoardRound[] {
  const out: BoardRound[] = [];
  let prev = -1;
  for (const tl of timeline(p, speedScale)) {
    const kind = kindFor(tl.n, rng);
    const { symbols, targets } = generateRound(tl.n, kind, prev, p, rng);
    const shift = p.shiftFrom > 0 && tl.n >= p.shiftFrom ? (rng.chance(0.5) ? 1 : -1) : 0;
    const after = shiftColumns(symbols, shift, p.cols);
    const hideAt = tl.start + tl.show;
    const decideAt = hideAt + tl.hide;
    const dropAt = decideAt + tl.decide;
    const fallAt = dropAt + p.shakeTime;
    const riseAt = fallAt + p.downTime;
    out.push({
      index: out.length,
      number: tl.n,
      kind,
      shown: symbols,
      symbols: after,
      shift,
      targets,
      safeMask: safeMaskFor(after, kind, targets),
      litDecide: tl.litDecide,
      sweeper: tl.sweeper,
      start: tl.start,
      hideAt,
      decideAt,
      dropAt,
      fallAt,
      riseAt,
      end: riseAt + p.riseTime,
    });
    prev = targets[0];
  }
  return out;
}

/** Index of the board round running at time t (clamped to the schedule), or -1 before the first. */
export function patternRoundIndexAt(schedule: readonly BoardRound[], t: number): number {
  if (schedule.length === 0 || t < schedule[0]!.start) return -1;
  let lo = 0;
  let hi = schedule.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (schedule[mid]!.start <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Phase of a board round at time t. */
export function patternPhaseOf(r: BoardRound, t: number): number {
  if (t < r.start) return PatternPhase.Idle;
  if (t < r.hideAt) return PatternPhase.Show;
  if (t < r.decideAt) return PatternPhase.Hide;
  if (t < r.dropAt) return PatternPhase.Decide;
  if (t < r.fallAt) return PatternPhase.Drop;
  if (t < r.riseAt) return PatternPhase.Fallen;
  if (t < r.end) return PatternPhase.Rise;
  return PatternPhase.Idle;
}

/** The grid layout fields shared by every tile-board obstacle (pattern board, puzzle floor). */
export type TileGrid = Pick<PatternBoardParams, 'cols' | 'rows' | 'tileSize' | 'gap' | 'solidSeams'>;

/** Local centre (top surface) of tile `i`. */
export function patternTileCenter(i: number, p: TileGrid, out: Vec3): Vec3 {
  const pitch = p.tileSize + p.gap;
  out.x = ((i % p.cols) - (p.cols - 1) / 2) * pitch;
  out.y = 0;
  out.z = (Math.floor(i / p.cols) - (p.rows - 1) / 2) * pitch;
  return out;
}

/** Tile under a local point (on the tile itself, not the gaps), or -1. */
export function patternTileAt(x: number, z: number, p: TileGrid): number {
  const pitch = p.tileSize + p.gap;
  const c = Math.round(x / pitch + (p.cols - 1) / 2);
  const r = Math.round(z / pitch + (p.rows - 1) / 2);
  if (c < 0 || c >= p.cols || r < 0 || r >= p.rows) return -1;
  const cx = (c - (p.cols - 1) / 2) * pitch;
  const cz = (r - (p.rows - 1) / 2) * pitch;
  const h = p.tileSize / 2;
  return Math.abs(x - cx) <= h && Math.abs(z - cz) <= h ? r * p.cols + c : -1;
}

/** A walkable seam strip between tiles; it exists only while every tile it touches is up. */
export interface PatternSeam {
  /** Local centre x/z and full extents. */
  x: number;
  z: number;
  sizeX: number;
  sizeZ: number;
  /** Tiles this seam joins. */
  tiles: number[];
}

/**
 * The seam strips filling the gaps between tiles (edges and crossings), so
 * the board reads as one floor until tiles drop. Empty when seams are off.
 */
export function patternSeams(p: TileGrid): PatternSeam[] {
  if (!p.solidSeams || p.gap <= 0) return [];
  const pitch = p.tileSize + p.gap;
  const cx = (c: number): number => (c - (p.cols - 1) / 2) * pitch;
  const cz = (r: number): number => (r - (p.rows - 1) / 2) * pitch;
  const out: PatternSeam[] = [];
  for (let r = 0; r < p.rows; r++) {
    for (let c = 0; c < p.cols; c++) {
      const i = r * p.cols + c;
      if (c + 1 < p.cols)
        out.push({ x: cx(c) + pitch / 2, z: cz(r), sizeX: p.gap, sizeZ: p.tileSize, tiles: [i, i + 1] });
      if (r + 1 < p.rows)
        out.push({ x: cx(c), z: cz(r) + pitch / 2, sizeX: p.tileSize, sizeZ: p.gap, tiles: [i, i + p.cols] });
      if (c + 1 < p.cols && r + 1 < p.rows) {
        out.push({
          x: cx(c) + pitch / 2,
          z: cz(r) + pitch / 2,
          sizeX: p.gap,
          sizeZ: p.gap,
          tiles: [i, i + 1, i + p.cols, i + p.cols + 1],
        });
      }
    }
  }
  return out;
}
// -----------------------------------------------------------------------------
// Sweeper pose (pure)
// -----------------------------------------------------------------------------

const timelineCache = new WeakMap<PatternBoardParams, Map<number, ReturnType<typeof timeline>>>();

function cachedTimeline(p: PatternBoardParams, speedScale: number): ReturnType<typeof timeline> {
  let bySpeed = timelineCache.get(p);
  if (!bySpeed) timelineCache.set(p, (bySpeed = new Map()));
  let tl = bySpeed.get(speedScale);
  if (!tl) bySpeed.set(speedScale, (tl = timeline(p, speedScale)));
  return tl;
}

const smooth = (x: number): number => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
const sweepQ = { x: 0, y: 0, z: 0, w: 1 };

/**
 * Pure sweeper pose: one sample, the bar (local +X from the hub) at height
 * h(t) rotated by its sweep angle. Parked high (harmless) outside DECIDE of
 * sweeper rounds, lowering and lifting over 0.6 s at the window edges.
 */
export function patternBoardPose(
  t: number,
  p: PatternBoardParams,
  out: PoseSample[],
  speedScale: number,
): void {
  ensurePoseSamples(out, 1);
  const tl = cachedTimeline(p, speedScale);
  let h = p.sweeperParkHeight;
  let angle = 0;
  if (tl.length > 0 && t >= tl[0]!.start) {
    let k = 0;
    while (k + 1 < tl.length && tl[k + 1]!.start <= t) k++;
    const r = tl[k]!;
    const decideAt = r.start + r.show + r.hide;
    const dropAt = decideAt + r.decide;
    angle = p.sweeperSpeed * speedScale * (t - decideAt) + k * 1.3;
    if (r.sweeper) {
      const lower = smooth(Math.min((t - decideAt + 0.6) / 0.6, (dropAt - t) / 0.6));
      h = p.sweeperParkHeight + (p.sweeperHeight - p.sweeperParkHeight) * lower;
    }
  }
  quatFromYaw(angle, sweepQ);
  writeSample(out[0] as PoseSample, 0, h, 0, sweepQ);
}

// -----------------------------------------------------------------------------
// Runtime
// -----------------------------------------------------------------------------

/** What the visual reads from a live board. */
export interface PatternBoardView {
  readonly schedule: readonly BoardRound[];
  /** Whether board round `index` was voided (nobody would have survived). */
  isVoided(index: number): boolean;
  /** Whether board round `index` has been judged (its DROP began). */
  isJudged(index: number): boolean;
}

const WORD_BITS = 30;

/** Live pattern board. */
export class PatternBoardRuntime extends RuntimeBase implements PatternBoardView {
  readonly schedule: BoardRound[];
  private readonly tiles: Collider[] = [];
  private readonly tileEnabled: boolean[] = [];
  private readonly seams: PatternSeam[];
  private readonly seamColliders: Collider[] = [];
  private readonly seamEnabled: boolean[] = [];
  private readonly voided: Uint8Array;
  private readonly judged: Uint8Array;
  private readonly bar: RigidBody;
  private readonly driver: KinematicDriver;
  private readonly poses: PoseSample[] = createPoseBuffer(1);
  private readonly barColliders = new Set<number>();
  private readonly cooldown = new ActorCooldown();
  private readonly local = vec3();
  private readonly spot = vec3();

  constructor(
    instance: ObstacleInstance<PatternBoardParams>,
    ctx: ObstacleBuildContext,
    readonly params: PatternBoardParams,
  ) {
    super(instance, ctx);
    const p = params;
    const { R } = ctx;
    this.schedule = buildPatternSchedule(p, ctx.speedScale, ctx.rng);
    this.voided = new Uint8Array(this.schedule.length);
    this.judged = new Uint8Array(this.schedule.length);
    const board = this.addBody(R.RigidBodyDesc.fixed());
    const c = vec3();
    for (let i = 0; i < p.cols * p.rows; i++) {
      patternTileCenter(i, p, c);
      const col = this.addCollider(
        R.ColliderDesc.cuboid(p.tileSize / 2, p.thickness / 2, p.tileSize / 2)
          .setTranslation(c.x, -p.thickness / 2, c.z)
          .setFriction(0.8)
          .setCollisionGroups(ObstacleGroups.static),
        board,
        { kind: 'normal' },
      );
      this.tiles.push(col);
      this.tileEnabled.push(true);
    }
    this.seams = patternSeams(p);
    for (const s of this.seams) {
      const col = this.addCollider(
        R.ColliderDesc.cuboid(s.sizeX / 2, 0.2, s.sizeZ / 2)
          .setTranslation(s.x, -p.seamDepth - 0.2, s.z)
          .setFriction(0.8)
          .setCollisionGroups(ObstacleGroups.static),
        board,
        { kind: 'normal' },
      );
      this.seamColliders.push(col);
      this.seamEnabled.push(true);
    }
    // Hub post standing in the central gap cross.
    this.addCollider(
      R.ColliderDesc.cylinder((p.hubHeight + 4) / 2, p.hubRadius)
        .setTranslation(0, (p.hubHeight - 4) / 2, 0)
        .setCollisionGroups(ObstacleGroups.static),
      board,
    );
    this.bar = this.addBody(R.RigidBodyDesc.kinematicPositionBased());
    const reach = p.sweeperLength - p.hubRadius;
    const s = Math.SQRT1_2;
    const barCol = this.addCollider(
      R.ColliderDesc.capsule(Math.max(0.05, reach / 2 - p.sweeperRadius), p.sweeperRadius)
        .setTranslation(p.hubRadius + reach / 2, 0, 0)
        // Capsule axis Y → X.
        .setRotation({ x: 0, y: 0, z: -s, w: s })
        .setCollisionGroups(ObstacleGroups.kinematic),
      this.bar,
    );
    this.barColliders.add(barCol.handle);
    this.driver = new KinematicDriver(this.bar, this.frame);
    patternBoardPose(0, p, this.poses, ctx.speedScale);
    this.driver.teleport(this.poses[0]!);
  }

  isVoided(index: number): boolean {
    return this.voided[index] === 1;
  }

  isJudged(index: number): boolean {
    return this.judged[index] === 1;
  }

  /** Board round running at `t`, or null before the first SHOW. */
  roundAt(t: number): BoardRound | null {
    const k = patternRoundIndexAt(this.schedule, t);
    return k >= 0 ? this.schedule[k]! : null;
  }

  update(ctx: ObstacleStepContext): void {
    const t = ctx.t;
    patternBoardPose(t, this.params, this.poses, this.build.speedScale);
    this.driver.drive(this.poses[0]!);
    const r = this.roundAt(t);
    if (r) {
      if (t >= r.dropAt && t < r.end && !this.judged[r.index]) this.judge(r, ctx);
      const down = t >= r.fallAt && t < r.riseAt && !this.voided[r.index];
      for (let i = 0; i < this.tiles.length; i++) this.setTile(i, !(down && (r.safeMask & (1 << i)) === 0));
      for (let k = 0; k < this.seams.length; k++) this.syncSeam(k);
    }
    this.endStep(ctx);
  }

  /** The reveal: decide whether this board round drops or is voided. */
  private judge(r: BoardRound, ctx: ObstacleStepContext): void {
    this.judged[r.index] = 1;
    let onBoard = 0;
    let safe = 0;
    for (let a = 0; a < ctx.actors.length; a++) {
      const actor = ctx.actors[a]!;
      if (actor.isGhost) continue;
      const l = actorLocal(this.frame, actor, this.local);
      // Airborne players are judged by the tile below them.
      if (l.y < -1 || l.y > 8) continue;
      onBoard++;
      const i = patternTileAt(l.x, l.z, this.params);
      if (i >= 0 ? (r.safeMask & (1 << i)) !== 0 : this.onSafeSeam(l.x, l.z, r.safeMask)) safe++;
    }
    if (onBoard > 0 && safe === 0) {
      this.voided[r.index] = 1;
      this.cue(ctx.events, 'void', 0, 1, 0);
    } else {
      this.cue(ctx.events, 'reveal', 0, 1, 0);
    }
  }

  private setTile(i: number, enabled: boolean): void {
    if (this.tileEnabled[i] === enabled) return;
    this.tileEnabled[i] = enabled;
    this.tiles[i]!.setEnabled(enabled);
  }

  /** A seam stands only while every tile it joins is up. */
  private syncSeam(k: number): void {
    const tiles = this.seams[k]!.tiles;
    let up = true;
    for (let j = 0; j < tiles.length; j++) if (!this.tileEnabled[tiles[j]!]) up = false;
    if (this.seamEnabled[k] === up) return;
    this.seamEnabled[k] = up;
    this.seamColliders[k]!.setEnabled(up);
  }

  /** True when a local point lies on a seam whose tiles are all safe (it will not drop). */
  private onSafeSeam(x: number, z: number, safeMask: number): boolean {
    for (const s of this.seams) {
      if (Math.abs(x - s.x) > s.sizeX / 2 || Math.abs(z - s.z) > s.sizeZ / 2) continue;
      let ok = true;
      for (const i of s.tiles) if ((safeMask & (1 << i)) === 0) ok = false;
      return ok;
    }
    return false;
  }

  onContact(actor: ObstacleActor, collider: Collider, ctx: ObstacleStepContext): void {
    if (!this.barColliders.has(collider.handle) || actor.isGhost) return;
    if (!this.cooldown.ready(actor.id, ctx.t, 0.5)) return;
    knockByMotion(actor, this.bar, {
      speed: this.params.knockSpeed,
      lift: this.params.knockLift,
      stun: false,
    });
    this.cue(ctx.events, 'trip', 0, this.params.sweeperHeight, 0);
  }

  /**
   * A tile to stand on. With the target known (DECIDE and after) it is a safe
   * tile; before that, a spread-out waiting tile. Bots think on staggered
   * ticks, so the tick phase spreads them over the candidates.
   */
  botSafeSpot(t: number, out: Vec3): boolean {
    const r = this.roundAt(t);
    if (!r) return false;
    const phase = ((Math.round(t / SIM_DT) % 6) + 6) % 6;
    const tiles = this.params.cols * this.params.rows;
    let tile: number;
    if (t >= r.decideAt) {
      let n = 0;
      for (let i = 0; i < tiles; i++) if (r.safeMask & (1 << i)) n++;
      if (n === 0) return false;
      let pick = (phase * 5 + r.index) % n;
      tile = 0;
      for (let i = 0; i < tiles; i++) {
        if ((r.safeMask & (1 << i)) === 0) continue;
        if (pick-- === 0) {
          tile = i;
          break;
        }
      }
    } else {
      tile = (phase * 5 + r.index * 3 + 1) % tiles;
    }
    patternTileCenter(tile, this.params, this.spot);
    // Pull outer tiles 2 m toward the middle: a bot that misremembers wanders ±4 m from here and
    // should land on a wrong tile, not walk off the board edge.
    this.spot.x -= Math.sign(this.spot.x) * Math.min(2, Math.max(0, Math.abs(this.spot.x) - 4));
    this.spot.z -= Math.sign(this.spot.z) * Math.min(2, Math.max(0, Math.abs(this.spot.z) - 4));
    toWorldPoint(this.frame, this.spot, out);
    return true;
  }

  telegraph(t: number): number {
    const r = this.roundAt(t);
    if (!r || t < r.decideAt || t >= r.dropAt) return 0;
    return Math.min(1, (t - r.decideAt) / Math.max(0.01, r.dropAt - r.decideAt));
  }

  /** `[voided bits 0–29, voided bits 30–59, judged bits 0–29, judged bits 30–59]`. */
  getNetState(): number[] {
    return [
      packBits(this.voided, 0),
      packBits(this.voided, WORD_BITS),
      packBits(this.judged, 0),
      packBits(this.judged, WORD_BITS),
    ];
  }

  setNetState(state: readonly number[]): void {
    unpackBits(state[0] ?? 0, this.voided, 0);
    unpackBits(state[1] ?? 0, this.voided, WORD_BITS);
    unpackBits(state[2] ?? 0, this.judged, 0);
    unpackBits(state[3] ?? 0, this.judged, WORD_BITS);
  }
}

function packBits(bits: Uint8Array, from: number): number {
  let w = 0;
  for (let k = 0; k < WORD_BITS && from + k < bits.length; k++) if (bits[from + k]) w |= 1 << k;
  return w;
}

function unpackBits(w: number, bits: Uint8Array, from: number): void {
  for (let k = 0; k < WORD_BITS && from + k < bits.length; k++) bits[from + k] = (w >>> k) & 1;
}

/** Pattern Board obstacle module. */
export const patternBoard: ObstacleModule<PatternBoardParams> = {
  type: 'patternBoard',
  displayName: 'Pattern Panic Board',
  schema: PatternBoardSchema,
  pose: patternBoardPose,
  poseCount: () => 1,
  create: (instance, ctx) =>
    new PatternBoardRuntime(instance, ctx, PatternBoardSchema.parse(instance.params)),
  audioCues: ['reveal', 'void', 'trip'],
};
