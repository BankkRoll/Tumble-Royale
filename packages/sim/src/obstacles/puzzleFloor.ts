/**
 * Puzzle Floor — the tile board of the two reading-the-floor logic rounds.
 * Every board round the floor shows a puzzle, the screen asks the question,
 * and when the timer ends every tile but the answers drops.
 *
 * Puzzles:
 * - `mix` (Colour Cauldron): tiles are paint colours. The screen shows a sum
 *   ("RED + BLUE") or a difference ("PURPLE − RED"); the safe tiles are the
 *   colour it makes. Primaries carry a shape (red ●, yellow ▲, blue ■) and
 *   mixes carry both parents' shapes, so the sum can be read without colour.
 * - `trail` (Trail Tracer): every tile shows an arrow and a few tiles carry a
 *   start flag. The screen says how many steps to walk; following the arrows
 *   from each flag lands on a safe tile.
 *
 * Responsibilities:
 * - Schedule: a deterministic sequence of board rounds (READ → [RECALL] →
 *   DROP → FALLEN → RISE). Timings are a pure function of params and the
 *   stage speed scale; puzzles come from the instance's seeded Rng, so server
 *   and clients build the same show without sending it.
 * - Escalation per board round: a teaching round (the answer glows near the
 *   end), harder questions, fewer safe tiles, shorter reading time, and
 *   memory rounds where the floor goes blank part-way through. Big fields get
 *   extra answer tiles in the opening rounds ().
 * - DROP: wrong tiles shake, fall (colliders off) and rise again. A drop that
 *   would leave nobody standing on a safe tile is voided.
 * - Bot hint: `botSafeSpot` names a waiting tile until the bots have "solved"
 *   the puzzle (part-way through reading), then a nearby safe tile, with a
 *   place of its own per bot; `botDifficulty` rates the question, and bots
 *   apply their own memory accuracy scaled by it.
 * - Replication: per board round "voided" and "judged" bits.
 */
import type { Collider } from '@dimforge/rapier3d-compat';
import { SIM_DT, vec3, type Rng, type Vec3 } from '@tumble/shared';
import { z } from 'zod';
import { ObstacleGroups, RuntimeBase, actorLocal, toLocalPoint, toWorldPoint } from './helpers-a.ts';
import {
  LOGIC_TEACH_DIFFICULTY,
  nearSafeTile,
  patternSeams,
  patternTileAt,
  patternTileCenter,
  placeOnTile,
  type PatternSeam,
} from './patternBoard.ts';
import type { ObstacleBuildContext, ObstacleInstance, ObstacleModule, ObstacleStepContext } from './types.ts';

// -----------------------------------------------------------------------------
// Params
// -----------------------------------------------------------------------------

/** Puzzle kinds. */
export const PUZZLE_KINDS = ['mix', 'trail'] as const;

/** Puzzle Floor parameters. Metres, seconds. Origin = centre of the board's top surface. */
export const PuzzleFloorSchema = z.object({
  puzzle: z.enum(PUZZLE_KINDS).default('mix'),
  cols: z.number().int().min(3).max(6).default(5),
  rows: z.number().int().min(3).max(6).default(5),
  tileSize: z.number().positive().default(5),
  gap: z.number().min(0).default(0.8),
  thickness: z.number().positive().default(0.8),
  /** Walkable seam strips between tiles that drop with their tiles. */
  solidSeams: z.boolean().default(true),
  /** Seam tops sit this far below the tile tops (m). */
  seamDepth: z.number().min(0).default(0.08),
  /** Match time of the first READ (s). */
  startTime: z.number().default(0.5),
  /** Board round number the show starts at (later rounds = harder). */
  startRound: z.number().int().min(1).default(1),
  /** From this board round on, the floor goes blank part-way through reading (0 = never). */
  memoryFrom: z.number().int().min(0).default(4),
  /** Fraction of the reading time the floor stays visible in memory rounds. */
  memoryShown: z.number().min(0.2).max(0.9).default(0.55),
  /** Multiplier on the rules table's reading times (before the stage speed scale). */
  thinkScale: z.number().positive().default(1),
  /** Floor for the stage-scaled reading time (s). */
  minThink: z.number().positive().default(3.5),
  /** Wrong tiles shake this long before dropping (s). */
  shakeTime: z.number().positive().default(0.8),
  /** Dropped tiles stay down this long (s). */
  downTime: z.number().positive().default(1.8),
  /** Tiles take this long to rise back (s). */
  riseTime: z.number().positive().default(0.6),
  /** Visual fall distance (m). */
  fallDepth: z.number().positive().default(12),
  /** Board rounds pre-generated (the round's hard cap ends the show before these run out). */
  maxRounds: z.number().int().min(1).max(60).default(40),
  /**
   * Big fields: the opening `crowdRounds` board rounds offer at least one
   * answer tile per this many entrants (up to `crowdTilesMax`), so a full
   * field fits on the answers instead of shoving itself off them. 0 = off.
   */
  playersPerSafeTile: z.number().min(0).default(0),
  crowdRounds: z.number().int().min(0).default(3),
  crowdTilesMax: z.number().int().min(1).default(6),
  /** Fraction of the reading time after which bots know the answer. */
  botSolveAt: z.number().min(0).max(1).default(0.4),
  /** Screen centre relative to the origin, and its size (visual). */
  screen: z
    .object({
      x: z.number(),
      y: z.number(),
      z: z.number(),
      width: z.number().positive(),
      height: z.number().positive(),
    })
    .default({ x: 0, y: 11, z: 21, width: 22, height: 10 }),
});

/** Validated Puzzle Floor parameters. */
export type PuzzleFloorParams = z.output<typeof PuzzleFloorSchema>;

// -----------------------------------------------------------------------------
// Colours, arrows, phases
// -----------------------------------------------------------------------------

/** Paint colours for `mix`: three primaries, then their mixes. Ids are tile values. */
export const MIX_COLORS = ['red', 'yellow', 'blue', 'orange', 'green', 'purple'] as const;

/** Display colours for {@link MIX_COLORS}. */
export const MIX_COLOR_HEX = ['#ff3d4f', '#ffd23f', '#2f7bff', '#ff8a1f', '#3fcf5a', '#a259ff'] as const;

/** Parent primaries of each mix colour (index 3, 4, 5); primaries are their own single parent. */
export const MIX_PARENTS: readonly (readonly [number, number])[] = [
  [0, 0],
  [1, 1],
  [2, 2],
  [0, 1],
  [1, 2],
  [0, 2],
];

/** Mix of two different primaries. */
export function mixOf(a: number, b: number): number {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  return lo === 0 ? (hi === 1 ? 3 : 5) : 4;
}

/** `mix` question kinds. */
export const MixOp = { Add: 0, Subtract: 1 } as const;

/** Arrow directions for `trail`, as (column, row) steps. Row grows toward local +Z. */
export const TRAIL_DIRS: readonly (readonly [number, number])[] = [
  [0, 1],
  [1, 0],
  [0, -1],
  [-1, 0],
];

/** Board round phase. */
export const PuzzlePhase = { Idle: 0, Read: 1, Recall: 2, Drop: 3, Fallen: 4, Rise: 5 } as const;

/** One pre-generated board round. Times are absolute match seconds. */
export interface PuzzleRound {
  /** 0-based position in the schedule. */
  readonly index: number;
  /** Board round number used by the rules table (1 = teaching round). */
  readonly number: number;
  /** Per tile: colour id (`mix`) or arrow direction (`trail`). */
  readonly tiles: Uint8Array;
  /** 1 for every tile that stays up. */
  readonly safe: Uint8Array;
  /** `mix`: {@link MixOp}. */
  readonly op: number;
  /** `mix`: the two colours on the screen (for Subtract, `a − b`). */
  readonly a: number;
  readonly b: number;
  /** `mix`: the answer colour. */
  readonly answer: number;
  /** `trail`: steps to walk. */
  readonly steps: number;
  /** `trail`: every start's walk, `steps + 1` tiles each (start first, landing last). */
  readonly trails: readonly (readonly number[])[];
  /** The answer glows near the end of reading (teaching round). */
  readonly teach: boolean;
  /** The floor goes blank at `hideAt`. */
  readonly memory: boolean;
  readonly start: number;
  readonly hideAt: number;
  readonly dropAt: number;
  readonly fallAt: number;
  readonly riseAt: number;
  readonly end: number;
}

interface Rule {
  think: number;
  safeTiles: number;
  op: number;
  steps: number;
}

/** Rules table for a board round number, before scaling. */
function ruleFor(n: number, p: PuzzleFloorParams, rng: Rng): Rule {
  if (p.puzzle === 'trail') {
    const steps = n <= 1 ? 2 : n === 2 ? 3 : n <= 4 ? 4 : n === 5 ? 5 : 5 + (rng.chance(0.5) ? 1 : 0);
    const think = n <= 5 ? [8, 8, 8.5, 8.5, 8][n - 1]! : Math.max(5, 7.5 - 0.25 * (n - 6));
    return { think, safeTiles: n <= 6 ? 3 : 2, op: MixOp.Add, steps };
  }
  const op = n === 3 || n === 5 ? MixOp.Subtract : n >= 6 && rng.chance(0.45) ? MixOp.Subtract : MixOp.Add;
  const think = n <= 5 ? [9, 8, 8, 7, 7][n - 1]! : Math.max(4.5, 6.5 - 0.25 * (n - 6));
  const safeTiles = n <= 2 ? 5 : n <= 5 ? 4 : n <= 8 ? 3 : 2;
  return { think, safeTiles, op, steps: 0 };
}

const tileCount = (p: PuzzleFloorParams): number => p.cols * p.rows;

function shuffled(n: number, rng: Rng): number[] {
  const a = Array.from({ length: n }, (_, i) => i);
  rng.shuffle(a);
  return a;
}

/** `mix` board: `k` answer tiles not all in one line, every other colour at least twice. */
function buildMix(
  p: PuzzleFloorParams,
  rule: Rule,
  prevAnswer: number,
  rng: Rng,
): { tiles: Uint8Array; a: number; b: number; answer: number } {
  const n = tileCount(p);
  let a: number;
  let b: number;
  let answer: number;
  do {
    if (rule.op === MixOp.Add) {
      a = rng.int(0, 2);
      b = (a + rng.int(1, 2)) % 3;
      answer = mixOf(a, b);
    } else {
      a = rng.int(3, 5);
      const parents = MIX_PARENTS[a]!;
      const keep = rng.int(0, 1);
      b = parents[1 - keep]!;
      answer = parents[keep]!;
    }
  } while (answer === prevAnswer);
  const tiles = new Uint8Array(n);
  let picks: number[] = [];
  for (let tries = 0; tries < 50; tries++) {
    picks = shuffled(n, rng).slice(0, rule.safeTiles);
    const oneRow = picks.every((i) => Math.floor(i / p.cols) === Math.floor(picks[0]! / p.cols));
    const oneCol = picks.every((i) => i % p.cols === picks[0]! % p.cols);
    if (picks.length < 2 || (!oneRow && !oneCol)) break;
  }
  const isAnswer = new Uint8Array(n);
  for (const i of picks) isAnswer[i] = 1;
  const others = [0, 1, 2, 3, 4, 5].filter((c) => c !== answer);
  const fill: number[] = [];
  for (const c of others) fill.push(c, c);
  while (fill.length < n - picks.length) fill.push(others[rng.int(0, others.length - 1)]!);
  rng.shuffle(fill);
  let f = 0;
  for (let i = 0; i < n; i++) tiles[i] = isAnswer[i] ? answer : fill[f++]!;
  return { tiles, a, b, answer };
}

/**
 * `trail` board: `k` walks of `steps` arrows from distinct start tiles to
 * distinct landing tiles. Walks may share arrows (a walk that reaches an
 * already-pointed tile follows it), never step on another walk's start or
 * landing, and never revisit a tile. Unused tiles get random decoy arrows.
 */
function buildTrail(p: PuzzleFloorParams, rule: Rule, rng: Rng): { tiles: Uint8Array; trails: number[][] } {
  const n = tileCount(p);
  for (let k = rule.safeTiles; k >= 1; k--) {
    for (let attempt = 0; attempt < 120; attempt++) {
      const dir = new Int8Array(n).fill(-1);
      const reserved = new Uint8Array(n);
      const trails: number[][] = [];
      let ok = true;
      for (let s = 0; s < k && ok; s++) {
        const starts = shuffled(n, rng).filter((i) => !reserved[i] && dir[i]! < 0);
        const start = starts[0];
        if (start === undefined) {
          ok = false;
          break;
        }
        const path = [start];
        let cur = start;
        for (let step = 0; step < rule.steps && ok; step++) {
          let d = dir[cur]!;
          if (d < 0) {
            const options = [0, 1, 2, 3].filter((o) => {
              const next = stepFrom(cur, o, p);
              return next >= 0 && !path.includes(next) && !reserved[next];
            });
            if (options.length === 0) {
              ok = false;
              break;
            }
            d = options[rng.int(0, options.length - 1)]!;
          }
          const next = stepFrom(cur, d, p);
          if (next < 0 || path.includes(next) || reserved[next]) {
            ok = false;
            break;
          }
          dir[cur] = d;
          path.push(next);
          cur = next;
        }
        if (!ok) break;
        reserved[start] = 1;
        reserved[cur] = 1;
        trails.push(path);
      }
      if (!ok) continue;
      const tiles = new Uint8Array(n);
      for (let i = 0; i < n; i++) tiles[i] = dir[i]! >= 0 ? dir[i]! : rng.int(0, 3);
      return { tiles, trails };
    }
  }
  return { tiles: new Uint8Array(n), trails: [] };
}

/** Tile reached by one arrow step from `i`, or -1 off the board. */
export function stepFrom(i: number, d: number, p: Pick<PuzzleFloorParams, 'cols' | 'rows'>): number {
  const [dc, dr] = TRAIL_DIRS[d]!;
  const c = (i % p.cols) + dc;
  const r = Math.floor(i / p.cols) + dr;
  if (c < 0 || c >= p.cols || r < 0 || r >= p.rows) return -1;
  return r * p.cols + c;
}

/**
 * Builds the full board-round schedule. Puzzles consume `rng` in a fixed
 * order, so the same seed always produces the same show.
 *
 * @param p - Params.
 * @param speedScale - Stage speed scale (divides reading time, down to `minThink`).
 * @param rng - The instance's seeded generator.
 * @param entrants - Players starting the round (0 = unknown), for `playersPerSafeTile`.
 * @returns Board rounds back to back from `startTime`.
 */
export function buildPuzzleSchedule(
  p: PuzzleFloorParams,
  speedScale: number,
  rng: Rng,
  entrants = 0,
): PuzzleRound[] {
  const out: PuzzleRound[] = [];
  let t = p.startTime;
  let prevAnswer = -1;
  const n = tileCount(p);
  const crowdTiles =
    p.playersPerSafeTile > 0 ? Math.min(p.crowdTilesMax, Math.ceil(entrants / p.playersPerSafeTile)) : 0;
  for (let k = 0; k < p.maxRounds; k++) {
    const number = p.startRound + k;
    const rule = ruleFor(number, p, rng);
    if (k < p.crowdRounds) rule.safeTiles = Math.max(rule.safeTiles, crowdTiles);
    const think = Math.max(p.minThink, (rule.think * p.thinkScale) / Math.max(0.1, speedScale));
    const memory = p.memoryFrom > 0 && number >= p.memoryFrom;
    const safe = new Uint8Array(n);
    let tiles: Uint8Array;
    let a = -1;
    let b = -1;
    let answer = -1;
    let trails: number[][] = [];
    if (p.puzzle === 'mix') {
      const m = buildMix(p, rule, prevAnswer, rng);
      ({ tiles, a, b, answer } = m);
      prevAnswer = answer;
      for (let i = 0; i < n; i++) if (tiles[i] === answer) safe[i] = 1;
    } else {
      const m = buildTrail(p, rule, rng);
      ({ tiles, trails } = m);
      for (const path of trails) safe[path[path.length - 1]!] = 1;
    }
    const dropAt = t + think;
    const fallAt = dropAt + p.shakeTime;
    const riseAt = fallAt + p.downTime;
    out.push({
      index: k,
      number,
      tiles,
      safe,
      op: rule.op,
      a,
      b,
      answer,
      steps: rule.steps,
      trails,
      teach: number === 1,
      memory,
      start: t,
      hideAt: memory ? t + think * p.memoryShown : dropAt,
      dropAt,
      fallAt,
      riseAt,
      end: riseAt + p.riseTime,
    });
    t = riseAt + p.riseTime;
  }
  return out;
}

/** Index of the board round running at time t (clamped to the schedule), or -1 before the first. */
export function puzzleRoundIndexAt(schedule: readonly PuzzleRound[], t: number): number {
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
export function puzzlePhaseOf(r: PuzzleRound, t: number): number {
  if (t < r.start) return PuzzlePhase.Idle;
  if (t < r.hideAt) return PuzzlePhase.Read;
  if (t < r.dropAt) return PuzzlePhase.Recall;
  if (t < r.fallAt) return PuzzlePhase.Drop;
  if (t < r.riseAt) return PuzzlePhase.Fallen;
  if (t < r.end) return PuzzlePhase.Rise;
  return PuzzlePhase.Idle;
}

// -----------------------------------------------------------------------------
// Runtime
// -----------------------------------------------------------------------------

/** What the visual reads from a live floor. */
export interface PuzzleFloorView {
  readonly schedule: readonly PuzzleRound[];
  /** Whether board round `index` was voided (nobody would have survived). */
  isVoided(index: number): boolean;
}

const WORD_BITS = 30;

/** Live puzzle floor. */
export class PuzzleFloorRuntime extends RuntimeBase implements PuzzleFloorView {
  readonly schedule: PuzzleRound[];
  private readonly tiles: Collider[] = [];
  private readonly tileEnabled: boolean[] = [];
  private readonly seams: PatternSeam[];
  private readonly seamColliders: Collider[] = [];
  private readonly seamEnabled: boolean[] = [];
  private readonly voided: Uint8Array;
  private readonly judged: Uint8Array;
  private readonly authoritative: boolean;
  private readonly local = vec3();
  private readonly spot = vec3();

  constructor(
    instance: ObstacleInstance<PuzzleFloorParams>,
    ctx: ObstacleBuildContext,
    readonly params: PuzzleFloorParams,
  ) {
    super(instance, ctx);
    const p = params;
    const { R } = ctx;
    this.authoritative = ctx.authoritative ?? true;
    this.schedule = buildPuzzleSchedule(p, ctx.speedScale, ctx.rng, ctx.entrants ?? 0);
    this.voided = new Uint8Array(this.schedule.length);
    this.judged = new Uint8Array(this.schedule.length);
    const board = this.addBody(R.RigidBodyDesc.fixed());
    const c = vec3();
    for (let i = 0; i < tileCount(p); i++) {
      patternTileCenter(i, p, c);
      this.tiles.push(
        this.addCollider(
          R.ColliderDesc.cuboid(p.tileSize / 2, p.thickness / 2, p.tileSize / 2)
            .setTranslation(c.x, -p.thickness / 2, c.z)
            .setFriction(0.8)
            .setCollisionGroups(ObstacleGroups.static),
          board,
          { kind: 'normal' },
        ),
      );
      this.tileEnabled.push(true);
    }
    this.seams = patternSeams(p);
    for (const s of this.seams) {
      this.seamColliders.push(
        this.addCollider(
          R.ColliderDesc.cuboid(s.sizeX / 2, 0.2, s.sizeZ / 2)
            .setTranslation(s.x, -p.seamDepth - 0.2, s.z)
            .setFriction(0.8)
            .setCollisionGroups(ObstacleGroups.static),
          board,
          { kind: 'normal' },
        ),
      );
      this.seamEnabled.push(true);
    }
  }

  isVoided(index: number): boolean {
    return this.voided[index] === 1;
  }

  /** Whether board round `index` has been judged (its DROP began). */
  isJudged(index: number): boolean {
    return this.judged[index] === 1;
  }

  /** Board round running at `t`, or null before the first READ. */
  roundAt(t: number): PuzzleRound | null {
    const k = puzzleRoundIndexAt(this.schedule, t);
    return k >= 0 ? this.schedule[k]! : null;
  }

  update(ctx: ObstacleStepContext): void {
    const t = ctx.t;
    const r = this.roundAt(t);
    if (r) {
      if (this.authoritative) this.cues(r, ctx);
      if (t >= r.dropAt && t < r.end && !this.judged[r.index]) this.judge(r, ctx);
      const down = t >= r.fallAt && t < r.riseAt && !this.voided[r.index];
      for (let i = 0; i < this.tiles.length; i++) this.setTile(i, !(down && !r.safe[i]));
      for (let k = 0; k < this.seams.length; k++) this.syncSeam(k);
    }
    this.endStep(ctx);
  }

  /** Edge cues: a new question, the floor going blank. */
  private cues(r: PuzzleRound, ctx: ObstacleStepContext): void {
    const prev = this.lastT;
    if (!Number.isFinite(prev)) return;
    if (prev < r.start && ctx.t >= r.start) this.cue(ctx.events, 'question', 0, 1, 0);
    if (r.memory && prev < r.hideAt && ctx.t >= r.hideAt) this.cue(ctx.events, 'hide', 0, 1, 0);
  }

  /** The reveal: decide whether this board round drops or is voided. */
  private judge(r: PuzzleRound, ctx: ObstacleStepContext): void {
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
      if (i >= 0 ? r.safe[i] === 1 : this.onSafeSeam(l.x, l.z, r)) safe++;
    }
    // A prediction sim only sees its own player; voids are the server's call (replicated).
    const voided = this.authoritative && onBoard > 0 && safe === 0;
    if (voided) this.voided[r.index] = 1;
    if (this.authoritative) this.cue(ctx.events, voided ? 'void' : 'reveal', 0, 1, 0);
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
  private onSafeSeam(x: number, z: number, r: PuzzleRound): boolean {
    for (const s of this.seams) {
      if (Math.abs(x - s.x) > s.sizeX / 2 || Math.abs(z - s.z) > s.sizeZ / 2) continue;
      for (const i of s.tiles) if (!r.safe[i]) return false;
      return true;
    }
    return false;
  }

  /**
   * A spot to stand on. Until the bots have worked the puzzle out (part-way
   * through reading) it is on a spread-out waiting tile; after that on a safe
   * tile. With a `key` (the bot's id) the crowd is dealt evenly over the
   * candidate tiles and each bot gets its own place on its tile, so nobody
   * leans on a neighbour; without one, bots spread by their staggered
   * thinking tick and take the point of the tile nearest them.
   */
  botSafeSpot(t: number, out: Vec3, key?: number): boolean {
    const r = this.roundAt(t);
    if (!r) return false;
    const p = this.params;
    const solved = t >= r.start + (r.dropAt - r.start) * p.botSolveAt;
    const n = tileCount(p);
    if (key !== undefined) {
      const waiting = (key * 7 + r.index * 3 + 1) % n;
      const tile = solved ? nearSafeTile(key, waiting, r.safe, p) : waiting;
      if (tile < 0) return false;
      toWorldPoint(this.frame, placeOnTile(key, tile, p, this.spot), out);
      return true;
    }
    const phase = ((Math.round(t / SIM_DT) % 6) + 6) % 6;
    let tile: number;
    if (solved) {
      let safe = 0;
      for (let i = 0; i < n; i++) safe += r.safe[i]!;
      if (safe === 0) return false;
      // 7 is coprime with every safe-tile count a board uses, so the six phases cover them all.
      let pick = (phase * 7 + r.index) % safe;
      tile = 0;
      for (let i = 0; i < n; i++) {
        if (!r.safe[i]) continue;
        if (pick-- === 0) {
          tile = i;
          break;
        }
      }
    } else {
      tile = (phase * 7 + r.index * 3 + 1) % n;
    }
    const hint = toLocalPoint(this.frame, out, this.local);
    patternTileCenter(tile, p, this.spot);
    const inner = Math.max(0, p.tileSize / 2 - 1.3);
    this.spot.x += Math.max(-inner, Math.min(inner, hint.x - this.spot.x));
    this.spot.z += Math.max(-inner, Math.min(inner, hint.z - this.spot.z));
    toWorldPoint(this.frame, this.spot, out);
    return true;
  }

  /**
   * How hard this board round's question is for a bot, 0–1: the teaching
   * round's answer glows; then each later round, a memory floor and a
   * difference sum make a slip likelier, and extra think time (`thinkScale`)
   * makes it rarer.
   */
  botDifficulty(t: number): number {
    const r = this.roundAt(t);
    if (!r) return 0;
    if (r.teach) return LOGIC_TEACH_DIFFICULTY;
    const d =
      0.1 +
      0.12 * (r.number - 1) +
      (r.memory ? 0.15 : 0) +
      (r.op === MixOp.Subtract && this.params.puzzle === 'mix' ? 0.05 : 0);
    return Math.min(1, d / this.params.thinkScale);
  }

  telegraph(t: number): number {
    const r = this.roundAt(t);
    if (!r || t < r.start || t >= r.dropAt) return 0;
    return Math.min(1, (t - r.start) / Math.max(0.01, r.dropAt - r.start));
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

/** Puzzle Floor obstacle module. */
export const puzzleFloor: ObstacleModule<PuzzleFloorParams> = {
  type: 'puzzleFloor',
  displayName: 'Puzzle Floor',
  schema: PuzzleFloorSchema,
  create: (instance, ctx) => new PuzzleFloorRuntime(instance, ctx, PuzzleFloorSchema.parse(instance.params)),
  audioCues: ['question', 'hide', 'reveal', 'void'],
};
