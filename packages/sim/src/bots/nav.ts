import type { Rng, RoundDefinition, Vec3, Waypoint } from '@tumble/shared';
import { waypointDistancesToGoal } from '../rounds/progress.ts';

/** Vertical offsets count this much more than horizontal when snapping to waypoints. */
const Y_WEIGHT = 2.5;

/**
 * A round's bot waypoint graph with precomputed distances to the goal and
 * depth from the start. Immutable and shared by every bot in the round.
 */
export class NavGraph {
  readonly nodes: readonly Waypoint[];
  /** Shortest remaining path length per node index. */
  readonly goalDist: Float64Array;
  /** BFS depth from the entry nodes per node index (course order). */
  readonly rank: Int32Array;
  /** `next` ids resolved to node indices. */
  readonly nextIdx: readonly (readonly number[])[];
  /** Instance positions of obstacles, for `waitForGap` crossing points. */
  readonly obstaclePos: ReadonlyMap<string, Vec3>;

  constructor(round: RoundDefinition) {
    this.nodes = round.botNav;
    const idx = new Map<number, number>();
    this.nodes.forEach((w, i) => idx.set(w.id, i));
    this.nextIdx = this.nodes.map((w) => w.next.map((n) => idx.get(n)).filter((n): n is number => n !== undefined));
    const dist = waypointDistancesToGoal(this.nodes);
    this.goalDist = Float64Array.from(this.nodes, (w) => dist.get(w.id) ?? Number.MAX_VALUE);
    this.rank = new Int32Array(this.nodes.length).fill(-1);
    const hasIncoming = new Array<boolean>(this.nodes.length).fill(false);
    for (const list of this.nextIdx) for (const n of list) hasIncoming[n] = true;
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
    for (const o of round.obstacles) obs.set(o.id, o.position);
    for (const v of round.variations) for (const o of v.addObstacles) if (!obs.has(o.id)) obs.set(o.id, o.position);
    this.obstaclePos = obs;
  }

  get size(): number {
    return this.nodes.length;
  }

  /**
   * Nearest node to `pos`, preferring nodes not behind `minRank` (so a bot
   * respawned at a checkpoint does not run back to the start).
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
   * Picks the successor of node `i`: the shortest way on with probability
   * `greed`, otherwise a uniformly random branch.
   *
   * @returns Node index, or -1 at a sink.
   */
  chooseNext(i: number, rng: Rng, greed: number): number {
    const next = this.nextIdx[i];
    if (!next || next.length === 0) return -1;
    if (next.length === 1) return next[0] as number;
    if (rng.chance(greed)) {
      let best = next[0] as number;
      let bestD = Infinity;
      for (const n of next) {
        const d = (this.goalDist[n] as number) + segLen(this.nodes[i] as Waypoint, this.nodes[n] as Waypoint);
        if (d < bestD) {
          bestD = d;
          best = n;
        }
      }
      return best;
    }
    return rng.pick(next);
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
