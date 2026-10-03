import type { RoundDefinition, Vec3, Waypoint } from '@tumble/shared';

/** Vertical distance counts this much more than horizontal when snapping to the course. */
const Y_WEIGHT = 2.5;

/**
 * Measures how far along a course a position is, from 0 (spawn) to 1 (goal).
 *
 * Built from the round's bot waypoint graph: every edge knows its remaining
 * shortest-path distance to the goal, a position snaps to the nearest edge
 * and progress is `1 - remaining / total`. Rounds without waypoints fall back
 * to straight-line distance to the goal trigger (finish or crown).
 *
 * Construction allocates; {@link measure} does not.
 */
export class CourseMetric {
  private readonly ax: Float64Array;
  private readonly ay: Float64Array;
  private readonly az: Float64Array;
  private readonly bx: Float64Array;
  private readonly by: Float64Array;
  private readonly bz: Float64Array;
  /** Shortest remaining distance from each edge's end point to the goal. */
  private readonly bRemain: Float64Array;
  private readonly edgeCount: number;
  private readonly total: number;
  private readonly goal: Vec3 | null;

  constructor(round: RoundDefinition, start: Vec3) {
    const goalTrigger =
      round.triggers.find((t) => t.kind === 'finish') ??
      round.triggers.find((t) => t.kind === 'crown') ??
      null;
    const nav = round.botNav;
    const remain = waypointDistancesToGoal(nav);
    const edges: [Waypoint, Waypoint][] = [];
    const byId = new Map(nav.map((w) => [w.id, w]));
    for (const w of nav)
      for (const n of w.next) {
        const b = byId.get(n);
        if (b) edges.push([w, b]);
      }
    this.edgeCount = edges.length;
    this.ax = new Float64Array(edges.length);
    this.ay = new Float64Array(edges.length);
    this.az = new Float64Array(edges.length);
    this.bx = new Float64Array(edges.length);
    this.by = new Float64Array(edges.length);
    this.bz = new Float64Array(edges.length);
    this.bRemain = new Float64Array(edges.length);
    edges.forEach(([a, b], i) => {
      this.ax[i] = a.position.x;
      this.ay[i] = a.position.y;
      this.az[i] = a.position.z;
      this.bx[i] = b.position.x;
      this.by[i] = b.position.y;
      this.bz[i] = b.position.z;
      const r = remain.get(b.id) ?? Infinity;
      this.bRemain[i] = Number.isFinite(r) ? r : 0;
    });
    this.goal = goalTrigger
      ? { ...goalTrigger.position }
      : nav.length > 0
        ? { ...nav[nav.length - 1]!.position }
        : null;
    let total = 0;
    if (this.edgeCount > 0) {
      total = this.remainingVia(start.x, start.y, start.z);
    } else if (this.goal) {
      total = Math.hypot(start.x - this.goal.x, start.y - this.goal.y, start.z - this.goal.z);
    }
    this.total = Math.max(total, 1);
  }

  /** @returns Progress in [0, 1] for a world position. */
  measure(p: Vec3): number {
    let remaining: number;
    if (this.edgeCount > 0) remaining = this.remainingVia(p.x, p.y, p.z);
    else if (this.goal) remaining = Math.hypot(p.x - this.goal.x, p.y - this.goal.y, p.z - this.goal.z);
    else return 0;
    const v = 1 - remaining / this.total;
    return v < 0 ? 0 : v > 1 ? 1 : v;
  }

  private remainingVia(px: number, py: number, pz: number): number {
    let best = Infinity;
    let bestRemain = 0;
    for (let i = 0; i < this.edgeCount; i++) {
      const ax = this.ax[i] as number;
      const ay = this.ay[i] as number;
      const az = this.az[i] as number;
      const dx = (this.bx[i] as number) - ax;
      const dy = (this.by[i] as number) - ay;
      const dz = (this.bz[i] as number) - az;
      const len2 = dx * dx + dy * dy + dz * dz;
      let s = len2 > 1e-9 ? ((px - ax) * dx + (py - ay) * dy + (pz - az) * dz) / len2 : 0;
      s = s < 0 ? 0 : s > 1 ? 1 : s;
      const cx = ax + dx * s;
      const cy = ay + dy * s;
      const cz = az + dz * s;
      const ex = px - cx;
      const ey = (py - cy) * Y_WEIGHT;
      const ez = pz - cz;
      const d = ex * ex + ey * ey + ez * ez;
      if (d < best) {
        best = d;
        bestRemain = (this.bRemain[i] as number) + Math.sqrt(len2) * (1 - s);
      }
    }
    return bestRemain;
  }
}

/**
 * Reverse Dijkstra over the waypoint graph from its sinks (waypoints with no
 * `next`). Used by progress measurement and by sharp bots choosing branches.
 *
 * @returns Shortest distance from each waypoint id to any sink.
 */
export function waypointDistancesToGoal(nav: readonly Waypoint[]): Map<number, number> {
  const dist = new Map<number, number>();
  const byId = new Map(nav.map((w) => [w.id, w]));
  const incoming = new Map<number, Waypoint[]>();
  for (const w of nav) {
    for (const n of w.next) {
      if (!byId.has(n)) continue;
      let list = incoming.get(n);
      if (!list) incoming.set(n, (list = []));
      list.push(w);
    }
  }
  const open: number[] = [];
  for (const w of nav) {
    const hasNext = w.next.some((n) => byId.has(n));
    if (!hasNext) {
      dist.set(w.id, 0);
      open.push(w.id);
    }
  }
  // Graphs are tens of nodes; an O(n²) selection keeps this dependency-free and deterministic.
  const done = new Set<number>();
  while (open.length > 0) {
    let bi = 0;
    for (let i = 1; i < open.length; i++) if (dist.get(open[i]!)! < dist.get(open[bi]!)!) bi = i;
    const id = open.splice(bi, 1)[0]!;
    if (done.has(id)) continue;
    done.add(id);
    const w = byId.get(id)!;
    const d = dist.get(id)!;
    for (const prev of incoming.get(id) ?? []) {
      const nd =
        d +
        Math.hypot(
          prev.position.x - w.position.x,
          prev.position.y - w.position.y,
          prev.position.z - w.position.z,
        );
      if (nd < (dist.get(prev.id) ?? Infinity)) {
        dist.set(prev.id, nd);
        open.push(prev.id);
      }
    }
  }
  return dist;
}
