/**
 * Generated data for custom rounds: bot legs and the intro flyover.
 *
 * Bot legs are deliberately simple: one straight leg from the spawn through
 * each checkpoint (in index order) to the finish. Each leg is sampled over the
 * walkable-surface model; a leg that crosses open air further than a jump is
 * reported, so the editor can say plainly that bots will fall there.
 */
import type { RoundDefinition, Vec3, Waypoint } from '@tumble/shared';
import { MOVEMENT, surfaceUnder, triggerBox, type Surface } from './support.ts';

/** Outcome of {@link generateBotNav}. */
export interface GeneratedNav {
  botNav: Waypoint[];
  /**
   * `route`: legs over solid ground (or short jumps). `gaps`: some leg crosses
   * a gap bots cannot jump, so they will fall there. `roam`: no route (not a
   * race); bots roam, dodge and chase objectives on their own.
   */
  status: 'route' | 'gaps' | 'roam';
  /** Leg indices (0 = spawn → first stop) that cross an unjumpable gap. */
  blockedLegs: number[];
}

const SAMPLE_STEP = 0.75;

/** Floor point a trigger stands on: its centre at the height of the surface below, else its bottom. */
function triggerFloor(surfaces: readonly Surface[], t: RoundDefinition['triggers'][number]): Vec3 {
  const box = triggerBox(t);
  const p = { x: t.position.x, y: box.min.y + 0.1, z: t.position.z };
  const i = surfaceUnder(surfaces, p, 2, box.max.y - box.min.y);
  return i >= 0 ? { ...p, y: surfaces[i]!.yMax } : p;
}

/** A point on a leg plus what to do when leaving it. */
interface LegPoint {
  position: Vec3;
  action: Waypoint['action'];
}

/**
 * Walks the straight leg a → b over the surface model and returns the extra
 * points bots need: a take-off at the edge before each gap or ledge (jump, or
 * jump + dive for long gaps) and a landing after it.
 *
 * @returns The points after `a` up to (not including) `b`, and the longest gap.
 */
function walkLeg(surfaces: readonly Surface[], a: Vec3, b: Vec3): { points: LegPoint[]; gap: number } {
  const len = Math.hypot(b.x - a.x, b.z - a.z);
  const steps = Math.max(1, Math.ceil(len / SAMPLE_STEP));
  const at = (u: number): Vec3 => ({
    x: a.x + (b.x - a.x) * u,
    y: a.y + (b.y - a.y) * u,
    z: a.z + (b.z - a.z) * u,
  });
  const points: LegPoint[] = [];
  let lastTop = a.y;
  let lastGround: Vec3 = a;
  let gapStart = -1;
  let worst = 0;
  for (let k = 1; k <= steps; k++) {
    const p = at(k / steps);
    const i = surfaceUnder(surfaces, { ...p, y: Math.max(p.y, lastTop) }, 3, 2.5);
    if (i < 0) {
      if (gapStart < 0) gapStart = k;
      continue;
    }
    const top = surfaces[i]!.yMax;
    const ground = { x: p.x, y: top, z: p.z };
    if (gapStart >= 0) {
      const gap = ((k - gapStart + 1) * len) / steps;
      worst = Math.max(worst, gap);
      points.push({ position: lastGround, action: gap > 4.25 ? 'jumpDive' : 'jump' });
      if (k < steps) points.push({ position: ground, action: 'run' });
      gapStart = -1;
    } else if (top - lastTop > 0.4 && top - lastTop <= 3) {
      points.push({ position: lastGround, action: 'jump' });
    }
    lastTop = top;
    lastGround = ground;
  }
  return { points, gap: worst };
}

/**
 * Straight-line bot legs for a race: spawn → checkpoints by index → finish,
 * with take-off and landing points around every gap on the way.
 *
 * @param round - Validated round.
 * @param surfaces - From `walkableSurfaces(round)`.
 * @returns The waypoints and how far bots can be trusted on them.
 */
export function generateBotNav(round: RoundDefinition, surfaces: readonly Surface[]): GeneratedNav {
  const finish = round.triggers.find((t) => t.kind === 'finish');
  if (round.type !== 'race' || !finish) return { botNav: [], status: 'roam', blockedLegs: [] };
  const stops: Vec3[] = [{ ...round.spawn.origin }];
  const checkpoints = round.triggers
    .filter((t) => t.kind === 'checkpoint' && t.index > 0)
    .sort((a, b) => a.index - b.index);
  for (const cp of checkpoints) stops.push(triggerFloor(surfaces, cp));
  stops.push(triggerFloor(surfaces, finish));

  const blockedLegs: number[] = [];
  const route: LegPoint[] = [];
  stops.forEach((stop, i) => {
    const next = stops[i + 1];
    if (!next) {
      route.push({ position: stop, action: 'run' });
      return;
    }
    const leg = walkLeg(surfaces, stop, next);
    if (leg.gap > MOVEMENT.gap - 1) blockedLegs.push(i);
    const first = leg.points[0];
    // A take-off right at the stop replaces the stop itself.
    if (first && Math.hypot(first.position.x - stop.x, first.position.z - stop.z) < 0.75) {
      route.push({ position: stop, action: first.action });
      route.push(...leg.points.slice(1));
    } else {
      route.push({ position: stop, action: 'run' }, ...leg.points);
    }
  });
  const capped = route.slice(0, CUSTOM_WAYPOINT_CAP);
  const botNav: Waypoint[] = capped.map((p, i) => ({
    id: i,
    position: { x: round2(p.position.x), y: round2(p.position.y), z: round2(p.position.z) },
    radius: i === capped.length - 1 ? 3 : p.action === 'run' ? 2 : 1.2,
    next: i + 1 < capped.length ? [i + 1] : [],
    action: p.action,
  }));
  return { botNav, status: blockedLegs.length > 0 ? 'gaps' : 'route', blockedLegs };
}

const CUSTOM_WAYPOINT_CAP = 128;
const round2 = (v: number) => Math.round(v * 100) / 100;

/**
 * A flyover over the whole course: from high behind the spawn, over the
 * middle, to the goal, always looking at the course centre.
 *
 * @param round - Validated round.
 * @returns A flyover block for the definition.
 */
export function autoFlyover(round: RoundDefinition): RoundDefinition['flyover'] {
  const pts: Vec3[] = [round.spawn.origin];
  for (const t of round.triggers) if (t.kind !== 'void') pts.push(t.position);
  for (const g of round.geometry) if (!g.decorative) pts.push(g.position);
  for (const o of round.obstacles) pts.push(o.position);
  const min = { x: Infinity, y: Infinity, z: Infinity };
  const max = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const p of pts) {
    min.x = Math.min(min.x, p.x);
    min.y = Math.min(min.y, p.y);
    min.z = Math.min(min.z, p.z);
    max.x = Math.max(max.x, p.x);
    max.y = Math.max(max.y, p.y);
    max.z = Math.max(max.z, p.z);
  }
  const c = { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 };
  const span = Math.max(20, max.x - min.x, max.z - min.z);
  const goal = round.triggers.find((t) => t.kind === 'finish')?.position ?? { x: c.x, y: c.y, z: max.z };
  const s = round.spawn.origin;
  const r = (v: number) => Math.round(v * 10) / 10;
  const at = (x: number, y: number, z: number): Vec3 => ({ x: r(x), y: r(y), z: r(z) });
  return {
    path: [
      at(goal.x + span * 0.15, max.y + span * 0.35, goal.z + span * 0.2),
      at(c.x - span * 0.45, max.y + span * 0.45, c.z),
      at(s.x, s.y + 8, s.z - 14),
    ],
    lookAt: [at(c.x, c.y, c.z), at(c.x, c.y, c.z), at(s.x, s.y + 1, s.z + 10)],
    duration: 6,
  };
}
