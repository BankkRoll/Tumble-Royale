/**
 * Why the local player was knocked out, read from the round's sim events
 * (the "How you went out" annotation).
 *
 * Responsibilities:
 * - classify an elimination: knocked off by an obstacle, grabbed or bumped
 *   off by another player, the floor dropping away, a wrong tile, a plain
 *   fall, missing the cut at the finish, the team losing, or time running out;
 * - find the decisive moment (the replay slows down around it);
 * - fall back to a generic cause whenever two different explanations are
 *   equally plausible, so the annotation never blames the wrong thing;
 * - turn a cause into one short line of text with names supplied by the
 *   caller (Streamer Mode masking happens there).
 *
 * Events carry no "hit by" field, so obstacle knocks are attributed by
 * proximity: a stun lands inside the reach of the nearest hazard placed in
 * the round. Pure: no DOM, no three, no sim instances.
 */
import type { SimEvent } from '@tumble/sim';

/** A sim event with the round time (s) it happened at. */
export interface TimedEvent {
  t: number;
  e: SimEvent;
}

/** A placed obstacle, as far as attribution needs it. */
export interface CauseObstacle {
  id: string;
  /** Obstacle module type (`sweeperArm`, `fallingTiles`, …). */
  type: string;
  x: number;
  y: number;
  z: number;
  /** Horizontal distance (m) within which the obstacle can hit a Tumbler. */
  reach: number;
}

/** What the attribution knows about the round. */
export interface CauseContext {
  localId: number;
  /** Round type as recorded (`race`, `survival`, `team`, `hunt`, `logic`, `final`). */
  roundType: string;
  isFinal: boolean;
  /** Round time of the local player's `eliminated` event. */
  eliminatedAt: number;
  /** Team per player id (team rounds; others may be empty). */
  teams: ReadonlyMap<number, number>;
  obstacles: readonly CauseObstacle[];
  /**
   * Race rounds: seconds the local player still needed to reach the finish
   * when the round ended (see {@link finishGapSeconds}), or null.
   */
  finishGap: number | null;
}

/** Why the local player went out. `at` is the decisive round time. */
export type EliminationCause =
  | { kind: 'grabbed'; by: number; at: number }
  | { kind: 'bumped'; by: number; at: number }
  | { kind: 'obstacle'; obstacleType: string; via: 'knock' | 'bounce'; at: number }
  | { kind: 'floor'; at: number }
  | { kind: 'wrongTile'; at: number }
  | { kind: 'fell'; at: number }
  | { kind: 'missedCut'; gap: number | null; at: number }
  | { kind: 'teamLost'; score: number; best: number; at: number }
  | { kind: 'timeUp'; at: number }
  | { kind: 'unknown'; at: number };

/** Kinds of {@link EliminationCause}. */
export type EliminationCauseKind = EliminationCause['kind'];

/** How far back from the fall a cause may lie (s). */
export const CAUSE_LOOKBACK_S = 4;
/** A grab still counts when it ended at most this long before the fall (s). */
const GRAB_LINK_S = 2.5;
/** A collapsing floor counts when it went within this long before the fall (s). */
const FLOOR_LINK_S = 2;
/** Two different causes this close together are a toss-up: say something generic (s). */
export const CAUSE_AMBIGUOUS_S = 0.3;
/** A fall this close to the `eliminated` event is what knocked the player out (s). */
const FALL_ELIMINATION_S = 0.6;
/** A dive this close (m, s) before a stun is a player bump. */
const BUMP_RANGE_M = 2.4;
const BUMP_LEAD_S = 0.8;
/** Gaps above this read as "didn't make the cut" rather than a number (s). */
const MAX_GAP_TEXT_S = 9.5;

/** Obstacles that knock Tumblers over (stuns near them are theirs). */
const KNOCKERS: ReadonlySet<string> = new Set([
  'sweeperArm',
  'spinwheel',
  'pendulumHammer',
  'punchWall',
  'bumperPillar',
  'boulderLane',
  'laserSweep',
  'cannon',
  'bumperCar',
  'jumpRopeBeam',
  'rollingDrum',
  'popupBlocks',
]);

/** Floors that drop away under Tumblers. */
const DROPPING_FLOORS: ReadonlySet<string> = new Set(['fallingTiles', 'collapsingBridge']);

/** Short nouns for the annotation ("Knocked off by a sweeper"). */
const OBSTACLE_NOUNS: Readonly<Record<string, string>> = {
  sweeperArm: 'a sweeper',
  spinwheel: 'a whirly wheel',
  pendulumHammer: 'a bonk mallet',
  punchWall: 'a pow wall',
  bumperPillar: 'a boing pillar',
  boulderLane: 'a jawbreaker',
  laserSweep: 'a laser sweep',
  cannon: 'a cannonball',
  bumperCar: 'a bumper cart',
  jumpRopeBeam: 'a skip sweeper',
  rollingDrum: 'a rolling drum',
  popupBlocks: 'a pop-up block',
  bouncePad: 'a boing pad',
  fanZone: 'a gusty fan',
  doorGauntlet: 'a door',
  spinningDisc: 'a turntable',
  seesaw: 'a teeter plank',
  tiltPlatform: 'a wobble plate',
  conveyorBelt: 'a treadmill',
};

/** Params that say how far an obstacle sweeps or rolls (m). */
const REACH_KEYS = [
  'armLength',
  'length',
  'radius',
  'reach',
  'range',
  'radiusX',
  'radiusZ',
  'orbitRadius',
] as const;

/**
 * How far from its origin an obstacle can hit (m): its longest sweeping
 * dimension plus a Tumbler's width, or a default for compact obstacles.
 *
 * @param params - The obstacle's params (with defaults applied, when known).
 * @returns Reach in metres, 2–40.
 * @example
 * obstacleReach({ armLength: 7 }); // 9
 */
export function obstacleReach(params: Readonly<Record<string, unknown>> | undefined): number {
  let r = 0;
  for (const k of REACH_KEYS) {
    const v = params?.[k];
    if (typeof v === 'number' && Number.isFinite(v)) r = Math.max(r, v);
  }
  return Math.max(2, Math.min(40, r > 0 ? r + 2 : 6));
}

/**
 * Seconds a Tumbler at `pos` still needed to reach the nearest finish volume
 * at full running speed: the "missed the cut by" figure.
 *
 * @param pos - Feet or capsule position.
 * @param finishes - Finish volumes (centre and full extents).
 * @param speed - Running speed (m/s).
 * @returns Seconds, or null without a finish.
 */
export function finishGapSeconds(
  pos: { x: number; y: number; z: number },
  finishes: readonly {
    position: { x: number; y: number; z: number };
    size: { x: number; y: number; z: number };
  }[],
  speed: number,
): number | null {
  let best = Infinity;
  for (const f of finishes) {
    const dx = Math.max(0, Math.abs(pos.x - f.position.x) - f.size.x / 2);
    const dz = Math.max(0, Math.abs(pos.z - f.position.z) - f.size.z / 2);
    best = Math.min(best, Math.hypot(dx, dz));
  }
  if (!Number.isFinite(best) || speed <= 0) return null;
  return best / speed;
}

interface Candidate {
  cause: EliminationCause;
  /** Who or what it blames, for the ambiguity check. */
  source: string;
}

function hDist(a: { x: number; z: number }, b: { x: number; z: number }): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

/** The hazard whose reach covers `pos`, nearest relative to its reach. */
function hazardAt(
  pos: { x: number; y: number; z: number },
  obstacles: readonly CauseObstacle[],
  types: ReadonlySet<string>,
): CauseObstacle | null {
  let best: CauseObstacle | null = null;
  let bestRatio = Infinity;
  for (const o of obstacles) {
    if (!types.has(o.type)) continue;
    const d = hDist(pos, o);
    if (d > o.reach || Math.abs(pos.y - o.y) > Math.max(6, o.reach)) continue;
    const ratio = d / o.reach;
    if (ratio < bestRatio) {
      bestRatio = ratio;
      best = o;
    }
  }
  return best;
}

/** The player who dived into the local Tumbler just before a stun, if any. */
function bumperOf(
  events: readonly TimedEvent[],
  localId: number,
  stun: TimedEvent & { e: { type: 'stun' } },
): number | null {
  let by: number | null = null;
  let byT = -Infinity;
  for (const { t, e } of events) {
    if (t > stun.t) break;
    if (e.type !== 'dive' || e.player === localId || stun.t - t > BUMP_LEAD_S) continue;
    if (hDist(e.pos, stun.e.pos) <= BUMP_RANGE_M && t >= byT) {
      by = e.player;
      byT = t;
    }
  }
  return by;
}

/** Collects what could have sent the player off before a fall at `fallT`. */
function fallCandidates(events: readonly TimedEvent[], ctx: CauseContext, fallT: number): Candidate[] {
  const out: Candidate[] = [];
  const me = ctx.localId;
  const byObstacle = new Map(ctx.obstacles.map((o) => [o.id, o]));
  const from = fallT - CAUSE_LOOKBACK_S;
  /** Open grabs on the local player: grabber → start time. */
  const held = new Map<number, number>();
  for (const item of events) {
    const { t, e } = item;
    if (t > fallT + 1e-6) break;
    switch (e.type) {
      case 'grabStart':
        if (e.target === me && e.targetKind === 'player' && e.player !== me) held.set(e.player, t);
        break;
      case 'grabEnd':
        if (e.target === me && held.has(e.player)) {
          held.delete(e.player);
          if (t >= fallT - GRAB_LINK_S && t >= from)
            out.push({ cause: { kind: 'grabbed', by: e.player, at: t }, source: `p${e.player}` });
        }
        break;
      case 'stun': {
        if (e.player !== me || t < from) break;
        const hazard = hazardAt(e.pos, ctx.obstacles, KNOCKERS);
        if (hazard) {
          out.push({
            cause: { kind: 'obstacle', obstacleType: hazard.type, via: 'knock', at: t },
            source: `o${hazard.id}`,
          });
          break;
        }
        const by = bumperOf(events, me, item as TimedEvent & { e: { type: 'stun' } });
        if (by !== null) out.push({ cause: { kind: 'bumped', by, at: t }, source: `p${by}` });
        else out.push({ cause: { kind: 'unknown', at: t }, source: 'stun' });
        break;
      }
      case 'bounce': {
        if (e.player !== me || t < from || !e.obstacle) break;
        const o = byObstacle.get(e.obstacle);
        if (o)
          out.push({
            cause: { kind: 'obstacle', obstacleType: o.type, via: 'bounce', at: t },
            source: `o${o.id}`,
          });
        break;
      }
      case 'tileFell': {
        if (t < fallT - FLOOR_LINK_S) break;
        const o = byObstacle.get(e.obstacle);
        if (o && DROPPING_FLOORS.has(o.type))
          out.push({ cause: { kind: 'floor', at: t }, source: `o${o.id}` });
        break;
      }
      default:
        break;
    }
  }
  // Still held when the fall came: the grab carried the player off.
  for (const [by, t] of held)
    out.push({ cause: { kind: 'grabbed', by, at: Math.max(t, fallT - GRAB_LINK_S) }, source: `p${by}` });
  return out;
}

/** Keeps only floor drops near where the player fell, so a far-away tile never gets the blame. */
function nearFloor(c: Candidate, ctx: CauseContext, fallPos: { x: number; z: number } | null): boolean {
  if (c.cause.kind !== 'floor') return true;
  const o = ctx.obstacles.find((x) => `o${x.id}` === c.source);
  return !!o && !!fallPos && hDist(fallPos, o) <= Math.max(o.reach, 12);
}

/** Final team totals from the score stream. */
function teamTotals(events: readonly TimedEvent[]): { totals: Map<number, number>; lastAt: number } {
  const totals = new Map<number, number>();
  let lastAt = Number.NaN;
  for (const { t, e } of events) {
    if (e.type !== 'score' || e.team < 0) continue;
    totals.set(e.team, e.total);
    lastAt = t;
  }
  return { totals, lastAt };
}

/** The end-of-round reasons: the cut, the team result or the clock. */
function endOfRoundCause(events: readonly TimedEvent[], ctx: CauseContext): EliminationCause {
  const at = ctx.eliminatedAt;
  const type = ctx.isFinal && ctx.roundType === 'final' ? 'final' : ctx.roundType;
  if (type === 'team') {
    const mine = ctx.teams.get(ctx.localId);
    const { totals, lastAt } = teamTotals(events);
    if (mine === undefined || mine < 0 || totals.size === 0) return { kind: 'unknown', at };
    const score = totals.get(mine) ?? 0;
    let best = -Infinity;
    for (const [team, total] of totals) if (team !== mine) best = Math.max(best, total);
    if (!Number.isFinite(best) || score >= best) return { kind: 'unknown', at };
    return { kind: 'teamLost', score, best, at: Number.isNaN(lastAt) ? at : lastAt };
  }
  if (type === 'race') return { kind: 'missedCut', gap: ctx.finishGap, at };
  if (type === 'logic') return { kind: 'unknown', at };
  return { kind: 'timeUp', at };
}

/**
 * Attributes the local player's elimination.
 *
 * Steps: find the fall that ended the run (a `fellOut` right at the
 * elimination); without one the player went out at the end of the round
 * (cut, team result, clock). With one, collect every cause in the 4 s before
 * the fall (grabs on the player, stuns near hazards or after a dive, bounces
 * off obstacles, floors dropping), take the latest, and give up to a generic
 * "fell" when a different cause lies within {@link CAUSE_AMBIGUOUS_S} of it.
 *
 * @param events - Round events in time order (round time).
 * @param ctx - Round facts.
 * @returns The cause; never throws.
 */
export function attributeElimination(events: readonly TimedEvent[], ctx: CauseContext): EliminationCause {
  const me = ctx.localId;
  let fall: TimedEvent | null = null;
  for (const item of events) {
    if (item.t > ctx.eliminatedAt + 1e-6) break;
    if (item.e.type === 'fellOut' && item.e.player === me) fall = item;
  }
  if (!fall || ctx.eliminatedAt - fall.t > FALL_ELIMINATION_S) return endOfRoundCause(events, ctx);
  const fallPos = fall.e.type === 'fellOut' ? fall.e.pos : null;
  const all = fallCandidates(events, ctx, fall.t).filter((c) => nearFloor(c, ctx, fallPos));
  if (all.length === 0) {
    return ctx.roundType === 'logic' ? { kind: 'wrongTile', at: fall.t } : { kind: 'fell', at: fall.t };
  }
  all.sort((a, b) => b.cause.at - a.cause.at);
  const top = all[0] as Candidate;
  const rival = all.find((c) => c.source !== top.source);
  if (rival && top.cause.at - rival.cause.at <= CAUSE_AMBIGUOUS_S) return { kind: 'fell', at: top.cause.at };
  if (top.cause.kind === 'unknown') return { kind: 'fell', at: top.cause.at };
  return top.cause;
}

/**
 * One line for the annotation.
 *
 * @param cause - The cause.
 * @param nameOf - Display name for a player id (already Streamer Mode safe).
 * @returns Text such as "Knocked off by a sweeper" or "Missed the cut by 0.4 s".
 * @example
 * causeText({ kind: 'grabbed', by: 3, at: 41.2 }, (id) => `P${id}`); // "Grabbed by P3"
 */
export function causeText(cause: EliminationCause, nameOf: (id: number) => string): string {
  switch (cause.kind) {
    case 'grabbed':
      return `Grabbed by ${nameOf(cause.by)}`;
    case 'bumped':
      return `Bumped off by ${nameOf(cause.by)}`;
    case 'obstacle': {
      const noun = OBSTACLE_NOUNS[cause.obstacleType] ?? 'an obstacle';
      return cause.via === 'bounce' && cause.obstacleType === 'bouncePad'
        ? `Launched off by ${noun}`
        : `Knocked off by ${noun}`;
    }
    case 'floor':
      return 'The floor dropped away';
    case 'wrongTile':
      return 'Picked the wrong tile';
    case 'fell':
      return 'Fell off the course';
    case 'missedCut':
      return cause.gap !== null && cause.gap <= MAX_GAP_TEXT_S
        ? `Missed the cut by ${Math.max(0.1, cause.gap).toFixed(1)} s`
        : "Didn't make the cut";
    case 'teamLost':
      return `Your team lost ${cause.score}–${cause.best}`;
    case 'timeUp':
      return 'Time ran out';
    default:
      return 'Knocked out';
  }
}

/**
 * The player whose point of view tells the story best: the grabber or
 * bumper when another player did it, else the local player.
 *
 * @param cause - The cause.
 * @param localId - Local player id.
 */
export function causeFocusPlayer(cause: EliminationCause, localId: number): number {
  return cause.kind === 'grabbed' || cause.kind === 'bumped' ? cause.by : localId;
}
