import type { Rng, RoundDefinition, Vec3, Waypoint } from '@tumble/shared';
import { waypointDistancesToGoal } from '../rounds/progress.ts';

/** Vertical offsets count this much more than horizontal when snapping to waypoints. */
const Y_WEIGHT = 2.5;
/** Weight of the distance to the node a candidate edge would send the bot to, when rejoining. */
const NODE_DIST_WEIGHT = 0.3;

/**
 * Leg actions that must be performed from their own waypoint, so a bot
 * resuming part-way along such a leg goes back to its start instead of
 * skipping ahead past the jump.
 */
const START_BOUND_ACTIONS: ReadonlySet<Waypoint['action']> = new Set<Waypoint['action']>([
  'jump',
  'jumpDive',
  'dive',
  'waitForGap',
  'waitForPlatform',
  'grab',
  'climb',
]);

/**
 * A round's bot waypoint graph with precomputed distances to the goal and
 * depth from the start. Immutable and shared by every bot in the round.
 */
export class NavGraph {
  readonly nodes: readonly Waypoint[];
  /** Shortest remaining path length per node index (`Number.MAX_VALUE` when no goal is reachable). */
  readonly goalDist: Float64Array;
  /** BFS depth from the entry nodes per node index (course order). */
  readonly rank: Int32Array;
  /** `next` ids resolved to node indices. */
  readonly nextIdx: readonly (readonly number[])[];
  /** Instance positions of obstacles, for `waitForGap` crossing points. */
  readonly obstaclePos: ReadonlyMap<string, Vec3>;
  /** Obstacle type per instance id (base round and every variation). */
  readonly obstacleType: ReadonlyMap<string, string>;
  /** True when some sink node is reached by an edge (a course with a goal). */
  readonly hasGoal: boolean;
  /** True when the graph has at least one edge. */
  readonly hasEdges: boolean;
  /** Mean successors per node: ~1 for courses and patrol loops, more for roam grids. */
  readonly meanOutDegree: number;

  constructor(round: RoundDefinition) {
    this.nodes = round.botNav;
    const idx = new Map<number, number>();
    this.nodes.forEach((w, i) => idx.set(w.id, i));
    this.nextIdx = this.nodes.map((w) =>
      w.next.map((n) => idx.get(n)).filter((n): n is number => n !== undefined),
    );
    const dist = waypointDistancesToGoal(this.nodes);
    this.goalDist = Float64Array.from(this.nodes, (w) => {
      const d = dist.get(w.id);
      return d !== undefined && Number.isFinite(d) ? d : Number.MAX_VALUE;
    });
    this.rank = new Int32Array(this.nodes.length).fill(-1);
    const hasIncoming = new Array<boolean>(this.nodes.length).fill(false);
    for (const list of this.nextIdx) for (const n of list) hasIncoming[n] = true;
    this.hasEdges = this.nextIdx.some((l) => l.length > 0);
    this.meanOutDegree =
      this.nodes.length > 0 ? this.nextIdx.reduce((n, l) => n + l.length, 0) / this.nodes.length : 0;
    this.hasGoal = this.nodes.some(
      (_, i) => hasIncoming[i] === true && (this.nextIdx[i] as number[]).length === 0,
    );
    const queue: number[] = [];
    this.nodes.forEach((_, i) => {
      if (!hasIncoming[i]) {
        this.rank[i] = 0;
        queue.push(i);
      }
    });
    if (queue.length === 0 && this.nodes.length > 0) {
      this.rank[0] = 0;
      queue.push(0);
    }
    for (let q = 0; q < queue.length; q++) {
      const i = queue[q] as number;
      for (const n of this.nextIdx[i] as number[]) {
        if ((this.rank[n] as number) < 0) {
          this.rank[n] = (this.rank[i] as number) + 1;
          queue.push(n);
        }
      }
    }
    const obs = new Map<string, Vec3>();
    const types = new Map<string, string>();
    for (const o of round.obstacles) {
      obs.set(o.id, o.position);
      types.set(o.id, o.type);
    }
    for (const v of round.variations) {
      for (const o of v.addObstacles) {
        if (!obs.has(o.id)) obs.set(o.id, o.position);
        if (!types.has(o.id)) types.set(o.id, o.type);
      }
    }
    this.obstaclePos = obs;
    this.obstacleType = types;
  }

  get size(): number {
    return this.nodes.length;
  }

  /**
   * Nearest node to `pos`, preferring nodes not behind `minRank`.
   *
   * @returns Node index, or -1 for an empty graph.
   */
  nearest(pos: Vec3, minRank = -1): number {
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < this.nodes.length; i++) {
      const w = this.nodes[i] as Waypoint;
      const dx = w.position.x - pos.x;
      const dy = (w.position.y - pos.y) * Y_WEIGHT;
      const dz = w.position.z - pos.z;
      let d = dx * dx + dy * dy + dz * dz;
      if ((this.rank[i] as number) < minRank) d *= 16;
      // Above head height is usually unreachable without the path leading up to it.
      if (w.position.y - pos.y > 2.5) d *= 4;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }

  /**
   * Where to rejoin the graph from `pos` (spawn, respawn, after falling or
   * getting lost). Snaps to the nearest edge and returns the node to head
   * for: the edge's end, or its start when the edge's action (jump, timed
   * crossing, climb) must be performed from the start and `pos` lies in the
   * first half. History is deliberately ignored, so a respawn just behind an
   * already-passed jump still goes back for the jump.
   *
   * @param pos - Where the bot is.
   * @param avoid - Node index to steer around (a branch just given up on), or -1.
   * @returns Node index, or -1 for an empty graph.
   */
  resume(pos: Vec3, avoid = -1): number {
    if (!this.hasEdges) return this.nearest(pos);
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < this.nodes.length; i++) {
      const from = this.nodes[i] as Waypoint;
      const a = from.position;
      for (const n of this.nextIdx[i] as number[]) {
        const b = (this.nodes[n] as Waypoint).position;
        const ex = b.x - a.x;
        const ez = b.z - a.z;
        const l2 = ex * ex + ez * ez;
        let s = l2 > 1e-6 ? ((pos.x - a.x) * ex + (pos.z - a.z) * ez) / l2 : 0;
        s = s < 0 ? 0 : s > 1 ? 1 : s;
        const cy = a.y + (b.y - a.y) * s;
        const dx = a.x + ex * s - pos.x;
        const dy = (cy - pos.y) * Y_WEIGHT;
        const dz = a.z + ez * s - pos.z;
        let d = dx * dx + dy * dy + dz * dz;
        if (cy - pos.y > 2.5) d *= 4;
        let pick = s >= 1 ? n : s <= 0 ? i : START_BOUND_ACTIONS.has(from.action) && s < 0.5 ? i : n;
        // Fan-out edges from a hub all pass close by; among them prefer the one whose node is nearest.
        const pw = (this.nodes[pick] as Waypoint).position;
        d +=
          NODE_DIST_WEIGHT * ((pw.x - pos.x) ** 2 + ((pw.y - pos.y) * Y_WEIGHT) ** 2 + (pw.z - pos.z) ** 2);
        // Edges into the avoided node lose to any comparable alternative; if one still wins, back up to its start.
        if (n === avoid) {
          d *= 9;
          if (pick === avoid) pick = i;
        } else if (pick === avoid) {
          d *= 9;
        }
        if (d < bestD) {
          bestD = d;
          best = pick;
        }
      }
    }
    return best;
  }

  /**
   * Picks the successor of node `i`: the shortest way on with probability
   * `greed`, otherwise a uniformly random branch.
   *
   * @param avoid - Successor to skip when another exists (a banned branch), or -1.
   * @returns Node index, or -1 at a sink.
   */
  chooseNext(i: number, rng: Rng, greed: number, avoid = -1): number {
    const next = this.nextIdx[i];
    if (!next || next.length === 0) return -1;
    if (next.length === 1) return next[0] as number;
    if (rng.chance(greed)) {
      let best = -1;
      let bestD = Infinity;
      for (const n of next) {
        if (n === avoid) continue;
        const d = (this.goalDist[n] as number) + segLen(this.nodes[i] as Waypoint, this.nodes[n] as Waypoint);
        if (d < bestD) {
          bestD = d;
          best = n;
        }
      }
      return best;
    }
    let pick = rng.pick(next);
    if (pick === avoid) pick = next[(next.indexOf(pick) + 1) % next.length] as number;
    return pick;
  }

  /**
   * A successor of `from` other than `not`, for re-pathing around a blocked
   * branch.
   *
   * @returns Node index, or -1 when `from` has no other branch.
   */
  sibling(from: number, not: number, rng: Rng): number {
    const next = this.nextIdx[from];
    if (!next || next.length < 2) return -1;
    const start = Math.floor(rng.next() * next.length);
    for (let k = 0; k < next.length; k++) {
      const n = next[(start + k) % next.length] as number;
      if (n !== not) return n;
    }
    return -1;
  }
}

function segLen(a: Waypoint, b: Waypoint): number {
  return Math.hypot(a.position.x - b.position.x, a.position.y - b.position.y, a.position.z - b.position.z);
}

const cache = new WeakMap<RoundDefinition, NavGraph>();

/**
 * Shared {@link NavGraph} for a round definition object.
 *
 * @param round - Validated round; the graph is cached per object identity.
 */
export function navGraphFor(round: RoundDefinition): NavGraph {
  let g = cache.get(round);
  if (!g) cache.set(round, (g = new NavGraph(round)));
  return g;
}
