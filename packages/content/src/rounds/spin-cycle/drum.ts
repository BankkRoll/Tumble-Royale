/**
 * Washing-drum kit shared by Spin Cycle (S1) and Spin Cycle Finale (F3).
 *
 * Responsibilities:
 * - Shrinking floors: the design's timed `fallingTiles` ring drops are built
 *   from one-shot `movingPlatform` panels laid radially around the drum (the
 *   real `fallingTiles` module is touch-only, rectangular and unmasked).
 * - Hex-tiled core decoration over a solid static disc.
 * - Bar heights and the `jumpRopeBeam` param builder for low/high bars.
 */
import type { RoundDefinitionInput } from '@tumble/shared';

type Piece = RoundDefinitionInput['geometry'][number];
type Obstacle = NonNullable<RoundDefinitionInput['obstacles']>[number];

const DEG = 180 / Math.PI;

/**
 * Low bar: centre height and radius (m). Top at 0.85 m — a full jump clears
 * it, a walker trips on it. The bar is fat enough to sit 5 cm off the floor:
 * a gap under a beam lets a capsule wedge beneath it and get flung out.
 */
export const LOW_BAR = { height: 0.45, radius: 0.4 } as const;

/**
 * High bar: centre height and radius (m). Tumblers keep their upright 1.8 m
 * capsule while diving (a dive only hops ~0.3 m), so the bar's underside sits
 * at 2.3 m: standing or diving Tumblers pass under it, a jumping one is hit.
 * The design's 1.40–2.10 m band is unclearable with the shipped controller.
 */
export const HIGH_BAR = { height: 2.6, radius: 0.3 } as const;

/** Options for {@link ringPanels}. */
export interface RingOptions {
  /** Id prefix; panels are `<prefix>-<k>`. */
  prefix: string;
  rIn: number;
  rOut: number;
  /** Panels around the ring. More panels ⇒ smaller wedge slivers at the rim. */
  count: number;
  /** Match time the ring starts to drop (s). Not scaled by the show stage. */
  dropAt: number;
  /** Angular offset of panel 0 (radians). */
  offset?: number;
}

/** How far a dropped panel sinks (m): well past killY, so it never comes back into view. */
const DROP_DEPTH = 30;
/** Average sink speed (m/s); sine easing makes the first half-second a visible sag. */
const DROP_SPEED = 12;
/** Hold at each end of the ping-pong (s): longer than any round, so a drop is one-shot. */
const HOLD = 400;

/**
 * A ring of floor panels that sag and drop at `dropAt`, never to return.
 *
 * Each panel is a `movingPlatform` ping-ponging between its rest pose and
 * 30 m below, holding 400 s at each end: with `phase = dropAt` the platform
 * sits in its top hold from match start and begins its (sine-eased) descent
 * exactly at `dropAt`. Pauses and phase are unscaled, so ring times match
 * the design on every show stage. (A one-segment `collapsingBridge` would
 * also work physically, but its visual stands abutment posts on every panel.)
 *
 * Neighbouring panels alternate their top by 2 cm so overlapping inner
 * corners never z-fight.
 *
 * @param o - Ring geometry and timing.
 * @returns One obstacle per panel.
 * @example
 * ringPanels({ prefix: 'ring-out', rIn: 17, rOut: 22, count: 36, dropAt: 60 });
 */
export function ringPanels(o: RingOptions): Obstacle[] {
  const step = (Math.PI * 2) / o.count;
  const rc = (o.rIn + o.rOut) / 2;
  const width = 2 * rc * Math.tan(step / 2);
  const out: Obstacle[] = [];
  for (let k = 0; k < o.count; k++) {
    const a = (o.offset ?? 0) + k * step;
    out.push({
      id: `${o.prefix}-${k}`,
      type: 'movingPlatform',
      position: { x: Math.sin(a) * rc, y: k % 2 === 0 ? 0 : -0.02, z: Math.cos(a) * rc },
      rotation: { yaw: a * DEG },
      params: {
        points: [
          { x: 0, y: 0, z: 0 },
          { x: 0, y: -DROP_DEPTH, z: 0 },
        ],
        size: { x: width, y: 0.6, z: o.rOut - o.rIn },
        speed: DROP_SPEED,
        mode: 'pingPong',
        pauseTime: HOLD,
        pauseAt: 'ends',
        easing: 'sine',
        phase: o.dropAt,
      },
    });
  }
  return out;
}

/**
 * Painted warning seam on a ring boundary (decor): doomed rings read as
 * doomed before they go.
 */
export function ringSeam(r: number, color = 'danger'): Piece {
  return {
    shape: 'torus',
    position: { x: 0, y: 0.03, z: 0 },
    size: { x: r, y: 0.09, z: r },
    color,
    decorative: true,
    bevel: 0,
    pattern: 'hazard',
  };
}

/** Options for {@link hexCore}. */
export interface HexCoreOptions {
  /** Radius the tile centres stay within (m). */
  radius: number;
  /** Tile circumradius (m). */
  tile: number;
  gap: number;
  /** Palette keys cycled by hex ring distance from the centre. */
  colors: readonly string[];
  /** Tiles with centre radius ≤ this use `centreColor` (hub/slow zone). */
  centreRadius?: number;
  centreColor?: string;
}

/**
 * Decorative hex tiles laid 2 cm proud of a solid disc, so the core reads as
 * the design's hex floor without hundreds of tiny colliders.
 *
 * @returns Decorative hexPrism pieces (vertex on +X, matching the collider convention).
 */
export function hexCore(o: HexCoreOptions): Piece[] {
  const pitch = o.tile + o.gap / Math.sqrt(3);
  const n = Math.ceil(o.radius / (pitch * 1.5)) + 1;
  const out: Piece[] = [];
  for (let q = -n; q <= n; q++) {
    for (let r = -2 * n; r <= 2 * n; r++) {
      const x = 1.5 * pitch * q;
      const z = Math.sqrt(3) * pitch * (r + q / 2);
      const d = Math.hypot(x, z);
      if (d > o.radius) continue;
      const ring = Math.max(Math.abs(q), Math.abs(r), Math.abs(q + r));
      const color =
        o.centreRadius !== undefined && d <= o.centreRadius
          ? (o.centreColor ?? 'safe')
          : (o.colors[ring % o.colors.length] as string);
      out.push({
        shape: 'hexPrism',
        position: { x, y: -0.03, z },
        size: { x: o.tile, y: 0.1, z: o.tile },
        color,
        decorative: true,
        bevel: 0.08,
        pattern: 'none',
      });
    }
  }
  return out;
}

/** Options for {@link bar}. */
export interface BarOptions {
  /** Beam reach from the hub (m). */
  reach: number;
  kind: 'low' | 'high';
  /** `full` beams cross the hub (two arms), `arm` beams are one-sided. */
  mode: 'full' | 'arm';
  /** Arms per layer, evenly spaced. */
  beams?: number;
  /** 1 or −1; high bars spin opposite to this. */
  direction: 1 | -1;
  /** Angular speed at the start of motion (rad/s). */
  startSpeed: number;
  /** Angular speed reached at `rampUntil` seconds of motion (rad/s). */
  endSpeed: number;
  /** Seconds of motion over which speed ramps linearly to `endSpeed`. */
  rampUntil: number;
  /** Match time the bar starts moving (s); it hangs still and harmless before. */
  startDelay?: number;
  hubRadius: number;
  knockImpulse: number;
}

/**
 * `jumpRopeBeam` params for one drum bar. The design's piecewise speed
 * schedules become the module's single linear ramp (start → end speed).
 *
 * @returns Params object for a `jumpRopeBeam` instance.
 */
export function bar(o: BarOptions): Record<string, unknown> {
  const w0 = o.startSpeed * DEG;
  const w1 = o.endSpeed * DEG;
  return {
    radius: o.reach,
    mode: o.mode,
    layers: o.kind,
    lowHeight: LOW_BAR.height,
    highHeight: HIGH_BAR.height,
    beamRadius: o.kind === 'low' ? LOW_BAR.radius : HIGH_BAR.radius,
    beamsPerLayer: o.beams ?? 1,
    highDirection: 'opposite',
    direction: o.direction,
    startSpeed: Math.round(w0 * 100) / 100,
    acceleration: Math.round(((w1 - w0) / o.rampUntil) * 1000) / 1000,
    maxSpeed: Math.round(w1 * 100) / 100,
    startDelay: o.startDelay ?? 0,
    hubRadius: o.hubRadius,
    knockImpulse: o.knockImpulse,
    // A stunned Tumbler in front of a bar is dragged round and off the drum, so the low bar only
    // shoves (fast bars still stun through the controller's impact threshold). The high bar
    // stuns: it only ever meets a Tumbler who jumped into it.
    stunOnHit: o.kind === 'high',
  };
}

/**
 * Tiny deterministic LCG for set dressing, so decor never shifts between builds.
 *
 * @param seed - Any integer.
 * @returns A function yielding floats in [0, 1).
 */
export function decorRng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
